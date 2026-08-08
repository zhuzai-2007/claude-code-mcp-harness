import { createHash, randomBytes } from "node:crypto";
import { resolveResourceProfile } from "./resource-profiles.mjs";

const TERMINAL_STATUSES = new Set(["succeeded", "failed", "cancelled", "interrupted"]);
const VALID_MODES = new Set(["plan", "review", "run"]);
const ALLOWED_TRANSITIONS = {
  queued: new Set(["running", "waiting_approval", "cancelled", "failed"]),
  running: new Set(["succeeded", "failed", "cancelled", "interrupted"]),
  waiting_approval: new Set(["queued", "cancelled", "failed"]),
  succeeded: new Set(),
  failed: new Set(),
  cancelled: new Set(),
  interrupted: new Set()
};

function nowIso() {
  return new Date().toISOString();
}

function promptHash(prompt) {
  return createHash("sha256").update(prompt, "utf8").digest("hex");
}

function publicError(error) {
  return { code: "runtime_error", message: String(error?.message || error) };
}

function normalizeProjectContext(projectContext) {
  if (!projectContext) return null;
  const projectId = String(projectContext.projectId || "").trim();
  const workspacePath = String(projectContext.workspacePath || "").trim().replaceAll("\\", "/");
  if (!projectId || !workspacePath) throw new Error("projectContext requires projectId and workspacePath");
  return { projectId, name: String(projectContext.name || projectId), workspacePath, workspaceRelativePath: projectContext.workspaceRelativePath || null };
}

function ensureTaskResourceProfile(task) {
  const settings = task.settings || {};
  const resolved = resolveResourceProfile(settings.resourceProfile, {
    ...(settings.maxBudgetUsd == null ? {} : { maxBudgetUsd: settings.maxBudgetUsd }),
    ...(settings.maxTurns == null ? {} : { maxTurns: settings.maxTurns }),
    ...(settings.maxFilesRead == null ? {} : { maxFilesRead: settings.maxFilesRead }),
    ...(settings.maxCommands == null ? {} : { maxCommands: settings.maxCommands }),
    ...(settings.workerTimeoutSeconds == null ? {} : { timeoutSeconds: settings.workerTimeoutSeconds })
  });
  task.settings = {
    ...settings,
    resourceProfile: resolved.name,
    resourceLimits: resolved.limits,
    workerTimeoutSeconds: resolved.limits.timeoutSeconds,
    maxBudgetUsd: resolved.limits.maxBudgetUsd,
    maxTurns: resolved.limits.maxTurns,
    maxFilesRead: resolved.limits.maxFilesRead,
    maxCommands: resolved.limits.maxCommands
  };
  task.capabilityBoundary = {
    ...(task.capabilityBoundary || {}),
    resourceProfile: resolved.name,
    resourceLimits: resolved.limits,
    workerTimeoutSeconds: resolved.limits.timeoutSeconds,
    maxBudgetUsd: resolved.limits.maxBudgetUsd
  };
}

function transition(task, nextStatus) {
  if (task.status === nextStatus) return;
  if (!ALLOWED_TRANSITIONS[task.status]?.has(nextStatus)) {
    throw new Error(`Invalid task transition: ${task.status} -> ${nextStatus}`);
  }
  task.status = nextStatus;
}

export class TaskRuntime {
  constructor({ store, runner, heartbeatSeconds = 15, stalledAfterSeconds = 60, maxConcurrentTasks = 1 }) {
    this.store = store;
    this.runner = runner;
    this.heartbeatMs = Math.max(1000, Number(heartbeatSeconds) * 1000);
    this.stalledAfterMs = Math.max(this.heartbeatMs * 2, Number(stalledAfterSeconds) * 1000);
    this.maxConcurrentTasks = Math.max(1, Number(maxConcurrentTasks) || 1);
    this.pending = [];
    this.pendingSet = new Set();
    this.activeCount = 0;
    this.activeAttempts = new Map();
    this.cancelRequests = new Set();
    this.locks = new Map();
    this.started = false;
  }

