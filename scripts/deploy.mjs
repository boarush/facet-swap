import { writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

const base = new URL(process.env.BASE_URL ?? "http://127.0.0.1:18743");
if (base.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(base.hostname)) {
  throw new Error("Publication status must use local HTTP");
}
const version = process.argv[2] ?? "v1";
// Alchemy watches this imported stack input; publication runs in its graph.
await writeFile(new URL("../facet-version.ts", import.meta.url),
  '// Facet version input.\nexport default ' + JSON.stringify(version) + ';\n');
for (const deadline = Date.now() + 30000; Date.now() < deadline; await delay(100)) {
  try {
    const response = await fetch(new URL("/__local/publication", base), { signal: AbortSignal.timeout(1000) });
    if (!response.ok) continue;
    const result = await response.json();
    if (result.metadata?.version === version) {
      console.log("Published " + version + " " + result.hash);
      process.exit(0);
    }
  } catch {}
}
throw new Error("Publication timed out. Is Alchemy dev running? Check its output.");
