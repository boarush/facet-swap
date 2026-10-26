import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { test } from "vitest";

const exec = promisify(execFile);

test("deploy changes its nonce while preserving the salt unless a label is supplied", async () => {
  const root = await mkdtemp(join(tmpdir(), "facet-deploy-"));
  try {
    await mkdir(join(root, "scripts"));
    const cli = join(root, "scripts/deploy.ts");
    await copyFile(new URL("../scripts/deploy.ts", import.meta.url), cli);
    const salt = join(root, "facet-version.ts");
    const original = '// Preserve my optional label and comments.\nexport default "custom";\n';
    await writeFile(salt, original);
    await exec(process.execPath, [cli]);
    const readSalt = async () =>
      (await import(salt + "?nonce=" + crypto.randomUUID())).default as string;
    const withoutTrigger = (source: string) =>
      source.replace(/^\/\/ Stack reconciliation trigger:.*\n?/m, "");
    const first = await readFile(salt, "utf8");
    assert.equal(await readSalt(), "custom");
    assert.equal(withoutTrigger(first), original);
    assert.match(first, /^\/\/ Stack reconciliation trigger: .+$/m);
    await exec(process.execPath, [cli]);
    const second = await readFile(salt, "utf8");
    assert.equal(await readSalt(), "custom");
    assert.equal(withoutTrigger(second), original);
    assert.notEqual(second, first);
    const label = 'manual "salt"\nnext line';
    await exec(process.execPath, [cli, label]);
    const labelled = await readFile(salt, "utf8");
    assert(labelled.includes("export default " + JSON.stringify(label) + ";"));
    await exec(process.execPath, [cli]);
    assert.equal(await readSalt(), label);
    const repeated = await readFile(salt, "utf8");
    assert.equal(withoutTrigger(repeated), withoutTrigger(labelled));
    assert.notEqual(repeated, labelled);
    await exec(process.execPath, [cli, ""]);
    assert.equal(await readSalt(), "");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
