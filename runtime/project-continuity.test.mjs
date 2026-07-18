import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FileSupervisorStore } from "./file-supervisor-store.mjs";
import { ProjectContextRegistry } from "./project-context.mjs";
import { ProjectContinuityService } from "./project-continuity.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = path.join(repoRoot, ".agent-runs", `project-continuity-test-${process.pid}-${Date.now()}`);
const workspace = path.join(root, "project");
const workflow = { workflowId: "workflow_continuity_fixture", projectId: "fixture", userRequest: "Add search", status: "completed", currentStage: "completed", updatedAt: "2026-07-18T10:00:00.000Z", createdAt: "2026-07-18T09:00:00.000Z", tasks: [], approvals: { implementation: { approvedBy: "operator" } }, workflowPlan: { workflowType: "software_change" } };
const legacyWorkflow = { workflowId: "workflow_continuity_legacy", userRequest: "Legacy task", status: "succeeded", currentStage: "completed", updatedAt: workflow.updatedAt, createdAt: workflow.createdAt, tasks: [] };

await mkdir(workspace, { recursive: true });
await writeFile(path.join(workspace, "PROJECT_MEMORY.md"), "# Project Memory\n\nConfirmed product direction.", "utf8");
await writeFile(path.join(root, "projects.json"), JSON.stringify({ projects: [{ projectId: "fixture", name: "Fixture", path: "project", description: "Continuity fixture", language: "JavaScript" }] }), "utf8");
try {
  const store = new FileSupervisorStore(root);
  await store.init();
  const registry = new ProjectContextRegistry({ projectRoot: root, registryPath: path.join(root, "projects.json") });
  await registry.init();
  const workflowBefore = JSON.parse(JSON.stringify(workflow));
  const workflowRuntime = {
    store: { async listWorkflows() { return [workflow, legacyWorkflow]; } },
    async inspectWorkflow(workflowId) { return workflowId === workflow.workflowId ? workflow : workflowId === legacyWorkflow.workflowId ? legacyWorkflow : null; }
  };
  const continuity = new ProjectContinuityService({ workflowRuntime, projectRegistry: registry, store, releaseStatus: { schemaVersion: 1, projectId: "fixture", version: "1.8.0-beta.1", readiness: "pending_gpt_web_validation", lastGptWebDogfood: null, attention: ["Release pending"], nextRequiredChecks: ["Run end-to-end validation"] } });
  const session = await store.createSession({ projectId: "fixture", name: "Search continuity", purpose: "Continue search delivery", decisions: ["Keep the UI dependency-free"], unresolvedQuestions: ["Should search include archived items?"], nextActions: ["Confirm search scope"] });
  await store.attachWorkflowToSession(session.sessionId, workflow.workflowId);
  const linked = await store.requireSession(session.sessionId, "fixture");
  assert.deepEqual(linked.relatedWorkflows, [workflow.workflowId]);
  await assert.rejects(() => store.requireSession(session.sessionId, "another-project"), /belongs to project 'fixture'/);

  await store.writeReviewPackage({ workflowId: workflow.workflowId, implementationStrategy: { proposedChanges: ["Add bounded search"] }, auditEvidence: { approval: workflow.approvals, stages: [{ role: "coder", observedChanges: [{ file: "app.js" }] }] }, changes: { summary: "Search added", reportedFiles: ["app.js"], observedChanges: [{ file: "app.js", operation: "edit" }] }, reviewerResult: { summary: "Technical review passed" } });
  const briefWithoutGpt = await continuity.buildProjectBrief("fixture");
  assert.equal(briefWithoutGpt.projectId, "fixture");
  assert.equal((await store.readProjectBrief("fixture")).projectId, "fixture");
  assert.deepEqual(briefWithoutGpt.recommendedNextSteps, [], "Project Brief must not invent or promote GPT recommendations before a confirmed Supervisor Review exists");
  assert(briefWithoutGpt.recentChanges.some((entry) => entry.change.file === "app.js"));
  assert(!JSON.stringify(briefWithoutGpt).includes("invented"));

  await store.writeSupervisorReviewResult({ schemaVersion: 1, reviewId: "supervisor_review_continuity", workflowId: workflow.workflowId, projectId: "fixture", conclusion: "accept", goalAlignment: "Goal met", architectureAssessment: "Bounded", risks: [], recommendations: ["Keep search indexing isolated"], nextSteps: ["Add an accessibility check"], memoryUpdateNeeded: false, source: { submittedBy: "operator" }, createdAt: "2026-07-18T11:00:00.000Z" });
  const context = await continuity.getProjectContext("fixture");
  assert.equal(context.brief.currentStatus, "idle");
  assert.equal(context.health.status, "healthy");
  assert.equal(context.health.release.version, "1.8.0-beta.1");
  assert(context.health.attention.includes("Release pending"));
  assert(context.health.recommended.includes("Run end-to-end validation"));
  assert(context.brief.recommendedNextSteps.includes("Keep search indexing isolated"));
  assert.equal(context.memorySummary.summary.includes("Confirmed product direction"), true);
  assert.equal(Object.hasOwn(context, "events"), false, "Compact MCP context must omit raw event history");
  assert.equal(context.sessions[0].purpose, "Continue search delivery");

  const artifactCenter = await continuity.getArtifactCenter(workflow.workflowId);
  assert.deepEqual(artifactCenter.changes.observedChanges, [{ file: "app.js", operation: "edit" }]);
  assert.equal(artifactCenter.review.supervisor.reviewId, "supervisor_review_continuity");
  assert.deepEqual(workflow, workflowBefore, "Artifact Center reads must not change Workflow state");

  const legacySessionPath = path.join(root, "project-sessions", "session_legacy.json");
  await writeFile(legacySessionPath, JSON.stringify({ schemaVersion: 1, sessionId: "session_legacy", projectId: "fixture", name: "Legacy", workflowIds: [workflow.workflowId], createdAt: workflow.createdAt, updatedAt: workflow.updatedAt }), "utf8");
  const legacy = await store.readSession("session_legacy");
  assert.deepEqual(legacy.relatedWorkflows, [workflow.workflowId]);
  assert.deepEqual(legacy.unresolvedQuestions, []);
  assert.deepEqual(workflow, workflowBefore, "Legacy reads must remain non-mutating");
  const legacyArtifacts = await continuity.getArtifactCenter(legacyWorkflow.workflowId);
  assert.equal(legacyArtifacts.projectId, null);
  assert.deepEqual(legacyArtifacts.changes.observedChanges, [], "Legacy Workflow without a Review Package must project empty compatible artifacts");
  assert.match(await readFile(path.join(root, "project-briefs", "fixture.json"), "utf8"), /"projectId": "fixture"/);
  console.log(JSON.stringify({ ok: true, projectBrief: true, supervisorSession: true, artifactCenterReadOnly: true, legacyCompatible: true }, null, 2));
} finally {
  await rm(root, { recursive: true, force: true });
}
