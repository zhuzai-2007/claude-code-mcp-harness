import { randomBytes } from "node:crypto";

export const WORKFLOW_ROLE_MODES = Object.freeze({ planner: "plan", coder: "run", reviewer: "review" });
const TASK_TERMINAL = new Set(["succeeded", "failed", "cancelled", "interrupted"]);
const TASK_FAILED = new Set(["failed", "cancelled", "interrupted"]);
const WORKFLOW_TERMINAL = new Set(["completed", "failed"]);

function nowIso() { return new Date().toISOString(); }
function durationSeconds(start, end = Date.now()) {
  const started = Date.parse(start);
  const ended = typeof end === "number" ? end : Date.parse(end);
  return Number.isFinite(started) && Number.isFinite(ended) ? Math.max(0, (ended - started) / 1000) : null;
}
function auditContext(audit) {
  if (!audit) return null;
  return Object.fromEntries(["summary", "files_read", "proposed_changes", "changes_made", "commands_run", "tests_or_checks", "risks", "blocked_on", "run_result"].map((key) => [key, audit[key]]).filter(([, value]) => value != null));
}

function projectBindingFromDecision(decision) {
  if (!decision?.project) return null;
  const projectId = decision.projectId || decision.project.projectId || decision.project.id;
  const workspacePath = decision.workspacePath || decision.project.workspacePath || decision.project.path;
  if (!projectId || !workspacePath) return null;
  return {
    projectId,
    name: decision.project.name || projectId,
    workspacePath,
    workspaceRelativePath: decision.project.path || null
  };
}

function workflowPlanContext(workflow) {
  const plan = workflow.workflowPlan;
  if (!plan) return "";
  return `\n\nWorkflow plan:\n${JSON.stringify({ workflowType: plan.workflowType, goal: plan.goal, reason: plan.reason, constraints: plan.constraints, stages: plan.stages }, null, 2)}`;
}

function supervisorDecisionContext(workflow) {
  const decision = workflow.supervisorDecision;
  if (!decision) return "";
  const context = {
    decisionId: decision.decisionId,
    intent: decision.intent,
    goal: decision.goal,
    technical_summary: decision.technical_summary,
    implementation_strategy: decision.implementation_strategy || "Use the Planner result to identify and execute the smallest bounded solution.",
    expected_changes: decision.expected_changes || [],
    validation_plan: decision.validation_plan || [],
    acceptance_criteria: decision.validation_plan || [],
    project: decision.project,
    reasoning: decision.reasoning,
    risks: decision.risks,
    workflowType: decision.workflowType,
    estimated_resources: decision.estimated_resources,
    recommended_actions: decision.recommended_actions,
    agentRequired: decision.agentRequired,
    confidence: decision.confidence,
    constraints: decision.constraints
  };
  return `\n\nSupervisor decision (authoritative task context):\n${JSON.stringify(context, null, 2)}\n\nUse the Supervisor technical summary, implementation strategy, expected changes, constraints, and acceptance criteria to guide this stage. Validate assumptions against the registered project without silently expanding scope.\n\nTarget project boundary: '${decision.project?.path || "."}'. Start there. Do not inspect sibling projects or guess another target directory.`;
}

const PROMPT_BUILDERS = {
  planner: ({ workflow }) => `Original user request:\n${workflow.userRequest}${supervisorDecisionContext(workflow)}${workflowPlanContext(workflow)}\n\nAnalyze the bounded request and return a result using the plan audit contract. Respect every Workflow constraint. Do not modify files.`,
  coder: ({ workflow, audits }) => `Original user request:\n${workflow.userRequest}${supervisorDecisionContext(workflow)}${workflowPlanContext(workflow)}\n\nHuman approval has been recorded for this implementation stage. Implement only the approved bounded plan and respect every Workflow constraint.\n\nPlanner audit result:\n${JSON.stringify(audits.planner || {}, null, 2)}`,
  reviewer: ({ workflow, audits }) => `Perform a focused verification of the completed change. Do not modify files or explore unrelated repository areas.\n\nOriginal user request:\n${workflow.userRequest}${supervisorDecisionContext(workflow)}${workflowPlanContext(workflow)}\n\nPlanner audit result:\n${JSON.stringify(audits.planner || {}, null, 2)}\n\nCoder audit result:\n${JSON.stringify(audits.coder || {}, null, 2)}\n\nchanges_made: ${JSON.stringify(audits.coder?.changes_made || [])}\nModified files: ${JSON.stringify(audits.coder?.changes_made || [])}`
};

