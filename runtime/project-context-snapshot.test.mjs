import assert from "node:assert/strict";
import path from "node:path";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createProjectContextSnapshot, writeAttemptProjectContextSnapshot } from "./project-context-snapshot.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = path.join(repoRoot, ".agent-runs", `project-context-snapshot-test-${process.pid}-${Date.now()}`);
const emptyWorkspace = path.join(root, "workspace", "empty-project");
const normalWorkspace = path.join(root, "workspace", "normal-project");

try {
  await mkdir(emptyWorkspace, { recursive: true });
  await mkdir(path.join(normalWorkspace, "src"), { recursive: true });
  await writeFile(path.join(normalWorkspace, "index.html"), "<!doctype html>\n", "utf8");
  await writeFile(path.join(normalWorkspace, "src", "app.js"), "export {};\n", "utf8");

  const empty = createProjectContextSnapshot({ projectRoot: root, workspacePath: emptyWorkspace, generatedAt: "2026-07-19T00:00:00.000Z" });
  assert.equal(empty.empty, true);
  assert.deepEqual(empty.entries, []);
  assert.equal(empty.generatedAt, "2026-07-19T00:00:00.000Z");
  assert.equal(empty.projectRoot, emptyWorkspace.replaceAll("\\", "/"));
  assert.deepEqual(await readdir(emptyWorkspace), [], "Snapshot generation modified the empty user project");

  const normal = createProjectContextSnapshot({ projectRoot: root, workspacePath: normalWorkspace });
  assert.equal(normal.empty, false);
  assert.deepEqual(normal.entries, [
    { path: "index.html", type: "file" },
    { path: "src", type: "directory" },
    { path: "src/app.js", type: "file" }
  ]);

  const persisted = writeAttemptProjectContextSnapshot({ projectRoot: root, workspacePath: emptyWorkspace, attemptId: "20260719-210000-001" });
  const parsed = JSON.parse(await readFile(persisted.filePath, "utf8"));
  assert.equal(parsed.empty, true);
  assert.deepEqual(parsed.entries, []);
  assert.match(persisted.filePath.replaceAll("\\", "/"), /\.agent-runs\/context-snapshots\/20260719-210000-001\.json$/);

  assert.throws(
    () => createProjectContextSnapshot({ projectRoot: root, workspacePath: path.dirname(root) }),
    /must stay inside/i
  );

  console.log(JSON.stringify({ ok: true, empty, normalEntries: normal.entries }, null, 2));
} finally {
  await rm(root, { recursive: true, force: true });
}
