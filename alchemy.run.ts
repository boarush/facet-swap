import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import * as Bundle from "alchemy/Bundle";
import { toFqn } from "alchemy/FQN";
import { CurrentNamespace } from "alchemy/Namespace";
import { isActionState, State } from "alchemy/State";
import * as Effect from "effect/Effect";

import type { Notes } from "./src/gateway";
import type { Supervisor } from "./src/supervisor";

import version from "./facet-version";

export const bundleFacet = (version: string) =>
  Bundle.build(
    {
      input: "src/app.ts",
      platform: "neutral",
      external: ["cloudflare:workers"],
      transform: { target: "es2022", define: { VERSION: JSON.stringify(version) } },
    },
    { format: "esm", codeSplitting: false },
  ).pipe(
    Effect.map((bundle) => {
      const file = bundle.files[0];
      if (bundle.files.length !== 1 || typeof file.content !== "string") {
        throw new Error("A facet must be a single JavaScript module");
      }
      // The loader verifies the module bytes, not Alchemy's aggregate bundle hash.
      return { code: file.content, hash: file.hash, version };
    }),
    Effect.orDie,
  );

export const publishFacet = (
  bucket: Cloudflare.R2.Bucket,
  namespace: Cloudflare.KV.Namespace,
  bundle: { code: string; hash: string; version: string },
) =>
  Effect.gen(function* () {
    const Upload = Alchemy.Action(
      "FacetCode",
      Effect.gen(function* () {
        const r2 = yield* Cloudflare.R2.WriteBucket(bucket);
        // Code comes from the closure: Action input is persisted and diffed, so it carries
        // only the content hash and the bundle never lands in stack state.
        return Effect.fn(function* (input: { hash: string }) {
          const object = yield* r2.put("code/" + input.hash + ".js", bundle.code);
          if (!object) throw new Error("Facet upload did not return an object");
          return { hash: input.hash, uploaded: object.uploaded.toISOString() };
        });
      }).pipe(Effect.provide(Cloudflare.R2.WriteBucketLocal)),
    );
    const uploaded = yield* Upload({ hash: bundle.hash });
    const stack = yield* Alchemy.Stack;
    // Capture before apply replaces the Action's saved output with its running state.
    const key = {
      stack: stack.name,
      stage: stack.stage,
      fqn: toFqn(yield* CurrentNamespace, "FacetLatest"),
    };
    // State is installed by Stack.make but omitted from its public StackServices type.
    const state = yield* Effect.serviceOption(State);
    if (state._tag === "None") throw new Error("Publication requires the stack state store");
    const store = yield* state.value;
    const previous = yield* store.get(key).pipe(Effect.orDie);
    const output =
      isActionState(previous) && previous.status === "ran"
        ? (previous.output as { generation?: number })
        : undefined;
    const Publish = Alchemy.Action(
      "FacetLatest",
      Effect.gen(function* () {
        const kv = yield* Cloudflare.KV.WriteNamespace(namespace);
        return Effect.fn(function* (input: { hash: string; version: string }) {
          const publication = crypto.randomUUID();
          const generation = Math.max(Date.now(), (output?.generation ?? 0) + 1);
          yield* kv.put("latest", JSON.stringify({ hash: input.hash, generation }), {
            metadata: { publication, version: input.version },
          });
          return { hash: input.hash, generation, publication };
        });
      }).pipe(Effect.provide(Cloudflare.KV.WriteNamespaceLocal)),
    );
    // An output edge ensures KV advances only after the upload succeeds.
    return yield* Publish({ hash: uploaded.hash, version: bundle.version });
  });

// Fail at evaluation: Number("") or a typo would silently become 0 or NaN at runtime,
// and a NaN deadline force-swaps instantly. setTimeout caps delays at 2^31 - 1.
const milliseconds = (name: string, fallback: string) => {
  const raw = process.env[name] ?? fallback;
  if (!/^\d+$/.test(raw) || Number(raw) > 2 ** 31 - 1) {
    throw new Error(name + " must be a whole number of milliseconds, got " + JSON.stringify(raw));
  }
  return raw;
};

export const gatewayWorker = (gatewayRevision = "g1") =>
  Effect.gen(function* () {
    const notes = yield* Cloudflare.R2.Bucket("Notes");
    return yield* Cloudflare.Worker("Gateway", {
      main: "./src/gateway.ts",
      compatibility: { date: "2026-10-12", flags: ["no_nodejs_compat"] },
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
      compatibility: { date: "2026-10-12", flags: ["no_nodejs_compat", "enable_ctx_exports"] },
      env: {
        GATEWAY: Cloudflare.WorkerEntrypoint<Notes>(gateway, "Notes"),
        CODE: code,
        VERSIONS: versions,
        LOADER: Cloudflare.WorkerLoader(),
        SUPERVISORS: Cloudflare.DurableObject<Supervisor>("Supervisor"),
        CHECK_INTERVAL_MS: milliseconds("CHECK_INTERVAL_MS", "10000"),
        DRAIN_DEADLINE_MS: milliseconds("DRAIN_DEADLINE_MS", "30000"),
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
