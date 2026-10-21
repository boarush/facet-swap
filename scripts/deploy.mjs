import { build } from "esbuild";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
export const base = process.env.BASE_URL ?? "http://127.0.0.1:18743";
const url = new URL(base);
if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.protocol !== "http:") {
  throw new Error("Publication is restricted to local HTTP.");
}
export async function deploy(version) {
  const bundle = await build({
    entryPoints: ["src/app.ts"], bundle: true, write: false, format: "esm",
    platform: "neutral", target: "es2022", external: ["cloudflare:workers"],
    define: { VERSION: JSON.stringify(version) },
  });
  const code = bundle.outputFiles[0].text;
  const hash = createHash("sha256").update(code).digest("hex");
  const uploaded = await fetch(base + "/__local/code", { method: "PUT", body: code });
  if (!uploaded.ok) throw new Error(await uploaded.text());
  if ((await uploaded.json()).hash !== hash) throw new Error("Hash mismatch");
  const published = await fetch(base + "/__local/latest", { method: "PUT", body: hash });
  if (!published.ok) throw new Error(await published.text());
  console.log("Published " + version + " " + hash);
  return hash;
}
if (import.meta.url === pathToFileURL(process.argv[1]).href) await deploy(process.argv[2] ?? "v1");
