import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

import { bundleFacet, publishFacet } from "./infra/facet";
import type { Notes } from "./src/gateway";
import type { Supervisor } from "./src/supervisor";

import version from "./facet-version";
import "./infra/reconcile";

export const gatewayWorker = (gatewayRevision = "g1") =>
  Effect.gen(function* () {
    const notes = yield* Cloudflare.R2.Bucket("Notes");
    return yield* Cloudflare.Worker("Gateway", {
      main: "./src/gateway.ts",
      compatibility: { date: "2026-10-21", flags: ["no_nodejs_compat"] },
      env: { NOTES: notes, REVISION: gatewayRevision },
      dev: { host: "127.0.0.1" },
    });
  });

export const resources = (label = version, gatewayRevision = "g1") =>
  Effect.gen(function* () {
    if (!(yield* Alchemy.AlchemyContext).dev) throw new Error("Local-only. Use npm run dev.");

    const code = yield* Cloudflare.R2.Bucket("Code");
    const versions = yield* Cloudflare.KV.Namespace("Versions");

    const bundle = yield* bundleFacet(label);
    const published = yield* publishFacet(code, versions, bundle);
    const gateway = yield* gatewayWorker(gatewayRevision);

    const api = yield* Cloudflare.Worker("Api", {
      main: "./src/worker.ts",
      compatibility: { date: "2026-10-21", flags: ["no_nodejs_compat", "enable_ctx_exports"] },
      env: {
        GATEWAY: Cloudflare.WorkerEntrypoint<Notes>(gateway, "Notes"),
        CODE: code,
        VERSIONS: versions,
        LOADER: Cloudflare.WorkerLoader(),
        SUPERVISORS: Cloudflare.DurableObject<Supervisor>("Supervisor"),
        CHECK_INTERVAL_MS: process.env.CHECK_INTERVAL_MS ?? "10000",
        DRAIN_DEADLINE_MS: process.env.DRAIN_DEADLINE_MS ?? "30000",
      },
      dev: { host: "127.0.0.1", port: Number(process.env.PORT ?? 18743), strictPort: true },
    });

    return { api, gateway, published };
  });

export const worker = resources(version).pipe(Effect.map((result) => result.api));

// Bindings typed straight from the stack, so src never hand-writes them.
export type GatewayEnv = Cloudflare.InferEnv<ReturnType<typeof gatewayWorker>>;
export type Env = Cloudflare.InferEnv<typeof worker>;

export default Alchemy.Stack(
  "FacetSwap",
  {
    providers: Cloudflare.providers(),
    state: Alchemy.localState(),
  },
  worker.pipe(Effect.map((worker) => ({ url: worker.url }))),
);
