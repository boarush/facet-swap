import { DurableObject } from "cloudflare:workers";
import type { Env } from "../alchemy.run";
import { loadApp, VersionSource } from "./version-source";
import { trackResponseBody, type UpdateAbort } from "./stream-lifetime";

type AppConfig = { hash: string; readOnly: boolean };
type VersionState = { current: AppConfig | null; pending: AppConfig | null };

// This class stays stable; only the app facet's code is versioned.
export class Supervisor extends DurableObject<Env> {
  private state: VersionState;
  private swapping = false;
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

  async fetch(request: Request): Promise<Response> {
    // Local diagnostics bypass admission so tests can observe a drain.
    if (new URL(request.url).pathname === "/__status") {
      return Response.json({
        ...this.state,
        inflight: this.active.size,
        swapping: this.swapping,
      });
    }

    await this.checkForUpdate();
    // Local trusted control plane only; never forward scope requests to the facet.
    if (new URL(request.url).pathname === "/__scope") {
      if (request.method !== "PUT") return new Response("Method not allowed", { status: 405 });
      const body = await request.json<{ readOnly?: unknown }>();
      if (typeof body.readOnly !== "boolean") return new Response("Invalid scope", { status: 400 });
      const target = this.state.pending ?? this.state.current;
      if (!target) return new Response("Publish a version first", { status: 503 });
      this.stage({ ...target, readOnly: body.readOnly });
      return Response.json({ accepted: true });
    }
    // Close admission while pending so new traffic cannot starve the update.
    if (this.state.pending) {
      // Clients own retries; never retain requests while old bodies drain.
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
    return this.serve(request);
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

  private async serve(request: Request): Promise<Response> {
    const controller = new AbortController();
    this.active.add(controller);
    const release = () => {
      // Old header/body completions after a forced swap cannot release new work.
      if (this.active.delete(controller)) this.swapWhenIdle();
    };
    try {
      const { hash, readOnly } = this.state.current!;
      const scope = { user: this.ctx.id.toString(), readOnly };
      const facet = this.ctx.facets.get("app", () => loadApp(this.env, hash, scope));
      const response = await facet.fetch(request);
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
