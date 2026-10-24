import { exports } from "cloudflare:workers";

import type { Env } from "../alchemy.run";

import type { App } from "./app";
import type { NotesScope } from "./notes";

export class VersionSource {
  private lastCheck = -Infinity;
  private checking?: Promise<void>;

  constructor(private readonly env: Env) {}

  // Lazy KV checks on requests and application alarms; no background update polling.
  check(onLatest: (hash: string | null) => void): Promise<void> {
    if (this.checking) return this.checking;
    if (Date.now() - this.lastCheck < Number(this.env.CHECK_INTERVAL_MS)) {
      return Promise.resolve();
    }
    this.lastCheck = Date.now();
    this.checking = this.env.VERSIONS.get("latest")
      .then(onLatest)
      .finally(() => {
        this.checking = undefined;
      });
    return this.checking;
  }
}

// The loader cache is keyed by content hash, not by a mutable version label.
export async function loadApp(env: Env, hash: string, scope: NotesScope) {
  // Loader env is cached too: hash alone would share Alice's capabilities with Bob.
  const worker = env.LOADER.get(JSON.stringify([hash, scope.user, scope.readOnly]), async () => {
    const object = await env.CODE.get("code/" + hash + ".js");
    if (!object) throw new Error("Missing code " + hash);
    return {
      compatibilityDate: "2026-10-12",
      mainModule: "app.js",
      modules: { "app.js": await object.text() },
      env: {
        HASH: hash,
        NOTES: exports.ScopedNotes({ props: scope }),
        SCHEDULER: exports.Scheduler({ props: { user: scope.user } }),
      },
      globalOutbound: null,
    };
  });
  return { class: worker.getDurableObjectClass<App>("App") };
}
