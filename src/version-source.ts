import type { Env } from "./env";

export class VersionSource {
  private lastCheck = -Infinity;
  private checking?: Promise<void>;

  constructor(private readonly env: Env) {}

  // Request-driven KV checks only: no pushes or alarms; each supervisor checks independently.
  check(onLatest: (hash: string | null) => void): Promise<void> {
    if (this.checking) return this.checking;
    if (Date.now() - this.lastCheck < Number(this.env.CHECK_INTERVAL_MS)) {
      return Promise.resolve();
    }
    this.lastCheck = Date.now();
    this.checking = this.env.VERSIONS.get("latest")
      .then(onLatest)
      .finally(() => { this.checking = undefined; });
    return this.checking;
  }
}

// The loader cache is keyed by content hash, not by a mutable version label.
export async function loadApp(env: Env, hash: string) {
  const worker = env.LOADER.get(hash, async () => {
    const object = await env.CODE.get("code/" + hash + ".js");
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
}
