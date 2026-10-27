import { exports } from "cloudflare:workers";

import type { Env } from "../alchemy.run";

import type { App } from "./app";
import type { NotesScope } from "./notes";

export type Publication = { hash: string; generation: number };

export class VersionSource {
  private lastCheck = -Infinity;
  private checking?: Promise<void>;

  constructor(private readonly env: Env) {}

  // Lazy KV checks on requests and application alarms; no background update polling.
  check(onLatest: (latest: unknown) => void | Promise<void>): Promise<void> {
    if (this.checking) return this.checking;
    if (Date.now() - this.lastCheck < Number(this.env.CHECK_INTERVAL_MS)) {
      return Promise.resolve();
    }
    this.lastCheck = Date.now();
    this.checking = this.env.VERSIONS.get("latest", "json")
      .catch((error: unknown) => {
        console.error("Version check failed; keeping current facet", error);
        return null;
      })
      .then(onLatest)
      .finally(() => {
        this.checking = undefined;
      });
    return this.checking;
  }
}

export async function loadApp(env: Env, hash: string, scope: NotesScope, preflight = false) {
  const readCode = async () => {
    const object = await env.CODE.get("code/" + hash + ".js");
    if (!object) throw new Error("Missing code " + hash);
    return object.text();
  };
  // Don't cache a failed R2 read in the loader: a later check must be able to retry.
  const code = preflight ? await readCode() : undefined;
  // Only code-level data belongs in the hash-shared loader environment.
  const worker = env.LOADER.get(hash, async () => ({
    compatibilityDate: "2026-10-12",
    mainModule: "app.js",
    modules: { "app.js": code ?? (await readCode()) },
    env: { HASH: hash },
    globalOutbound: null,
  }));
  if (preflight) {
    const response = await worker.getEntrypoint().fetch("https://facet.invalid/");
    if (response.status !== 204) throw new Error("Facet preflight failed: " + response.status);
    await response.body?.cancel();
  }
  return {
    class: worker.getDurableObjectClass<App>("App", {
      props: {
        notes: exports.ScopedNotes({ props: scope }),
        scheduler: exports.Scheduler({ props: { supervisorId: scope.supervisorId } }),
      },
    }),
  };
}
