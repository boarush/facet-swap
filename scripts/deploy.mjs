import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";

// Even the same label triggers a fresh plan, so source-only edits get bundled.
const version = process.argv[2] ?? "v1";
await writeFile(new URL("../facet-version.ts", import.meta.url),
  '// Facet version input. Reconcile ' + randomUUID() + '\nexport default ' + JSON.stringify(version) + ';\n');
console.log("Requested " + version + ". Wait for Alchemy dev to finish reconciling.");
