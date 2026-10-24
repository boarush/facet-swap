import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";

const label = process.argv[2];
if (label !== undefined) {
  await writeFile(
    new URL("../facet-version.ts", import.meta.url),
    "// Optional manual salt. Changing it forces a new bundle hash.\nexport default " +
      JSON.stringify(label) +
      ";\n",
  );
}
// Alchemy watches stack imports, not the facet's separately bundled source.
// A separate trigger requests evaluation without modifying the optional salt.
await writeFile(
  new URL("../infra/reconcile.ts", import.meta.url),
  "// Stack reconciliation trigger: " + randomUUID() + "\nexport {};\n",
);
console.log("Requested stack reconciliation. Wait for Alchemy dev to finish.");
