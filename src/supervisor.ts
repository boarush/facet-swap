import { DurableObject } from "cloudflare:workers";
import type { Env } from "../alchemy.run";
import { loadApp, VersionSource } from "./version-source";
import { trackResponseBody } from "./stream-lifetime";

type VersionState = { current: string | null; pending: string | null };
type WaitingRequest = {
  request: Request;
  resolve: (response: Response) => void;
  reject: (error: unknown) => void;
};

// This class stays stable; only the app facet's code is versioned.
export class Supervisor extends DurableObject<Env> {
  private state: VersionState;
  private inflight = 0;
  private queue: WaitingRequest[] = [];
  private swapping = false;
  private readonly versions: VersionSource;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.versions = new VersionSource(env);
    this.state = ctx.storage.kv.get<VersionState>("versions") ?? { current: null, pending: null };
  }

  async fetch(request: Request): Promise<Response> {
    // Local diagnostics bypass admission so tests can observe a drain.
    if (new URL(request.url).pathname === "/__status") {
      return Response.json({
        ...this.state,
        inflight: this.inflight,
        queued: this.queue.length,
        swapping: this.swapping,
      });
    }

    await this.checkForUpdate();
    // Close admission while pending so new traffic cannot starve the update.
    if (this.state.pending || this.swapping) return this.waitForSwap(request);
    if (!this.state.current) return new Response("Publish a version first", { status: 503 });
    return this.serve(request);
  }

  private checkForUpdate(): Promise<void> {
    return this.versions.check((latest) => {
      if (latest && latest !== this.state.current && latest !== this.state.pending) {
        this.state.pending = latest;
        this.ctx.storage.kv.put("versions", this.state);
      }
      this.swapWhenIdle();
    });
  }

  private waitForSwap(request: Request): Promise<Response> {
    return new Promise((resolve, reject) => {
      this.queue.push({ request, resolve, reject });
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
        this.ctx.storage.kv.put("versions", this.state);
        // Abort restarts facet code but preserves its SQLite storage.
        this.ctx.facets.abort("app", new Error("Code updated"));
      }
    } finally {
      this.swapping = false;
    }
    const queued = this.queue.splice(0);
    for (const item of queued) this.serve(item.request).then(item.resolve, item.reject);
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
      const hash = this.state.current!;
      const facet = this.ctx.facets.get("app", () => loadApp(this.env, hash));
      const response = await facet.fetch(request);
      return trackResponseBody(response, this.ctx, release);
    } catch (error) {
      release();
      throw error;
    }
  }
}
