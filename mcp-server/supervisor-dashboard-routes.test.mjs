import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { registerSupervisorDashboardRoutes } from "./supervisor-dashboard-routes.mjs";
import { refreshDelay } from "../workspace/supervisor-dashboard/refresh-policy.mjs";

const directory = path.dirname(fileURLToPath(import.meta.url));
const attemptId = "20260714-120000-001";
const task = {
  taskId: "task_dashboard_test", workflowId: "workflow_dashboard_test", role: "reviewer", mode: "review", status: "succeeded", currentStage: "succeeded",
  createdAt: "2026-07-14T12:00:00.000Z", updatedAt: "2026-07-14T12:01:00.000Z", settings: { resourceProfile: "review_readonly", resourceLimits: { maxBudgetUsd: 1.5 } }, prompt: "Review the current change",
  attempts: [{ attemptId, status: "succeeded", startedAt: "2026-07-14T12:00:10.000Z", completedAt: "2026-07-14T12:01:00.000Z", resourceProfile: "review_readonly", resourceLimits: { maxBudgetUsd: 1.5 } }]
};
const workflow = {
  workflowId: "workflow_dashboard_test", userRequest: "Add search", status: "completed", currentStage: "completed", nextAction: { type: "none" }, createdAt: task.createdAt, updatedAt: task.updatedAt, durationSeconds: 60,
  workflowPlan: { schemaVersion: 1, workflowType: "software_change", goal: "Add search", reason: "Software behavior must change.", constraints: ["Human approval required."], stages: ["planner", "approval", "coder", "reviewer"], selection: "supervisor_decision" },
  supervisorDecision: { decisionId: "decision_dashboard_test", intent: "code_change", goal: "Add search", project: { id: "board", name: "Task Board", path: "workspace/board" }, reasoning: ["Existing behavior must change."], workflowType: "software_change", confidence: 0.9, nextAction: "create_workflow", source: "gpt" },
  stages: [{ id: "planning", role: "planner", mode: "plan", resourceProfile: "small_readonly", status: "succeeded", taskId: task.taskId }, { id: "implementation", role: "coder", mode: "run", resourceProfile: "small_readonly", requiresApproval: true, status: "succeeded", taskId: task.taskId }, { id: "review", role: "reviewer", mode: "review", resourceProfile: "review_readonly", status: "succeeded", taskId: task.taskId }], approvals: { implementation: { approvedBy: "operator", approvalReason: "Approved bounded plan.", approvedAt: task.createdAt } },
  counts: { total: 1, succeeded: 1, running: 0, failed: 0 }, tasks: [{ taskId: task.taskId, role: "reviewer", mode: "review", status: "succeeded" }]
};
const events = [{ sequence: 1, type: "workflow.created", timestamp: task.createdAt, source: "workflow_runtime", payload: {} }, { sequence: 2, type: "task.completed", timestamp: task.updatedAt, source: "task_runtime", role: "reviewer", payload: {} }];
const calls = [];
const taskRuntime = {
  async listTasks(options) { calls.push(["listTasks", options]); return [task]; },
  async getTask(taskId) { calls.push(["getTask", taskId]); return taskId === task.taskId ? task : null; },
  async getTaskEvents(taskId, options) { calls.push(["taskEvents", taskId, options]); return taskId === task.taskId ? { taskId, events: events.slice(1), lastSequence: 1, hasMore: false } : null; }
};
const workflowRuntime = {
  async listWorkflows(options) { calls.push(["listWorkflows", options]); return [workflow]; },
  async createWorkflow(options) { calls.push(["createWorkflow", options]); return { ...workflow, workflowId: "workflow_created_test", userRequest: options.userRequest, tasks: [], counts: { total: 0, succeeded: 0, running: 0, failed: 0 }, status: "planning", currentStage: "planning" }; },
  async approveWorkflow(workflowId, approval) { calls.push(["approveWorkflow", workflowId, approval]); return { ...workflow, workflowId, tasks: [], counts: { total: 0, succeeded: 0, running: 0, failed: 0 }, status: "running", approvals: { implementation: { ...approval, approvedAt: task.createdAt } } }; },
  async rejectWorkflow(workflowId, rejection) { calls.push(["rejectWorkflow", workflowId, rejection]); return { ...workflow, workflowId, tasks: [], counts: { total: 0, succeeded: 0, running: 0, failed: 0 }, status: "failed", approvals: {}, failure: { error: { code: "approval_rejected", message: rejection.rejectionReason } }, rejections: { implementation: { ...rejection, rejectedAt: task.createdAt } } }; },
  async getWorkflow(workflowId) { calls.push(["getWorkflow", workflowId]); return [workflow.workflowId, "workflow_created_test", "workflow_waiting_test"].includes(workflowId) ? { ...workflow, workflowId } : null; },
  async getWorkflowEvents(workflowId, options) { calls.push(["workflowEvents", workflowId, options]); return workflowId === workflow.workflowId ? { workflowId, events, lastSequence: 2, hasMore: false } : null; }
};
const supervisorService = {
  async submitRequest(options) {
    calls.push(["submitRequest", options]);
    const created = await workflowRuntime.createWorkflow(options);
    return { status: "success", decision: workflow.supervisorDecision, workflow: created };
  },
  async listProjects() { calls.push(["listProjects"]); return [{ id: "board", name: "Task Board", path: "workspace/board", description: "Board", language: "JavaScript", lastUsed: null }]; },
  async getDecision(decisionId) { calls.push(["getDecision", decisionId]); return decisionId === "decision_dashboard_test" ? workflow.supervisorDecision : null; }
};
const taskRunner = {
  inspectAttempt(id) {
    assert.equal(id, attemptId);
    return { audit: { summary: "Review passed", files_read: ["app.js"], changes_made: [], commands_run: [], tests_or_checks: ["Read app.js"], risks: [], blocked_on: [], cost: 0.1, resource_usage: { turns: 7, filesRead: 1, commands: 0 } }, recentToolCalls: [{ tool: "Read", succeeded: true }], observedChanges: [{ file: "workspace/board/app.js", operation: "edit", addedLines: 1, removedLines: 1, diff: "--- a/app.js\n+++ b/app.js" }], artifactFiles: ["worker-result.normalized.json"] };
  },
  artifactPath(id, name) { return id === attemptId && name === "worker-result.normalized.json" ? path.join(directory, "package.json") : null; }
};

