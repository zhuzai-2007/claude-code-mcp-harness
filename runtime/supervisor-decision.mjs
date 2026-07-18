import { randomBytes } from "node:crypto";
import { resolveResourceProfile } from "./resource-profiles.mjs";

const INTENTS = new Set(["code_change", "documentation_change", "analysis", "conversation", "unknown"]);
const NEXT_ACTIONS = new Set(["create_workflow", "confirm_project", "respond_directly", "request_clarification"]);

function nowIso() { return new Date().toISOString(); }
function boundedConfidence(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= 1 ? number : fallback;
}
function intentForWorkflow(workflowType) {
  return workflowType === "analysis_only" ? "analysis" : workflowType === "documentation_change" ? "documentation_change" : "code_change";
}

function stringList(value, fallback = [], limit = 12) {
  const values = Array.isArray(value) ? value : [];
  const normalized = values.map((item) => String(item || "").trim()).filter(Boolean).slice(0, limit);
  return normalized.length ? normalized : [...fallback];
}

function workflowResources(workflowPlanner, workflowType, nextAction, proposed = null) {
  if (nextAction !== "create_workflow") {
    return { basis: "no_worker_required", complexity: "none", expected: { budgetUsd: 0, turns: 0, filesRead: 0, commands: 0, timeoutSeconds: 0 }, hard_caps: { budgetUsd: 0, turns: 0, filesRead: 0, commands: 0, timeoutSeconds: 0 }, stages: [], within_hard_caps: true, notes: ["No local Worker or Workflow will run."] };
  }
  const definition = workflowPlanner.definitions?.definitions?.[workflowType];
  const stages = (definition?.stages || []).map((stage) => {
    const profile = resolveResourceProfile(stage.resourceProfile);
    return { role: stage.role, mode: stage.mode, resourceProfile: profile.name, limits: profile.limits };
  });
  const hard = stages.reduce((total, stage) => ({
    budgetUsd: total.budgetUsd + Number(stage.limits.maxBudgetUsd || 0),
    turns: total.turns + Number(stage.limits.maxTurns || 0),
    filesRead: total.filesRead + Number(stage.limits.maxFilesRead || 0),
    commands: total.commands + Number(stage.limits.maxCommands || 0),
    timeoutSeconds: total.timeoutSeconds + Number(stage.limits.timeoutSeconds || 0)
  }), { budgetUsd: 0, turns: 0, filesRead: 0, commands: 0, timeoutSeconds: 0 });
  const complexity = ["low", "medium", "high"].includes(proposed?.complexity) ? proposed.complexity : workflowType === "documentation_change" ? "low" : "medium";
  const expectedInput = proposed?.expected || proposed || {};
  const expectedValue = (key, fallback) => {
    const number = Number(expectedInput[key]);
    return Number.isFinite(number) && number >= 0 ? number : fallback;
  };
  const expected = {
    budgetUsd: expectedValue("budgetUsd", Number((hard.budgetUsd * 0.25).toFixed(2))),
    turns: Math.round(expectedValue("turns", hard.turns * 0.35)),
    filesRead: Math.round(expectedValue("filesRead", hard.filesRead * 0.3)),
    commands: Math.round(expectedValue("commands", hard.commands * 0.2)),
    timeoutSeconds: Math.round(expectedValue("timeoutSeconds", hard.timeoutSeconds * 0.5))
  };
  const withinHardCaps = Object.entries(expected).every(([key, value]) => value <= hard[key]);
  const notes = stringList(proposed?.notes, ["Estimate is advisory; Resource Profiles remain the enforced per-stage limits."], 8);
  if (!withinHardCaps) notes.push("The GPT estimate exceeds the selected Workflow profile envelope; revise the Workflow or estimate before approval.");
  return { basis: proposed ? "gpt_estimate_with_runtime_caps" : "workflow_profile_heuristic", complexity, expected, hard_caps: hard, stages, within_hard_caps: withinHardCaps, notes };
}

