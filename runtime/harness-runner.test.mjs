import assert from "node:assert/strict";
import path from "node:path";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { HarnessRunner } from "./harness-runner.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".agent-runs", `harness-runner-test-${process.pid}-${Date.now()}`);
const attemptId = "20260715-120000-001";
const runDir = path.join(root, ".agents", "runs", attemptId);
try {
  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(runDir, "worker-result.normalized.json"), JSON.stringify({ status: "success", changes_made: [path.join(root, "workspace", "app.js")] }), "utf8");
  await writeFile(path.join(runDir, "tool-events.json"), JSON.stringify({ tool_calls: [{ tool: "Edit", succeeded: true, denied: false, input: { file_path: path.join(root, "workspace", "app.js"), old_string: "old", new_string: "new\nline", replace_all: false } }, { tool: "Read", succeeded: true, input: { file_path: path.join(root, "workspace", "app.js") } }] }), "utf8");
  await writeFile(path.join(runDir, "project-context-snapshot.json"), JSON.stringify({ projectRoot: path.join(root, "workspace"), entries: [], empty: true, generatedAt: new Date().toISOString() }), "utf8");
  await writeFile(path.join(runDir, "capability-diagnostics.json"), JSON.stringify({ initObserved: true, mismatch: true, missingAllowedTools: ["Glob"] }), "utf8");
  const inspected = new HarnessRunner({ projectRoot: root }).inspectAttempt(attemptId);
  assert.equal(inspected.observedChanges.length, 1);
  assert.equal(inspected.observedChanges[0].file, "workspace/app.js");
  assert.equal(inspected.observedChanges[0].addedLines, 2);
  assert.match(inspected.observedChanges[0].diff, /-old\n\+new\n\+line/);
  assert.equal(inspected.recentToolCalls.length, 2);
  assert(inspected.artifactFiles.includes("project-context-snapshot.json"));
  assert(inspected.artifactFiles.includes("capability-diagnostics.json"));
  assert.equal(path.basename(new HarnessRunner({ projectRoot: root }).artifactPath(attemptId, "project-context-snapshot.json")), "project-context-snapshot.json");
  const emptyWorkspace = path.join(root, "workspace", "empty");
  await mkdir(emptyWorkspace, { recursive: true });
  const prepared = new HarnessRunner({ projectRoot: root }).prepareAttemptContext({ attemptId: "20260715-120000-002", mode: "plan", projectContext: { workspacePath: emptyWorkspace } });
  assert.equal(prepared.metadata.empty, true);
  assert.equal(prepared.metadata.entryCount, 0);
  await rm(prepared.projectContextSnapshot.filePath, { force: true });
  console.log(JSON.stringify({ ok: true, observedChanges: inspected.observedChanges }, null, 2));
} finally {
  await rm(root, { recursive: true, force: true });
}
