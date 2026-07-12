import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { diffSnapshots, hasUnexpectedSideEffects, snapshotTree } from "./side-effect-guard.mjs";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(moduleDirectory, "..", ".agent-runs", `side-effect-guard-test-${process.pid}-${Date.now()}`);

try {
  await mkdir(root, { recursive: true });
  const before = await snapshotTree(root);
  await mkdir(path.join(root, "declared"), { recursive: true });
  await writeFile(path.join(root, "declared", "result.txt"), "OK\n", "utf8");
  await mkdir(path.join(root, "Dagent_testing_fieldmulti_testoutbox"));
  const after = await snapshotTree(root);
  const diff = diffSnapshots(before, after, {
    allowedFiles: ["declared/result.txt"],
    allowedDirectories: ["declared"]
  });

  assert.equal(hasUnexpectedSideEffects(diff), true);
  assert.deepEqual(diff.newDirectories, ["Dagent_testing_fieldmulti_testoutbox"]);
  assert.deepEqual(diff.newFiles, []);
  console.log(JSON.stringify({ ok: true, detected: diff }, null, 2));
} finally {
  await rm(root, { recursive: true, force: true });
}