function assertDecisionConsistency(intent, workflowType, nextAction, projectResolution) {
  if (nextAction === "create_workflow" && projectResolution.status !== "selected") throw new Error("create_workflow requires one confirmed registered project.");
  if (nextAction === "confirm_project" && projectResolution.status === "selected") throw new Error("confirm_project is inconsistent with an already selected project.");
  if (nextAction !== "create_workflow") return;
  const expected = { analysis: "analysis_only", documentation_change: "documentation_change", code_change: "software_change" }[intent];
  if (expected && workflowType !== expected) throw new Error(`Supervisor intent '${intent}' requires Workflow '${expected}', received '${workflowType}'.`);
  if (intent === "conversation") throw new Error("Conversation intent must use respond_directly.");
}

export class SupervisorDecisionLayer {
  constructor({ projectRegistry, workflowPlanner }) {
    this.projectRegistry = projectRegistry;
    this.workflowPlanner = workflowPlanner;
  }

  decide(userRequest, { project = null, definitionId = null, proposedDecision = null } = {}) {
    const request = String(userRequest || "").trim();
    if (!request) throw new Error("userRequest is required");
    const proposed = proposedDecision && typeof proposedDecision === "object" ? proposedDecision : null;
    const requestedWorkflow = proposed?.workflowType || definitionId || null;
    const plan = this.workflowPlanner.plan(request, { workflowType: requestedWorkflow });
    const projectResolution = this.projectRegistry.resolve(request, { selector: project || proposed?.project || proposed?.projectId || null });
    const proposedNextAction = String(proposed?.nextAction || "").trim();
    if (proposedNextAction && !NEXT_ACTIONS.has(proposedNextAction)) throw new Error(`Unsupported Supervisor nextAction: ${proposedNextAction}`);
    const requestedNextAction = proposedNextAction === "respond_directly" ? "respond_directly" : projectResolution.status !== "selected" ? "confirm_project" : proposedNextAction || "create_workflow";
    const intent = String(proposed?.intent || intentForWorkflow(plan.workflowType)).trim();
    if (!INTENTS.has(intent)) throw new Error(`Unsupported Supervisor intent: ${intent}`);
    const source = proposed ? "gpt" : "local_rules";
    const reasoning = Array.isArray(proposed?.reasoning) && proposed.reasoning.length
      ? proposed.reasoning.map((item) => String(item).trim()).filter(Boolean).slice(0, 12)
      : [plan.reason, projectResolution.status === "selected" ? `Selected registered project '${projectResolution.project.name}' by ${projectResolution.method}.` : "The target project is ambiguous and requires user confirmation."];
    const constraints = [...new Set([
      ...plan.constraints,
      ...(projectResolution.project ? [...(projectResolution.project.defaultConstraints || []), `Only inspect or modify files under registered project '${projectResolution.project.path}'.`, "Do not explore sibling projects or other workspace directories."] : [])
    ])];
    const technicalSummary = String(proposed?.technical_summary || `${plan.goal} ${projectResolution.project ? `in '${projectResolution.project.name}'` : "after the target project is confirmed"}; recommended Workflow: ${plan.workflowType}.`).trim();
    const implementationStrategy = String(proposed?.implementation_strategy || (requestedNextAction === "respond_directly"
      ? "No local implementation is required; answer the user directly and make the reasoning explicit."
      : plan.workflowType === "analysis_only"
        ? "Inspect only the registered project, trace the relevant implementation path, and report evidence without modifying files."
        : "Use the Planner to identify the smallest relevant file set, preserve existing behavior, and implement only the approved bounded change.")).trim();
    const expectedChanges = stringList(proposed?.expected_changes, requestedNextAction === "create_workflow" && plan.workflowType !== "analysis_only"
      ? ["Planner must identify the exact files and behavior expected to change before approval."]
      : [], 20);
    const validationPlan = stringList(proposed?.validation_plan, requestedNextAction === "create_workflow"
      ? ["Run focused checks for the requested behavior.", "Reviewer must verify the result against the original goal and report regressions or remaining risks."]
      : [], 20);
    const projectContext = projectResolution.project ? this.projectRegistry.getProjectContext(projectResolution.project.id) : null;
    const supervisorContext = projectContext?.supervisorContext || { available: false, file: "AI_SUPERVISOR.md", digest: null };
    const defaultRisks = requestedNextAction === "respond_directly"
      ? ["No local Worker will run; the response remains the responsibility of the GPT Supervisor."]
      : requestedNextAction === "confirm_project"
        ? ["The target project is ambiguous; starting a Worker before confirmation would risk modifying the wrong project."]
        : ["The external Worker may inspect files inside the registered project.", ...(plan.workflowType === "analysis_only" ? [] : ["Any write-capable stage remains blocked until explicit human approval."])];
    let recommendedActions = stringList(proposed?.recommended_actions, requestedNextAction === "respond_directly"
      ? ["Answer the user directly without creating a local Workflow."]
      : requestedNextAction === "confirm_project"
        ? ["Ask the user to select one registered project before starting a Worker."]
        : [`Create the '${plan.workflowType}' Workflow.`, "Review the Planner result and risks before any approval-gated execution."], 12);
    const estimatedResources = workflowResources(this.workflowPlanner, plan.workflowType, requestedNextAction, proposed?.estimated_resources || null);
    const risks = stringList(proposed?.risks, defaultRisks, 12);
    if (!estimatedResources.within_hard_caps) risks.push("Estimated resources exceed the selected Workflow profile envelope.");
    const decisionConfidence = boundedConfidence(proposed?.confidence, projectResolution.status === "selected" ? (proposed ? 0.9 : 0.78) : 0.4);
    const goalConfidence = boundedConfidence(proposed?.goalConfidence, proposed ? decisionConfidence : 0.78);
    const possibleIntentMismatch = String(proposed?.possibleIntentMismatch || "").trim() || null;
    const clarificationReasons = [];
    if (projectResolution.status !== "selected") clarificationReasons.push("target_project_requires_confirmation");
    if (possibleIntentMismatch) clarificationReasons.push("possible_intent_mismatch");
    if (goalConfidence < 0.6) clarificationReasons.push("low_goal_confidence");
    if (estimatedResources.complexity === "high" && goalConfidence < 0.75) clarificationReasons.push("high_impact_with_uncertain_goal");
    if (proposed?.clarificationNeeded === true) clarificationReasons.push("supervisor_requested_clarification");
    if (proposedNextAction === "request_clarification") clarificationReasons.push("supervisor_requested_clarification");
    const clarificationNeeded = clarificationReasons.length > 0;
    const nextAction = clarificationNeeded && requestedNextAction === "create_workflow" ? "request_clarification" : requestedNextAction;
    if (nextAction === "request_clarification") recommendedActions = ["Ask the user to clarify the identified goal ambiguity before creating a Workflow."];
    assertDecisionConsistency(intent, plan.workflowType, nextAction, projectResolution);
    const createdAt = nowIso();
    const memorySnapshot = projectContext?.memory
      ? { projectId: projectResolution.project?.id || null, ...projectContext.memory, capturedAt: createdAt, content: projectContext.projectMemory || "" }
      : { projectId: projectResolution.project?.id || null, available: false, file: "PROJECT_MEMORY.md", digest: null, lastUpdated: null, size: 0, capturedAt: createdAt, content: "" };
    return {
      schemaVersion: 6,
      decisionId: `decision_${Date.now().toString(36)}_${randomBytes(6).toString("hex")}`,
      intent,
      goal: String(proposed?.goal || request).trim(),
      goalConfidence,
      possibleIntentMismatch,
      clarificationNeeded,
      clarificationReasons: [...new Set(clarificationReasons)],
      technical_summary: technicalSummary,
      implementation_strategy: implementationStrategy,
      expected_changes: expectedChanges,
      validation_plan: validationPlan,
      supervisor_context: { projectId: projectResolution.project?.id || null, ...supervisorContext },
      project_memory: memorySnapshot,
      originalRequest: request,
      project: projectResolution.project,
      projectId: projectResolution.project?.projectId || null,
      workspacePath: projectResolution.project?.workspacePath || null,
      projectResolution: { status: projectResolution.status, method: projectResolution.method, candidates: projectResolution.candidates },
      reasoning,
      risks: [...new Set(risks)],
      workflowType: plan.workflowType,
      constraints,
      estimated_resources: estimatedResources,
      recommended_actions: recommendedActions,
      confidence: decisionConfidence,
      nextAction,
      agentRequired: nextAction === "create_workflow",
      source,
      status: nextAction === "confirm_project" ? "waiting_project_confirmation" : nextAction === "request_clarification" ? "waiting_for_clarification" : nextAction === "respond_directly" ? "decision_only" : "ready",
      workflowId: null,
      createdAt,
      updatedAt: createdAt
    };
  }