export class WorkflowRuntime {
  constructor({ store, taskRuntime, definitions, workflowPlanner = null, resultProvider = null, orchestratorIntervalMs = 500, autoReconcile = true }) {
    this.store = store;
    this.taskRuntime = taskRuntime;
    this.definitions = definitions;
    this.workflowPlanner = workflowPlanner;
    this.resultProvider = resultProvider || (() => null);
    this.orchestratorIntervalMs = Math.max(100, Number(orchestratorIntervalMs) || 500);
    this.autoReconcile = autoReconcile;
    this.locks = new Map();
    this.started = false;
    this.timer = null;
  }

  async start() {
    if (this.started) return;
    await this.store.init();
    const workflows = await this.store.listWorkflows();
    for (const workflow of workflows) {
      const maxSequence = await this.store.maxEventSequence?.(workflow.workflowId) || 0;
      if (maxSequence > Number(workflow.lastEventSequence || 0)) {
        workflow.lastEventSequence = maxSequence;
        await this.store.writeWorkflow(workflow);
      }
    }
    this.started = true;
    await this.reconcileAll();
    if (this.autoReconcile) {
      this.timer = setInterval(() => this.reconcileAll().catch(() => {}), this.orchestratorIntervalMs);
      this.timer.unref?.();
    }
  }

  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  async createWorkflow({ userRequest, definitionId = null, supervisorDecision = null, session = null, mockWorker = false, recovery = null }) {
    const request = String(userRequest || "").trim();
    if (!request) throw new Error("userRequest is required");
    if (supervisorDecision && supervisorDecision.nextAction !== "create_workflow") throw new Error("Supervisor Decision is not ready to create a Workflow.");
    const projectBinding = projectBindingFromDecision(supervisorDecision);
    if (supervisorDecision && !projectBinding) throw new Error("Supervisor Decision must contain a confirmed registered projectId and workspacePath.");
    if (session && projectBinding && session.projectId !== projectBinding.projectId) throw new Error("Project Session does not belong to the Workflow project.");
    const selectedWorkflowType = supervisorDecision?.workflowType || definitionId;
    const workflowPlan = this.workflowPlanner
      ? this.workflowPlanner.plan(request, { workflowType: selectedWorkflowType })
      : { schemaVersion: 1, workflowType: String(definitionId || this.definitions?.defaultDefinition || "").trim(), goal: request, reason: "Workflow definition selected by the Orchestrator.", constraints: [], stages: [], selection: definitionId ? "explicit" : "default" };
    if (supervisorDecision) {
      workflowPlan.selection = "supervisor_decision";
      workflowPlan.reason = supervisorDecision.reasoning?.join(" ") || workflowPlan.reason;
      workflowPlan.constraints = [...new Set([...(workflowPlan.constraints || []), ...(supervisorDecision.constraints || [])])];
      workflowPlan.supervisorDecisionId = supervisorDecision.decisionId;
      workflowPlan.project = supervisorDecision.project;
    }
    const selectedId = workflowPlan.workflowType;
    const definition = this.definitions?.definitions?.[selectedId];
    if (!definition) throw new Error(`Unknown Workflow definition: ${selectedId || "<empty>"}`);
    const createdAt = nowIso();
    const workflow = {
      schemaVersion: 7,
      workflowId: `workflow_${Date.now().toString(36)}_${randomBytes(6).toString("hex")}`,
      userRequest: request,
      orchestrated: true,
      definitionId: selectedId,
      definition: { schemaVersion: this.definitions.schemaVersion, description: definition.description || null },
      workflowPlan,
      supervisorDecision: supervisorDecision ? JSON.parse(JSON.stringify(supervisorDecision)) : null,
      project: supervisorDecision?.project || null,
      projectId: projectBinding?.projectId || null,
      workspacePath: projectBinding?.workspacePath || null,
      projectBinding,
      sessionId: session?.sessionId || supervisorDecision?.session?.sessionId || null,
      session: session ? JSON.parse(JSON.stringify(session)) : (supervisorDecision?.session ? JSON.parse(JSON.stringify(supervisorDecision.session)) : null),
      status: "created",
      currentStage: "created",
      nextAction: { type: "wait_for_orchestrator" },
      createdAt,
      updatedAt: createdAt,
      tasks: [],
      stages: definition.stages.map((stage, index) => ({
        index,
        id: stage.id,
        role: stage.role,
        mode: stage.mode,
        promptKind: stage.promptKind || stage.role,
        requiresApproval: stage.requiresApproval === true,
        resourceProfile: stage.resourceProfile || null,
        status: "pending",
        taskId: null,
        startedAt: null,
        completedAt: null,
        error: null
      })),
      approvals: {},
      rejections: {},
      settings: { mockWorker: Boolean(mockWorker) },
      recovery: recovery ? JSON.parse(JSON.stringify(recovery)) : null,
      recoveries: [],
      failure: null,
      lastEventSequence: 0
    };
    await this.store.createWorkflow(workflow);
    await this._mutate(workflow.workflowId, (current, emit) => {
      if (current.recovery) emit("workflow.recovery_started", current.recovery);
      if (current.supervisorDecision) emit("workflow.supervisor_decision_recorded", { decisionId: current.supervisorDecision.decisionId, schemaVersion: current.supervisorDecision.schemaVersion, intent: current.supervisorDecision.intent, workflowType: current.supervisorDecision.workflowType, project: current.supervisorDecision.project, projectId: current.projectId, workspacePath: current.workspacePath, sessionId: current.sessionId, risks: current.supervisorDecision.risks, estimatedResources: current.supervisorDecision.estimated_resources, confidence: current.supervisorDecision.confidence });
      emit("workflow.planning_completed", { workflowType: current.workflowPlan.workflowType, reason: current.workflowPlan.reason, selection: current.workflowPlan.selection, stages: current.workflowPlan.stages });
      emit("workflow.created", { userRequest: current.userRequest, definitionId: current.definitionId });
    });
    return this.reconcileWorkflow(workflow.workflowId);
  }

