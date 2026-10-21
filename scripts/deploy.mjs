import { build } from "esbuild";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

export const base = process.env.BASE_URL ?? "http://127.0.0.1:18743";
const url = new URL(base);
if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.protocol !== "http:") {
  throw new Error("Publication is restricted to local HTTP.");
}

async function bundleVersion(version) {
  const bundle = await build({
    entryPoints: ["src/app.ts"],
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    external: ["cloudflare:workers"],
    define: { VERSION: JSON.stringify(version) },
  });
  return bundle.outputFiles[0].text;
}

async function put(path, body) {
  const response = await fetch(base + path, { method: "PUT", body });
  if (!response.ok) throw new Error(await response.text());
  return response;
}

export async function deploy(version) {
  const code = await bundleVersion(version);
  const hash = createHash("sha256").update(code).digest("hex");

  // Upload to R2 before advancing KV: the published pointer must never dangle.
  const uploaded = await put("/__local/code", code);
  if ((await uploaded.json()).hash !== hash) throw new Error("Hash mismatch");
  await put("/__local/latest", hash);

  console.log("Published " + version + " " + hash);
  return hash;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await deploy(process.argv[2] ?? "v1");
}
