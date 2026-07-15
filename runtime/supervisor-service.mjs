export class SupervisorService {
  constructor({ decisionLayer, store, workflowRuntime }) {
    this.decisionLayer = decisionLayer;
    this.store = store;
    this.workflowRuntime = workflowRuntime;
  }

  async start() { await this.store.init(); }

  async submitRequest({ userRequest, project = null, projectId = null, decisionId = null, definitionId = null, supervisorDecision = null, mockWorker = false }) {
    let decision;
    if (decisionId) {
      const existing = await this.store.readDecision(decisionId);
      if (!existing) throw new Error(`Supervisor Decision not found: ${decisionId}`);
      decision = this.decisionLayer.confirmProject(existing, projectId || project);
    } else {
      decision = this.decisionLayer.decide(userRequest, { project: projectId || project, definitionId, proposedDecision: supervisorDecision });
    }
    await this.store.writeDecision(decision);

    if (decision.nextAction === "confirm_project") return { status: "project_confirmation_required", decision, workflow: null };
    if (decision.nextAction === "respond_directly") return { status: "decision_only", decision, workflow: null };

    const workflow = await this.workflowRuntime.createWorkflow({
      userRequest: decision.originalRequest,
      definitionId: decision.workflowType,
      supervisorDecision: decision,
      mockWorker
    });
    decision = { ...decision, status: "workflow_created", workflowId: workflow.workflowId, updatedAt: new Date().toISOString() };
    await this.store.writeDecision(decision);
    await this.store.markProjectUsed(decision.project.id, decision.updatedAt);
    return { status: "success", decision, workflow };
  }

  async listProjects() { return this.decisionLayer.projectRegistry.listProjects(); }
  async getDecision(decisionId) { return this.store.readDecision(decisionId); }
}