const app = express();
// Match the real MCP host, which has already consumed JSON request bodies
// before the Supervisor product routes are registered.
app.use(express.json());
registerSupervisorDashboardRoutes(app, { taskRuntime, workflowRuntime, supervisorService, taskRunner, dashboardRoot: path.resolve(directory, "..", "workspace", "supervisor-dashboard") });
const server = http.createServer(app);
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

try {
  const base = `http://127.0.0.1:${server.address().port}`;
  const workflowList = await fetch(`${base}/api/supervisor/workflows?status=completed&limit=10`);
  assert.equal(workflowList.status, 200);
  assert.equal((await workflowList.json()).workflows[0].workflowId, workflow.workflowId);

  const localHeaders = { "content-type": "application/json", origin: base };
  const projectsResponse = await fetch(`${base}/api/supervisor/projects`);
  assert.equal((await projectsResponse.json()).projects[0].id, "board");
  const createdResponse = await fetch(`${base}/api/supervisor/workflows`, { method: "POST", headers: localHeaders, body: JSON.stringify({ userRequest: "给任务看板增加导出 JSON 功能" }) });
  assert.equal(createdResponse.status, 201);
  const createdWorkflow = (await createdResponse.json()).workflow;
  assert.equal(createdWorkflow.userRequest, "给任务看板增加导出 JSON 功能");
  assert.equal(createdWorkflow.status, "planning");

  const approveResponse = await fetch(`${base}/api/supervisor/workflows/workflow_waiting_test/approve`, { method: "POST", headers: localHeaders, body: JSON.stringify({ approvedBy: "operator", approvalReason: "Approve the bounded beta change." }) });
  assert.equal(approveResponse.status, 200);
  assert.equal((await approveResponse.json()).workflow.status, "running");

  const rejectResponse = await fetch(`${base}/api/supervisor/workflows/workflow_waiting_test/reject`, { method: "POST", headers: localHeaders, body: JSON.stringify({ rejectedBy: "operator", rejectionReason: "Scope is too broad." }) });
  assert.equal(rejectResponse.status, 200);
  assert.equal((await rejectResponse.json()).workflow.product.approval.status, "rejected");

  const invalidCreate = await fetch(`${base}/api/supervisor/workflows`, { method: "POST", headers: localHeaders, body: JSON.stringify({ userRequest: "" }) });
  assert.equal(invalidCreate.status, 400);
  const remoteCreate = await fetch(`${base}/api/supervisor/workflows`, { method: "POST", headers: { "content-type": "application/json", origin: "https://chatgpt.com" }, body: JSON.stringify({ userRequest: "must not start" }) });
  assert.equal(remoteCreate.status, 403);
  const missingOriginCreate = await fetch(`${base}/api/supervisor/workflows`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ userRequest: "must not start" }) });
  assert.equal(missingOriginCreate.status, 403);

  const workflowDetail = await fetch(`${base}/api/supervisor/workflows/${workflow.workflowId}`);
  const detailedWorkflow = (await workflowDetail.json()).workflow;
  assert.equal(detailedWorkflow.status, "completed");
  assert.equal(detailedWorkflow.nextAction.type, "none");
  assert.equal(detailedWorkflow.workflowPlan.workflowType, "software_change");
  assert.deepEqual(detailedWorkflow.workflowPlan.stages, ["planner", "approval", "coder", "reviewer"]);
  assert.deepEqual(detailedWorkflow.stages.map((stage) => stage.role), ["planner", "coder", "reviewer"]);
  assert.equal(detailedWorkflow.approvals.implementation.approvedBy, "operator");
  assert.equal(detailedWorkflow.tasks[0].attempts[0].audit.cost, 0.1);
  assert.equal(detailedWorkflow.tasks[0].attempts[0].recentToolCalls[0].tool, "Read");
  assert.equal(detailedWorkflow.product.totalCostUsd, 0.1);
  assert.equal(detailedWorkflow.product.review.summary, "Review passed");
  assert.equal(detailedWorkflow.product.supervisorDecision.project.path, "workspace/board");
  assert(detailedWorkflow.product.executionPolicy.blocked.length >= 4);

  const workflowEvents = await fetch(`${base}/api/supervisor/workflows/${workflow.workflowId}/events?limit=20`);
  assert.deepEqual((await workflowEvents.json()).events.map((event) => event.type), ["workflow.created", "task.completed"]);

  const taskList = await fetch(`${base}/api/supervisor/tasks?status=succeeded&limit=10`);
  assert.equal((await taskList.json()).tasks[0].taskId, task.taskId);
  const taskDetail = await fetch(`${base}/api/supervisor/tasks/${task.taskId}`);
  assert.equal((await taskDetail.json()).task.attempts[0].audit.summary, "Review passed");

  const artifact = await fetch(`${base}/api/supervisor/tasks/${task.taskId}/artifacts/${attemptId}/worker-result.normalized.json`);
  assert.equal(artifact.status, 200);
  assert.match(await artifact.text(), /codex-claude-worker-mcp-bridge/);

  assert.equal((await fetch(`${base}/api/supervisor/workflows/workflow_missing`)).status, 404);
  assert.equal((await fetch(`${base}/api/supervisor/tasks/not-a-task`)).status, 400);
  const dashboard = await fetch(`${base}/supervisor/`);
  assert.equal(dashboard.status, 200);
  const dashboardHtml = await dashboard.text();
  for (const marker of ["new-task-form", "project-confirmation", "decision-panel", "decision-content", "approval-panel", "approval-title", "Approve and run", "Reject", "Execution policy", "Technical details"]) assert.match(dashboardHtml, new RegExp(marker));
  const dashboardScript = await fetch(`${base}/supervisor/app.js`);
  const dashboardSource = await dashboardScript.text();
  for (const marker of ["workflowType", "supervisorDecision", "technicalSummary", "estimatedResources", "recommendedActions", "project_confirmation_required", "Observed Diff", "Modified files", "Review result", "Risks and errors", "totalCostUsd", "totalUsage", "/approve", "/reject"]) assert.match(dashboardSource, new RegExp(marker));
  assert.equal((await fetch(`${base}/supervisor/refresh-policy.mjs`)).status, 200);
  assert.equal(refreshDelay(true), 1000, "Running work must refresh at least once per second");
  assert.equal(refreshDelay(false), 4000, "Idle refresh should back off to 3-5 seconds");
  assert(calls.every(([operation]) => ["listTasks", "getTask", "taskEvents", "listWorkflows", "createWorkflow", "approveWorkflow", "rejectWorkflow", "getWorkflow", "workflowEvents", "submitRequest", "listProjects", "getDecision"].includes(operation)));
  console.log(JSON.stringify({ ok: true, routes: ["workflow-create", "workflow-approve", "workflow-reject", "workflow-list", "workflow-detail", "workflow-events", "task-list", "task-detail", "artifact", "static"], refresh: { activeMs: refreshDelay(true), idleMs: refreshDelay(false) } }, null, 2));
} finally {
  await new Promise((resolve) => server.close(resolve));
}