  async start() {
    if (this.started) return;
    await this.store.init();
    const tasks = await this.store.listTasks();
    for (const task of tasks) {
      ensureTaskResourceProfile(task);
      await this.store.writeTask(task);
      const maxSequence = await this.store.maxEventSequence(task.taskId);
      if (maxSequence > Number(task.lastEventSequence || 0)) {
        task.lastEventSequence = maxSequence;
        await this.store.writeTask(task);
      }
      if (task.status === "running") {
        await this._mutate(task.taskId, async (current, emit) => {
          transition(current, "interrupted");
          current.currentStage = "interrupted_after_runtime_restart";
          const attempt = current.attempts.find((item) => item.attemptId === current.currentAttempt);
          if (attempt && attempt.status === "running") {
            attempt.status = "interrupted";
            attempt.completedAt = nowIso();
            attempt.error = { code: "runtime_restarted", message: "Task Runtime restarted while the attempt was running." };
            await this.store.writeAttempt(current.taskId, attempt);
          }
          emit("task.interrupted", { reason: "runtime_restarted", attemptId: current.currentAttempt });
        });
      } else if (task.status === "queued") {
        this._enqueue(task.taskId);
      }
    }
    this.started = true;
    this._drain();
  }

  async createTask({ prompt, mode = "plan", resourceProfile = null, workerTimeoutSeconds, maxBudgetUsd, maxTurns, maxFilesRead, maxCommands, mockWorker = false, workflowId = null, role = null, projectContext = null, sessionId = null }) {
    const normalizedPrompt = String(prompt || "").trim();
    if (!normalizedPrompt) throw new Error("prompt is required");
    if (!VALID_MODES.has(mode)) throw new Error(`Unsupported task mode: ${mode}`);
    const selectedProfile = resolveResourceProfile(resourceProfile, {
      ...(maxBudgetUsd == null ? {} : { maxBudgetUsd }),
      ...(maxTurns == null ? {} : { maxTurns }),
      ...(maxFilesRead == null ? {} : { maxFilesRead }),
      ...(maxCommands == null ? {} : { maxCommands }),
      ...(workerTimeoutSeconds == null ? {} : { timeoutSeconds: workerTimeoutSeconds })
    });
    const resourceLimits = selectedProfile.limits;
    const projectBinding = normalizeProjectContext(projectContext);
    const executionDirectory = String(this.runner.projectRoot || "").replaceAll("\\", "/") || null;
    const createdAt = nowIso();
    const taskId = `task_${Date.now().toString(36)}_${randomBytes(6).toString("hex")}`;
    const boundary = {
      mode,
      resourceProfile: selectedProfile.name,
      resourceLimits,
      workerTimeoutSeconds: resourceLimits.timeoutSeconds,
      maxBudgetUsd: resourceLimits.maxBudgetUsd,
      network: false,
      dependencyInstall: false,
      gitWrite: false,
      recursiveDelete: false,
      externalDirectories: [],
      ...(projectBinding ? { projectId: projectBinding.projectId, workspacePath: projectBinding.workspacePath } : {})
    };
    const task = {
      schemaVersion: 1,
      taskId,
      revision: 1,
      prompt: normalizedPrompt,
      promptHash: promptHash(normalizedPrompt),
      mode,
      status: mode === "run" ? "waiting_approval" : "queued",
      createdAt,
      updatedAt: createdAt,
      lastHeartbeat: null,
      lastEventTime: null,
      currentStage: mode === "run" ? "waiting_for_approval" : "queued",
      currentAttempt: null,
      lastEventSequence: 0,
      settings: {
        resourceProfile: selectedProfile.name,
        resourceLimits,
        workerTimeoutSeconds: resourceLimits.timeoutSeconds,
        maxBudgetUsd: resourceLimits.maxBudgetUsd,
        maxTurns: resourceLimits.maxTurns,
        maxFilesRead: resourceLimits.maxFilesRead,
        maxCommands: resourceLimits.maxCommands,
        mockWorker: Boolean(mockWorker)
      },
      capabilityBoundary: boundary,
      approval: null,
      attempts: [],
      result: null,
      error: null,
      projectContext: projectBinding,
      projectId: projectBinding?.projectId || null,
      workspacePath: projectBinding?.workspacePath || null,
      executionDirectory,
      sessionId: sessionId || null,
      ...(workflowId ? { workflowId, role } : {})
    };
    await this.store.createTask(task);
    const created = await this._mutate(taskId, (current, emit) => {
      emit("task.created", { mode: current.mode, revision: current.revision, promptHash: current.promptHash, resourceProfile: current.settings.resourceProfile, resourceLimits: current.settings.resourceLimits, workflowId: current.workflowId || null, role: current.role || null, projectId: current.projectId, workspacePath: current.workspacePath, executionDirectory: current.executionDirectory, sessionId: current.sessionId });
      if (current.status === "queued") emit("task.queued", { reason: "created" });
      else emit("approval.requested", { revision: current.revision, promptHash: current.promptHash, capabilityBoundary: current.capabilityBoundary });
    });
    if (created.status === "queued") this._enqueue(taskId);
    return this._decorate(created);
  }

