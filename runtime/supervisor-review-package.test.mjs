import assert from "node:assert/strict";
import path from "node:path";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { FileSupervisorStore } from "./file-supervisor-store.mjs";
import { SupervisorReviewPackageService } from "./supervisor-review-package.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = path.join(projectRoot, ".agent-runs", `supervisor-review-package-test-${process.pid}-${Date.now()}`);

const workflow = {
  workflowId: "workflow_review_package_fixture",
  status: "completed",
  currentStage: "completed",
  definitionId: "software_change",
  userRequest: "Add CSV export",
  createdAt: "2026-07-18T00:00:00.000Z",
  updatedAt: "2026-07-18T00:05:00.000Z",
  projectId: "task-board",
  workspacePath: "D:/workspace/task-board",
  projectBinding: { projectId: "task-board", workspacePath: "D:/workspace/task-board" },
  project: { projectId: "task-board", name: "Task Board", description: "Local board", stack: ["JavaScript"] },
  supervisorDecision: {
    decisionId: "decision_review_fixture",
    goal: "Add CSV export",
    implementation_strategy: "Add a bounded export action and validate escaping.",
    validation_plan: ["Verify CSV escaping"],
    constraints: ["Stay inside the task board"],
    project_memory: { available: true, file: "PROJECT_MEMORY.md", digest: "frozen-digest", lastUpdated: "2026-07-17T00:00:00.000Z", size: 17, capturedAt: "2026-07-18T00:00:00.000Z", content: "frozen memory v1" }
  },
  approvals: { implementation: { approvedBy: "human", approvalReason: "Bounded plan", approvedAt: "2026-07-18T00:01:00.000Z" } },
  failure: null,
  tasks: [
    { taskId: "task_plan_fixture", stageId: "planning", role: "planner", mode: "plan" },
    { taskId: "task_run_fixture", stageId: "implementation", role: "coder", mode: "run" },
    { taskId: "task_review_fixture", stageId: "review", role: "reviewer", mode: "review" }
  ]
};
const legacyWorkflow = {
  ...workflow,
  workflowId: "workflow_review_legacy_fixture",
  supervisorDecision: { ...workflow.supervisorDecision, project_memory: { available: true, file: "PROJECT_MEMORY.md", digest: "legacy-digest", lastUpdated: "2026-07-16T00:00:00.000Z", size: 9 } }
};
const preDecisionWorkflow = { ...workflow, workflowId: "workflow_review_predates_supervisor", supervisorDecision: null, projectId: null, project: null, projectBinding: null };

const tasks = {
  task_plan_fixture: { taskId: "task_plan_fixture", status: "succeeded", settings: { resourceProfile: "exploration_readonly" }, attempts: [{ attemptId: "attempt-plan", status: "succeeded" }] },
  task_run_fixture: { taskId: "task_run_fixture", status: "succeeded", settings: { resourceProfile: "small_change" }, attempts: [{ attemptId: "attempt-run", status: "succeeded" }] },
  task_review_fixture: { taskId: "task_review_fixture", status: "succeeded", settings: { resourceProfile: "review_readonly" }, attempts: [{ attemptId: "attempt-review", status: "succeeded" }] }
};

const inspections = {
  "attempt-plan": { audit: { status: "success", mode: "plan", summary: "Plan export", files_read: ["app.js"], proposed_changes: ["Add exportCsv"] }, recentToolCalls: [], observedChanges: [], artifactFiles: ["worker-result.normalized.json"] },
  "attempt-run": { audit: { status: "success", mode: "run", summary: "Implemented export", files_read: ["app.js"], changes_made: ["app.js"], commands_run: [], tests_or_checks: ["Read app.js"], risks: [], blocked_on: [], run_result: { type: "modified" } }, recentToolCalls: [{ tool: "Read", succeeded: true }], observedChanges: [{ file: "app.js", operation: "edit" }], artifactFiles: ["worker-result.normalized.json", "tool-events.json"] },
  "attempt-review": { audit: { status: "success", mode: "review", summary: "Export meets request", files_read: ["app.js"], changes_made: [], commands_run: [], tests_or_checks: ["Verified escaping"], risks: [], blocked_on: [] }, recentToolCalls: [], observedChanges: [], artifactFiles: ["worker-result.normalized.json"] }
};