  async retryWorkflow(workflowId, { requestedBy, recoveryReason }) {
    const operator = String(requestedBy || "").trim();
    const reason = String(recoveryReason || "").trim();
    if (!operator || !reason) throw new Error("requestedBy and recoveryReason are required");
    const source = await this.store.readWorkflow(workflowId);
    if (!source) throw new Error(`Workflow not found: ${workflowId}`);
    if (!source.orchestrated) throw new Error("Legacy Workflow does not support recovery.");
    if (source.status !== "failed") throw new Error(`Only failed Workflows can be recovered: ${source.status}`);
    const requestedAt = nowIso();
    const recovery = {
      sourceWorkflowId: source.workflowId,
      requestedBy: operator,
      recoveryReason: reason,
      requestedAt,
      sourceFailure: source.failure ? {
        failedStage: source.failure.failedStage || null,
        role: source.failure.role || null,
        code: source.failure.error?.code || "stage_failed"
      } : null
    };
    const created = await this.createWorkflow({
      userRequest: source.userRequest,
      definitionId: source.definitionId,
      supervisorDecision: source.supervisorDecision || null,
      session: source.session || null,
      mockWorker: source.settings?.mockWorker === true,
      recovery
    });
    await this._mutate(source.workflowId, (current, emit) => {
      current.recoveries ||= [];
      current.recoveries.push({ workflowId: created.workflowId, requestedBy: operator, recoveryReason: reason, requestedAt });
      emit("workflow.recovery_created", { recoveredWorkflowId: created.workflowId, requestedBy: operator, recoveryReason: reason });
    });
    return { sourceWorkflow: await this.getWorkflow(source.workflowId), workflow: await this.getWorkflow(created.workflowId) };
  }