  async getTask(taskId) {
    const task = await this._withLock(taskId, () => this.store.readTask(taskId));
    return task ? this._decorate(task) : null;
  }

  async listTasks({ status = null, limit = 50 } = {}) {
    await Promise.all([...this.locks.values()]);
    const tasks = await this.store.listTasks();
    return tasks
      .filter((task) => !status || task.status === status)
      .slice(0, Math.max(1, Math.min(200, Number(limit) || 50)))
      .map((task) => this._decorate(task));
  }

  async getTaskEvents(taskId, { afterSequence = 0, limit = 200 } = {}) {
    return this._withLock(taskId, async () => {
      const task = await this.store.readTask(taskId);
      if (!task) return null;
      const events = await this.store.readEvents(taskId, {
        afterSequence: Math.max(0, Number(afterSequence) || 0),
        limit: Math.max(1, Math.min(500, Number(limit) || 200))
      });
      const lastSequence = events.length ? events[events.length - 1].sequence : Number(afterSequence) || 0;
      return { taskId, afterSequence: Number(afterSequence) || 0, lastSequence, hasMore: lastSequence < Number(task.lastEventSequence || 0), events };
    });
  }

  async approveTask(taskId, { approvedBy, approvalReason }) {
    if (!String(approvedBy || "").trim() || !String(approvalReason || "").trim()) {
      throw new Error("approvedBy and approvalReason are required");
    }
    const approved = await this._mutate(taskId, (task, emit) => {
      if (task.status !== "waiting_approval") throw new Error(`Task is not waiting for approval: ${task.status}`);
      const approvedAt = nowIso();
      task.approval = {
        taskId: task.taskId,
        attemptId: null,
        revision: task.revision,
        promptHash: task.promptHash,
        capabilityBoundary: task.capabilityBoundary,
        approvedBy: String(approvedBy).trim(),
        approvalReason: String(approvalReason).trim(),
        approvedAt
      };
      transition(task, "queued");
      task.currentStage = "queued";
      emit("approval.completed", { approvedBy: task.approval.approvedBy, approvedAt, revision: task.revision, promptHash: task.promptHash, capabilityBoundary: task.capabilityBoundary });
      emit("task.queued", { reason: "approval_completed" });
    });
    this._enqueue(taskId);
    return this._decorate(approved);
  }

