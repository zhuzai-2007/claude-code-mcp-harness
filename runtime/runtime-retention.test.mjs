import assert from "node:assert/strict";
import path from "node:path";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { applyRuntimeRetention, planRuntimeRetention } from "./runtime-retention.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".agent-runs", `retention-test-${process.pid}-${Date.now()}`);
const artifacts = path.join(root, "artifacts");
const old = "2020-01-01T00:00:00.000Z";
const current = "2026-07-15T00:00:00.000Z";
async function fixture(directory, file, value) { await mkdir(directory, { recursive: true }); await writeFile(path.join(directory, file), JSON.stringify(value), "utf8"); }
try {
  await fixture(path.join(root, "workflows", "workflow_old"), "workflow.json", { workflowId: "workflow_old", status: "completed", createdAt: old, updatedAt: old, tasks: [{ taskId: "task_old" }] });
  await fixture(path.join(root, "workflows", "workflow_active"), "workflow.json", { workflowId: "workflow_active", status: "running", createdAt: old, updatedAt: current, tasks: [{ taskId: "task_active" }] });
  await fixture(path.join(root, "tasks", "task_old"), "task.json", { taskId: "task_old", workflowId: "workflow_old", status: "succeeded", createdAt: old, updatedAt: old, attempts: [{ attemptId: "20200101-000000-001" }] });
  await fixture(path.join(root, "tasks", "task_active"), "task.json", { taskId: "task_active", workflowId: "workflow_active", status: "running", createdAt: old, updatedAt: current, attempts: [] });
  await fixture(path.join(artifacts, "20200101-000000-001"), "result.json", { ok: true });
  await fixture(path.join(root, "supervisor-decisions"), "decision_old.json", { decisionId: "decision_old", status: "workflow_created", workflowId: "workflow_old", createdAt: old, updatedAt: old });
  const plan = await planRuntimeRetention({ dataRoot: root, artifactRoots: [artifacts], maxAgeDays: 30, maxWorkflows: 200, maxStandaloneTasks: 200, now: Date.parse(current) });
  assert.deepEqual(plan.expiredWorkflowIds, ["workflow_old"]);
  assert.deepEqual(plan.expiredTaskIds, ["task_old"]);
  assert.deepEqual(plan.expiredDecisionIds, ["decision_old"]);
  assert(!plan.directories.some((directory) => directory.includes("workflow_active")));
  const applied = await applyRuntimeRetention(plan);
  assert.equal(applied.removedPathCount, 4);
  const secondPlan = await planRuntimeRetention({ dataRoot: root, artifactRoots: [artifacts], maxAgeDays: 30, now: Date.parse(current) });
  assert.deepEqual(secondPlan.expiredWorkflowIds, []);
  console.log(JSON.stringify({ ok: true, removedPathCount: applied.removedPathCount, preserved: ["workflow_active", "task_active"] }, null, 2));
} finally {
  await rm(root, { recursive: true, force: true });
}
