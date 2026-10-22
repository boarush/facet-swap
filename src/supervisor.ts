import { DurableObject } from "cloudflare:workers";
import type { Env } from "../alchemy.run";
import { createRouter } from "./router";
import { loadApp, VersionSource } from "./version-source";
import { trackResponseBody, type UpdateAbort } from "./stream-lifetime";

type ScheduledAlarm = { time: number; token: string };

type AppConfig = { hash: string; readOnly: boolean };
type VersionState = { current: AppConfig | null; pending: AppConfig | null };

// This class stays stable; only the app facet's code is versioned.
export class Supervisor extends DurableObject<Env> {
  private state: VersionState;
  private swapping = false;
  private runningAlarm?: string;
  private readonly active = new Set<AbortController>();
  private drainTimer?: ReturnType<typeof setTimeout>;
  private readonly versions: VersionSource;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.versions = new VersionSource(env);
    this.state = ctx.storage.kv.get<VersionState>("app-config") ?? { current: null, pending: null };
    // Inflight tracking cannot survive restart; finish any persisted pending swap on wake.
    this.swapWhenIdle();
  }

  private readonly router = createRouter<Env>()
    // Local diagnostics bypass update checks and admission.
    .all("/__status", () =>
      Response.json({
        ...this.state,
        inflight: this.active.size,
        swapping: this.swapping,
      }),
    )
    .use(async (_c, next) => {
      await this.checkForUpdate();
      await next();
    })
    // Local trusted control plane only; never forward scope requests to the facet.
    .put("/__scope", async (c) => {
      const body = await c.req.raw.json<{ readOnly?: unknown }>();
      if (typeof body.readOnly !== "boolean") return new Response("Invalid scope", { status: 400 });
      const target = this.state.pending ?? this.state.current;
      if (!target) return new Response("Publish a version first", { status: 503 });
      this.stage({ ...target, readOnly: body.readOnly });
      return Response.json({ accepted: true });
    })
    .all("/__scope", () => new Response("Method not allowed", { status: 405 }))
    .all("*", (c) => {
      // Clients own retries; never retain requests while old bodies drain.
      if (this.state.pending) {
        return new Response("Update pending; retry later", {
          status: 503,
          headers: {
            "Retry-After": "1",
            "X-Current-Version": this.state.current?.hash ?? "",
            "X-Pending-Version": this.state.pending.hash,
            "Cache-Control": "no-store",
          },
        });
      }
      if (!this.state.current) return new Response("Publish a version first", { status: 503 });
      return this.serve(c.req.raw);
    });

  async fetch(request: Request): Promise<Response> {
    return this.router.fetch(request, this.env);
  }

  // Keep the logical due time separate from the physical alarm's drain deferrals.
  async setAlarm(time: number | Date): Promise<void> {
    const scheduled = { time: Number(time), token: crypto.randomUUID() };
    await this.ctx.storage.transaction(async (storage) => {
      await storage.put("app-alarm", scheduled);
      await storage.setAlarm(scheduled.time);
    });
  }

  getAlarm(): number | null {
    const scheduled = this.ctx.storage.kv.get<ScheduledAlarm>("app-alarm");
    // Like native alarms, the running delivery is not a pending alarm.
    return scheduled && scheduled.token !== this.runningAlarm ? scheduled.time : null;
  }

  async deleteAlarm(): Promise<void> {
    await this.ctx.storage.transaction(async (storage) => {
      await storage.delete("app-alarm");
      await storage.deleteAlarm();
    });
  }

  async alarm(info?: AlarmInvocationInfo): Promise<void> {
    await this.checkForUpdate();
    const scheduled = this.ctx.storage.kv.get<ScheduledAlarm>("app-alarm");
    if (!scheduled) return;
    if (scheduled.time > Date.now() || this.state.pending) {
      // Deferral doesn't consume the alarm or reset the hard drain deadline.
      await this.ctx.storage.setAlarm(Math.max(scheduled.time, Date.now() + 2000));
      return;
    }
    if (!this.state.current) throw new Error("Publish a version first");
    const { release } = this.beginWork();
    this.runningAlarm = scheduled.token;
    try {
      // 'alarm' is reserved on DO RPC; the facet's tiny bridge calls its handler.
      // Runtime AlarmInvocationInfo is not RPC-serializable; copy its public fields.
      await this.app().dispatchAlarm(
        info && {
          scheduledTime: scheduled.time,
          retryCount: info.retryCount,
          isRetry: info.isRetry,
        },
      );
      // A handler can rearm, even for the same time; don't erase its new alarm.
      if (this.ctx.storage.kv.get<ScheduledAlarm>("app-alarm")?.token === scheduled.token) {
        this.ctx.storage.kv.delete("app-alarm");
      }
    } finally {
      // On error leave the durable record intact and let native alarm retries run.
      this.runningAlarm = undefined;
      release();
    }
  }

  private checkForUpdate(): Promise<void> {
    return this.versions.check((latest) => {
      if (latest && latest !== this.state.current?.hash && latest !== this.state.pending?.hash) {
        this.stage({
          hash: latest,
          readOnly: (this.state.pending ?? this.state.current)?.readOnly ?? false,
        });
      }
      this.swapWhenIdle();
    });
  }

  private stage(config: AppConfig): void {
    this.state.pending = config;
    this.ctx.storage.kv.put("app-config", this.state);
    // Replacing pending code/scope never extends an already-running deadline.
    if (this.drainTimer === undefined) {
      // Active timers prevent DO hibernation; no durable alarm is needed for live bodies.
      this.drainTimer = setTimeout(() => this.swap(true), Number(this.env.DRAIN_DEADLINE_MS));
    }
    this.swapWhenIdle();
  }

  private swapWhenIdle(): void {
    if (this.active.size === 0) this.swap();
  }

  private swap(force = false): void {
    if (this.swapping || !this.state.pending || (!force && this.active.size !== 0)) return;
    this.swapping = true;
    try {
      clearTimeout(this.drainTimer);
      this.drainTimer = undefined;
      const reason: UpdateAbort = {
        reason: "drain-deadline",
        oldVersion: this.state.current?.hash ?? "",
        newVersion: this.state.pending.hash,
      };
      this.state = { current: this.state.pending, pending: null };
      // Persist before abort, without yielding: eviction must restart on current.
      this.ctx.storage.kv.put("app-config", this.state);
      // Finish Supervisor-owned SSE bodies before aborting their facet source.
      if (force) {
        for (const controller of this.active) controller.abort(reason);
        this.active.clear();
      }
      // Abort restarts facet code but preserves its SQLite storage.
      this.ctx.facets.abort(
        "app",
        new Error(force ? "Drain deadline exceeded" : "Code or scope updated"),
      );
    } finally {
      this.swapping = false;
    }
  }

  private app() {
    const { hash, readOnly } = this.state.current!;
    const scope = { user: this.ctx.id.toString(), readOnly };
    return this.ctx.facets.get("app", () => loadApp(this.env, hash, scope));
  }

  private beginWork() {
    const controller = new AbortController();
    this.active.add(controller);
    const release = () => {
      // Old header/body completions after a forced swap cannot release new work.
      if (this.active.delete(controller)) this.swapWhenIdle();
    };
    return { controller, release };
  }

  private async serve(request: Request): Promise<Response> {
    const { controller, release } = this.beginWork();
    try {
      const response = await this.app().fetch(request);
      return trackResponseBody(response, controller.signal, release);
    } catch (error) {
      release();
      // A deadline can also cut work still waiting for response headers.
      if (controller.signal.aborted) {
        return new Response("Update aborted request; retry", {
          status: 503,
          headers: { "Retry-After": "1", "Cache-Control": "no-store" },
        });
      }
      throw error;
    }
  }
}