  async cancelTask(taskId, { requestedBy = "operator" } = {}) {
    const task = await this.getTask(taskId);
    if (!task) return null;
    if (TERMINAL_STATUSES.has(task.status)) return this._decorate(task);
    if (task.status === "running") {
      const active = this.activeAttempts.get(taskId);
      const updated = await this._mutate(taskId, (current, emit) => {
        if (current.status !== "running") return;
        current.currentStage = "cancellation_requested";
        emit("task.cancellation_requested", { requestedBy });
      });
      if (updated.status === "running") {
        this.cancelRequests.add(taskId);
        active?.controller.abort();
      }
      return this._decorate(updated);
    }
    const cancelled = await this._mutate(taskId, (current, emit) => {
      const previousStatus = current.status;
      transition(current, "cancelled");
      current.currentStage = "cancelled";
      emit("task.cancelled", { requestedBy, previousStatus });
    });
    this.pendingSet.delete(taskId);
    return this._decorate(cancelled);
  }

  _decorate(task) {
    const heartbeatTime = task.lastHeartbeat ? Date.parse(task.lastHeartbeat) : NaN;
    const eventTime = task.lastEventTime ? Date.parse(task.lastEventTime) : NaN;
    const heartbeatHealthy = task.status === "running" && Number.isFinite(heartbeatTime) && Date.now() - heartbeatTime <= this.stalledAfterMs;
    const progressStalled = task.status === "running" && (!Number.isFinite(eventTime) || Date.now() - eventTime > this.stalledAfterMs);
    const stalled = task.status === "running" && (!heartbeatHealthy || progressStalled);
    const nextExpectedAction = {
      queued: "start_worker_when_runtime_slot_is_available",
      running: stalled ? "inspect_worker_activity_or_cancel" : "wait_for_worker_or_query_new_events",
      waiting_approval: "approve_exact_capability_boundary_or_cancel",
      succeeded: "review_result_and_artifacts",
      failed: "inspect_error_events_and_worker_artifacts",
      cancelled: "no_action_required",
      interrupted: "inspect_previous_attempt_before_creating_a_retry"
    }[task.status] || "inspect_task";
    return {
      ...task,
      activity: task.status === "running" ? (stalled ? "stalled" : "active") : "inactive",
      stalled,
      heartbeatHealthy,
      progressStalled,
      nextExpectedAction
    };
  }

  _enqueue(taskId) {
    if (this.pendingSet.has(taskId) || this.activeAttempts.has(taskId)) return;
    this.pendingSet.add(taskId);
    this.pending.push(taskId);
    queueMicrotask(() => this._drain());
  }

  _drain() {
    while (this.activeCount < this.maxConcurrentTasks && this.pending.length > 0) {
      const taskId = this.pending.shift();
      if (!this.pendingSet.delete(taskId)) continue;
      this.activeCount += 1;
      this._execute(taskId)
        .catch((error) => this._failRuntimeTask(taskId, error))
        .finally(() => {
          this.activeCount -= 1;
          this.activeAttempts.delete(taskId);
          this.cancelRequests.delete(taskId);
          this._drain();
        });
    }
  }