await mkdir(root, { recursive: true });
try {
  const projectMemoryPath = path.join(root, "PROJECT_MEMORY.md");
  await writeFile(projectMemoryPath, "operator-owned memory\n", "utf8");
  const memoryBefore = await readFile(projectMemoryPath, "utf8");
  const workflowBefore = JSON.parse(JSON.stringify(workflow));
  const store = new FileSupervisorStore(root);
  const service = new SupervisorReviewPackageService({
    workflowRuntime: {
      async inspectWorkflow(id) { return id === workflow.workflowId ? workflow : id === legacyWorkflow.workflowId ? legacyWorkflow : id === preDecisionWorkflow.workflowId ? preDecisionWorkflow : null; },
      async getWorkflow() { throw new Error("Review Package must not call the reconciling Workflow read path"); }
    },
    taskRuntime: { async getTask(id) { return tasks[id] || null; } },
    projectRegistry: { getProjectContext() { return { projectDescription: "Current description", technicalStack: ["JavaScript"], constraints: [], supervisorContext: { digest: "context" }, projectMemory: "newer memory that must not replace the snapshot", memory: { digest: "new-digest" } }; } },
    store,
    attemptInspector: (attemptId) => inspections[attemptId]
  });

  const reviewPackage = await service.build(workflow.workflowId);
  assert.equal(reviewPackage.schemaVersion, 2);
  assert.equal(reviewPackage.reviewReadiness, "complete");
  assert.equal(reviewPackage.originalRequest, "Add CSV export");
  assert.equal(reviewPackage.implementationStrategy.supervisor, "Add a bounded export action and validate escaping.");
  assert.deepEqual(reviewPackage.changes.reportedFiles, ["app.js"]);
  assert.equal(reviewPackage.auditEvidence.stages.length, 3);
  assert.equal(reviewPackage.reviewerResult.summary, "Export meets request");
  assert.equal(reviewPackage.projectContext.projectId, "task-board");
  assert.equal(reviewPackage.memorySnapshot.content, "frozen memory v1", "Review must use the Decision-time Memory snapshot");
  assert.equal(reviewPackage.memorySnapshot.status, "captured");
  assert.equal(reviewPackage.goalAlignment, null, "Review Package must not fabricate a GPT judgment");
  assert.equal(reviewPackage.architectureImpact, null, "Review Package must not fabricate architecture analysis");
  assert.deepEqual(reviewPackage.futureRecommendations, []);
  assert.equal(reviewPackage.memoryUpdateNeeded, null);
  assert.equal(reviewPackage.chatGptReviewGuidance.status, "available");
  assert.equal(reviewPackage.chatGptReviewGuidance.reviewPackageTool.name, "cc_get_supervisor_review_package");
  assert.deepEqual(reviewPackage.chatGptReviewGuidance.reviewPackageTool.arguments, { workflowId: workflow.workflowId });
  assert.match(reviewPackage.chatGptReviewGuidance.suggestedPrompts.en, /Whether the original user goal was met/);
  assert.match(reviewPackage.chatGptReviewGuidance.suggestedPrompts.en, /only if the user explicitly asks to save it/);
  assert.match(reviewPackage.chatGptReviewGuidance.suggestedPrompts.zhCN, /是否满足用户最初目标/);
  assert.equal(reviewPackage.memoryUpdateProposal.status, "proposed");
  assert.deepEqual(reviewPackage.memoryUpdateProposal.affectedAreas, ["app.js"]);
  assert.equal(reviewPackage.memoryUpdateProposal.requiresConfirmation, true);
  assert.equal(reviewPackage.memoryUpdateProposal.applied, false);
  const stableProposal = (await service.build(workflow.workflowId)).memoryUpdateProposal;
  assert.equal(stableProposal.generatedAt, reviewPackage.memoryUpdateProposal.generatedAt, "Dashboard polling must not rewrite an unchanged terminal Proposal");
  assert.equal((await store.readReviewPackage(workflow.workflowId)).packageId, reviewPackage.packageId, "Review Package was not persisted");
  assert.equal((await store.readMemoryUpdateProposal(workflow.workflowId)).proposalId, reviewPackage.memoryUpdateProposal.proposalId, "Memory proposal was not persisted separately");
  assert.deepEqual(workflow, workflowBefore, "Building a Review Package must not mutate Workflow state");
  assert.equal(await readFile(projectMemoryPath, "utf8"), memoryBefore, "Unconfirmed proposal must not modify PROJECT_MEMORY.md");
  const persistedReview = {
    schemaVersion: 1,
    reviewId: "supervisor_review_package_fixture",
    workflowId: workflow.workflowId,
    projectId: "task-board",
    reviewer: "chatgpt_supervisor",
    source: { channel: "chatgpt_web_mcp", submittedBy: "operator", confirmation: { confirmed: true, reason: "Save final judgment" } },
    conclusion: "accept",
    goalAlignment: "The original export goal was met.",
    architectureAssessment: "The change remains bounded to the existing browser architecture.",
    risks: [],
    recommendations: ["Retain focused export checks."],
    nextSteps: [],
    memoryUpdateNeeded: true,
    createdAt: "2026-07-18T01:00:00.000Z"
  };
  await store.writeSupervisorReviewResult(persistedReview);
  const appliedProposal = { ...reviewPackage.memoryUpdateProposal, status: "applied", applied: true, application: { applicationId: "memory_apply_package_fixture", appliedBy: "operator", appliedAt: "2026-07-18T01:01:00.000Z" } };
  await store.writeMemoryUpdateProposal(appliedProposal);
  const reviewedPackage = await service.build(workflow.workflowId);
  assert.equal(reviewedPackage.supervisorReviewResult.reviewId, persistedReview.reviewId);
  assert.equal(reviewedPackage.goalAlignment, persistedReview.goalAlignment);
  assert.equal(reviewedPackage.architectureImpact, persistedReview.architectureAssessment);
  assert.deepEqual(reviewedPackage.futureRecommendations, persistedReview.recommendations);
  assert.equal(reviewedPackage.memoryUpdateNeeded, true);
  assert.equal(reviewedPackage.chatGptReviewGuidance.supervisorReviewStatus, "accept");
  assert.equal(reviewedPackage.memoryUpdateProposal.applied, true, "Rebuilding a Review Package must not reset an applied Proposal");
  const legacyPackage = await service.build(legacyWorkflow.workflowId);
  assert.equal(legacyPackage.memorySnapshot.status, "legacy_metadata_only");
  assert.equal(legacyPackage.memorySnapshot.content, "", "Legacy metadata must not be mislabeled with current Memory content");
  const preDecisionPackage = await service.build(preDecisionWorkflow.workflowId);
  assert.equal(preDecisionPackage.reviewReadiness, "complete", "Legacy Workflow without a Supervisor Decision must remain readable");
  assert.equal(preDecisionPackage.decision, null);
  assert.equal(preDecisionPackage.memorySnapshot.status, "unavailable");
  assert.equal(await service.build("workflow_missing_fixture"), null);
  console.log(JSON.stringify({ ok: true, workflowId: workflow.workflowId, stageCount: reviewPackage.auditEvidence.stages.length }, null, 2));
} finally {
  await rm(root, { recursive: true, force: true });
}
