import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "vitest";

const exec = promisify(execFile);

test("deploy reconciles without touching the salt unless a label is supplied", async () => {
  const root = await mkdtemp(join(tmpdir(), "facet-deploy-"));
  try {
    await mkdir(join(root, "scripts"));
    await mkdir(join(root, "infra"));
    const cli = join(root, "scripts/deploy.mjs");
    await copyFile(new URL("../scripts/deploy.mjs", import.meta.url), cli);
    const salt = join(root, "facet-version.ts");
    const original = '// Preserve my optional label and comments.\nexport default "custom";\n';
    await writeFile(salt, original);
    await exec(process.execPath, [cli]);
    assert.equal(await readFile(salt, "utf8"), original);
    const trigger = await readFile(join(root, "infra/reconcile.ts"), "utf8");
    await exec(process.execPath, [cli]);
    assert.equal(await readFile(salt, "utf8"), original);
    assert.notEqual(await readFile(join(root, "infra/reconcile.ts"), "utf8"), trigger);
    const label = 'manual "salt"\nnext line';
    await exec(process.execPath, [cli, label]);
    const labelled = await readFile(salt, "utf8");
    assert(labelled.includes("export default " + JSON.stringify(label) + ";"));
    await exec(process.execPath, [cli]);
    assert.equal(await readFile(salt, "utf8"), labelled);
    await exec(process.execPath, [cli, ""]);
    assert((await readFile(salt, "utf8")).includes('export default "";'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
