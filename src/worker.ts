import { DurableObject } from "cloudflare:workers";

interface Env {
  CODE: R2Bucket;
  VERSIONS: KVNamespace;
  LOADER: WorkerLoader;
  SUPERVISORS: DurableObjectNamespace<Supervisor>;
  CHECK_INTERVAL_MS: string;
}
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
      const facet = this.ctx.facets.get("app", async () => {
        const worker = this.env.LOADER.get(hash, async () => {
          const object = await this.env.CODE.get("code/" + hash + ".js");
          if (!object) throw new Error("Missing code " + hash);
          return {
            compatibilityDate: "2026-10-21",
            mainModule: "app.js",
            modules: { "app.js": await object.text() },
            env: { HASH: hash },
            globalOutbound: null,
          };
        });
        return { class: worker.getDurableObjectClass("App") };
      });
      const response = await facet.fetch(request);
      if (!response.body) { release(); return response; }
      const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
      // Includes EOF, errors, and downstream cancellation. Never decrement at headers.
      this.ctx.waitUntil(response.body.pipeTo(writable).catch(error => {
        console.log("response body ended with error/cancellation", String(error));
      }).finally(release));
      return new Response(readable, response);
    } catch (error) {
      release();
      throw error;
    }
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return new Response("ready");
    // LOCAL-ONLY publication gateway, bound to loopback. Never expose this server.
    if (url.pathname === "/__local/code" && request.method === "PUT") {
      const code = await request.text();
      const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(code));
      const hash = Array.from(new Uint8Array(bytes), n => n.toString(16).padStart(2, "0")).join("");
      await env.CODE.put("code/" + hash + ".js", code);
      return Response.json({ hash });
    }
    if (url.pathname === "/__local/latest" && request.method === "PUT") {
      const hash = await request.text();
      if (!/^[a-f0-9]{64}$/.test(hash) || !await env.CODE.head("code/" + hash + ".js")) {
        return new Response("Missing/invalid code hash", { status: 400 });
      }
      await env.VERSIONS.put("latest", hash);
      return Response.json({ hash });
    }
    const match = /^\/u\/([^/]+)(\/.*)?$/.exec(url.pathname);
    if (!match) return new Response("Not found", { status: 404 });
    url.pathname = match[2] ?? "/";
    return env.SUPERVISORS.get(env.SUPERVISORS.idFromName(match[1])).fetch(new Request(url, request));
  },
} satisfies ExportedHandler<Env>;
