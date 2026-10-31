import { exports } from "cloudflare:workers";

import type { Env } from "../alchemy.run";

import type { App } from "./app";
import type { NotesScope } from "./notes";

export type Publication = { hash: string; generation: number };

export async function loadApp(
  env: Env,
  hash: string,
  scope: NotesScope,
  facet: string,
  preflight = false,
) {
  const readCode = async () => {
    const object = await env.CODE.get("code/" + hash + ".js");
    if (!object) throw new Error("Missing code " + hash);
    return object.text();
  };
  // Don't cache a failed R2 read in the loader: a later check must be able to retry.
  const code = preflight ? await readCode() : undefined;
  // Production rejects stub-valued DO class props. Trusted facets assert their own identity.
  const worker = env.LOADER.get(hash, async () => ({
    compatibilityDate: "2026-10-12",
    mainModule: "app.js",
    modules: { "app.js": code ?? (await readCode()) },
    env: {
      HASH: hash,
      CHECK_INTERVAL_MS: env.CHECK_INTERVAL_MS,
      VERSIONS: exports.Versions({ props: {} }),
      SWAP: exports.Swap({ props: {} }),
      NOTES: exports.ScopedNotes({ props: {} }),
      SCHEDULER: exports.Scheduler({ props: {} }),
    },
    globalOutbound: null,
  }));
  if (preflight) {
    const response = await worker.getEntrypoint().fetch("https://facet.invalid/");
    if (response.status !== 204) throw new Error("Facet preflight failed: " + response.status);
    await response.body?.cancel();
  }
  return {
    class: worker.getDurableObjectClass<App>("App", {
      props: { ...scope, facet },
    }),
  };
}