  async approveWorkflow(workflowId, { approvedBy, approvalReason }) {
    if (!String(approvedBy || "").trim() || !String(approvalReason || "").trim()) throw new Error("approvedBy and approvalReason are required");
    await this._mutate(workflowId, async (workflow, emit) => {
      if (!workflow.orchestrated) throw new Error("Legacy Workflow does not support orchestrated approval.");
      if (workflow.status !== "waiting_approval") throw new Error(`Workflow is not waiting for approval: ${workflow.status}`);
      const stage = workflow.stages.find((item) => item.status === "waiting_approval");
      if (!stage || !stage.requiresApproval) throw new Error("Workflow has no approval-gated stage.");
      const planner = workflow.stages.find((item) => item.role === "planner");
      const plannerTask = planner?.taskId ? await this.taskRuntime.getTask(planner.taskId) : null;
      const approvedAt = nowIso();
      workflow.approvals[stage.id] = {
        stageId: stage.id,
        approvedBy: String(approvedBy).trim(),
        approvalReason: String(approvalReason).trim(),
        approvedAt,
        plannerTaskId: planner?.taskId || null,
        plannerAttemptId: plannerTask?.currentAttempt || null
      };
      stage.status = "pending";
      workflow.status = "planned";
      workflow.currentStage = stage.id;
      workflow.nextAction = { type: "wait_for_orchestrator", stageId: stage.id };
      emit("workflow.approval_completed", { stageId: stage.id, approvedBy: workflow.approvals[stage.id].approvedBy, approvedAt, plannerTaskId: planner?.taskId || null });
      emit("workflow.status_changed", { status: "planned", stageId: stage.id });
    });
    return this.reconcileWorkflow(workflowId);
  }

  async rejectWorkflow(workflowId, { rejectedBy, rejectionReason }) {
    if (!String(rejectedBy || "").trim() || !String(rejectionReason || "").trim()) throw new Error("rejectedBy and rejectionReason are required");
    await this._mutate(workflowId, async (workflow, emit) => {
      if (!workflow.orchestrated) throw new Error("Legacy Workflow does not support orchestrated rejection.");
      if (workflow.status !== "waiting_approval") throw new Error(`Workflow is not waiting for approval: ${workflow.status}`);
      const stage = workflow.stages.find((item) => item.status === "waiting_approval");
      if (!stage || !stage.requiresApproval || stage.taskId) throw new Error("Workflow has no rejectable approval-gated stage.");
      const rejectedAt = nowIso();
      workflow.rejections ||= {};
      workflow.rejections[stage.id] = {
        stageId: stage.id,
        rejectedBy: String(rejectedBy).trim(),
        rejectionReason: String(rejectionReason).trim(),
        rejectedAt
      };
      stage.status = "failed";
      stage.completedAt = rejectedAt;
      stage.error = { code: "approval_rejected", message: workflow.rejections[stage.id].rejectionReason };
      this._failWorkflow(workflow, stage, stage.error);
      workflow.nextAction = { type: "none", reason: "Workflow was rejected by a human reviewer." };
      emit("workflow.approval_rejected", { stageId: stage.id, rejectedBy: workflow.rejections[stage.id].rejectedBy, rejectedAt, reason: workflow.rejections[stage.id].rejectionReason });
      emit("workflow.failed", { failedStage: stage.id, taskId: null, error: stage.error });
    });
    return this.getWorkflow(workflowId);
  }

  async reconcileAll() {
    const workflows = await this.store.listWorkflows();
    for (const workflow of workflows) {
      if (workflow.orchestrated && !WORKFLOW_TERMINAL.has(workflow.status)) await this.reconcileWorkflow(workflow.workflowId);
    }
  }