  resolveClarification(decision, clarificationResponse, proposedDecision = null) {
    if (!decision || decision.status !== "waiting_for_clarification") throw new Error("Decision is not waiting for clarification.");
    const response = String(clarificationResponse || "").trim();
    if (!response) throw new Error("clarificationResponse is required.");
    const proposed = proposedDecision && typeof proposedDecision === "object" ? proposedDecision : {};
    const regenerated = this.decide(`${decision.originalRequest}\n\nUser clarification: ${response}`, {
      project: decision.projectId,
      definitionId: proposed.workflowType || decision.workflowType,
      proposedDecision: {
        ...proposed,
        intent: proposed.intent || decision.intent,
        goal: proposed.goal || `${decision.goal} — clarified: ${response}`,
        reasoning: stringList(proposed.reasoning, [...(decision.reasoning || []), `User clarified the goal: ${response}`], 12),
        workflowType: proposed.workflowType || decision.workflowType,
        confidence: boundedConfidence(proposed.confidence, Math.max(0.8, Number(decision.confidence || 0))),
        goalConfidence: boundedConfidence(proposed.goalConfidence, Math.max(0.8, Number(decision.goalConfidence || 0))),
        possibleIntentMismatch: proposed.possibleIntentMismatch || null,
        clarificationNeeded: false,
        nextAction: "create_workflow"
      }
    });
    return { ...regenerated, originalRequest: decision.originalRequest, clarification: { supersedesDecisionId: decision.decisionId, response, resolvedAt: nowIso() } };
  }