  async _execute(taskId) {
    const initial = await this.store.readTask(taskId);
    if (!initial || initial.status !== "queued") return;
    const attemptId = this.runner.generateAttemptId();
    const preparedAttemptContext = await this.runner.prepareAttemptContext?.({
      attemptId,
      mode: initial.mode,
      projectContext: initial.projectContext
    }) || null;
    const startedAt = nowIso();
    const runningTask = await this._mutate(taskId, async (task, emit) => {
      if (task.status !== "queued") throw new Error(`Task cannot start from status ${task.status}`);
      if (task.mode === "run" && (!task.approval || task.approval.revision !== task.revision || task.approval.promptHash !== task.promptHash)) {
        transition(task, "waiting_approval");
        task.currentStage = "waiting_for_approval";
        emit("approval.requested", { reason: "missing_or_stale_approval", revision: task.revision, promptHash: task.promptHash, capabilityBoundary: task.capabilityBoundary });
        return;
      }
      const attempt = {
        attemptId,
        runId: attemptId,
        status: "running",
        startedAt,
        completedAt: null,
        workerPid: null,
        resourceProfile: task.settings.resourceProfile,
        resourceLimits: task.settings.resourceLimits,
        projectContext: task.projectContext || null,
        projectContextSnapshot: preparedAttemptContext?.metadata || null,
        projectId: task.projectId || null,
        workspacePath: task.workspacePath || null,
        executionDirectory: task.executionDirectory || String(this.runner.projectRoot || "").replaceAll("\\", "/") || null,
        sessionId: task.sessionId || null,
        artifactReference: null,
        error: null
      };
      task.attempts.push(attempt);
      task.currentAttempt = attemptId;
      transition(task, "running");
      task.currentStage = "starting_worker";
      task.lastHeartbeat = startedAt;
      task.error = null;
      task.result = null;
      if (task.approval && !task.approval.attemptId) task.approval.attemptId = attemptId;
      await this.store.writeAttempt(taskId, attempt);
      emit("task.started", { attemptId });
      emit("attempt.started", { attemptId, mode: task.mode, resourceProfile: attempt.resourceProfile, resourceLimits: attempt.resourceLimits, projectId: attempt.projectId, workspacePath: attempt.workspacePath, executionDirectory: attempt.executionDirectory, sessionId: attempt.sessionId });
      emit("worker.started", { attemptId });
      emit("phase.changed", { stage: "starting_worker", attemptId });
    });
    if (runningTask.status !== "running") return;

    const controller = new AbortController();
    this.activeAttempts.set(taskId, { attemptId, controller });
    if (this.cancelRequests.delete(taskId)) controller.abort();
    const heartbeat = setInterval(() => {
      this._heartbeat(taskId, attemptId).catch(() => {});
    }, this.heartbeatMs);
    heartbeat.unref?.();

    let outcome;
    try {
      outcome = await this.runner.runAttempt({
        attemptId,
        mode: runningTask.mode,
        prompt: runningTask.prompt,
        resourceProfile: runningTask.settings.resourceProfile,
        resourceLimits: runningTask.settings.resourceLimits,
        workerTimeoutSeconds: runningTask.settings.workerTimeoutSeconds,
        maxBudgetUsd: runningTask.settings.maxBudgetUsd,
        maxTurns: runningTask.settings.maxTurns,
        maxFilesRead: runningTask.settings.maxFilesRead,
        maxCommands: runningTask.settings.maxCommands,
        mockWorker: runningTask.settings.mockWorker,
        approval: runningTask.approval,
        projectContext: runningTask.projectContext,
        preparedAttemptContext,
        signal: controller.signal,
        onSpawn: ({ pid }) => this._workerSpawned(taskId, attemptId, pid).catch(() => {})
      });
    } finally {
      clearInterval(heartbeat);
    }

    await this._completeAttempt(taskId, attemptId, outcome);
  }

  async _workerSpawned(taskId, attemptId, pid) {
    await this._mutate(taskId, async (task, emit) => {
      if (task.status !== "running" || task.currentAttempt !== attemptId) return;
      task.currentStage = "worker_running";
      task.lastHeartbeat = nowIso();
      const attempt = task.attempts.find((item) => item.attemptId === attemptId);
      if (attempt) {
        attempt.workerPid = pid || null;
        await this.store.writeAttempt(taskId, attempt);
      }
      emit("phase.changed", { stage: "worker_running", attemptId, workerPid: pid || null });
    });
  }

  async _heartbeat(taskId, attemptId) {
    await this._mutate(taskId, (task) => {
      if (task.status !== "running" || task.currentAttempt !== attemptId) return;
      const timestamp = nowIso();
      task.lastHeartbeat = timestamp;
    });
  }

