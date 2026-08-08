import { resolveResourceProfile } from "../runtime/resource-profiles.mjs";
import { classifyWorkflowFailure } from "../runtime/failure-catalog.mjs";

const ACTIVE_STATUSES = new Set(["created", "planning", "planned", "waiting_approval", "running", "reviewing", "queued"]);

function unique(values) {
  return [...new Set((values || []).filter((value) => value != null && String(value).trim()).map((value) => String(value)))];
}

function latestAudit(task) {
  return task?.attempts?.at(-1)?.audit || null;
}

function numeric(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function describeProposedChange(change) {
  if (typeof change === "string") return change;
  if (!change || typeof change !== "object") return String(change || "");
  const target = change.file || change.path || change.target || "";
  const description = change.description || change.summary || change.operation || "";
  return [target, description].filter(Boolean).join(" — ") || JSON.stringify(change);
}

function humanNextAction(workflow) {
  if (workflow.status === "waiting_approval") return "Review the plan and approve or reject the proposed change.";
  if (workflow.status === "failed") return workflow.failure?.error?.code === "approval_rejected" ? "Revise the request before creating a new workflow." : "Inspect the failure and audit evidence.";
  if (workflow.status === "completed" || workflow.status === "succeeded") return "Review the completed result.";
  if (workflow.nextAction?.role) return `Wait for ${workflow.nextAction.role} to finish.`;
  return "Wait for the current stage to finish.";
}

function resourceEstimate(profileName, plannedChangeCount) {
  try {
    const profile = resolveResourceProfile(profileName);
    const likelyUsd = Math.min(profile.limits.maxBudgetUsd, Math.max(0.1, 0.15 + Math.max(1, plannedChangeCount) * 0.1));
    return { likelyUsd: Number(likelyUsd.toFixed(2)), upperBoundUsd: profile.limits.maxBudgetUsd, basis: "rule_based_from_planned_scope", resourceLimits: profile.limits };
  } catch { return null; }
}

function observedChangeDetails(task) {
  const changes = task?.attempts?.at(-1)?.observedChanges || [];
  const grouped = new Map();
  for (const change of changes) {
    const current = grouped.get(change.file) || { file: change.file, operations: [], addedLines: 0, removedLines: 0, diffs: [] };
    current.operations.push(change.operation);
    current.addedLines += numeric(change.addedLines);
    current.removedLines += numeric(change.removedLines);
    if (change.diff) current.diffs.push(change.diff);
    grouped.set(change.file, current);
  }
  return [...grouped.values()].map((change) => ({ ...change, operationCount: change.operations.length, summary: `${change.operations.length} observed edit${change.operations.length === 1 ? "" : "s"}; +${change.addedLines} / -${change.removedLines} lines`, diff: change.diffs.join("\n\n").slice(0, 40000) }));
}

export function buildSupervisorProductView(workflow, tasks = []) {
  const auditsByRole = Object.fromEntries(tasks.map((task) => [task.role, latestAudit(task)]).filter(([, audit]) => audit));
  const allAudits = Object.values(auditsByRole);
  const implementationStage = (workflow.stages || []).find((stage) => stage.requiresApproval);
  const approval = implementationStage ? workflow.approvals?.[implementationStage.id] : null;
  const rejection = implementationStage ? workflow.rejections?.[implementationStage.id] : null;
  const plannerAudit = auditsByRole.planner || null;
  const coderAudit = auditsByRole.coder || null;
  const reviewerAudit = auditsByRole.reviewer || null;
  const coderTask = tasks.find((task) => task.role === "coder") || null;
  const changedFiles = unique(coderAudit?.changes_made);
  const decision = workflow.supervisorDecision || null;
  const risks = unique([...(decision?.risks || []), ...allAudits.flatMap((audit) => audit?.risks || [])]);
  const errors = unique([
    workflow.failure?.error?.message,
    ...tasks.map((task) => task.error?.message),
    ...allAudits.map((audit) => audit?.error?.message)
  ]);
  const totalCostUsd = allAudits.reduce((total, audit) => total + numeric(audit?.cost), 0);
  const totalUsage = allAudits.reduce((total, audit) => ({
    turns: total.turns + numeric(audit?.resource_usage?.turns),
    filesRead: total.filesRead + numeric(audit?.resource_usage?.filesRead),
    commands: total.commands + numeric(audit?.resource_usage?.commands)
  }), { turns: 0, filesRead: 0, commands: 0 });
  const plannedChanges = unique((plannerAudit?.proposed_changes || []).map(describeProposedChange));
  const contextualFiles = unique(plannerAudit?.files_read);
  const changeDetails = observedChangeDetails(coderTask);
  const estimatedCost = implementationStage ? resourceEstimate(implementationStage.resourceProfile, plannedChanges.length) : null;
  const failure = classifyWorkflowFailure(workflow);

  return {
    status: workflow.status,
    active: ACTIVE_STATUSES.has(workflow.status),
    currentStage: workflow.currentStage,
    project: workflow.project || null,
    projectId: workflow.projectId || workflow.project?.projectId || workflow.project?.id || null,
    workspacePath: workflow.workspacePath || workflow.project?.workspacePath || workflow.project?.path || null,
    session: workflow.session || null,
    sessionId: workflow.sessionId || workflow.session?.sessionId || null,
    nextAction: humanNextAction(workflow),
    totalCostUsd,
    totalUsage,
    changedFiles,
    changeDetails,
    risks,
    errors,
    failure,
    recovery: {
      available: workflow.status === "failed" && workflow.orchestrated === true && failure?.retryable === true,
      sourceWorkflowId: workflow.recovery?.sourceWorkflowId || null,
      recoveries: workflow.recoveries || []
    },
    planner: plannerAudit ? { summary: plannerAudit.summary || null, proposedChanges: plannedChanges, filesRead: contextualFiles, risks: unique(plannerAudit.risks), blockedOn: unique(plannerAudit.blocked_on) } : null,
    review: reviewerAudit ? { summary: reviewerAudit.summary || null, checks: unique(reviewerAudit.tests_or_checks), risks: unique(reviewerAudit.risks), blockedOn: unique(reviewerAudit.blocked_on) } : null,
    supervisorDecision: decision ? {
      decisionId: decision.decisionId,
      intent: decision.intent,
      goal: decision.goal,
      goalConfidence: decision.goalConfidence ?? decision.confidence,
      possibleIntentMismatch: decision.possibleIntentMismatch || null,
      clarificationNeeded: decision.clarificationNeeded === true,
      clarificationReasons: decision.clarificationReasons || [],
      technicalSummary: decision.technical_summary || null,
      implementationStrategy: decision.implementation_strategy || null,
      expectedChanges: decision.expected_changes || [],
      validationPlan: decision.validation_plan || [],
      supervisorContext: decision.supervisor_context || null,
      project: decision.project,
      reasoning: decision.reasoning || [],
      risks: decision.risks || [],
      workflowType: decision.workflowType,
      estimatedResources: decision.estimated_resources || null,
      recommendedActions: decision.recommended_actions || [],
      agentRequired: decision.agentRequired === true,
      confidence: decision.confidence,
      nextAction: decision.nextAction,
      source: decision.source
    } : null,
    approval: implementationStage ? {
      required: true,
      stageId: implementationStage.id,
      status: approval ? "approved" : rejection ? "rejected" : workflow.status === "waiting_approval" ? "waiting" : "pending",
      reason: workflow.nextAction?.reason || "A write-capable stage requires explicit human approval.",
      approvedBy: approval?.approvedBy || null,
      approvalReason: approval?.approvalReason || null,
      approvedAt: approval?.approvedAt || null,
      rejectedBy: rejection?.rejectedBy || null,
      rejectionReason: rejection?.rejectionReason || null,
      rejectedAt: rejection?.rejectedAt || null,
      resourceProfile: implementationStage.resourceProfile || null,
      resourceSelection: implementationStage.resourceSelection || null,
      estimatedCost,
      workflowResourceEstimate: decision?.estimated_resources || null,
      modificationReason: plannerAudit?.summary || decision?.technical_summary || workflow.userRequest,
      plannedChanges,
      contextualFiles,
      risks: unique([...(decision?.risks || []), ...(plannerAudit?.risks || [])]),
      changeDetails,
      estimatedImpact: `${plannedChanges.length} planned change${plannedChanges.length === 1 ? "" : "s"}; ${contextualFiles.length} contextual file${contextualFiles.length === 1 ? "" : "s"} inspected.`
    } : { required: false, status: "not_required" },
    executionPolicy: {
      allowed: [
        "Read files inside the configured project.",
        "Modify the approved workspace after explicit human approval.",
        "Run only tools allowed by the selected mode and policy."
      ],
      blocked: [
        "Modify files outside the configured workspace.",
        "Run unauthorized commands or write-capable tools in read-only stages.",
        "Start an approval-gated execution without explicit approval.",
        "Accept a result that fails the audit contract."
      ]
    }
  };
}
