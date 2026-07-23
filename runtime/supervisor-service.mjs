export class SupervisorService {
  constructor({ decisionLayer, store, workflowRuntime, reviewPackageService = null, projectIntelligenceService = null, projectContinuityService = null, projectWorkspaceService = null }) {
    this.decisionLayer = decisionLayer;
    this.store = store;
    this.workflowRuntime = workflowRuntime;
    this.reviewPackageService = reviewPackageService;
    this.projectIntelligenceService = projectIntelligenceService;
    this.projectContinuityService = projectContinuityService;
    this.projectWorkspaceService = projectWorkspaceService;
  }

  async start() { await this.store.init(); }

  async submitRequest({ userRequest, project = null, projectId = null, decisionId = null, clarificationDecisionId = null, clarificationResponse = null, definitionId = null, supervisorDecision = null, sessionId = null, sessionName = null, supervisorSession = null, mockWorker = false }) {
    const explicitProjectId = String(projectId || supervisorDecision?.projectId || "").trim();
    if (!decisionId && !clarificationDecisionId && supervisorDecision?.nextAction === "create_workflow" && !explicitProjectId) {
      throw new Error("projectId_required: GPT-authored Workflow creation requires an explicit registered projectId.");
    }
    let decision;
    if (clarificationDecisionId) {
      const existing = await this.store.readDecision(clarificationDecisionId);
      if (!existing) throw new Error(`Supervisor Decision not found: ${clarificationDecisionId}`);
      if (projectId && projectId !== existing.projectId) throw new Error("Clarification response cannot change the confirmed project.");
      decision = this.decisionLayer.resolveClarification(existing, clarificationResponse, supervisorDecision);
      await this.store.writeDecision({ ...existing, status: "clarification_resolved", resolvedByDecisionId: decision.decisionId, updatedAt: new Date().toISOString() });
    } else if (decisionId) {
      const existing = await this.store.readDecision(decisionId);
      if (!existing) throw new Error(`Supervisor Decision not found: ${decisionId}`);
      decision = this.decisionLayer.confirmProject(existing, projectId || project);
    } else {
      decision = this.decisionLayer.decide(userRequest, { project: explicitProjectId || project, definitionId, proposedDecision: supervisorDecision });
    }

    if (decision.nextAction === "confirm_project") { await this.store.writeDecision(decision); return { status: "project_confirmation_required", decision, workflow: null }; }
    if (decision.nextAction === "request_clarification") { await this.store.writeDecision(decision); return { status: "clarification_required", decision, workflow: null }; }
    if (decision.nextAction === "respond_directly") { await this.store.writeDecision(decision); return { status: "decision_only", decision, workflow: null }; }

    const boundProjectId = decision.project?.projectId || decision.project?.id;
    const session = sessionId
      ? await this.store.requireSession(sessionId, boundProjectId)
      : await this.store.createSession({
        projectId: boundProjectId,
        name: sessionName || decision.goal || decision.originalRequest,
        source: supervisorDecision ? "chatgpt" : "local_fallback",
        purpose: supervisorSession?.purpose || decision.goal || decision.originalRequest,
        decisions: supervisorSession?.decisions || [],
        unresolvedQuestions: supervisorSession?.unresolvedQuestions || [],
        nextActions: supervisorSession?.nextActions || []
      });
    decision = { ...decision, session: { sessionId: session.sessionId, projectId: session.projectId, name: session.name }, updatedAt: new Date().toISOString() };
    await this.store.writeDecision(decision);

    const workflow = await this.workflowRuntime.createWorkflow({
      userRequest: decision.originalRequest,
      definitionId: decision.workflowType,
      supervisorDecision: decision,
      session,
      mockWorker
    });
    await this.store.attachWorkflowToSession(session.sessionId, workflow.workflowId);
    decision = { ...decision, status: "workflow_created", workflowId: workflow.workflowId, updatedAt: new Date().toISOString() };
    await this.store.writeDecision(decision);
    await this.store.markProjectUsed(decision.project.id, decision.updatedAt);
    return { status: "success", decision, workflow };
  }

  async listProjects() { return this.decisionLayer.projectRegistry.listProjects(); }
  async createProject(input) {
    if (!this.projectWorkspaceService) throw new Error("Project workspace management is unavailable.");
    return this.projectWorkspaceService.createProject(input);
  }
  async updateProject(projectId, patch) {
    if (!this.projectWorkspaceService) throw new Error("Project workspace management is unavailable.");
    if (Object.hasOwn(patch, "name") || patch.archived === true) {
      const activeStatuses = new Set(["created", "queued", "planning", "planned", "waiting_approval", "running", "reviewing"]);
      const workflows = await this.workflowRuntime.listWorkflows({ limit: 200 });
      const active = workflows.filter((workflow) => (workflow.projectId || workflow.project?.projectId || workflow.project?.id) === projectId && activeStatuses.has(workflow.status));
      if (active.length) throw new Error(`Project has ${active.length} active Workflow(s); rename or archive is not allowed.`);
    }
    let project = this.decisionLayer.projectRegistry.getProjectContext(projectId).project;
    if (Object.hasOwn(patch, "name")) project = await this.projectWorkspaceService.renameProject(projectId, { name: patch.name });
    if (Object.hasOwn(patch, "archived") || Object.hasOwn(patch, "pinned")) project = await this.projectWorkspaceService.updateProjectMetadata(projectId, patch);
    return project;
  }
  async getProjectContext(project) {
    const context = this.decisionLayer.projectRegistry.getProjectContext(project);
    return { ...context, sessions: await this.store.listSessions({ projectId: context.project.projectId }) };
  }
  async listProjectViews() {
    const [projects, workflows] = await Promise.all([this.listProjects(), this.workflowRuntime.listWorkflows({ limit: 200 })]);
    const sessions = await this.store.listSessions({ limit: 500 });
    return projects.map((project) => {
      const projectSessions = sessions.filter((session) => session.projectId === project.projectId);
      const projectWorkflows = workflows.filter((workflow) => (workflow.projectId || workflow.project?.projectId || workflow.project?.id) === project.projectId);
      return {
        ...project,
        sessionCount: projectSessions.length,
        workflowCount: projectWorkflows.length,
        sessions: projectSessions,
        recentWorkflows: projectWorkflows.slice(0, 10).map((workflow) => ({ workflowId: workflow.workflowId, sessionId: workflow.sessionId || null, userRequest: workflow.userRequest, status: workflow.status, updatedAt: workflow.updatedAt }))
      };
    });
  }
  async getDecision(decisionId) { return this.store.readDecision(decisionId); }
  async getWorkflowReviewPackage(workflowId) {
    if (!this.reviewPackageService) throw new Error("Supervisor Review Package service is unavailable.");
    return this.reviewPackageService.build(workflowId);
  }
  async getWorkflowProjectIntelligence(workflowId) {
    if (!this.projectIntelligenceService) throw new Error("Project Intelligence service is unavailable.");
    return this.projectIntelligenceService.getWorkflowIntelligence(workflowId);
  }
  async recordSupervisorReview(input) {
    if (!this.projectIntelligenceService) throw new Error("Project Intelligence service is unavailable.");
    return this.projectIntelligenceService.recordSupervisorReview(input);
  }
  async applyMemoryProposal(input) {
    if (!this.projectIntelligenceService) throw new Error("Project Intelligence service is unavailable.");
    return this.projectIntelligenceService.applyMemoryProposal(input);
  }
  async getProjectContinuity(projectId) {
    if (!this.projectContinuityService) throw new Error("Project Continuity service is unavailable.");
    return this.projectContinuityService.getProjectContext(projectId);
  }
  async getWorkflowArtifactCenter(workflowId) {
    if (!this.projectContinuityService) throw new Error("Project Continuity service is unavailable.");
    return this.projectContinuityService.getArtifactCenter(workflowId);
  }
}