  async _completeAttempt(taskId, attemptId, outcome) {
    await this._mutate(taskId, async (task, emit) => {
      if (task.currentAttempt !== attemptId || TERMINAL_STATUSES.has(task.status)) return;
      const attempt = task.attempts.find((item) => item.attemptId === attemptId);
      const completedAt = nowIso();
      const normalizedStatus = outcome.result?.status || outcome.bridgeStatus;
      const finalStatus = outcome.bridgeStatus === "cancelled"
        ? "cancelled"
        : outcome.bridgeStatus === "interrupted"
          ? "interrupted"
          : normalizedStatus === "success"
            ? "succeeded"
            : "failed";
      const artifactReference = { runId: attemptId, normalizedResult: "worker-result.normalized.json", resultEnvelope: "result.json" };
      if (attempt) {
        attempt.status = finalStatus;
        attempt.completedAt = completedAt;
        attempt.artifactReference = artifactReference;
        attempt.error = outcome.result?.error || (finalStatus === "succeeded" ? null : { code: outcome.bridgeStatus, message: outcome.stderr || "Worker attempt failed." });
        await this.store.writeAttempt(taskId, attempt);
      }
      transition(task, finalStatus);
      task.currentStage = finalStatus;
      task.result = {
        attemptId,
        status: normalizedStatus,
        summary: outcome.result?.summary || null,
        resourceProfile: attempt?.resourceProfile || task.settings.resourceProfile,
        resourceLimits: attempt?.resourceLimits || task.settings.resourceLimits,
        artifactStatus: outcome.result?.artifact_status || null,
        artifactReference
      };
      task.error = attempt?.error || null;
      emit("worker.completed", { attemptId, status: normalizedStatus, artifactStatus: task.result.artifactStatus });
      emit("attempt.completed", { attemptId, status: finalStatus, artifactReference });
      emit(finalStatus === "succeeded" ? "task.completed" : finalStatus === "cancelled" ? "task.cancelled" : finalStatus === "interrupted" ? "task.interrupted" : "task.failed", {
        attemptId,
        status: finalStatus,
        error: task.error
      });
    });
  }

  async _failRuntimeTask(taskId, error) {
    try {
      await this._mutate(taskId, (task, emit) => {
        if (TERMINAL_STATUSES.has(task.status)) return;
        transition(task, "failed");
        task.currentStage = "runtime_failed";
        task.error = publicError(error);
        emit("task.failed", { error: task.error, source: "task_runtime" });
      });
    } catch {}
  }

  async _mutate(taskId, mutate) {
    return this._withLock(taskId, async () => {
      const task = await this.store.readTask(taskId);
      if (!task) throw new Error(`Task not found: ${taskId}`);
      const pendingEvents = [];
      const emit = (type, payload = {}) => pendingEvents.push({ type, payload });
      await mutate(task, emit);
      if (pendingEvents.length > 0) {
        task.lastEventSequence = Math.max(Number(task.lastEventSequence || 0), await this.store.maxEventSequence(taskId));
      }
      for (const pending of pendingEvents) {
        const timestamp = nowIso();
        const event = {
          schemaVersion: 1,
          sequence: Number(task.lastEventSequence || 0) + 1,
          timestamp,
          taskId: task.taskId,
          attemptId: task.currentAttempt,
          type: pending.type,
          source: pending.type.startsWith("worker.") || pending.type.startsWith("tool.") ? "worker" : "task_runtime",
          payload: pending.payload
        };
        await this.store.appendEvent(taskId, event);
        task.lastEventSequence = event.sequence;
        task.lastEventTime = timestamp;
      }
      task.updatedAt = nowIso();
      await this.store.writeTask(task);
      return task;
    });
  }

  async _withLock(taskId, operation) {
    const previous = this.locks.get(taskId) || Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    const marker = previous.then(() => current);
    this.locks.set(taskId, marker);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.locks.get(taskId) === marker) this.locks.delete(taskId);
    }
  }
}
