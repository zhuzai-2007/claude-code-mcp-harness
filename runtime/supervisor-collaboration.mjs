const TERMINAL_WORKFLOW_STATUSES = new Set(["completed", "succeeded", "failed"]);

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function uniqueStrings(values, limit = 50) {
  return [...new Set((values || []).map((value) => String(value || "").trim()).filter(Boolean))].slice(0, limit);
}

function technicalReviewStatus(workflow, reviewerStage) {
  if (workflow.status === "failed") return "failed";
  if (!TERMINAL_WORKFLOW_STATUSES.has(workflow.status)) return "pending";
  if (!reviewerStage) return "not_applicable";
  const audit = reviewerStage.audit || {};
  const blocked = Array.isArray(audit.blocked_on) ? audit.blocked_on : [];
  return reviewerStage.taskStatus === "succeeded" && audit.status === "success" && blocked.length === 0 ? "pass" : "attention";
}

export function buildChatGptReviewGuidance({ workflow, reviewPackage }) {
  const workflowId = workflow.workflowId;
  const projectId = workflow.projectId || workflow.project?.projectId || workflow.project?.id || null;
  const reviewerStage = reviewPackage.auditEvidence?.stages?.find((stage) => stage.role === "reviewer") || null;
  const available = TERMINAL_WORKFLOW_STATUSES.has(workflow.status);
  const toolCall = { name: "cc_get_supervisor_review_package", arguments: { workflowId } };
  const zhCN = `请作为项目负责人，对当前 Workflow 进行 Supervisor Review。\n\nWorkflow ID:\n${workflowId}\n\nProject ID:\n${projectId || "未绑定"}\n\n请通过 MCP 调用：\ncc_get_supervisor_review_package({"workflowId":"${workflowId}"})\n\n重点分析：\n1. 是否满足用户最初目标；\n2. 当前修改是否符合项目长期方向；\n3. 是否存在隐藏风险；\n4. 下一步开发建议；\n5. 是否需要更新 Project Memory。\n\n请区分事实证据、推断和建议。不要自动审批、执行新 Workflow 或修改 Project Memory。先向用户展示结论；只有用户明确要求保存时，才调用 cc_record_supervisor_review_result。`;
  const en = `Act as the accountable project Supervisor and review this Workflow.\n\nWorkflow ID:\n${workflowId}\n\nProject ID:\n${projectId || "unbound"}\n\nUse MCP to call:\ncc_get_supervisor_review_package({"workflowId":"${workflowId}"})\n\nAssess:\n1. Whether the original user goal was met;\n2. Whether the change fits the project's long-term direction;\n3. Hidden risks;\n4. Recommended next development steps;\n5. Whether Project Memory should be updated.\n\nSeparate evidence, inference, and recommendation. Do not auto-approve, start another Workflow, or modify Project Memory. Present the conclusion first; call cc_record_supervisor_review_result only if the user explicitly asks to save it.`;
  return {
    schemaVersion: 1,
    status: available ? "available" : "not_available",
    supervisorReviewStatus: reviewPackage.supervisorReviewResult?.conclusion || "not_started",
    technicalReview: technicalReviewStatus(workflow, reviewerStage),
    workflowId,
    projectId,
    reviewPackageTool: toolCall,
    suggestedPrompts: { zhCN, en }
  };
}

export function buildMemoryUpdateProposal({ workflow, reviewPackage }) {
  const stages = reviewPackage.auditEvidence?.stages || [];
  const coder = stages.find((stage) => stage.role === "coder") || null;
  const reviewer = stages.find((stage) => stage.role === "reviewer") || null;
  const observedChanges = (coder?.observedChanges || []).filter((change) => change?.file);
  const affectedAreas = uniqueStrings(observedChanges.map((change) => change.file));
  const reviewerAudit = reviewer?.audit || null;
  const reviewerChecks = uniqueStrings(reviewerAudit?.tests_or_checks, 12);
  const reviewerBlocked = uniqueStrings(reviewerAudit?.blocked_on, 12);
  const completed = ["completed", "succeeded"].includes(workflow.status);
  const coderEvidencePassed = coder?.taskStatus === "succeeded" && coder?.audit?.status === "success" && observedChanges.length > 0;
  const reviewerEvidencePassed = reviewer?.taskStatus === "succeeded" && reviewerAudit?.status === "success" && reviewerChecks.length > 0 && reviewerBlocked.length === 0;
  const evidenceSufficient = completed && coderEvidencePassed && reviewerEvidencePassed;
  const decision = workflow.supervisorDecision || reviewPackage.decision || null;
  const goal = String(decision?.goal || workflow.userRequest || "").trim();
  const projectId = workflow.projectId || reviewPackage.projectContext?.projectId || null;
  const generatedAt = new Date().toISOString();
  const noProposalReason = !completed
    ? "Workflow did not complete; partial evidence must not be promoted to Project Memory."
    : !coderEvidencePassed
      ? "No completed Harness-observed implementation change requires a durable Memory entry."
      : !reviewerEvidencePassed
        ? "Reviewer evidence is incomplete or blocked, so a Memory update is not proposed."
        : null;
  const suggestedMemoryChanges = evidenceSufficient ? [
    `Completed project goal: ${goal}`,
    `Harness-observed affected areas: ${affectedAreas.join(", ")}.`,
    `Reviewer verification: ${reviewerChecks.join("; ")}.`
  ] : [];
  return {
    schemaVersion: 1,
    proposalId: `memory_proposal_${workflow.workflowId}`,
    projectId,
    workflowId: workflow.workflowId,
    workflowStatus: workflow.status,
    status: evidenceSufficient ? "proposed" : "no_update_proposed",
    generatedAt,
    summary: evidenceSufficient ? `Durable project facts from completed goal: ${goal}` : null,
    affectedAreas,
    suggestedMemoryChanges,
    reason: evidenceSufficient
      ? "Proposal is based on successful strict audit, Harness-observed file changes, and Reviewer verification evidence."
      : noProposalReason,
    evidenceBasis: {
      decision: decision ? { decisionId: decision.decisionId || null, goal, goalConfidence: decision.goalConfidence ?? null } : null,
      observedChanges: clone(observedChanges),
      reviewer: reviewer ? { taskId: reviewer.taskId, taskStatus: reviewer.taskStatus, filesRead: clone(reviewerAudit?.files_read || []), checks: reviewerChecks, blockedOn: reviewerBlocked } : null,
      projectContext: {
        projectId,
        description: reviewPackage.projectContext?.description || null,
        constraints: clone(reviewPackage.projectContext?.constraints || []),
        memoryDigest: reviewPackage.memorySnapshot?.digest || null
      }
    },
    requiresConfirmation: true,
    applied: false
  };
}
