import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FileSupervisorStore } from "./file-supervisor-store.mjs";
import { buildMemoryApplicationDocument, ProjectIntelligenceService } from "./project-intelligence.mjs";
import { ProjectContextRegistry } from "./project-context.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = path.join(repoRoot, ".agent-runs", `project-intelligence-test-${process.pid}-${Date.now()}`);
const workspace = path.join(root, "project");
const memoryPath = path.join(workspace, "PROJECT_MEMORY.md");
const workflow = {
  workflowId: "workflow_intelligence_fixture",
  projectId: "fixture-project",
  project: { projectId: "fixture-project", id: "fixture-project", workspacePath: workspace },
  userRequest: "Add CSV export",
  status: "completed",
  currentStage: "completed",
  tasks: []
};
const legacyWorkflow = { workflowId: "workflow_intelligence_legacy", projectId: null, project: null, userRequest: "Legacy review", status: "succeeded", currentStage: "completed", tasks: [] };
const workflows = new Map([[workflow.workflowId, workflow], [legacyWorkflow.workflowId, legacyWorkflow]]);

await mkdir(workspace, { recursive: true });
await writeFile(memoryPath, "# Legacy Project Memory\n\nExisting operator-owned fact.\n", "utf8");
await writeFile(path.join(root, "projects.json"), JSON.stringify({ schemaVersion: 3, projects: [{ projectId: "fixture-project", name: "Fixture Project", workspacePath: "project", description: "Project Intelligence fixture", stack: ["JavaScript"], aliases: ["fixture"], constraints: ["Keep tests isolated."] }] }), "utf8");
try {
  const store = new FileSupervisorStore(root);
  const projectRegistry = new ProjectContextRegistry({ projectRoot: root, registryPath: path.join(root, "projects.json") });
  await projectRegistry.init();
  const service = new ProjectIntelligenceService({
    workflowRuntime: { async inspectWorkflow(workflowId) { return workflows.get(workflowId) || null; } },
    projectRegistry,
    store
  });
  const workflowBefore = JSON.parse(JSON.stringify(workflow));

  await assert.rejects(() => service.recordSupervisorReview({ workflowId: workflow.workflowId, conclusion: "accept", goalAlignment: "Goal met.", architectureAssessment: "Bounded change.", submittedBy: "operator", confirmationReason: "Save GPT review", confirmed: false }), /explicit_confirmation_required/);
  const review = await service.recordSupervisorReview({
    workflowId: workflow.workflowId,
    conclusion: "accept",
    goalAlignment: "The implementation satisfies the original export goal.",
    architectureAssessment: "The bounded browser-only change preserves the current architecture.",
    risks: ["Large exports remain a future risk."],
    recommendations: ["Keep export serialization isolated."],
    nextSteps: ["Add a large-payload fixture."],
    memoryUpdateNeeded: true,
    submittedBy: "local-operator",
    confirmationReason: "User explicitly requested saving the ChatGPT Supervisor review.",
    confirmed: true
  });
  assert.equal(review.reviewer, "chatgpt_supervisor");
  assert.equal(review.source.channel, "chatgpt_web_mcp");
  assert.equal(review.source.confirmation.confirmed, true);
  assert.equal((await store.listSupervisorReviewResults(workflow.workflowId))[0].reviewId, review.reviewId);
  assert.deepEqual(workflow, workflowBefore, "Review Result persistence must not mutate Workflow state");

  const legacyReview = await service.recordSupervisorReview({ workflowId: legacyWorkflow.workflowId, conclusion: "investigate", goalAlignment: "Legacy evidence is incomplete.", architectureAssessment: "No project binding is available.", submittedBy: "operator", confirmationReason: "Keep a legacy review record.", confirmed: true });
  assert.equal(legacyReview.projectId, null, "Legacy Workflow without Project Context must remain reviewable");

  const proposal = {
    schemaVersion: 1,
    proposalId: `memory_proposal_${workflow.workflowId}`,
    projectId: "fixture-project",
    workflowId: workflow.workflowId,
    status: "proposed",
    summary: "CSV export was added and independently reviewed",
    affectedAreas: ["app.js"],
    suggestedMemoryChanges: ["Completed project goal: Add CSV export", "Harness-observed affected areas: app.js.", "Reviewer verification: Verified CSV escaping."],
    reason: "Strict evidence is sufficient.",
    requiresConfirmation: true,
    applied: false,
    generatedAt: new Date().toISOString()
  };
  await store.writeMemoryUpdateProposal(proposal);
  const memoryBefore = await readFile(memoryPath, "utf8");
  await assert.rejects(() => service.applyMemoryProposal({ workflowId: workflow.workflowId, proposalId: proposal.proposalId, appliedBy: "operator", confirmationReason: "Apply reviewed facts", confirmed: false }), /explicit_confirmation_required/);
  assert.equal(await readFile(memoryPath, "utf8"), memoryBefore, "Unconfirmed proposal must not change PROJECT_MEMORY.md");

  const applied = await service.applyMemoryProposal({ workflowId: workflow.workflowId, proposalId: proposal.proposalId, appliedBy: "local-operator", confirmationReason: "Reviewed evidence is durable project history.", confirmed: true });
  const memoryAfter = await readFile(memoryPath, "utf8");
  assert.match(memoryAfter, /Existing operator-owned fact/, "Apply must preserve legacy Memory content");
  assert.match(memoryAfter, /## Recent Evolution/);
  assert.match(memoryAfter, new RegExp(proposal.proposalId));
  assert.equal(applied.proposal.applied, true);
  assert.equal(applied.proposal.status, "applied");
  assert.equal(applied.application.status, "applied");
  assert.notEqual(applied.application.beforeDigest, applied.application.afterDigest);
  assert.equal(applied.application.afterDigest, createHash("sha256").update(memoryAfter.trim()).digest("hex"), "Apply audit digest must match Project Context Memory digest semantics");
  assert.equal((await store.listMemoryApplications({ projectId: "fixture-project", workflowId: workflow.workflowId }))[0].applicationId, applied.application.applicationId);
  assert.match(projectRegistry.getProjectContext("fixture-project").projectMemory, /CSV export was added/);
  assert.equal(projectRegistry.getProjectContext("fixture-project").memory.digest, applied.application.afterDigest, "Project Context Memory snapshot must refresh after apply");
  await assert.rejects(() => service.applyMemoryProposal({ workflowId: workflow.workflowId, proposalId: proposal.proposalId, appliedBy: "operator", confirmationReason: "Duplicate", confirmed: true }), /memory_proposal_not_applicable/);

  const intelligence = await service.getWorkflowIntelligence(workflow.workflowId);
  assert.equal(intelligence.latestReview.conclusion, "accept");
  assert.equal(intelligence.memoryProposal.applied, true);
  assert.equal(intelligence.latestMemoryApplication.status, "applied");
  const newMemory = buildMemoryApplicationDocument("", proposal, { appliedAt: new Date().toISOString(), appliedBy: "operator", confirmationReason: "Confirmed" });
  for (const heading of ["## Stable Facts", "## Architecture Decisions", "## Recent Evolution"]) assert.match(newMemory, new RegExp(heading));

  console.log(JSON.stringify({ ok: true, reviewId: review.reviewId, applicationId: applied.application.applicationId, legacyCompatible: true }, null, 2));
} finally {
  await rm(root, { recursive: true, force: true });
}