  async reconcileWorkflow(workflowId) {
    return this._withLock(workflowId, async () => {
      const workflow = await this.store.readWorkflow(workflowId);
      if (!workflow) return null;
      if (!workflow.orchestrated) return this._persistLegacySnapshot(workflow);
      if (WORKFLOW_TERMINAL.has(workflow.status)) return this._decorateOrchestrated(workflow);

      for (let step = 0; step < workflow.stages.length + 2; step += 1) {
        const stage = workflow.stages.find((item) => item.status !== "succeeded");
        if (!stage) {
          this._setWorkflowState(workflow, "completed", "completed", { type: "none" });
          await this._appendWorkflowEvent(workflow, "workflow.completed", { taskCount: workflow.tasks.length });
          break;
        }

        if (stage.taskId) {
          const task = await this.taskRuntime.getTask(stage.taskId);
          const ref = workflow.tasks.find((item) => item.taskId === stage.taskId);
          if (!task) {
            this._failWorkflow(workflow, stage, { code: "task_not_found", message: `Task not found: ${stage.taskId}` });
            await this._appendWorkflowEvent(workflow, "workflow.failed", { failedStage: stage.id, taskId: stage.taskId, error: workflow.failure.error });
            break;
          }
          if (ref) ref.status = task.status;
          if (task.status === "succeeded") {
            stage.status = "succeeded";
            stage.completedAt = task.attempts?.at(-1)?.completedAt || task.updatedAt;
            await this._appendWorkflowEvent(workflow, "workflow.stage_completed", { stageId: stage.id, role: stage.role, taskId: task.taskId });
            if (stage.role === "planner") {
              this._setWorkflowState(workflow, "planned", stage.id, { type: "prepare_approval", stageId: workflow.stages[stage.index + 1]?.id || null });
              await this._appendWorkflowEvent(workflow, "workflow.status_changed", { status: "planned", stageId: stage.id });
            }
            continue;
          }
          if (TASK_FAILED.has(task.status)) {
            stage.status = "failed";
            stage.completedAt = task.attempts?.at(-1)?.completedAt || task.updatedAt;
            stage.error = task.error || { code: task.status, message: `Task ended with ${task.status}.` };
            this._failWorkflow(workflow, stage, stage.error);
            await this._appendWorkflowEvent(workflow, "workflow.failed", { failedStage: stage.id, taskId: task.taskId, error: stage.error });
            break;
          }
          stage.status = task.status === "waiting_approval" ? "waiting_approval" : "running";
          const workflowStatus = stage.role === "planner" ? "planning" : stage.role === "reviewer" ? "reviewing" : "running";
          this._setWorkflowState(workflow, workflowStatus, stage.id, { type: "wait_for_task", taskId: task.taskId, role: stage.role });
          break;
        }

        if (stage.requiresApproval && !workflow.approvals?.[stage.id]) {
          if (stage.status !== "waiting_approval") {
            stage.status = "waiting_approval";
            await this._appendWorkflowEvent(workflow, "workflow.approval_requested", { stageId: stage.id, role: stage.role, reason: "Planner completed the approval-gated stage plan." });
          }
          this._setWorkflowState(workflow, "waiting_approval", stage.id, { type: "approve_workflow", workflowId, stageId: stage.id, reason: "Planner completed the approval-gated stage plan." });
          break;
        }

        const prompt = await this._buildStagePrompt(workflow, stage);
        let task = await this.taskRuntime.createTask({ prompt, mode: stage.mode, resourceProfile: stage.resourceProfile, workflowId, role: stage.role, projectContext: workflow.projectBinding || null, sessionId: workflow.sessionId || null, mockWorker: workflow.settings?.mockWorker === true });
        stage.taskId = task.taskId;
        stage.startedAt = task.createdAt;
        stage.status = task.status === "waiting_approval" ? "waiting_approval" : "running";
        workflow.tasks.push({ taskId: task.taskId, role: stage.role, mode: stage.mode, status: task.status, stageId: stage.id, addedAt: nowIso() });
        await this._appendWorkflowEvent(workflow, "workflow.stage_started", { stageId: stage.id, role: stage.role, mode: stage.mode, taskId: task.taskId });
        if (stage.mode === "run") {
          const approval = workflow.approvals?.[stage.id];
          if (!approval) throw new Error(`Run stage '${stage.id}' has no human approval.`);
          task = await this.taskRuntime.approveTask(task.taskId, { approvedBy: approval.approvedBy, approvalReason: approval.approvalReason });
          const ref = workflow.tasks.find((item) => item.taskId === task.taskId);
          if (ref) ref.status = task.status;
          stage.status = "running";
        }
        const workflowStatus = stage.role === "planner" ? "planning" : stage.role === "reviewer" ? "reviewing" : "running";
        this._setWorkflowState(workflow, workflowStatus, stage.id, { type: "wait_for_task", taskId: task.taskId, role: stage.role });
        break;
      }

      workflow.updatedAt = nowIso();
      await this.store.writeWorkflow(workflow);
      return this._decorateOrchestrated(workflow);
    });
  }

