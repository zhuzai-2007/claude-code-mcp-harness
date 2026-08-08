import { buildChatGptReviewGuidance, buildMemoryUpdateProposal } from "./supervisor-collaboration.mjs";

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function auditFields(audit) {
  if (!audit) return null;
  const keys = ["status", "mode", "summary", "files_read", "proposed_changes", "changes_made", "commands_run", "tests_or_checks", "risks", "blocked_on", "run_result", "resource_profile", "resource_limits", "resource_usage", "cost", "error", "audit_issues", "supervisor_notes", "capability_diagnostics", "artifact_status"];
  return Object.fromEntries(keys.map((key) => [key, clone(audit[key])]).filter(([, value]) => value !== undefined));
}

function unique(values) {
  return [...new Set((values || []).map((value) => String(value || "").trim()).filter(Boolean))];
}

export class SupervisorReviewPackageService {
  constructor({ workflowRuntime, taskRuntime, projectRegistry, store, attemptInspector = null }) {
    this.workflowRuntime = workflowRuntime;
    this.taskRuntime = taskRuntime;
    this.projectRegistry = projectRegistry;
    this.store = store;
    this.attemptInspector = attemptInspector || (() => ({ audit: null, recentToolCalls: [], observedChanges: [], artifactFiles: [] }));
  }

  async build(workflowId) {
    const workflow = this.workflowRuntime.inspectWorkflow
      ? await this.workflowRuntime.inspectWorkflow(workflowId)
      : await this.workflowRuntime.getWorkflow(workflowId);
    if (!workflow) return null;
    const stages = [];
    for (const ref of workflow.tasks || []) {
      const task = await this.taskRuntime.getTask(ref.taskId);
      const attempt = task?.attempts?.at(-1) || null;
      const inspection = attempt ? this.attemptInspector(attempt.attemptId) : null;
      stages.push({
        stageId: ref.stageId || null,
        role: ref.role,
        mode: ref.mode,
        taskId: ref.taskId,
        taskStatus: task?.status || "missing",
        attemptId: attempt?.attemptId || null,
        attemptStatus: attempt?.status || null,
        resourceProfile: attempt?.resourceProfile || task?.settings?.resourceProfile || null,
        resourceLimits: clone(attempt?.resourceLimits || task?.settings?.resourceLimits || null),
        audit: auditFields(inspection?.audit || null),
        observedChanges: clone(inspection?.observedChanges || []),
        recentToolCalls: clone(inspection?.recentToolCalls || []),
        artifactFiles: clone(inspection?.artifactFiles || []),
        error: clone(task?.error || attempt?.error || null)
      });
    }

    const byRole = Object.fromEntries(stages.map((stage) => [stage.role, stage]));
    const decision = workflow.supervisorDecision || null;
    let registeredContext = null;
    const projectId = workflow.projectId || workflow.project?.projectId || workflow.project?.id || null;
    if (projectId) {
      try { registeredContext = this.projectRegistry.getProjectContext(projectId); }
      catch { registeredContext = null; }
    }
    const memory = decision?.project_memory || registeredContext?.memory || null;
    const hasFrozenMemoryContent = memory ? Object.hasOwn(memory, "content") : false;
    const generatedAt = new Date().toISOString();
    const reviewResults = await this.store.listSupervisorReviewResults(workflow.workflowId);
    const supervisorReviewResult = reviewResults[0] || null;
    const reviewPackage = {
      schemaVersion: 2,
      packageId: `review_package_${workflow.workflowId}`,
      workflowId: workflow.workflowId,
      generatedAt,
      reviewReadiness: ["completed", "succeeded"].includes(workflow.status) ? "complete" : workflow.status === "failed" ? "failed_workflow" : "in_progress",
      originalRequest: workflow.userRequest,
      decision: clone(decision),
      implementationStrategy: {
        supervisor: decision?.implementation_strategy || null,
        plannerSummary: byRole.planner?.audit?.summary || null,
        proposedChanges: clone(byRole.planner?.audit?.proposed_changes || []),
        validationPlan: clone(decision?.validation_plan || [])
      },
      changes: {
        summary: byRole.coder?.audit?.summary || null,
        runResult: clone(byRole.coder?.audit?.run_result || null),
        reportedFiles: unique(byRole.coder?.audit?.changes_made),
        observedChanges: clone(byRole.coder?.observedChanges || [])
      },
      auditEvidence: {
        contract: "mode_specific_strict_audit",
        workflowStatus: workflow.status,
        approval: clone(workflow.approvals || {}),
        failure: clone(workflow.failure || null),
        stages
      },
      reviewerResult: clone(byRole.reviewer?.audit || null),
      projectContext: {
        projectId,
        workspacePath: workflow.workspacePath || workflow.projectBinding?.workspacePath || null,
        binding: clone(workflow.projectBinding || null),
        project: clone(workflow.project || registeredContext?.project || null),
        description: registeredContext?.projectDescription || workflow.project?.description || null,
        stack: clone(registeredContext?.technicalStack || workflow.project?.stack || workflow.project?.techStack || []),
        constraints: clone(decision?.constraints || registeredContext?.constraints || []),
        supervisorContext: clone(decision?.supervisor_context || registeredContext?.supervisorContext || null),
        supervisorInstructions: String(registeredContext?.supervisorInstructions || ""),
        contextSource: registeredContext ? "current_project_registry" : "workflow_snapshot_only"
      },
      memorySnapshot: memory ? {
        status: hasFrozenMemoryContent ? "captured" : memory.available === true ? "legacy_metadata_only" : "unavailable",
        available: memory.available === true,
        file: memory.file || "PROJECT_MEMORY.md",
        digest: memory.digest || null,
        lastUpdated: memory.lastUpdated || null,
        size: Number(memory.size || 0),
        capturedAt: memory.capturedAt || decision?.createdAt || workflow.createdAt,
        content: hasFrozenMemoryContent ? String(memory.content || "") : ""
      } : { status: "unavailable", available: false, file: "PROJECT_MEMORY.md", digest: null, lastUpdated: null, size: 0, capturedAt: workflow.createdAt, content: "" },
      supervisorReviewResult: clone(supervisorReviewResult),
      goalAlignment: supervisorReviewResult?.goalAlignment || null,
      architectureImpact: supervisorReviewResult?.architectureAssessment || null,
      futureRecommendations: clone(supervisorReviewResult?.recommendations || []),
      memoryUpdateNeeded: supervisorReviewResult?.memoryUpdateNeeded ?? null
    };
    reviewPackage.chatGptReviewGuidance = buildChatGptReviewGuidance({ workflow, reviewPackage });
    const existingProposal = await this.store.readMemoryUpdateProposal(workflow.workflowId);
    const preserveExistingProposal = existingProposal?.applied === true || existingProposal?.workflowStatus === workflow.status;
    reviewPackage.memoryUpdateProposal = preserveExistingProposal
      ? existingProposal
      : buildMemoryUpdateProposal({ workflow, reviewPackage });
    if (!preserveExistingProposal) await this.store.writeMemoryUpdateProposal(reviewPackage.memoryUpdateProposal);
    await this.store.writeReviewPackage(reviewPackage);
    return reviewPackage;
  }

  async read(workflowId) {
    return this.store.readReviewPackage(workflowId);
  }
}
