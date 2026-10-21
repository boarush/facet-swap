import * as Alchemy from "alchemy";
import { AlchemyContext } from "alchemy/AlchemyContext";
import * as Cloudflare from "alchemy/Cloudflare";
import type { InferEnv } from "alchemy/Cloudflare";
import { localState } from "alchemy/State";
import * as Effect from "effect/Effect";
import type { Supervisor } from "./src/supervisor";
import { bundleFacet, publishFacet } from "./infra/facet";
import version from "./facet-version";

export const resources = (version: string) => Effect.gen(function* () {
  if (!(yield* AlchemyContext).dev) throw new Error("Local-only. Use npm run dev.");
  const code = yield* Cloudflare.R2.Bucket("Code");
  const versions = yield* Cloudflare.KV.Namespace("Versions");
  const bundle = yield* bundleFacet(version);
  const published = yield* publishFacet(code, versions, bundle);
  const api = yield* Cloudflare.Worker("Api", {
    main: "./src/worker.ts",
    compatibility: { date: "2026-10-21", flags: ["no_nodejs_compat"] },
    env: {
      CODE: code,
      VERSIONS: versions,
      LOADER: Cloudflare.WorkerLoader(),
      SUPERVISORS: Cloudflare.DurableObject<Supervisor>("Supervisor"),
      CHECK_INTERVAL_MS: process.env.CHECK_INTERVAL_MS ?? "10000",
    },
    dev: { host: "127.0.0.1", port: Number(process.env.PORT ?? 18743), strictPort: true },
  });
  return { api, published };
});

export const worker = resources(version).pipe(Effect.map(result => result.api));

// Bindings typed straight from the stack, so src never hand-writes them.
export type Env = InferEnv<typeof worker>;

export default Alchemy.Stack("FacetSwap", {
  providers: Cloudflare.providers(),
  state: localState(),
}, worker.pipe(Effect.map(worker => ({ url: worker.url }))));