  async createTask(workflowId, options) {
    const existing = await this.store.readWorkflow(workflowId);
    if (!existing) throw new Error(`Workflow not found: ${workflowId}`);
    if (existing.orchestrated) throw new Error("Orchestrated Workflow creates stage Tasks automatically.");
    const mode = WORKFLOW_ROLE_MODES[options.role];
    if (!mode) throw new Error(`Unsupported workflow role: ${options.role}`);
    const task = await this.taskRuntime.createTask({ ...options, mode, workflowId, role: options.role, projectContext: existing.projectBinding || options.projectContext || null, sessionId: existing.sessionId || options.sessionId || null });
    await this._mutate(workflowId, (workflow, emit) => {
      workflow.tasks.push({ taskId: task.taskId, role: options.role, mode, status: task.status, addedAt: nowIso() });
      emit("workflow.task_added", { taskId: task.taskId, role: options.role, mode });
    });
    return { workflow: await this.getWorkflow(workflowId), task };
  }

  async attachTask(workflowId, { taskId, role }) {
    const workflow = await this.store.readWorkflow(workflowId);
    if (!workflow) throw new Error(`Workflow not found: ${workflowId}`);
    if (workflow.orchestrated) throw new Error("Orchestrated Workflow creates stage Tasks automatically.");
    const mode = WORKFLOW_ROLE_MODES[role];
    const task = await this.taskRuntime.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    if (task.mode !== mode) throw new Error(`Role '${role}' requires mode '${mode}', received '${task.mode}'.`);
    await this._mutate(workflowId, (current, emit) => {
      current.tasks.push({ taskId, role, mode, status: task.status, addedAt: nowIso() });
      emit("workflow.task_attached", { taskId, role, mode });
    });
    return this.getWorkflow(workflowId);
  }

  async getWorkflow(workflowId) {
    const workflow = await this.store.readWorkflow(workflowId);
    if (!workflow) return null;
    return workflow.orchestrated ? this.reconcileWorkflow(workflowId) : this._withLock(workflowId, async () => this._persistLegacySnapshot(await this.store.readWorkflow(workflowId)));
  }

  async inspectWorkflow(workflowId) {
    const workflow = await this.store.readWorkflow(workflowId);
    if (!workflow) return null;
    return workflow.orchestrated ? this._decorateOrchestrated(workflow) : { ...workflow };
  }

  async listWorkflows({ status = null, limit = 50 } = {}) {
    const workflows = await this.store.listWorkflows();
    const snapshots = [];
    for (const workflow of workflows) snapshots.push(await this.getWorkflow(workflow.workflowId));
    return snapshots.filter((workflow) => !status || workflow.status === status).slice(0, Math.max(1, Math.min(200, Number(limit) || 50)));
  }

