const ACTIVE_WORKFLOW_STATUSES = new Set(["created", "queued", "planning", "planned", "waiting_approval", "running", "reviewing"]);
const TERMINAL_WORKFLOW_STATUSES = new Set(["completed", "succeeded", "failed"]);

function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }
function unique(values, limit = 50) { return [...new Set((values || []).map((value) => String(value || "").trim()).filter(Boolean))].slice(0, limit); }
function projectIdOf(workflow) { return workflow?.projectId || workflow?.project?.projectId || workflow?.project?.id || null; }
function sortRecent(values) { return [...values].sort((left, right) => String(right.updatedAt || right.createdAt || "").localeCompare(String(left.updatedAt || left.createdAt || ""))); }

export class ProjectContinuityService {
  constructor({ workflowRuntime, projectRegistry, store, releaseStatus = null }) {
    this.workflowRuntime = workflowRuntime;
    this.projectRegistry = projectRegistry;
    this.store = store;
    this.releaseStatus = releaseStatus && typeof releaseStatus === "object" ? clone(releaseStatus) : null;
  }

  async listProjectWorkflows(projectId, limit = 50) {
    const raw = this.workflowRuntime.store?.listWorkflows
      ? await this.workflowRuntime.store.listWorkflows()
      : await this.workflowRuntime.listWorkflows({ limit: 200 });
    const snapshots = [];
    for (const workflow of raw) {
      if (projectIdOf(workflow) !== projectId) continue;
      const snapshot = this.workflowRuntime.inspectWorkflow ? await this.workflowRuntime.inspectWorkflow(workflow.workflowId) : workflow;
      if (snapshot) snapshots.push(snapshot);
    }
    return sortRecent(snapshots).slice(0, limit);
  }

  async buildProjectBrief(projectId) {
    const context = this.projectRegistry.getProjectContext(projectId);
    const resolvedProjectId = context.project.projectId;
    const [workflows, sessions, decisions] = await Promise.all([
      this.listProjectWorkflows(resolvedProjectId),
      this.store.listSessions({ projectId: resolvedProjectId, limit: 200 }),
      this.store.listDecisions({ limit: 500 })
    ]);
    const projectDecisions = decisions.filter((decision) => decision.projectId === resolvedProjectId);
    const waitingDecisions = projectDecisions.filter((decision) => decision.status === "waiting_for_clarification");
    const active = workflows.filter((workflow) => ACTIVE_WORKFLOW_STATUSES.has(workflow.status));
    const recentTerminal = workflows.filter((workflow) => TERMINAL_WORKFLOW_STATUSES.has(workflow.status)).slice(0, 10);
    const packages = (await Promise.all(recentTerminal.map((workflow) => this.store.readReviewPackage(workflow.workflowId)))).filter(Boolean);
    const reviewResults = (await Promise.all(recentTerminal.map((workflow) => this.store.listSupervisorReviewResults(workflow.workflowId)))).flat();
    const currentStatus = waitingDecisions.length ? "waiting_for_clarification" : active.length ? "active" : workflows[0]?.status === "failed" ? "needs_attention" : "idle";
    const recentChanges = packages.flatMap((reviewPackage) => (reviewPackage.changes?.observedChanges || []).map((change) => ({ workflowId: reviewPackage.workflowId, change: clone(change) }))).slice(0, 30);
    const unresolvedIssues = unique([
      ...waitingDecisions.map((decision) => `Supervisor needs clarification: ${decision.possibleIntentMismatch || decision.goal}`),
      ...(workflows[0]?.status === "failed" ? [`Latest Workflow ${workflows[0].workflowId} failed: ${workflows[0].userRequest}`] : []),
      ...sessions.flatMap((session) => session.unresolvedQuestions || []),
      ...reviewResults.filter((review) => ["revise", "investigate"].includes(review.conclusion)).flatMap((review) => review.risks || [])
    ]);
    const recommendedNextSteps = unique([
      ...reviewResults.flatMap((review) => [...(review.recommendations || []), ...(review.nextSteps || [])])
    ]);
    const generatedFrom = [
      { type: "project_context", id: resolvedProjectId },
      ...workflows.slice(0, 20).map((workflow) => ({ type: "workflow", id: workflow.workflowId })),
      ...reviewResults.slice(0, 20).map((review) => ({ type: "confirmed_supervisor_review", id: review.reviewId })),
      ...sessions.slice(0, 20).map((session) => ({ type: "supervisor_session", id: session.sessionId }))
    ];
    if (context.memory?.available) generatedFrom.push({ type: "project_memory", id: context.memory.digest });
    const brief = {
      schemaVersion: 1,
      projectId: resolvedProjectId,
      currentStatus,
      activeGoals: unique(active.map((workflow) => workflow.supervisorDecision?.goal || workflow.userRequest)),
      recentChanges,
      recentWorkflowSummary: recentTerminal.map((workflow) => ({ workflowId: workflow.workflowId, status: workflow.status, goal: workflow.supervisorDecision?.goal || workflow.userRequest, updatedAt: workflow.updatedAt })),
      unresolvedIssues,
      recommendedNextSteps,
      generatedFrom,
      updatedAt: new Date().toISOString()
    };
    await this.store.writeProjectBrief(brief);
    return brief;
  }

