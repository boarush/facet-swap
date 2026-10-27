import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import * as Bundle from "alchemy/Bundle";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { Notes } from "./src/gateway";
import type { Supervisor } from "./src/supervisor";

import version from "./facet-version";

export const bundleFacet = Effect.fn("bundleFacet")(function* (version: string) {
  const bundle = yield* Bundle.build(
    {
      input: "src/app.ts",
      platform: "neutral",
      external: ["cloudflare:workers"],
      transform: { target: "es2024", define: { VERSION: JSON.stringify(version) } },
    },
    { format: "esm", codeSplitting: false },
  );
  const file = bundle.files[0];
  if (bundle.files.length !== 1 || typeof file.content !== "string") {
    throw new Error("A facet must be a single JavaScript module");
  }
  // Address the module bytes, not Alchemy's aggregate bundle hash. Supervisors trust
  // code/<hash>.js as published here; integrity rests on the private bucket.
  return { code: file.content, hash: file.hash, version };
}, Effect.orDie);

export const publishFacet = Effect.fn("publishFacet")(function* (
  bucket: Cloudflare.R2.Bucket,
  namespace: Cloudflare.KV.Namespace,
  bundle: { code: string; hash: string; version: string },
) {
  const Upload = Alchemy.Action(
    "FacetCode",
    Effect.gen(function* () {
      const r2 = yield* Cloudflare.R2.WriteBucket(bucket);
      // Code comes from the closure: Action input is persisted and diffed, so it carries
      // only the content hash and the bundle never lands in stack state.
      return Effect.fn(function* (input: { hash: string }) {
        const object = yield* r2.put("code/" + input.hash + ".js", bundle.code);
        if (!object) throw new Error("Facet upload did not return an object");
        return { hash: input.hash };
      });
    }).pipe(Effect.provide(Cloudflare.R2.WriteBucketLocal)),
  );
  const uploaded = yield* Upload({ hash: bundle.hash });
  const Publish = Alchemy.Action(
    "FacetLatest",
    Effect.gen(function* () {
      const kv = yield* Cloudflare.KV.ReadWriteNamespace(namespace);
      return Effect.fn(function* (input: { hash: string; version: string }) {
        const publication = crypto.randomUUID();
        // KV holds the high-water mark: Action output is dropped while a run is in flight,
        // so an interrupted publish would otherwise forget it.
        const previous = yield* kv.get<{ generation?: number }>("latest", "json");
        const generation = Math.max(Date.now(), (previous?.generation ?? 0) + 1);
        yield* kv.put("latest", JSON.stringify({ hash: input.hash, generation }), {
          metadata: { publication, version: input.version },
        });
        return { hash: input.hash, generation, publication };
      });
    }).pipe(Effect.provide(Cloudflare.KV.ReadWriteNamespaceLocal)),
  );
  // An output edge ensures KV advances only after the upload succeeds.
  return yield* Publish({ hash: uploaded.hash, version: bundle.version });
});

// Fail at evaluation: Number("") or a typo would silently become 0 or NaN at runtime,
// and a NaN deadline force-swaps instantly. setTimeout caps delays at 2^31 - 1.
export const milliseconds = Effect.fn("milliseconds")(function* (name: string, fallback: string) {
  const config = Config.schema(
    Schema.String.check(
      Schema.makeFilter((raw) =>
        /^\d+$/.test(raw) && Number(raw) <= 2 ** 31 - 1
          ? undefined
          : name + " must be a whole number of milliseconds, got " + JSON.stringify(raw),
      ),
    ),
    name,
  ).pipe(Config.withDefault(fallback));
  // The default provider treats an empty string as missing; here it must fail validation.
  return yield* config.parse(ConfigProvider.fromEnv({ preserveEmptyStrings: true }));
});

export const gatewayWorker = Effect.fn("gatewayWorker")(function* (gatewayRevision: string = "g1") {
  const notes = yield* Cloudflare.R2.Bucket("Notes");
  return yield* Cloudflare.Worker("Gateway", {
    main: "./src/gateway.ts",
    compatibility: { date: "2026-10-12", flags: ["no_nodejs_compat"] },
    env: { NOTES: notes, REVISION: gatewayRevision },
    dev: { host: "127.0.0.1" },
  });
});

export const resources = Effect.fn("resources")(function* (
  label = version,
  gatewayRevision = "g1",
) {
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
      CHECK_INTERVAL_MS: yield* milliseconds("CHECK_INTERVAL_MS", "10000"),
      DRAIN_DEADLINE_MS: yield* milliseconds("DRAIN_DEADLINE_MS", "30000"),
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