  async getWorkflowEvents(workflowId, { afterSequence = 0, limit = 500 } = {}) {
    return this._withLock(workflowId, async () => {
      const workflow = await this.store.readWorkflow(workflowId);
      if (!workflow) return null;
      const ownEvents = ((await this.store.readEvents(workflowId)) || []).map((event) => ({ ...event, source: event.source || "workflow_runtime" }));
      const taskEvents = [];
      for (const ref of workflow.tasks || []) {
        let taskCursor = 0;
        while (true) {
          const result = await this.taskRuntime.getTaskEvents(ref.taskId, { afterSequence: taskCursor, limit: 500 });
          for (const event of result?.events || []) taskEvents.push({ ...event, workflowId, role: ref.role, mode: ref.mode, stageId: ref.stageId || null, source: event.source || "task_runtime", taskId: event.taskId || ref.taskId });
          if (!result?.hasMore || !result.events?.length) break;
          taskCursor = result.lastSequence;
        }
      }

      const sourceKey = (event) => event.source === "workflow_runtime"
        ? `workflow:${event.eventId || event.sequence}`
        : `task:${event.taskId}:${event.eventId || event.sequence}`;
      const discovered = [...ownEvents, ...taskEvents].sort((left, right) =>
        String(left.timestamp).localeCompare(String(right.timestamp)) || sourceKey(left).localeCompare(sourceKey(right))
      );
      const eventIndex = (await this.store.readEventIndex?.(workflowId)) || { schemaVersion: 1, workflowId, lastSequence: 0, sources: {} };
      eventIndex.sources ||= {};
      eventIndex.lastSequence = Math.max(Number(eventIndex.lastSequence || 0), ...Object.values(eventIndex.sources).map((value) => Number(value) || 0));
      let changed = false;
      for (const event of discovered) {
        const key = sourceKey(event);
        if (eventIndex.sources[key]) continue;
        eventIndex.lastSequence += 1;
        eventIndex.sources[key] = eventIndex.lastSequence;
        changed = true;
      }
      if (changed) await this.store.writeEventIndex?.(workflowId, eventIndex);

      const merged = discovered
        .map((event) => ({ ...event, sourceSequence: event.sequence, sequence: eventIndex.sources[sourceKey(event)] }))
        .sort((left, right) => left.sequence - right.sequence);
      const cursor = Math.max(0, Number(afterSequence) || 0);
      const page = merged.filter((event) => event.sequence > cursor).slice(0, Math.max(1, Math.min(1000, Number(limit) || 500)));
      const lastSequence = page.length ? page.at(-1).sequence : cursor;
      return { workflowId, afterSequence: cursor, lastSequence, hasMore: merged.some((event) => event.sequence > lastSequence), events: page };
    });
  }

  async _buildStagePrompt(workflow, stage) {
    const audits = {};
    for (const ref of workflow.tasks) {
      const task = await this.taskRuntime.getTask(ref.taskId);
      if (!task?.currentAttempt) continue;
      audits[ref.role] = auditContext(await this.resultProvider(task.currentAttempt));
    }
    const builder = PROMPT_BUILDERS[stage.promptKind];
    if (!builder) throw new Error(`Unsupported Workflow prompt kind: ${stage.promptKind}`);
    return builder({ workflow, stage, audits });
  }

  _setWorkflowState(workflow, status, currentStage, nextAction) {
    workflow.status = status;
    workflow.currentStage = currentStage;
    workflow.nextAction = nextAction;
  }

  _failWorkflow(workflow, stage, error) {
    workflow.status = "failed";
    workflow.currentStage = stage.id;
    workflow.nextAction = { type: "inspect_failure", stageId: stage.id, taskId: stage.taskId };
    workflow.failure = { failedStage: stage.id, role: stage.role, taskId: stage.taskId, error: { code: error?.code || "stage_failed", message: String(error?.message || error || "Stage failed.") }, failedAt: nowIso() };
  }

