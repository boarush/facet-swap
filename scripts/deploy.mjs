import { writeFile } from "node:fs/promises";

// Alchemy watches this imported stack input; publication runs in its graph.
const version = process.argv[2] ?? "v1";
await writeFile(new URL("../facet-version.ts", import.meta.url),
  '// Facet version input.\nexport default ' + JSON.stringify(version) + ';\n');
console.log("Requested " + version + "; Alchemy dev will reconcile the stack.");
