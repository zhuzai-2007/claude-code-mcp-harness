import assert from "node:assert/strict";
import { buildSupervisorProductView } from "./supervisor-product-view.mjs";

const workflow = {
  status: "waiting_approval",
  currentStage: "implementation",
  nextAction: { type: "approve_workflow", reason: "Planner completed the bounded plan." },
  stages: [
    { id: "planning", role: "planner", resourceProfile: "small_readonly" },
    { id: "implementation", role: "coder", resourceProfile: "large_change", requiresApproval: true },
    { id: "review", role: "reviewer", resourceProfile: "review_readonly" }
  ],
  approvals: {},
  rejections: {},
  failure: null,
  projectId: "board",
  workspacePath: "D:/registered/workspace/board",
  sessionId: "session_product_test",
  session: { sessionId: "session_product_test", projectId: "board", name: "JSON export" },
  supervisorDecision: { decisionId: "decision_product_test", intent: "code_change", goal: "Add JSON export", goalConfidence: 0.72, possibleIntentMismatch: "The request may require a migration rather than a download.", clarificationNeeded: true, clarificationReasons: ["possible_intent_mismatch"], technical_summary: "Add a bounded export control without changing storage semantics.", implementation_strategy: "Reuse the existing browser action pattern.", expected_changes: ["Add one export action."], validation_plan: ["Verify JSON download and existing storage behavior."], supervisor_context: { projectId: "board", file: "AI_SUPERVISOR.md", digest: "fixture" }, project: { id: "board", name: "Task Board", path: "workspace/board", techStack: ["Browser JavaScript"], defaultConstraints: ["No dependencies."] }, reasoning: ["A bounded code change is required."], risks: ["Downloaded JSON may contain user task text."], workflowType: "software_change", estimated_resources: { basis: "gpt_estimate_with_runtime_caps", complexity: "low", expected: { budgetUsd: 0.5, turns: 20, filesRead: 8, commands: 0, timeoutSeconds: 300 }, hard_caps: { budgetUsd: 4, turns: 150, filesRead: 200, commands: 50, timeoutSeconds: 1800 }, stages: [], within_hard_caps: true, notes: ["Advisory only."] }, recommended_actions: ["Plan, approve, implement, and review."], agentRequired: true, confidence: 0.91, nextAction: "create_workflow", source: "gpt" }
};
const tasks = [{
  role: "planner",
  attempts: [{ audit: { summary: "Add JSON export", files_read: ["app.js"], proposed_changes: [{ file: "app.js", description: "add export control" }, { file: "style.css", operation: "edit" }], risks: ["Large payload"], blocked_on: [], cost: 0.2, resource_usage: { turns: 8, filesRead: 1, commands: 0 } } }]
}, {
  role: "coder",
  attempts: [{ observedChanges: [{ file: "workspace/board/app.js", operation: "edit", addedLines: 3, removedLines: 1, diff: "--- a/app.js\n+++ b/app.js\n-old\n+new" }] }]
}];

const product = buildSupervisorProductView(workflow, tasks);
assert.equal(product.approval.status, "waiting");
assert.equal(product.approval.resourceProfile, "large_change");
assert.deepEqual(product.approval.contextualFiles, ["app.js"]);
assert.deepEqual(product.approval.plannedChanges, ["app.js — add export control", "style.css — edit"]);
assert.deepEqual(product.risks, ["Downloaded JSON may contain user task text.", "Large payload"]);
assert.equal(product.totalCostUsd, 0.2);
assert.equal(product.totalUsage.turns, 8);
assert.equal(product.supervisorDecision.decisionId, "decision_product_test");
assert.equal(product.supervisorDecision.goalConfidence, 0.72);
assert.equal(product.supervisorDecision.clarificationNeeded, true);
assert.match(product.supervisorDecision.possibleIntentMismatch, /migration/);
assert.equal(product.projectId, "board");
assert.equal(product.workspacePath, "D:/registered/workspace/board");
assert.equal(product.sessionId, "session_product_test");
assert.equal(product.supervisorDecision.technicalSummary, "Add a bounded export control without changing storage semantics.");
assert.equal(product.supervisorDecision.implementationStrategy, "Reuse the existing browser action pattern.");
assert.deepEqual(product.supervisorDecision.expectedChanges, ["Add one export action."]);
assert.deepEqual(product.supervisorDecision.validationPlan, ["Verify JSON download and existing storage behavior."]);
assert.equal(product.supervisorDecision.supervisorContext.file, "AI_SUPERVISOR.md");
assert.deepEqual(product.supervisorDecision.risks, ["Downloaded JSON may contain user task text."]);
assert.equal(product.supervisorDecision.estimatedResources.expected.turns, 20);
assert(product.risks.includes("Downloaded JSON may contain user task text."));
assert.equal(product.approval.modificationReason, "Add JSON export");
assert.equal(product.approval.changeDetails[0].file, "workspace/board/app.js");
assert.equal(product.changeDetails[0].summary, "1 observed edit; +3 / -1 lines");
assert.equal(product.approval.estimatedCost.upperBoundUsd, 4);
assert(product.executionPolicy.blocked.some((item) => item.includes("without explicit approval")));

const rejected = buildSupervisorProductView({ ...workflow, orchestrated: true, status: "failed", failure: { failedStage: "implementation", role: "coder", error: { code: "approval_rejected", message: "Too broad" } }, rejections: { implementation: { rejectedBy: "operator", rejectionReason: "Too broad", rejectedAt: "2026-07-15T00:00:00Z" } } }, tasks);
assert.equal(rejected.approval.status, "rejected");
assert.match(rejected.nextAction, /Revise/);
assert.equal(rejected.failure.category, "human_decision");
assert.equal(rejected.recovery.available, true);

const providerFailure = buildSupervisorProductView({ ...workflow, orchestrated: true, status: "failed", currentStage: "planning", failure: { failedStage: "planning", role: "planner", taskId: "task_failed", error: { code: "worker_crash", message: "API Error: Unable to connect to API (ConnectionRefused)" } }, recoveries: [{ workflowId: "workflow_recovered" }] }, []);
assert.equal(providerFailure.failure.category, "provider_connectivity");
assert.equal(providerFailure.failure.stageLabel, "Planning");
assert(providerFailure.failure.recoverySteps.some((step) => step.includes("Preflight")));
assert.equal(providerFailure.recovery.recoveries[0].workflowId, "workflow_recovered");

console.log(JSON.stringify({ ok: true, approval: product.approval, policy: product.executionPolicy }, null, 2));
