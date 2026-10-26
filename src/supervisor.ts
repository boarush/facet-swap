import { DurableObject } from "cloudflare:workers";

import type { Env } from "../alchemy.run";

import { createRouter } from "./router";
import { trackResponseBody, type UpdateAbort } from "./stream-lifetime";
import { loadApp, VersionSource } from "./version-source";

type ScheduledAlarm = { time: number; token: string };

type AppConfig = { hash: string; generation: number; readOnly: boolean };
type VersionState = {
  current: AppConfig | null;
  pending: AppConfig | null;
  pendingSince?: number;
};
type SwapRow = {
  id: number;
  oldHash: string | null;
  newHash: string;
  kind: "code" | "scope";
  pendingSince: number;
  swappedAt: number;
  forced: number;
  abortedStreams: number;
  restartCommit: number;
};

// This class stays stable; only the app facet's code is versioned.
export class Supervisor extends DurableObject<Env> {
  private state: VersionState;
  private swapping = false;
  private runningAlarm?: string;
  private readonly active = new Set<AbortController>();
  private readonly streams = new Set<AbortController>();
  private drainTimer?: ReturnType<typeof setTimeout>;
  private readonly versions: VersionSource;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.versions = new VersionSource(env);
    this.state = ctx.storage.kv.get<VersionState>("app-config") ?? { current: null, pending: null };
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS swaps (
        id INTEGER PRIMARY KEY,
        oldHash TEXT, newHash TEXT NOT NULL, kind TEXT NOT NULL,
        pendingSince INTEGER NOT NULL, swappedAt INTEGER NOT NULL,
        forced INTEGER NOT NULL, abortedStreams INTEGER NOT NULL, restartCommit INTEGER NOT NULL
      )
    `);
    // Inflight tracking cannot survive restart; finish any persisted pending swap on wake.
    this.swap(false, true);
  }

  private readonly router = createRouter<Env>()
    // Local diagnostics bypass update checks and admission.
    .get("/__status", (c) => {
      const raw = c.req.query("swaps") ?? "20";
      const limit = Number(raw);
      if (!/^\d+$/.test(raw) || !Number.isSafeInteger(limit)) {
        return new Response("Invalid swaps", { status: 400 });
      }
      const swaps = this.ctx.storage.sql
        .exec<SwapRow>("SELECT * FROM swaps ORDER BY id DESC LIMIT ?", Math.min(limit, 100))
        .toArray()
        .map((row) => ({ ...row, forced: !!row.forced, restartCommit: !!row.restartCommit }));
      return Response.json({
        ...this.state,
        pendingSince: this.state.pendingSince ?? null,
        inflight: this.active.size,
        swapping: this.swapping,
        swaps,
      });
    })
    .all("/__status", () => new Response("Method not allowed", { status: 405 }))
    .use(async (_c, next) => {
      await this.checkForUpdate();
      await next();
    })
    // Local trusted control plane only; never forward scope requests to the facet.
    .put("/__scope", async (c) => {
      const body = await c.req.raw.json<{ readOnly?: unknown }>();
      if (typeof body.readOnly !== "boolean") return new Response("Invalid scope", { status: 400 });
      const target = this.target();
      if (!target) return new Response("Publish a version first", { status: 503 });
      // Same scope means same facet env; draining would only cost availability.
      if (target.readOnly === body.readOnly)
        return Response.json({ accepted: true, changed: false });
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
    return this.versions.check(async (latest) => {
      if (latest !== null && latest !== undefined) {
        let config: AppConfig;
        try {
          if (
            typeof latest !== "object" ||
            !("hash" in latest) ||
            typeof latest.hash !== "string" ||
            !/^[0-9a-f]{64}$/.test(latest.hash) ||
            !("generation" in latest) ||
            typeof latest.generation !== "number" ||
            !Number.isSafeInteger(latest.generation) ||
            latest.generation < 1
          )
            throw new Error("Invalid facet publication");
          const highest = Math.max(
            this.state.current?.generation ?? 0,
            this.state.pending?.generation ?? 0,
          );
          if (latest.generation <= highest) return;
          const scope = {
            user: this.ctx.id.toString(),
            readOnly: this.target()?.readOnly ?? false,
          };
          await loadApp(this.env, latest.hash, scope, true);
          // A scope change may land during preflight; never stage the stale permission.
          // The module is already validated, so a new scope only needs a new loader env.
          const readOnly = this.target()?.readOnly ?? false;
          config = { hash: latest.hash, generation: latest.generation, readOnly };
        } catch (error) {
          console.error("Facet preflight failed; keeping current configuration", latest, error);
          return;
        }
        const target = this.target();
        if (target?.hash === config.hash) {
          // A forced republication of identical code advances ordering, not the drain.
          target.generation = config.generation;
          this.ctx.storage.kv.put("app-config", this.state);
        } else {
          this.stage(config);
        }
      }
      this.swapWhenIdle();
    });
  }

  // The configuration the next swap lands on.
  private target(): AppConfig | null {
    return this.state.pending ?? this.state.current;
  }

  private stage(config: AppConfig): void {
    this.state.pendingSince ??= Date.now();
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

  private swap(force = false, restartCommit = false): void {
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
      const swappedAt = Date.now();
      const next = { current: this.state.pending, pending: null };
      // Commit history with current atomically; restart must not lose or duplicate a row.
      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.kv.put("app-config", next);
        this.ctx.storage.sql.exec(
          `INSERT INTO swaps
            (oldHash, newHash, kind, pendingSince, swappedAt, forced, abortedStreams, restartCommit)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          this.state.current?.hash ?? null,
          next.current.hash,
          this.state.current?.hash === next.current.hash ? "scope" : "code",
          this.state.pendingSince ?? swappedAt,
          swappedAt,
          Number(force),
          force ? this.streams.size : 0,
          Number(restartCommit),
        );
        this.ctx.storage.sql.exec(
          "DELETE FROM swaps WHERE id NOT IN (SELECT id FROM swaps ORDER BY id DESC LIMIT 100)",
        );
      });
      this.state = next;
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
      this.streams.delete(controller);
      if (this.active.delete(controller)) this.swapWhenIdle();
    };
    return { controller, release };
  }

  private async serve(request: Request): Promise<Response> {
    const { controller, release } = this.beginWork();
    try {
      const response = await this.app().fetch(request);
      if (response.body && !controller.signal.aborted) this.streams.add(controller);
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