  async _decorateOrchestrated(workflow) {
    const tasks = [];
    for (const ref of workflow.tasks || []) {
      const task = await this.taskRuntime.getTask(ref.taskId);
      if (!task) { tasks.push({ ...ref, status: "missing" }); continue; }
      const startedAt = task.attempts?.[0]?.startedAt || null;
      const completedAt = task.attempts?.at(-1)?.completedAt || null;
      tasks.push({ ...ref, status: task.status, currentStage: task.currentStage, createdAt: task.createdAt, updatedAt: task.updatedAt, startedAt, completedAt, durationSeconds: durationSeconds(startedAt || task.createdAt, completedAt || Date.now()), resourceProfile: task.settings?.resourceProfile || null, resourceLimits: task.settings?.resourceLimits || null, attemptCount: task.attempts?.length || 0, error: task.error || null });
    }
    const counts = { total: tasks.length, succeeded: tasks.filter((task) => task.status === "succeeded").length, running: tasks.filter((task) => ["queued", "running", "waiting_approval"].includes(task.status)).length, failed: tasks.filter((task) => TASK_FAILED.has(task.status) || task.status === "missing").length };
    const latestUpdate = [workflow.updatedAt, ...tasks.map((task) => task.updatedAt)].filter(Boolean).sort().at(-1) || workflow.updatedAt;
    return { ...workflow, updatedAt: latestUpdate, durationSeconds: durationSeconds(workflow.createdAt, WORKFLOW_TERMINAL.has(workflow.status) ? latestUpdate : Date.now()), counts, tasks };
  }

  async _persistLegacySnapshot(workflow) {
    if (!workflow) return null;
    const tasks = [];
    for (const ref of workflow.tasks || []) {
      const task = await this.taskRuntime.getTask(ref.taskId);
      tasks.push(task ? { ...ref, status: task.status, currentStage: task.currentStage, updatedAt: task.updatedAt, resourceProfile: task.settings?.resourceProfile || null } : { ...ref, status: "missing" });
    }
    const statuses = tasks.map((task) => task.status);
    let status = "created";
    if (statuses.some((value) => TASK_FAILED.has(value) || value === "missing")) status = "failed";
    else if (statuses.includes("running")) status = "running";
    else if (statuses.includes("waiting_approval")) status = "waiting_approval";
    else if (statuses.includes("queued")) status = "queued";
    else if (tasks.length && statuses.every((value) => value === "succeeded")) status = "succeeded";
    const counts = { total: tasks.length, succeeded: tasks.filter((task) => task.status === "succeeded").length, running: tasks.filter((task) => ["queued", "running", "waiting_approval"].includes(task.status)).length, failed: tasks.filter((task) => TASK_FAILED.has(task.status) || task.status === "missing").length };
    workflow.status = status;
    workflow.counts = counts;
    workflow.tasks = workflow.tasks.map((ref) => ({ ...ref, status: tasks.find((task) => task.taskId === ref.taskId)?.status || "missing" }));
    await this.store.writeWorkflow(workflow);
    return { ...workflow, currentStage: status === "succeeded" ? "completed" : workflow.currentStage || status, nextAction: null, durationSeconds: durationSeconds(workflow.createdAt, WORKFLOW_TERMINAL.has(status) || status === "succeeded" ? workflow.updatedAt : Date.now()), counts, tasks };
  }

  async _appendWorkflowEvent(workflow, type, payload = {}) {
    const timestamp = nowIso();
    const event = { schemaVersion: 1, eventId: `${workflow.workflowId}:${Number(workflow.lastEventSequence || 0) + 1}`, sequence: Number(workflow.lastEventSequence || 0) + 1, timestamp, workflowId: workflow.workflowId, type, source: "workflow_runtime", payload };
    await this.store.appendEvent(workflow.workflowId, event);
    workflow.lastEventSequence = event.sequence;
  }

  async _mutate(workflowId, mutate) {
    return this._withLock(workflowId, async () => {
      const workflow = await this.store.readWorkflow(workflowId);
      if (!workflow) throw new Error(`Workflow not found: ${workflowId}`);
      const pending = [];
      await mutate(workflow, (type, payload = {}) => pending.push({ type, payload }));
      for (const event of pending) await this._appendWorkflowEvent(workflow, event.type, event.payload);
      workflow.updatedAt = nowIso();
      await this.store.writeWorkflow(workflow);
      return workflow;
    });
  }

  async _withLock(workflowId, operation) {
    const previous = this.locks.get(workflowId) || Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    const marker = previous.then(() => current);
    this.locks.set(workflowId, marker);
    await previous;
    try { return await operation(); }
    finally { release(); if (this.locks.get(workflowId) === marker) this.locks.delete(workflowId); }
  }
}
