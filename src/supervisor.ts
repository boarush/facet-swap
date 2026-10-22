import { DurableObject } from "cloudflare:workers";
import type { Env } from "../alchemy.run";
import { loadApp, VersionSource } from "./version-source";
import { trackResponseBody } from "./stream-lifetime";

type AppConfig = { hash: string; readOnly: boolean };
type VersionState = { current: AppConfig | null; pending: AppConfig | null };

// This class stays stable; only the app facet's code is versioned.
export class Supervisor extends DurableObject<Env> {
  private state: VersionState;
  private inflight = 0;
  private swapping = false;
  private readonly versions: VersionSource;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.versions = new VersionSource(env);
    this.state = ctx.storage.kv.get<VersionState>("app-config") ?? { current: null, pending: null };
  }

  async fetch(request: Request): Promise<Response> {
    // Local diagnostics bypass admission so tests can observe a drain.
    if (new URL(request.url).pathname === "/__status") {
      return Response.json({
        ...this.state,
        inflight: this.inflight,
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
      this.state.pending = { ...target, readOnly: body.readOnly };
      this.ctx.storage.kv.put("app-config", this.state);
      this.swapWhenIdle();
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
        this.state.pending = {
          hash: latest,
          readOnly: (this.state.pending ?? this.state.current)?.readOnly ?? false,
        };
        this.ctx.storage.kv.put("app-config", this.state);
      }
      this.swapWhenIdle();
    });
  }

  private swapWhenIdle(): void {
    // Streams are assumed to end. Never force a swap or impose a drain deadline.
    if (this.swapping || this.inflight !== 0) return;
    this.swapping = true;
    try {
      if (this.state.pending) {
        this.state = { current: this.state.pending, pending: null };
        // Persist before abort, without yielding: eviction must restart on current.
        // Forward-only; rollback and canary behavior belong in separate testing.
        this.ctx.storage.kv.put("app-config", this.state);
        // Abort restarts facet code but preserves its SQLite storage.
        this.ctx.facets.abort("app", new Error("Code or scope updated"));
      }
    } finally {
      this.swapping = false;
    }
  }

  private async serve(request: Request): Promise<Response> {
    this.inflight++;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.inflight--;
      if (this.inflight === 0 && this.state.pending) this.swapWhenIdle();
    };
    try {
      const { hash, readOnly } = this.state.current!;
      const scope = { user: this.ctx.id.toString(), readOnly };
      const facet = this.ctx.facets.get("app", () => loadApp(this.env, hash, scope));
      const response = await facet.fetch(request);
      return trackResponseBody(response, this.ctx, release);
    } catch (error) {
      release();
      throw error;
    }
  }
}
