import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const path = new URL("../facet-version.ts", import.meta.url);
const label = process.argv[2];
const source =
  label === undefined
    ? await readFile(path, "utf8")
    : "// Optional manual salt. Changing it forces a new bundle hash.\nexport default " +
      JSON.stringify(label) +
      ";\n";
// Alchemy watches stack imports, not the facet's separately bundled source.
// Changing only a comment requests evaluation without changing the bundled salt.
const trigger = "// Stack reconciliation trigger: " + randomUUID() + "\n";
await writeFile(
  path,
  /^\/\/ Stack reconciliation trigger:.*\n?/m.test(source)
    ? source.replace(/^\/\/ Stack reconciliation trigger:.*\n?/m, trigger)
    : source + (source.endsWith("\n") ? "" : "\n") + trigger,
);
console.log("Requested stack reconciliation. Wait for Alchemy dev to finish.");
