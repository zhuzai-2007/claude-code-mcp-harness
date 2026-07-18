import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { registerSupervisorDashboardRoutes } from "./supervisor-dashboard-routes.mjs";
import { WorkflowMetadataStore } from "./workflow-metadata-store.mjs";
import { refreshDelay } from "../workspace/supervisor-dashboard/refresh-policy.mjs";

const directory = path.dirname(fileURLToPath(import.meta.url));
const metadataDataRoot = await mkdtemp(path.resolve(directory, "..", ".agent-runs", "dashboard-metadata-test-"));
const workflowMetadataStore = new WorkflowMetadataStore(metadataDataRoot);
await workflowMetadataStore.init();
const attemptId = "20260714-120000-001";
const task = {
  taskId: "task_dashboard_test", workflowId: "workflow_dashboard_test", role: "reviewer", mode: "review", status: "succeeded", currentStage: "succeeded",
  createdAt: "2026-07-14T12:00:00.000Z", updatedAt: "2026-07-14T12:01:00.000Z", settings: { resourceProfile: "review_readonly", resourceLimits: { maxBudgetUsd: 1.5 } }, prompt: "Review the current change",
  attempts: [{ attemptId, status: "succeeded", startedAt: "2026-07-14T12:00:10.000Z", completedAt: "2026-07-14T12:01:00.000Z", resourceProfile: "review_readonly", resourceLimits: { maxBudgetUsd: 1.5 } }]
};
const workflow = {
  workflowId: "workflow_dashboard_test", userRequest: "Add search", status: "completed", currentStage: "completed", nextAction: { type: "none" }, createdAt: task.createdAt, updatedAt: task.updatedAt, durationSeconds: 60,
  projectId: "board", workspacePath: "D:/registered/workspace/board", sessionId: "session_board_test", session: { sessionId: "session_board_test", projectId: "board", name: "Board search", workflowIds: ["workflow_dashboard_test"], updatedAt: task.updatedAt },
  workflowPlan: { schemaVersion: 1, workflowType: "software_change", goal: "Add search", reason: "Software behavior must change.", constraints: ["Human approval required."], stages: ["planner", "approval", "coder", "reviewer"], selection: "supervisor_decision" },
  supervisorDecision: { decisionId: "decision_dashboard_test", intent: "code_change", goal: "Add search", projectId: "board", workspacePath: "D:/registered/workspace/board", project: { projectId: "board", id: "board", name: "Task Board", workspacePath: "D:/registered/workspace/board", path: "workspace/board" }, reasoning: ["Existing behavior must change."], workflowType: "software_change", confidence: 0.9, nextAction: "create_workflow", source: "gpt" },
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
  async retryWorkflow(workflowId, recovery) { calls.push(["retryWorkflow", workflowId, recovery]); return { sourceWorkflow: { ...workflow, workflowId, status: "failed", orchestrated: true, failure: { failedStage: "planning", role: "planner", error: { code: "worker_crash", message: "ConnectionRefused" } }, recoveries: [{ workflowId: "workflow_recovered_test" }] }, workflow: { ...workflow, workflowId: "workflow_recovered_test", status: "planning", approvals: {}, rejections: {}, recovery: { sourceWorkflowId: workflowId }, tasks: [], counts: { total: 0, succeeded: 0, running: 0, failed: 0 } } }; },
  async getWorkflow(workflowId) { calls.push(["getWorkflow", workflowId]); return [workflow.workflowId, "workflow_created_test", "workflow_waiting_test"].includes(workflowId) ? { ...workflow, workflowId } : null; },
  async getWorkflowEvents(workflowId, options) { calls.push(["workflowEvents", workflowId, options]); return workflowId === workflow.workflowId ? { workflowId, events, lastSequence: 2, hasMore: false } : null; }
};
const providerPreflight = {
  latest: null,
  next: { status: "ok", classification: "reachable", safety: { projectContentSent: false, toolsEnabled: false, modificationsAllowed: false } },
  async getLatest() { calls.push(["getPreflight"]); return this.latest; },
  async run(options) { calls.push(["runPreflight", options]); this.latest = this.next; return this.latest; }
};
const supervisorService = {
  async submitRequest(options) {
    calls.push(["submitRequest", options]);
    const created = await workflowRuntime.createWorkflow(options);
    return { status: "success", decision: workflow.supervisorDecision, workflow: created };
  },
  async listProjects() { calls.push(["listProjects"]); return [{ projectId: "board", id: "board", name: "Task Board", workspacePath: "D:/registered/workspace/board", path: "workspace/board", description: "Board", language: "JavaScript", memory: { available: true, lastUpdated: task.updatedAt }, lastUsed: null }]; },
  async listProjectViews() { calls.push(["listProjectViews"]); return [{ projectId: "board", id: "board", name: "Task Board", workspacePath: "D:/registered/workspace/board", path: "workspace/board", memory: { available: true, lastUpdated: task.updatedAt }, sessionCount: 1, workflowCount: 1, sessions: [workflow.session], recentWorkflows: [{ workflowId: workflow.workflowId, sessionId: workflow.sessionId, userRequest: workflow.userRequest, status: workflow.status, updatedAt: workflow.updatedAt }] }]; },
  async getProjectContext(projectId) { calls.push(["getProjectContext", projectId]); if (projectId !== "board") throw new Error("Unknown registered project"); return { project: { projectId: "board", name: "Task Board", workspacePath: "D:/registered/workspace/board" }, supervisorInstructions: "Board instructions", projectMemory: "Board memory", memory: { available: true, lastUpdated: task.updatedAt }, sessions: [workflow.session] }; },
  async getProjectContinuity(projectId) { calls.push(["getProjectContinuity", projectId]); if (projectId !== "board") throw new Error("Unknown registered project"); return { schemaVersion: 1, project: { projectId: "board", name: "Task Board", description: "Board" }, brief: { projectId: "board", currentStatus: "idle", activeGoals: [], recentChanges: [{ workflowId: workflow.workflowId, change: { file: "app.js" } }], recentWorkflowSummary: [{ workflowId: workflow.workflowId, status: "completed", goal: "Add search" }], unresolvedIssues: [], recommendedNextSteps: [], generatedFrom: [{ type: "workflow", id: workflow.workflowId }], updatedAt: task.updatedAt }, health: { status: "healthy", recent: [{ workflowId: workflow.workflowId, status: "completed", goal: "Add search" }], attention: ["GPT Web validation pending"], recommended: ["Run the documented validation"], release: { version: "1.8.0-beta.1", readiness: "pending_gpt_web_validation" }, generatedFrom: [{ type: "workflow", id: workflow.workflowId }, { type: "release_status", id: "1.8.0-beta.1" }] }, memorySummary: { available: true, summary: "Board memory", lastUpdated: task.updatedAt }, sessions: [{ ...workflow.session, purpose: "Add search", decisions: [], unresolvedQuestions: [], nextActions: [], relatedWorkflows: [workflow.workflowId] }], recentWorkflows: [{ workflowId: workflow.workflowId, goal: "Add search", status: "completed", updatedAt: task.updatedAt }], openIssues: [], waitingClarifications: [] }; },
  async getDecision(decisionId) { calls.push(["getDecision", decisionId]); return decisionId === "decision_dashboard_test" ? workflow.supervisorDecision : null; },
  async getWorkflowReviewPackage(workflowId) { calls.push(["getWorkflowReviewPackage", workflowId]); return workflowId === workflow.workflowId ? { schemaVersion: 2, packageId: `review_package_${workflowId}`, workflowId, originalRequest: workflow.userRequest, reviewerResult: { summary: "Review passed" }, auditEvidence: { stages: [{ role: "reviewer" }] }, memorySnapshot: { digest: "memory-fixture" }, goalAlignment: "Goal met", architectureImpact: "Bounded", futureRecommendations: ["Keep checks"], memoryUpdateNeeded: true, supervisorReviewResult: { reviewId: "supervisor_review_dashboard", conclusion: "accept" }, chatGptReviewGuidance: { status: "available", workflowId, projectId: "board", supervisorReviewStatus: "accept", reviewPackageTool: { name: "cc_get_supervisor_review_package", arguments: { workflowId } }, suggestedPrompts: { en: "Review this Workflow", zhCN: "审查此 Workflow" } }, memoryUpdateProposal: { proposalId: `memory_proposal_${workflowId}`, status: "proposed", workflowId, projectId: "board", requiresConfirmation: true, applied: false } } : null; },
  async getWorkflowProjectIntelligence(workflowId) { calls.push(["getWorkflowProjectIntelligence", workflowId]); return workflowId === workflow.workflowId ? { schemaVersion: 1, workflowId, projectId: "board", reviewResults: [{ reviewId: "supervisor_review_dashboard", conclusion: "accept", goalAlignment: "Goal met", source: { submittedBy: "operator" }, createdAt: task.updatedAt }], latestReview: { reviewId: "supervisor_review_dashboard", conclusion: "accept" }, memoryProposal: { proposalId: `memory_proposal_${workflowId}`, status: "proposed", applied: false, summary: "Add search", affectedAreas: ["app.js"] }, memoryApplications: [], latestMemoryApplication: null } : null; },
  async getWorkflowArtifactCenter(workflowId) { calls.push(["getWorkflowArtifactCenter", workflowId]); return workflowId === workflow.workflowId ? { schemaVersion: 1, workflowId, projectId: "board", plan: { proposedChanges: ["Add search"] }, approval: workflow.approvals, executionEvidence: [{ role: "coder" }], changes: { observedChanges: [{ file: "app.js" }] }, review: { technical: { summary: "Review passed" }, supervisor: null }, memoryImpact: { proposal: null, applications: [] } } : null; },
  async applyMemoryProposal(input) { calls.push(["applyMemoryProposal", input]); return { proposal: { proposalId: input.proposalId, workflowId: input.workflowId, status: "applied", applied: true }, application: { applicationId: "memory_apply_dashboard", workflowId: input.workflowId, projectId: "board", status: "applied", appliedBy: input.appliedBy } }; }
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
registerSupervisorDashboardRoutes(app, { taskRuntime, workflowRuntime, supervisorService, providerPreflight, taskRunner, workflowMetadataStore, dashboardRoot: path.resolve(directory, "..", "workspace", "supervisor-dashboard") });
const server = http.createServer(app);
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

try {
  const base = `http://127.0.0.1:${server.address().port}`;
  const workflowList = await fetch(`${base}/api/supervisor/workflows?status=completed&limit=10`);
  assert.equal(workflowList.status, 200);
  const listedWorkflow = (await workflowList.json()).workflows[0];
  assert.equal(listedWorkflow.workflowId, workflow.workflowId);
  assert.deepEqual(listedWorkflow.metadata, { schemaVersion: 1, workflowId: workflow.workflowId, displayName: null, archived: false, folderId: "default", updatedAt: null });

  const localHeaders = { "content-type": "application/json", origin: base };
  const initialFolders = (await (await fetch(`${base}/api/supervisor/folders`)).json()).folders;
  assert.deepEqual(initialFolders.map((folder) => folder.folderId), ["default"]);
  assert.equal(initialFolders[0].system, true);
  const createdFolderResponse = await fetch(`${base}/api/supervisor/folders`, { method: "POST", headers: localHeaders, body: JSON.stringify({ name: "Board work" }) });
  assert.equal(createdFolderResponse.status, 201);
  const createdFolder = (await createdFolderResponse.json()).folder;
  assert.match(createdFolder.folderId, /^folder_/);
  const pinnedFolderResponse = await fetch(`${base}/api/supervisor/folders/${createdFolder.folderId}`, { method: "PATCH", headers: localHeaders, body: JSON.stringify({ name: "Product board", pinned: true }) });
  const pinnedFolder = (await pinnedFolderResponse.json()).folder;
  assert.equal(pinnedFolder.name, "Product board");
  assert.equal(pinnedFolder.pinned, true);
  assert.equal((await fetch(`${base}/api/supervisor/folders/default`, { method: "PATCH", headers: localHeaders, body: JSON.stringify({ name: "Changed" }) })).status, 400, "default folder cannot be renamed");
  assert.equal((await fetch(`${base}/api/supervisor/folders/default`, { method: "DELETE", headers: localHeaders })).status, 400, "default folder cannot be deleted");
  assert.equal((await fetch(`${base}/api/supervisor/folders`, { method: "POST", headers: { "content-type": "application/json", origin: "https://chatgpt.com" }, body: JSON.stringify({ name: "Remote" }) })).status, 403, "folder mutations must remain local-console only");
  const projectsResponse = await fetch(`${base}/api/supervisor/projects`);
  const projectView = (await projectsResponse.json()).projects[0];
  assert.equal(projectView.projectId, "board");
  assert.equal(projectView.sessions[0].sessionId, "session_board_test");
  const projectContextResponse = await fetch(`${base}/api/supervisor/projects/board`);
  const projectContext = (await projectContextResponse.json()).context;
  assert.equal(projectContext.project.workspacePath, "D:/registered/workspace/board");
  assert.equal(projectContext.projectMemory, "Board memory");
  const continuityResponse = await fetch(`${base}/api/supervisor/projects/board/continuity`);
  assert.equal(continuityResponse.status, 200);
  const continuity = (await continuityResponse.json()).context;
  assert.equal(continuity.brief.projectId, "board");
  assert.equal(continuity.health.status, "healthy");
  assert.equal(continuity.health.release.version, "1.8.0-beta.1");
  assert.deepEqual(continuity.health.attention, ["GPT Web validation pending"]);
  assert.equal(continuity.sessions[0].purpose, "Add search");
  assert.equal((await fetch(`${base}/api/supervisor/projects/not%20valid`)).status, 400);
  assert.equal((await (await fetch(`${base}/api/supervisor/provider-preflight`)).json()).latest, null);
  const preflightResponse = await fetch(`${base}/api/supervisor/provider-preflight`, { method: "POST", headers: localHeaders, body: JSON.stringify({ timeoutSeconds: 30 }) });
  assert.equal(preflightResponse.status, 200);
  assert.equal((await preflightResponse.json()).result.classification, "reachable");
  providerPreflight.next = { status: "failed", classification: "provider_timeout", message: "The provider timed out.", safety: { projectContentSent: false, toolsEnabled: false, modificationsAllowed: false } };
  const failedPreflightResponse = await fetch(`${base}/api/supervisor/provider-preflight`, { method: "POST", headers: localHeaders, body: JSON.stringify({ timeoutSeconds: 30 }) });
  assert.equal(failedPreflightResponse.status, 503);
  assert.equal((await failedPreflightResponse.json()).result.classification, "provider_timeout");
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

  const retryResponse = await fetch(`${base}/api/supervisor/workflows/workflow_dashboard_test/retry`, { method: "POST", headers: localHeaders, body: JSON.stringify({ requestedBy: "operator", recoveryReason: "Provider connectivity restored." }) });
  assert.equal(retryResponse.status, 201);
  const retried = await retryResponse.json();
  assert.equal(retried.workflow.recovery.sourceWorkflowId, "workflow_dashboard_test");
  assert.deepEqual(retried.workflow.approvals, {});

  const invalidCreate = await fetch(`${base}/api/supervisor/workflows`, { method: "POST", headers: localHeaders, body: JSON.stringify({ userRequest: "" }) });
  assert.equal(invalidCreate.status, 400);
  const remoteCreate = await fetch(`${base}/api/supervisor/workflows`, { method: "POST", headers: { "content-type": "application/json", origin: "https://chatgpt.com" }, body: JSON.stringify({ userRequest: "must not start" }) });
  assert.equal(remoteCreate.status, 403);
  const missingOriginCreate = await fetch(`${base}/api/supervisor/workflows`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ userRequest: "must not start" }) });
  assert.equal(missingOriginCreate.status, 403);

  const workflowBeforeMetadata = JSON.stringify(workflow);
  const eventsBeforeMetadata = JSON.stringify(events);
  const metadataResponse = await fetch(`${base}/api/supervisor/workflows/${workflow.workflowId}/metadata`, { method: "PATCH", headers: localHeaders, body: JSON.stringify({ displayName: "Search feature", archived: true, folderId: createdFolder.folderId }) });
  assert.equal(metadataResponse.status, 200);
  const savedMetadata = (await metadataResponse.json()).metadata;
  assert.equal(savedMetadata.displayName, "Search feature");
  assert.equal(savedMetadata.archived, true);
  assert.equal(savedMetadata.folderId, createdFolder.folderId);
  assert.equal(JSON.stringify(workflow), workflowBeforeMetadata, "metadata must not mutate Workflow state");
  assert.equal(JSON.stringify(events), eventsBeforeMetadata, "metadata must not mutate Workflow events");
  assert.equal(JSON.parse(await readFile(workflowMetadataStore.metadataPath(workflow.workflowId), "utf8")).displayName, "Search feature");
  const remoteMetadata = await fetch(`${base}/api/supervisor/workflows/${workflow.workflowId}/metadata`, { method: "PATCH", headers: { "content-type": "application/json", origin: "https://chatgpt.com" }, body: JSON.stringify({ archived: false }) });
  assert.equal(remoteMetadata.status, 403);
  const invalidMetadata = await fetch(`${base}/api/supervisor/workflows/${workflow.workflowId}/metadata`, { method: "PATCH", headers: localHeaders, body: JSON.stringify({ archived: "yes" }) });
  assert.equal(invalidMetadata.status, 400);
  const invalidFolderMetadata = await fetch(`${base}/api/supervisor/workflows/${workflow.workflowId}/metadata`, { method: "PATCH", headers: localHeaders, body: JSON.stringify({ folderId: "folder_missing" }) });
  assert.equal(invalidFolderMetadata.status, 400);

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
  assert.equal(detailedWorkflow.product.projectId, "board");
  assert.equal(detailedWorkflow.product.workspacePath, "D:/registered/workspace/board");
  assert.equal(detailedWorkflow.product.sessionId, "session_board_test");
  assert.equal(detailedWorkflow.metadata.displayName, "Search feature");
  assert.equal(detailedWorkflow.metadata.archived, true);
  const reviewPackageResponse = await fetch(`${base}/api/supervisor/workflows/${workflow.workflowId}/review-package`);
  assert.equal(reviewPackageResponse.status, 200);
  const reviewPackage = (await reviewPackageResponse.json()).reviewPackage;
  assert.equal(reviewPackage.originalRequest, workflow.userRequest);
  assert.equal(reviewPackage.reviewerResult.summary, "Review passed");
  assert.equal(reviewPackage.chatGptReviewGuidance.reviewPackageTool.name, "cc_get_supervisor_review_package");
  assert.equal(reviewPackage.memoryUpdateProposal.applied, false);
  const artifactCenterResponse = await fetch(`${base}/api/supervisor/workflows/${workflow.workflowId}/artifacts`);
  assert.equal(artifactCenterResponse.status, 200);
  const artifactCenter = (await artifactCenterResponse.json()).artifacts;
  assert.equal(artifactCenter.changes.observedChanges[0].file, "app.js");
  const intelligenceResponse = await fetch(`${base}/api/supervisor/workflows/${workflow.workflowId}/project-intelligence`);
  assert.equal(intelligenceResponse.status, 200);
  const intelligence = (await intelligenceResponse.json()).intelligence;
  assert.equal(intelligence.latestReview.conclusion, "accept");
  assert.equal(intelligence.memoryProposal.status, "proposed");
  const unconfirmedApply = await fetch(`${base}/api/supervisor/workflows/${workflow.workflowId}/memory-proposal/apply`, { method: "POST", headers: localHeaders, body: JSON.stringify({ proposalId: intelligence.memoryProposal.proposalId, appliedBy: "operator", confirmationReason: "Reviewed", confirmed: false }) });
  assert.equal(unconfirmedApply.status, 400, "Dashboard must reject an unconfirmed Memory apply");
  const remoteApply = await fetch(`${base}/api/supervisor/workflows/${workflow.workflowId}/memory-proposal/apply`, { method: "POST", headers: { "content-type": "application/json", origin: "https://chatgpt.com" }, body: JSON.stringify({ proposalId: intelligence.memoryProposal.proposalId, appliedBy: "operator", confirmationReason: "Reviewed", confirmed: true }) });
  assert.equal(remoteApply.status, 403, "Dashboard Memory apply must remain a local-console operation");
  const applyResponse = await fetch(`${base}/api/supervisor/workflows/${workflow.workflowId}/memory-proposal/apply`, { method: "POST", headers: localHeaders, body: JSON.stringify({ proposalId: intelligence.memoryProposal.proposalId, appliedBy: "operator", confirmationReason: "Reviewed evidence", confirmed: true }) });
  assert.equal(applyResponse.status, 200);
  assert.equal((await applyResponse.json()).application.status, "applied");
  assert.equal((await fetch(`${base}/api/supervisor/workflows/workflow_missing/review-package`)).status, 404);
  assert.equal(detailedWorkflow.metadata.folderId, createdFolder.folderId);
  assert(detailedWorkflow.product.executionPolicy.blocked.length >= 4);

  const workflowEvents = await fetch(`${base}/api/supervisor/workflows/${workflow.workflowId}/events?limit=20`);
  assert.deepEqual((await workflowEvents.json()).events.map((event) => event.type), ["workflow.created", "task.completed"]);
  const deletedFolderResponse = await fetch(`${base}/api/supervisor/folders/${createdFolder.folderId}`, { method: "DELETE", headers: localHeaders });
  assert.equal(deletedFolderResponse.status, 200);
  assert.equal((await deletedFolderResponse.json()).result.movedWorkflows, 1);
  assert.equal((await workflowMetadataStore.read(workflow.workflowId)).folderId, "default", "deleting a folder must return its sessions to Default");

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
  for (const marker of ["language-switch", "local-entry", "overview-disclosure", "hide-recent", "show-recent", "create-folder", "project-browser", "project-list", "project-summary", "project-overview", "project-overview-content", "artifact-center", "new-task-form", "project-confirmation", "workflow-navigation", "workflow-summary-pane", "workflow-timeline-pane", "stage-timeline", "stage-plan", "stage-approval", "stage-implementation", "stage-review", "decision-panel", "approval-panel", "recovery-panel", "workflow-metadata-dialog", "metadata-folder", "folder-dialog", "Approve and run", "Technical details"]) assert.match(dashboardHtml, new RegExp(marker));
  assert.doesNotMatch(dashboardHtml, /<details id="local-entry"[^>]*\sopen(?:\s|>)/, "Local fallback entry must be collapsed by default");
  assert.doesNotMatch(dashboardHtml, /<details id="overview-disclosure"[^>]*\sopen(?:\s|>)/, "Overall status must be collapsed by default");
  const dashboardScript = await fetch(`${base}/supervisor/app.js`);
  const dashboardSource = await dashboardScript.text();
  for (const marker of ["provider-preflight", "failure.category", "recoverySteps", "workflowType", "supervisorDecision", "technicalSummary", "estimatedResources", "recommendedActions", "project_confirmation_required", "implementation.diff", "implementation.files", "review.title", "review.errors", "totalCostUsd", "totalUsage", "renderProjects", "renderProjectOverview", "renderArtifactCenter", "clarification-form", "projectId", "workspacePath", "sessionId", "stageIcon", "applyRecentVisibility", "applyHeroView", "groupWorkflowsByFolder", "/projects", "/continuity", "/artifacts", "/folders", "/approve", "/reject", "/retry", "/metadata", "PATCH", "DELETE"]) assert.match(dashboardSource, new RegExp(marker));
  assert.match(dashboardSource, /sentenceLabel\(result\.classification\)/, "Provider failure heading should use a sentence-cased label");
  assert.doesNotMatch(dashboardSource, /Provider: \$\{statusLabel/, "Provider failure heading should not repeat the Provider label");
  assert.equal((await fetch(`${base}/supervisor/refresh-policy.mjs`)).status, 200);
  assert.equal(refreshDelay(true), 1000, "Running work must refresh at least once per second");
  assert.equal(refreshDelay(false), 4000, "Idle refresh should back off to 3-5 seconds");
  assert(calls.every(([operation]) => ["listTasks", "getTask", "taskEvents", "listWorkflows", "createWorkflow", "approveWorkflow", "rejectWorkflow", "retryWorkflow", "getWorkflow", "workflowEvents", "submitRequest", "listProjects", "listProjectViews", "getProjectContext", "getProjectContinuity", "getDecision", "getWorkflowReviewPackage", "getWorkflowProjectIntelligence", "getWorkflowArtifactCenter", "applyMemoryProposal", "getPreflight", "runPreflight"].includes(operation)));
  console.log(JSON.stringify({ ok: true, routes: ["project-list", "project-context", "provider-preflight", "workflow-create", "workflow-approve", "workflow-reject", "workflow-retry", "workflow-metadata", "review-package", "project-intelligence", "memory-proposal-apply", "folder-list", "folder-create", "folder-update", "folder-delete", "workflow-list", "workflow-detail", "workflow-events", "task-list", "task-detail", "artifact", "static"], refresh: { activeMs: refreshDelay(true), idleMs: refreshDelay(false) } }, null, 2));
} finally {
  await new Promise((resolve) => server.close(resolve));
  await rm(metadataDataRoot, { recursive: true, force: true });
}