  async getProjectContext(projectId) {
    const context = this.projectRegistry.getProjectContext(projectId);
    const resolvedProjectId = context.project.projectId;
    const [brief, sessions, workflows, decisions] = await Promise.all([
      this.buildProjectBrief(resolvedProjectId),
      this.store.listSessions({ projectId: resolvedProjectId, limit: 50 }),
      this.listProjectWorkflows(resolvedProjectId, 20),
      this.store.listDecisions({ limit: 500 })
    ]);
    const health = {
      schemaVersion: 1,
      projectId: resolvedProjectId,
      status: brief.currentStatus === "idle" ? "healthy" : brief.currentStatus,
      recent: brief.recentWorkflowSummary.slice(0, 5),
      attention: [...brief.unresolvedIssues],
      recommended: [...brief.recommendedNextSteps],
      generatedFrom: [...brief.generatedFrom]
    };
    if (!health.recent.length && context.memory?.available) {
      health.recent.push({ type: "project_memory", summary: "Project Memory is available.", updatedAt: context.memory.lastUpdated });
    }
    if (this.releaseStatus && resolvedProjectId === String(this.releaseStatus.projectId || "supervisor-runtime")) {
      health.release = clone(this.releaseStatus);
      health.attention = unique([...health.attention, ...(this.releaseStatus.attention || [])]);
      health.recommended = unique([...health.recommended, ...(this.releaseStatus.nextRequiredChecks || [])]);
      health.generatedFrom.push({ type: "release_status", id: this.releaseStatus.version || "current" });
    }
    return {
      schemaVersion: 1,
      project: context.project,
      brief,
      memorySummary: {
        available: context.memory.available,
        file: context.memory.file,
        digest: context.memory.digest,
        lastUpdated: context.memory.lastUpdated,
        summary: String(context.projectMemorySummary || "").slice(0, 4000)
      },
      sessions: sessions.map((session) => ({ sessionId: session.sessionId, name: session.name, purpose: session.purpose, decisions: session.decisions, unresolvedQuestions: session.unresolvedQuestions, nextActions: session.nextActions, relatedWorkflows: session.relatedWorkflows, updatedAt: session.updatedAt })),
      recentWorkflows: workflows.map((workflow) => ({ workflowId: workflow.workflowId, sessionId: workflow.sessionId || null, goal: workflow.supervisorDecision?.goal || workflow.userRequest, status: workflow.status, currentStage: workflow.currentStage, updatedAt: workflow.updatedAt })),
      openIssues: brief.unresolvedIssues,
      health,
      waitingClarifications: decisions.filter((decision) => decision.projectId === resolvedProjectId && decision.status === "waiting_for_clarification").map((decision) => ({ decisionId: decision.decisionId, goal: decision.goal, possibleIntentMismatch: decision.possibleIntentMismatch, clarificationReasons: decision.clarificationReasons, originalRequest: decision.originalRequest, createdAt: decision.createdAt }))
    };
  }

  async getArtifactCenter(workflowId) {
    const workflow = this.workflowRuntime.inspectWorkflow ? await this.workflowRuntime.inspectWorkflow(workflowId) : await this.workflowRuntime.getWorkflow(workflowId);
    if (!workflow) return null;
    const [reviewPackage, reviewResults, memoryProposal] = await Promise.all([
      this.store.readReviewPackage(workflowId),
      this.store.listSupervisorReviewResults(workflowId),
      this.store.readMemoryUpdateProposal(workflowId)
    ]);
    const projectId = projectIdOf(workflow);
    const memoryApplications = projectId ? await this.store.listMemoryApplications({ projectId, workflowId }) : [];
    return {
      schemaVersion: 1,
      workflowId,
      projectId,
      plan: clone(reviewPackage?.implementationStrategy || { workflowPlan: workflow.workflowPlan || null, decision: workflow.supervisorDecision || null }),
      approval: clone(reviewPackage?.auditEvidence?.approval || workflow.approvals || {}),
      executionEvidence: clone(reviewPackage?.auditEvidence?.stages || []),
      changes: clone(reviewPackage?.changes || { summary: null, reportedFiles: [], observedChanges: [] }),
      review: { technical: clone(reviewPackage?.reviewerResult || null), supervisor: clone(reviewResults[0] || null) },
      memoryImpact: { proposal: clone(memoryProposal), applications: clone(memoryApplications) },
      generatedAt: new Date().toISOString()
    };
  }
}
