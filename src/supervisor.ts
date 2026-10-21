import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";
import { loadApp } from "./version-source";
import { trackResponseBody } from "./stream-lifetime";

type VersionState = { current: string | null; pending: string | null };

export class Supervisor extends DurableObject<Env> {
  private state: VersionState;
  private inflight = 0;
  private queue: Array<{ request: Request; resolve: (r: Response) => void; reject: (e: unknown) => void }> = [];
  private swapping = false;
  private lastCheck = -Infinity;
  private checking?: Promise<void>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.state = ctx.storage.kv.get<VersionState>("versions") ?? { current: null, pending: null };
  }

  private maybeUpdate(): Promise<void> {
    if (this.checking) return this.checking;
    if (Date.now() - this.lastCheck < Number(this.env.CHECK_INTERVAL_MS)) return Promise.resolve();
    this.lastCheck = Date.now();
    this.checking = (async () => {
      const latest = await this.env.VERSIONS.get("latest");
      if (latest && latest !== this.state.current && latest !== this.state.pending) {
        this.state.pending = latest;
        this.ctx.storage.kv.put("versions", this.state);
      }
      if (this.inflight === 0) this.swap();
    })().finally(() => { this.checking = undefined; });
    return this.checking;
  }

  private swap() {
    if (this.swapping || this.inflight !== 0) return;
    this.swapping = true;
    try {
      while (this.state.pending) {
        this.state = { current: this.state.pending, pending: null };
        // Synchronous SQLite KV persists the pointer before the abort, without yielding.
        this.ctx.storage.kv.put("versions", this.state);
        this.ctx.facets.abort("app", new Error("Code updated"));
      }
    } finally {
      this.swapping = false;
    }
    const queued = this.queue.splice(0);
    for (const item of queued) this.run(item.request).then(item.resolve, item.reject);
  }

  async fetch(request: Request): Promise<Response> {
    // Local diagnostics deliberately bypass the drain gate.
    if (new URL(request.url).pathname === "/__status") {
      return Response.json({ ...this.state, inflight: this.inflight, queued: this.queue.length, swapping: this.swapping });
    }
    await this.maybeUpdate();
    if (this.state.pending || this.swapping) {
      return new Promise((resolve, reject) => this.queue.push({ request, resolve, reject }));
    }
    if (!this.state.current) return new Response("Publish a version first", { status: 503 });
    return this.run(request);
  }

  private async run(request: Request): Promise<Response> {
    this.inflight++;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.inflight--;
      if (this.inflight === 0 && this.state.pending) this.swap();
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

