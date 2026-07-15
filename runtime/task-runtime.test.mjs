import assert from "node:assert/strict";
import path from "node:path";
import { mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { FileTaskStore } from "./file-task-store.mjs";
import { TaskRuntime } from "./task-runtime.mjs";
import { resolveResourceProfile } from "./resource-profiles.mjs";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(moduleDirectory, "..");
const testRoot = path.join(projectRoot, ".agent-runs", `task-runtime-test-${process.pid}-${Date.now()}`);

assert.deepEqual(resolveResourceProfile("small_readonly").limits, { maxBudgetUsd: 1, maxTurns: 30, maxFilesRead: 30, maxCommands: 1, timeoutSeconds: 300 });
assert.deepEqual(resolveResourceProfile("exploration_readonly").limits, { maxBudgetUsd: 1.5, maxTurns: 100, maxFilesRead: 100, maxCommands: 1, timeoutSeconds: 1200 });
assert.deepEqual(resolveResourceProfile("review_readonly").limits, { maxBudgetUsd: 1.5, maxTurns: 50, maxFilesRead: 40, maxCommands: 1, timeoutSeconds: 600 });
assert.deepEqual(resolveResourceProfile("small_change").limits, { maxBudgetUsd: 1.5, maxTurns: 80, maxFilesRead: 50, maxCommands: 10, timeoutSeconds: 900 });
assert.deepEqual(resolveResourceProfile("medium_analysis").limits, { maxBudgetUsd: 2, maxTurns: 80, maxFilesRead: 100, maxCommands: 10, timeoutSeconds: 1200 });
assert.deepEqual(resolveResourceProfile("large_change").limits, { maxBudgetUsd: 4, maxTurns: 150, maxFilesRead: 200, maxCommands: 50, timeoutSeconds: 1800 });

class FakeRunner {
  constructor(delayMs = 40) {
    this.delayMs = delayMs;
    this.counter = 0;
    this.calls = [];
    this.forceMissingArtifact = false;
  }

  generateAttemptId() {
    this.counter += 1;
    return `20260713-120000-${String(this.counter).padStart(3, "0")}`;
  }

  async runAttempt(input) {
    this.calls.push(input);
    input.onSpawn?.({ pid: 4242 });
    await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    if (input.signal?.aborted) return { bridgeStatus: "cancelled", result: null, stderr: "cancelled" };
    if (this.forceMissingArtifact) return { bridgeStatus: "artifact_missing", result: null, stderr: "normalized result was not written" };
    return {
      bridgeStatus: "success",
      result: { status: "success", summary: "fake worker succeeded", artifact_status: "worker_reported_success", error: null },
      stderr: ""
    };
  }
}

async function waitFor(runtime, taskId, predicate, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let latest = null;
  while (Date.now() < deadline) {
    latest = await runtime.getTask(taskId);
    if (predicate(latest)) return latest;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for task ${taskId}: ${JSON.stringify(latest)}`);
}

await mkdir(testRoot, { recursive: true });
try {
  const store = new FileTaskStore(testRoot);
  const runner = new FakeRunner();
  const runtime = new TaskRuntime({ store, runner, heartbeatSeconds: 1, stalledAfterSeconds: 2 });
  await runtime.start();

  const created = await runtime.createTask({ prompt: "Inspect README", mode: "plan", mockWorker: true });
  assert.equal(created.status, "queued");
  assert.equal(created.currentAttempt, null);
  const completed = await waitFor(runtime, created.taskId, (task) => task.status === "succeeded");
  assert.equal(completed.settings.resourceProfile, "small_readonly");
  assert.equal(completed.settings.resourceLimits.maxFilesRead, 30);
  assert.equal(completed.attempts.length, 1);
  assert.equal(completed.attempts[0].resourceProfile, "small_readonly");
  assert.deepEqual(completed.attempts[0].resourceLimits, completed.settings.resourceLimits);
  assert.equal(completed.currentAttempt, completed.attempts[0].attemptId);
  assert.equal(completed.result.artifactReference.runId, completed.currentAttempt);

  const firstPage = await runtime.getTaskEvents(created.taskId, { afterSequence: 0, limit: 3 });
  assert.equal(firstPage.events[0].type, "task.created");
  assert.equal(firstPage.events[1].type, "task.queued");
  assert.equal(firstPage.hasMore, true);
  const secondPage = await runtime.getTaskEvents(created.taskId, { afterSequence: firstPage.lastSequence, limit: 100 });
  assert(secondPage.events.some((event) => event.type === "attempt.started"));
  assert(secondPage.events.some((event) => event.type === "task.completed"));
  assert(secondPage.events.every((event) => event.sequence > firstPage.lastSequence));

  runner.delayMs = 2600;
  const heartbeatTask = await runtime.createTask({ prompt: "Long enough to observe a heartbeat", mode: "plan", mockWorker: true });
  const heartbeatRunning = await waitFor(runtime, heartbeatTask.taskId, (task) => task.status === "running");
  const firstHeartbeat = Date.parse(heartbeatRunning.lastHeartbeat);
  await new Promise((resolve) => setTimeout(resolve, 2200));
  const heartbeatUpdated = await runtime.getTask(heartbeatTask.taskId);
  assert.equal(heartbeatUpdated.status, "running");
  assert(Date.parse(heartbeatUpdated.lastHeartbeat) > firstHeartbeat, "Task heartbeat did not advance while Worker remained active");
  assert.equal(heartbeatUpdated.heartbeatHealthy, true);
  assert.equal(heartbeatUpdated.progressStalled, true);
  assert.equal(heartbeatUpdated.activity, "stalled");
  await waitFor(runtime, heartbeatTask.taskId, (task) => task.status === "succeeded");
  runner.delayMs = 40;

  const waiting = await runtime.createTask({ prompt: "Write one bounded file", mode: "run", mockWorker: true });
  assert.equal(waiting.status, "waiting_approval");
  assert.equal(runner.calls.length, 2, "run task executed before approval");
  const approved = await runtime.approveTask(waiting.taskId, { approvedBy: "runtime-test", approvalReason: "Approve exact bounded fixture task." });
  assert.equal(approved.status, "queued");
  assert.equal(approved.approval.taskId, waiting.taskId);
  assert.equal(approved.approval.revision, waiting.revision);
  assert.equal(approved.approval.promptHash, waiting.promptHash);
  assert.deepEqual(approved.approval.capabilityBoundary, waiting.capabilityBoundary);
  const runCompleted = await waitFor(runtime, waiting.taskId, (task) => task.status === "succeeded");
  assert.equal(runCompleted.approval.attemptId, runCompleted.currentAttempt);
  assert.equal(runner.calls[2].approval.approvedBy, "runtime-test");

  const cancellable = await runtime.createTask({ prompt: "Wait for approval", mode: "run", mockWorker: true });
  const cancelled = await runtime.cancelTask(cancellable.taskId, { requestedBy: "runtime-test" });
  assert.equal(cancelled.status, "cancelled");

  runner.delayMs = 1000;
  const activeCancellation = await runtime.createTask({ prompt: "Cancel an active worker", mode: "plan", mockWorker: true });
  await waitFor(runtime, activeCancellation.taskId, (task) => task.status === "running");
  await runtime.cancelTask(activeCancellation.taskId, { requestedBy: "runtime-test" });
  const activeCancelled = await waitFor(runtime, activeCancellation.taskId, (task) => task.status === "cancelled");
  assert.equal(activeCancelled.currentStage, "cancelled");
  runner.delayMs = 40;

  runner.forceMissingArtifact = true;
  const missingArtifact = await runtime.createTask({ prompt: "Simulate missing normalized output", mode: "plan", mockWorker: true });
  const missingFailed = await waitFor(runtime, missingArtifact.taskId, (task) => task.status === "failed");
  assert.equal(missingFailed.error.code, "artifact_missing");
  runner.forceMissingArtifact = false;

  const explorationTask = await runtime.createTask({ prompt: "Explore a larger read-only project surface", mode: "plan", resourceProfile: "exploration_readonly", mockWorker: true });
  const explorationCompleted = await waitFor(runtime, explorationTask.taskId, (task) => task.status === "succeeded");
  assert.equal(explorationCompleted.settings.resourceProfile, "exploration_readonly");
  assert.equal(explorationCompleted.attempts[0].resourceProfile, "exploration_readonly");
  assert.deepEqual(explorationCompleted.attempts[0].resourceLimits, { maxBudgetUsd: 1.5, maxTurns: 100, maxFilesRead: 100, maxCommands: 1, timeoutSeconds: 1200 });

  const mediumAnalysis = await runtime.createTask({ prompt: "Inspect a larger architecture surface", mode: "plan", resourceProfile: "medium_analysis", mockWorker: true });
  const mediumCompleted = await waitFor(runtime, mediumAnalysis.taskId, (task) => task.status === "succeeded");
  assert.equal(mediumCompleted.settings.resourceProfile, "medium_analysis");
  assert.equal(mediumCompleted.settings.resourceLimits.maxFilesRead, 100);
  assert.equal(mediumCompleted.settings.resourceLimits.maxTurns, 80);
  assert.equal(runner.calls.at(-1).resourceProfile, "medium_analysis");
  assert.equal(runner.calls.at(-1).maxFilesRead, 100);

  await assert.rejects(
    runtime.createTask({ prompt: "Exceed the global hard budget", mode: "plan", resourceProfile: "medium_analysis", maxBudgetUsd: 5.01, mockWorker: true }),
    /exceeds hard limit 5/
  );

  const restartStore = new FileTaskStore(path.join(testRoot, "restart-case"));
  await restartStore.init();
  const timestamp = new Date().toISOString();
  const restartTask = {
    schemaVersion: 1,
    taskId: "task_restart_fixture",
    revision: 1,
    prompt: "Interrupted fixture",
    promptHash: "fixture",
    mode: "plan",
    status: "running",
    createdAt: timestamp,
    updatedAt: timestamp,
    lastHeartbeat: timestamp,
    lastEventTime: null,
    currentStage: "worker_running",
    currentAttempt: "20260713-120000-999",
    lastEventSequence: 0,
    settings: { workerTimeoutSeconds: 30, maxBudgetUsd: 0.1, mockWorker: true },
    capabilityBoundary: { mode: "plan" },
    approval: null,
    attempts: [{ attemptId: "20260713-120000-999", runId: "20260713-120000-999", status: "running", startedAt: timestamp }],
    result: null,
    error: null
  };
  await restartStore.createTask(restartTask);
  await restartStore.writeAttempt(restartTask.taskId, restartTask.attempts[0]);
  const queuedRestartTask = {
    ...restartTask,
    taskId: "task_queued_restart_fixture",
    prompt: "Queued restart fixture",
    status: "queued",
    lastHeartbeat: null,
    currentStage: "queued",
    currentAttempt: null,
    attempts: []
  };
  await restartStore.createTask(queuedRestartTask);
  const restartedRuntime = new TaskRuntime({ store: restartStore, runner: new FakeRunner() });
  await restartedRuntime.start();
  const interrupted = await restartedRuntime.getTask(restartTask.taskId);
  assert.equal(interrupted.status, "interrupted");
  assert.equal(interrupted.workflowId, undefined, "Legacy Task unexpectedly required Workflow metadata");
  assert.equal(interrupted.attempts[0].status, "interrupted");
  const restartEvents = await restartedRuntime.getTaskEvents(restartTask.taskId);
  assert.equal(restartEvents.events.at(-1).type, "task.interrupted");
  const resumedQueued = await waitFor(restartedRuntime, queuedRestartTask.taskId, (task) => task.status === "succeeded");
  assert.equal(resumedQueued.attempts.length, 1, "Queued task was not resumed after Runtime restart");

  console.log(JSON.stringify({ ok: true, planTaskId: created.taskId, runTaskId: waiting.taskId, eventCount: completed.lastEventSequence }, null, 2));
} finally {
  await rm(testRoot, { recursive: true, force: true });
}
