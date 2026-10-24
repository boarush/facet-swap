import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import * as Bundle from "alchemy/Bundle";
import * as Effect from "effect/Effect";

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
        return Effect.fn(function* (input: { code: string; hash: string }) {
          const object = yield* r2.put("code/" + input.hash + ".js", input.code);
          if (!object) throw new Error("Facet upload did not return an object");
          return { hash: input.hash, uploaded: object.uploaded.toISOString() };
        });
      }).pipe(Effect.provide(Cloudflare.R2.WriteBucketLocal)),
    );
    const uploaded = yield* Upload({ code: bundle.code, hash: bundle.hash });
    const Publish = Alchemy.Action(
      "FacetLatest",
      Effect.gen(function* () {
        const kv = yield* Cloudflare.KV.WriteNamespace(namespace);
        return Effect.fn(function* (input: { hash: string; version: string }) {
          const publication = crypto.randomUUID();
          yield* kv.put("latest", input.hash, {
            metadata: { publication, version: input.version },
          });
          return { hash: input.hash, publication };
        });
      }).pipe(Effect.provide(Cloudflare.KV.WriteNamespaceLocal)),
    );
    // An output edge ensures KV advances only after the upload succeeds.
    return yield* Publish({ hash: uploaded.hash, version: bundle.version });
  });
