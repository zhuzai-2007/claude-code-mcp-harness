import assert from "node:assert/strict";
import path from "node:path";
import { mkdir, readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { FileTaskStore } from "./file-task-store.mjs";
import { FileWorkflowStore } from "./file-workflow-store.mjs";
import { TaskRuntime } from "./task-runtime.mjs";
import { WorkflowRuntime, WORKFLOW_ROLE_MODES } from "./workflow-runtime.mjs";
import { loadWorkflowDefinitions } from "./workflow-definitions.mjs";
import { WorkflowPlanner } from "./workflow-planner.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = path.join(projectRoot, ".agent-runs", `workflow-runtime-test-${process.pid}-${Date.now()}`);

class FakeRunner {
  constructor() { this.counter = 0; this.calls = []; this.projectRoot = projectRoot; }
  generateAttemptId() { this.counter += 1; return `20260714-120000-${String(this.counter).padStart(3, "0")}`; }
  async runAttempt(input) {
    this.calls.push(input);
    input.onSpawn?.({ pid: 4242 });
    await new Promise((resolve) => setTimeout(resolve, 30));
    if (input.prompt.includes("FORCE_FAILURE") || (input.mode === "run" && input.prompt.includes("FORCE_CODER_FAILURE"))) return { bridgeStatus: "failed", result: { status: "worker_failed", summary: "forced failure", artifact_status: "worker_output_needs_review", error: { code: "worker_crash", message: "fixture failure" } }, stderr: "fixture failure" };
    return { bridgeStatus: "success", result: { status: "success", summary: `${input.mode} complete`, artifact_status: "worker_reported_success", error: null }, stderr: "" };
  }
}

async function waitForTask(taskRuntime, taskId, status = "succeeded") {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const task = await taskRuntime.getTask(taskId);
    if (task?.status === status) return task;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${taskId}=${status}`);
}

await mkdir(root, { recursive: true });
try {
  const definitions = await loadWorkflowDefinitions();
  const workflowPlanner = new WorkflowPlanner({ definitions });
  const taskStore = new FileTaskStore(root);
  const workflowStore = new FileWorkflowStore(root);
  const runner = new FakeRunner();
  const taskRuntime = new TaskRuntime({ store: taskStore, runner });
  const workflowRuntime = new WorkflowRuntime({
    store: workflowStore,
    taskRuntime,
    definitions,
    workflowPlanner,
    autoReconcile: false,
    resultProvider: (attemptId) => {
      if (attemptId.endsWith("001")) return { summary: "Plan search", files_read: ["app.js"], proposed_changes: ["Add search"] };
      if (attemptId.endsWith("004")) return {
        summary: "Plan a medium multi-file change",
        files_read: ["app.js", "index.html"],
        proposed_changes: [
          { file: "app.js", type: "modify" },
          { file: "index.html", type: "modify" },
          { file: "tests.html", type: "create" }
        ],
        risks: ["Compatibility"],
        blocked_on: []
      };
      if (attemptId.endsWith("006")) return {
        summary: "Plan a large cross-file change",
        files_read: ["src/index.js"],
        proposed_changes: Array.from({ length: 8 }, (_, index) => ({ file: `src/file-${index}.js`, type: "modify" })),
        risks: [],
        blocked_on: []
      };
      return { summary: "Implemented search", files_read: ["app.js"], changes_made: ["app.js"], tests_or_checks: ["Read app.js"], run_result: { type: "modified" } };
    }
  });
  await taskRuntime.start();
  await workflowRuntime.start();

  assert.deepEqual(WORKFLOW_ROLE_MODES, { planner: "plan", coder: "run", reviewer: "review" });
  assert.deepEqual(definitions.definitions.software_change.stages.map(({ role, mode, requiresApproval, resourceProfile }) => ({ role, mode, requiresApproval, resourceProfile })), [
    { role: "planner", mode: "plan", requiresApproval: false, resourceProfile: "exploration_readonly" },
    { role: "coder", mode: "run", requiresApproval: true, resourceProfile: "small_change" },
    { role: "reviewer", mode: "review", requiresApproval: false, resourceProfile: "review_readonly" }
  ]);
  assert.deepEqual(definitions.definitions.software_change.stages.find((stage) => stage.role === "coder").resourceProfilePolicy.tiers, {
    small: "small_change",
    medium: "medium_change",
    large: "large_change"
  });
  assert.deepEqual(definitions.definitions.documentation_change.stages.map(({ role, resourceProfile }) => ({ role, resourceProfile })), [
    { role: "planner", resourceProfile: "small_readonly" },
    { role: "coder", resourceProfile: "small_change" },
    { role: "reviewer", resourceProfile: "review_readonly" }
  ]);

  const created = await workflowRuntime.createWorkflow({ userRequest: "Add bounded search to the task board" });
  assert.equal(created.status, "planning");
  assert.equal(created.workflowPlan.workflowType, "software_change");
  assert.deepEqual(created.workflowPlan.stages, ["planner", "approval", "coder", "reviewer"]);
  assert.equal(created.currentStage, "planning");
  assert.equal(created.tasks.length, 1, "Planner Task was not created automatically");
  assert.equal(created.tasks[0].role, "planner");
  const plannerTaskId = created.tasks[0].taskId;
  await waitForTask(taskRuntime, plannerTaskId);

  const waiting = await workflowRuntime.reconcileWorkflow(created.workflowId);
  assert.equal(waiting.status, "waiting_approval");
  assert.equal(waiting.currentStage, "implementation");
  assert.equal(waiting.nextAction.type, "approve_workflow");
  const waitingCoderStage = waiting.stages.find((stage) => stage.role === "coder");
  assert.equal(waitingCoderStage.taskId, null, "Coder Task was created before human approval");
  assert.equal(waitingCoderStage.resourceProfile, "small_change");
  assert.equal(waitingCoderStage.resourceSelection.tier, "small");
  assert.equal((await taskRuntime.listTasks()).filter((task) => task.workflowId === created.workflowId).length, 1, "Unapproved Workflow created more than the planner Task");

  const approved = await workflowRuntime.approveWorkflow(created.workflowId, { approvedBy: "workflow-test", approvalReason: "Approve the bounded implementation plan." });
  const coderStage = approved.stages.find((stage) => stage.role === "coder");
  assert(coderStage.taskId, "Coder Task was not created after approval");
  const coderTask = await taskRuntime.getTask(coderStage.taskId);
  assert.equal(coderTask.mode, "run");
  assert.equal(coderTask.approval.approvedBy, "workflow-test");
  assert.equal(coderTask.approval.approvalReason, "Approve the bounded implementation plan.");
  assert.equal(coderTask.approval.promptHash, coderTask.promptHash, "Workflow approval did not preserve Task prompt binding");
  await waitForTask(taskRuntime, coderStage.taskId);

  const reviewing = await workflowRuntime.reconcileWorkflow(created.workflowId);
  assert.equal(reviewing.status, "reviewing");
  const reviewerStage = reviewing.stages.find((stage) => stage.role === "reviewer");
  assert(reviewerStage.taskId, "Reviewer Task was not created automatically after coder success");
  assert.match((await taskRuntime.getTask(reviewerStage.taskId)).prompt, /Modified files: \["app.js"\]/);
  await waitForTask(taskRuntime, reviewerStage.taskId);

  const completed = await workflowRuntime.reconcileWorkflow(created.workflowId);
  assert.equal(completed.status, "completed");
  assert.equal(completed.currentStage, "completed");
  assert.deepEqual(completed.stages.map(({ role, status }) => ({ role, status })), [
    { role: "planner", status: "succeeded" },
    { role: "coder", status: "succeeded" },
    { role: "reviewer", status: "succeeded" }
  ]);
  assert.deepEqual(completed.counts, { total: 3, succeeded: 3, running: 0, failed: 0 });

  const events = await workflowRuntime.getWorkflowEvents(created.workflowId);
  assert(events.events.some((event) => event.type === "workflow.planning_completed"));
  assert(events.events.some((event) => event.type === "workflow.stage_resource_selected"));
  assert(events.events.some((event) => event.type === "workflow.approval_requested"));
  assert(events.events.some((event) => event.type === "workflow.approval_completed"));
  assert(events.events.some((event) => event.type === "workflow.completed"));
  const stableEventKey = (event) => `${event.source}:${event.taskId || event.workflowId}:${event.eventId || event.sourceSequence}`;
  const stableSequences = new Map(events.events.map((event) => [stableEventKey(event), event.sequence]));
  const plannerEvents = await taskStore.readEvents(plannerTaskId, { afterSequence: 0, limit: Number.MAX_SAFE_INTEGER });
  const lateSourceSequence = Math.max(...plannerEvents.map((event) => Number(event.sequence) || 0)) + 1;
  await taskStore.appendEvent(plannerTaskId, {
    schemaVersion: 1,
    eventId: `${plannerTaskId}:${lateSourceSequence}`,
    sequence: lateSourceSequence,
    timestamp: "2000-01-01T00:00:00.000Z",
    taskId: plannerTaskId,
    type: "task.synthetic_late_event",
    source: "task_runtime",
    payload: { fixture: true }
  });
  const latePage = await workflowRuntime.getWorkflowEvents(created.workflowId, { afterSequence: events.lastSequence, limit: 100 });
  assert.equal(latePage.events.length, 1, "A late Task event must remain visible after the previous Workflow cursor");
  assert.equal(latePage.events[0].type, "task.synthetic_late_event");
  assert(latePage.events[0].sequence > events.lastSequence, "A newly discovered event must receive a new monotonic Workflow sequence");
  const eventsAfterLateArrival = await workflowRuntime.getWorkflowEvents(created.workflowId);
  for (const event of eventsAfterLateArrival.events) {
    const previous = stableSequences.get(stableEventKey(event));
    if (previous) assert.equal(event.sequence, previous, `Workflow event sequence drifted for ${event.eventId}`);
  }

  const persisted = JSON.parse(await readFile(path.join(root, "workflows", created.workflowId, "workflow.json"), "utf8"));
  assert.equal(persisted.status, "completed");
  assert(persisted.tasks.every((task) => task.status === "succeeded"));
  assert.equal(persisted.approvals.implementation.approvedBy, "workflow-test");
  assert.equal(persisted.approvals.implementation.resourceProfile, "small_change");

  const mediumWorkflow = await workflowRuntime.createWorkflow({ userRequest: "Change the UI, storage, and add a test file" });
  await waitForTask(taskRuntime, mediumWorkflow.tasks[0].taskId);
  const mediumWaiting = await workflowRuntime.reconcileWorkflow(mediumWorkflow.workflowId);
  const mediumCoderStage = mediumWaiting.stages.find((stage) => stage.role === "coder");
  assert.equal(mediumCoderStage.resourceProfile, "medium_change", "Planner scope must upgrade a multi-file Coder stage");
  assert.equal(mediumCoderStage.resourceSelection.source, "planner_audit");
  assert.equal(mediumCoderStage.resourceSelection.limits.maxBudgetUsd, 2.5);
  const mediumApproved = await workflowRuntime.approveWorkflow(mediumWorkflow.workflowId, { approvedBy: "resource-reviewer", approvalReason: "Approve the Planner-selected medium resource envelope." });
  const mediumCoderTask = await taskRuntime.getTask(mediumApproved.stages.find((stage) => stage.role === "coder").taskId);
  assert.equal(mediumCoderTask.settings.resourceProfile, "medium_change", "Coder Attempt must freeze the Planner-selected profile");
  assert.equal(mediumApproved.approvals.implementation.resourceProfile, "medium_change", "Approval must bind the selected profile");
  await waitForTask(taskRuntime, mediumCoderTask.taskId);

  const largeWorkflow = await workflowRuntime.createWorkflow({ userRequest: "Apply a broad cross-file software change" });
  await waitForTask(taskRuntime, largeWorkflow.tasks[0].taskId);
  const largeWaiting = await workflowRuntime.reconcileWorkflow(largeWorkflow.workflowId);
  const largeCoderStage = largeWaiting.stages.find((stage) => stage.role === "coder");
  assert.equal(largeCoderStage.resourceProfile, "large_change", "Planner scope must upgrade a broad Coder stage to the large tier");
  assert.equal(largeCoderStage.resourceSelection.metrics.uniqueFiles, 8);

  const decisionWorkflow = await workflowRuntime.createWorkflow({
    userRequest: "Inspect the registered task board",
    supervisorDecision: {
      decisionId: "decision_runtime_fixture",
      intent: "analysis",
      goal: "Inspect the registered task board",
      technical_summary: "Inspect only the registered task board and report bounded findings.",
      implementation_strategy: "Trace the task board state path without modifying files.",
      expected_changes: [],
      validation_plan: ["Confirm the relevant state and rendering paths from source evidence."],
      supervisor_context: { projectId: "dogfood-study-board", file: "AI_SUPERVISOR.md", digest: "fixture", instructions: "SUPERVISOR_ONLY_SENTINEL" },
      originalRequest: "Inspect the registered task board",
      projectId: "dogfood-study-board",
      workspacePath: path.join(projectRoot, "workspace", "dogfood-study-board").replaceAll("\\", "/"),
      project: { projectId: "dogfood-study-board", id: "dogfood-study-board", name: "Dogfood Study Board", workspacePath: path.join(projectRoot, "workspace", "dogfood-study-board").replaceAll("\\", "/"), path: "workspace/dogfood-study-board", description: "fixture", language: "JavaScript", lastUsed: null },
      reasoning: ["The request is read-only and targets one registered project."],
      risks: ["Analysis may be incomplete if relevant files are outside the registered project."],
      workflowType: "analysis_only",
      confidence: 0.96,
      estimated_resources: { basis: "fixture", complexity: "low", expected: { budgetUsd: 0.2, turns: 10, filesRead: 5, commands: 0, timeoutSeconds: 120 }, hard_caps: { budgetUsd: 1.5, turns: 100, filesRead: 100, commands: 1, timeoutSeconds: 1200 }, stages: [], within_hard_caps: true, notes: [] },
      recommended_actions: ["Run the read-only analysis Workflow."],
      constraints: ["Only inspect or modify files under registered project 'workspace/dogfood-study-board'."],
      nextAction: "create_workflow",
      source: "gpt"
    },
    session: { sessionId: "session_runtime_fixture", projectId: "dogfood-study-board", name: "Runtime fixture", workflowIds: [] }
  });
  assert.equal(decisionWorkflow.workflowPlan.selection, "supervisor_decision");
  assert.equal(decisionWorkflow.supervisorDecision.decisionId, "decision_runtime_fixture");
  assert.equal(decisionWorkflow.project.path, "workspace/dogfood-study-board");
  assert.equal(decisionWorkflow.projectId, "dogfood-study-board");
  assert.equal(decisionWorkflow.workspacePath, path.join(projectRoot, "workspace", "dogfood-study-board").replaceAll("\\", "/"));
  assert.equal(decisionWorkflow.sessionId, "session_runtime_fixture");
  const decisionTask = await taskRuntime.getTask(decisionWorkflow.tasks[0].taskId);
  assert.equal(decisionTask.projectId, "dogfood-study-board");
  assert.equal(decisionTask.workspacePath, decisionWorkflow.workspacePath);
  assert.equal(decisionTask.sessionId, "session_runtime_fixture");
  assert.equal(decisionTask.executionDirectory, projectRoot.replaceAll("\\", "/"), "Task must record the actual Harness execution directory separately from the bound workspace");
  assert.match(decisionTask.prompt, /Supervisor decision \(authoritative task context\)/);
  assert.match(decisionTask.prompt, /Inspect only the registered task board/);
  assert.match(decisionTask.prompt, /implementation_strategy/);
  assert.match(decisionTask.prompt, /Trace the task board state path/);
  assert.match(decisionTask.prompt, /expected_changes/);
  assert.match(decisionTask.prompt, /acceptance_criteria/);
  assert.match(decisionTask.prompt, /Confirm the relevant state and rendering paths/);
  assert.doesNotMatch(decisionTask.prompt, /SUPERVISOR_ONLY_SENTINEL/, "AI_SUPERVISOR.md content must not become a Worker prompt");
  assert.match(decisionTask.prompt, /Do not inspect sibling projects/);
  const completedDecisionTask = await waitForTask(taskRuntime, decisionWorkflow.tasks[0].taskId);
  assert.equal(completedDecisionTask.attempts[0].projectId, "dogfood-study-board");
  assert.equal(completedDecisionTask.attempts[0].workspacePath, decisionWorkflow.workspacePath);
  assert.equal(completedDecisionTask.attempts[0].executionDirectory, projectRoot.replaceAll("\\", "/"));
  assert.equal(completedDecisionTask.attempts[0].sessionId, "session_runtime_fixture");
  await workflowRuntime.reconcileWorkflow(decisionWorkflow.workflowId);
  const decisionEvents = await workflowRuntime.getWorkflowEvents(decisionWorkflow.workflowId);
  assert.equal(decisionEvents.events[0].type, "workflow.supervisor_decision_recorded");

  const analysisOnly = await workflowRuntime.createWorkflow({ userRequest: "分析当前项目架构并说明风险" });
  assert.equal(analysisOnly.definitionId, "analysis_only");
  assert.equal(analysisOnly.tasks[0].resourceProfile, "exploration_readonly");
  await waitForTask(taskRuntime, analysisOnly.tasks[0].taskId);
  const analysisCompleted = await workflowRuntime.reconcileWorkflow(analysisOnly.workflowId);
  assert.equal(analysisCompleted.status, "completed");
  assert.equal(analysisCompleted.tasks.length, 1);
  assert.deepEqual(analysisCompleted.approvals, {});

  const documentation = await workflowRuntime.createWorkflow({ userRequest: "更新 README 使用说明" });
  assert.equal(documentation.definitionId, "documentation_change");
  assert(documentation.workflowPlan.constraints.some((constraint) => constraint.includes("documentation")));
  await waitForTask(taskRuntime, documentation.tasks[0].taskId);

  const rejected = await workflowRuntime.createWorkflow({ userRequest: "Add a rejected beta feature" });
  await waitForTask(taskRuntime, rejected.tasks[0].taskId);
  await workflowRuntime.reconcileWorkflow(rejected.workflowId);
  const rejectedFinal = await workflowRuntime.rejectWorkflow(rejected.workflowId, { rejectedBy: "beta-reviewer", rejectionReason: "The proposed scope is too broad." });
  assert.equal(rejectedFinal.status, "failed");
  assert.equal(rejectedFinal.failure.error.code, "approval_rejected");
  assert.equal(rejectedFinal.rejections.implementation.rejectedBy, "beta-reviewer");
  assert.equal(rejectedFinal.stages.find((stage) => stage.role === "coder").taskId, null, "Rejected Workflow created a coder Task");
  assert.equal((await taskRuntime.listTasks()).filter((task) => task.workflowId === rejected.workflowId).length, 1);
  await assert.rejects(() => workflowRuntime.approveWorkflow(rejected.workflowId, { approvedBy: "late", approvalReason: "Must remain rejected." }), /not waiting for approval/);

  const failed = await workflowRuntime.createWorkflow({ userRequest: "FORCE_FAILURE" });
  await waitForTask(taskRuntime, failed.tasks[0].taskId, "failed");
  const failedWorkflow = await workflowRuntime.reconcileWorkflow(failed.workflowId);
  assert.equal(failedWorkflow.status, "failed");
  assert.equal(failedWorkflow.failure.failedStage, "planning");
  assert.equal(failedWorkflow.failure.taskId, failed.tasks[0].taskId);
  assert.equal(failedWorkflow.failure.error.code, "worker_crash");

  const recovered = await workflowRuntime.retryWorkflow(failed.workflowId, { requestedBy: "recovery-test", recoveryReason: "Provider connectivity was restored." });
  assert.notEqual(recovered.workflow.workflowId, failed.workflowId);
  assert.equal(recovered.workflow.recovery.sourceWorkflowId, failed.workflowId);
  assert.equal(recovered.workflow.recovery.sourceFailure.failedStage, "planning");
  assert.deepEqual(recovered.workflow.approvals, {}, "Recovery must not reuse old approval metadata");
  assert.deepEqual(recovered.workflow.rejections, {}, "Recovery must not reuse old rejection metadata");
  assert.equal(recovered.workflow.tasks.length, 1, "Recovery must restart from a new Planner Task");
  assert.notEqual(recovered.workflow.tasks[0].taskId, failed.tasks[0].taskId);
  assert.equal(recovered.sourceWorkflow.status, "failed", "Source history must remain failed");
  assert.equal(recovered.sourceWorkflow.recoveries.at(-1).workflowId, recovered.workflow.workflowId);
  await waitForTask(taskRuntime, recovered.workflow.tasks[0].taskId, "failed");
  await workflowRuntime.reconcileWorkflow(recovered.workflow.workflowId);
  const recoveryEvents = await workflowRuntime.getWorkflowEvents(recovered.workflow.workflowId);
  assert(recoveryEvents.events.some((event) => event.type === "workflow.recovery_started"));
  const sourceRecoveryEvents = await workflowRuntime.getWorkflowEvents(failed.workflowId);
  assert(sourceRecoveryEvents.events.some((event) => event.type === "workflow.recovery_created"));
  await assert.rejects(() => workflowRuntime.retryWorkflow(created.workflowId, { requestedBy: "recovery-test", recoveryReason: "Must reject active Workflow." }), /Only failed Workflows/);

  const coderFailure = await workflowRuntime.createWorkflow({ userRequest: "FORCE_CODER_FAILURE" });
  await waitForTask(taskRuntime, coderFailure.tasks[0].taskId);
  await workflowRuntime.reconcileWorkflow(coderFailure.workflowId);
  const approvedCoderFailure = await workflowRuntime.approveWorkflow(coderFailure.workflowId, { approvedBy: "failure-test", approvalReason: "Exercise coder failure aggregation." });
  const failedCoderTaskId = approvedCoderFailure.stages.find((stage) => stage.role === "coder").taskId;
  await waitForTask(taskRuntime, failedCoderTaskId, "failed");
  const coderFailedWorkflow = await workflowRuntime.reconcileWorkflow(coderFailure.workflowId);
  assert.equal(coderFailedWorkflow.status, "failed");
  assert.equal(coderFailedWorkflow.failure.failedStage, "implementation");
  assert.equal(coderFailedWorkflow.failure.taskId, failedCoderTaskId);

  const backgroundRuntime = new WorkflowRuntime({
    store: workflowStore,
    taskRuntime,
    definitions,
    workflowPlanner,
    orchestratorIntervalMs: 100,
    autoReconcile: true,
    resultProvider: () => ({ summary: "bounded background audit", proposed_changes: ["change"], changes_made: ["app.js"], tests_or_checks: ["read"] })
  });
  await backgroundRuntime.start();
  const background = await backgroundRuntime.createWorkflow({ userRequest: "Background orchestrator progression" });
  await new Promise((resolve) => setTimeout(resolve, 350));
  const backgroundWaiting = await workflowStore.readWorkflow(background.workflowId);
  assert.equal(backgroundWaiting.status, "waiting_approval", "Background Orchestrator did not advance planner completion without a status query");
  assert.equal(backgroundWaiting.stages.find((stage) => stage.role === "coder").taskId, null);
  await backgroundRuntime.approveWorkflow(background.workflowId, { approvedBy: "background-test", approvalReason: "Approve background bounded flow." });
  await new Promise((resolve) => setTimeout(resolve, 800));
  const backgroundCompleted = await workflowStore.readWorkflow(background.workflowId);
  assert.equal(backgroundCompleted.status, "completed", "Background Orchestrator did not create coder/reviewer and complete without polling getWorkflow");
  backgroundRuntime.stop();

  const legacyTask = await taskRuntime.createTask({ prompt: "Legacy standalone plan", mode: "plan", mockWorker: true });
  await waitForTask(taskRuntime, legacyTask.taskId);
  const timestamp = new Date().toISOString();
  await workflowStore.createWorkflow({ schemaVersion: 1, workflowId: "workflow_legacy_fixture", userRequest: "Legacy v0.2", status: "created", createdAt: timestamp, updatedAt: timestamp, tasks: [{ taskId: legacyTask.taskId, role: "planner", mode: "plan", addedAt: timestamp }], lastEventSequence: 0 });
  const legacy = await workflowRuntime.getWorkflow("workflow_legacy_fixture");
  assert.equal(legacy.status, "succeeded");
  assert.equal(legacy.orchestrated, undefined);
  assert.equal(legacy.projectId, undefined, "Legacy Workflow remains readable without a Project binding");

  await workflowStore.createWorkflow({
    schemaVersion: 1,
    workflowId: "workflow_legacy_create_fixture",
    userRequest: "Legacy createTask compatibility",
    status: "created",
    createdAt: timestamp,
    updatedAt: timestamp,
    projectBinding: { projectId: "legacy-project", workspacePath: projectRoot.replaceAll("\\", "/") },
    sessionId: "session_legacy_fixture",
    tasks: [],
    lastEventSequence: 0
  });
  await workflowStore.appendEvent("workflow_legacy_create_fixture", { schemaVersion: 1, eventId: "workflow_legacy_create_fixture:4", sequence: 4, timestamp, workflowId: "workflow_legacy_create_fixture", type: "workflow.legacy_fixture", source: "workflow_runtime", payload: {} });
  const restartedWorkflowRuntime = new WorkflowRuntime({ store: workflowStore, taskRuntime, definitions, workflowPlanner, autoReconcile: false });
  await restartedWorkflowRuntime.start();
  assert.equal((await workflowStore.readWorkflow("workflow_legacy_create_fixture")).lastEventSequence, 4, "Workflow restart did not recover the durable event sequence");
  const legacyCreated = await restartedWorkflowRuntime.createTask("workflow_legacy_create_fixture", { role: "planner", prompt: "Legacy bounded plan", mockWorker: true });
  assert.equal(legacyCreated.task.projectId, "legacy-project");
  assert.equal(legacyCreated.task.sessionId, "session_legacy_fixture");
  const legacyCreateEvents = await workflowStore.readEvents("workflow_legacy_create_fixture");
  assert.equal(legacyCreateEvents.at(-1).sequence, 5);
  assert.equal(legacyCreateEvents.at(-1).eventId, "workflow_legacy_create_fixture:5");
  await waitForTask(taskRuntime, legacyCreated.task.taskId);

  console.log(JSON.stringify({ ok: true, workflowId: created.workflowId, plannerTaskId, coderTaskId: coderStage.taskId, reviewerTaskId: reviewerStage.taskId, finalStatus: completed.status, failedStage: failedWorkflow.failure.failedStage }, null, 2));
} finally {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