  confirmProject(decision, projectId) {
    if (!decision || decision.status !== "waiting_project_confirmation") throw new Error("Decision is not waiting for project confirmation.");
    const resolution = this.projectRegistry.resolve(decision.originalRequest, { selector: projectId });
    const updatedAt = nowIso();
    const projectContext = this.projectRegistry.getProjectContext(resolution.project.id);
    const supervisorContext = projectContext.supervisorContext;
    const memoryCapturedAt = nowIso();
    const clarificationReasons = (decision.clarificationReasons || []).filter((reason) => reason !== "target_project_requires_confirmation");
    const requiresClarification = clarificationReasons.length > 0;
    return {
      ...decision,
      schemaVersion: 6,
      project: resolution.project,
      projectId: resolution.project.projectId,
      workspacePath: resolution.project.workspacePath,
      projectResolution: { status: "selected", method: "user_confirmed", candidates: [] },
      technical_summary: `${decision.technical_summary} Confirmed target: '${resolution.project.name}' (${resolution.project.path}).`,
      supervisor_context: { projectId: resolution.project.id, ...supervisorContext },
      project_memory: { projectId: resolution.project.id, ...projectContext.memory, capturedAt: memoryCapturedAt, content: projectContext.projectMemory || "" },
      clarificationNeeded: requiresClarification,
      clarificationReasons,
      reasoning: [...decision.reasoning, `User confirmed registered project '${resolution.project.name}'.`],
      risks: (decision.risks || []).filter((risk) => !risk.includes("target project is ambiguous")),
      constraints: [...new Set([...(decision.constraints || []), ...(resolution.project.defaultConstraints || []), `Only inspect or modify files under registered project '${resolution.project.path}'.`, "Do not explore sibling projects or other workspace directories."])],
      recommended_actions: requiresClarification ? ["Ask the user to clarify the remaining goal ambiguity before creating a Workflow."] : [`Create the '${decision.workflowType}' Workflow for the confirmed project.`, "Review the Planner result and risks before any approval-gated execution."],
      confidence: Math.max(Number(decision.confidence || 0), 0.95),
      nextAction: requiresClarification ? "request_clarification" : "create_workflow",
      agentRequired: !requiresClarification,
      status: requiresClarification ? "waiting_for_clarification" : "ready",
      updatedAt
    };
  }
}
