import { randomBytes } from "node:crypto";
import { resolveResourceProfile } from "./resource-profiles.mjs";

const INTENTS = new Set(["code_change", "documentation_change", "analysis", "conversation", "unknown"]);
const NEXT_ACTIONS = new Set(["create_workflow", "confirm_project", "respond_directly"]);

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
    const nextAction = proposedNextAction === "respond_directly" ? "respond_directly" : projectResolution.status !== "selected" ? "confirm_project" : proposedNextAction || "create_workflow";
    const intent = String(proposed?.intent || intentForWorkflow(plan.workflowType)).trim();
    if (!INTENTS.has(intent)) throw new Error(`Unsupported Supervisor intent: ${intent}`);
    assertDecisionConsistency(intent, plan.workflowType, nextAction, projectResolution);
    const source = proposed ? "gpt" : "local_rules";
    const reasoning = Array.isArray(proposed?.reasoning) && proposed.reasoning.length
      ? proposed.reasoning.map((item) => String(item).trim()).filter(Boolean).slice(0, 12)
      : [plan.reason, projectResolution.status === "selected" ? `Selected registered project '${projectResolution.project.name}' by ${projectResolution.method}.` : "The target project is ambiguous and requires user confirmation."];
    const constraints = [...new Set([
      ...plan.constraints,
      ...(projectResolution.project ? [...(projectResolution.project.defaultConstraints || []), `Only inspect or modify files under registered project '${projectResolution.project.path}'.`, "Do not explore sibling projects or other workspace directories."] : [])
    ])];
    const technicalSummary = String(proposed?.technical_summary || `${plan.goal} ${projectResolution.project ? `in '${projectResolution.project.name}'` : "after the target project is confirmed"}; recommended Workflow: ${plan.workflowType}.`).trim();
    const defaultRisks = nextAction === "respond_directly"
      ? ["No local Worker will run; the response remains the responsibility of the GPT Supervisor."]
      : nextAction === "confirm_project"
        ? ["The target project is ambiguous; starting a Worker before confirmation would risk modifying the wrong project."]
        : ["The external Worker may inspect files inside the registered project.", ...(plan.workflowType === "analysis_only" ? [] : ["Any write-capable stage remains blocked until explicit human approval."])];
    const recommendedActions = stringList(proposed?.recommended_actions, nextAction === "respond_directly"
      ? ["Answer the user directly without creating a local Workflow."]
      : nextAction === "confirm_project"
        ? ["Ask the user to select one registered project before starting a Worker."]
        : [`Create the '${plan.workflowType}' Workflow.`, "Review the Planner result and risks before any approval-gated execution."], 12);
    const estimatedResources = workflowResources(this.workflowPlanner, plan.workflowType, nextAction, proposed?.estimated_resources || null);
    const risks = stringList(proposed?.risks, defaultRisks, 12);
    if (!estimatedResources.within_hard_caps) risks.push("Estimated resources exceed the selected Workflow profile envelope.");
    const createdAt = nowIso();
    return {
      schemaVersion: 2,
      decisionId: `decision_${Date.now().toString(36)}_${randomBytes(6).toString("hex")}`,
      intent,
      goal: String(proposed?.goal || request).trim(),
      technical_summary: technicalSummary,
      originalRequest: request,
      project: projectResolution.project,
      projectResolution: { status: projectResolution.status, method: projectResolution.method, candidates: projectResolution.candidates },
      reasoning,
      risks: [...new Set(risks)],
      workflowType: plan.workflowType,
      constraints,
      estimated_resources: estimatedResources,
      recommended_actions: recommendedActions,
      confidence: boundedConfidence(proposed?.confidence, projectResolution.status === "selected" ? (proposed ? 0.9 : 0.78) : 0.4),
      nextAction,
      agentRequired: nextAction === "create_workflow",
      source,
      status: nextAction === "confirm_project" ? "waiting_project_confirmation" : nextAction === "respond_directly" ? "decision_only" : "ready",
      workflowId: null,
      createdAt,
      updatedAt: createdAt
    };
  }

  confirmProject(decision, projectId) {
    if (!decision || decision.status !== "waiting_project_confirmation") throw new Error("Decision is not waiting for project confirmation.");
    const resolution = this.projectRegistry.resolve(decision.originalRequest, { selector: projectId });
    const updatedAt = nowIso();
    return {
      ...decision,
      project: resolution.project,
      projectResolution: { status: "selected", method: "user_confirmed", candidates: [] },
      technical_summary: `${decision.technical_summary} Confirmed target: '${resolution.project.name}' (${resolution.project.path}).`,
      reasoning: [...decision.reasoning, `User confirmed registered project '${resolution.project.name}'.`],
      risks: (decision.risks || []).filter((risk) => !risk.includes("target project is ambiguous")),
      constraints: [...new Set([...(decision.constraints || []), ...(resolution.project.defaultConstraints || []), `Only inspect or modify files under registered project '${resolution.project.path}'.`, "Do not explore sibling projects or other workspace directories."])],
      recommended_actions: [`Create the '${decision.workflowType}' Workflow for the confirmed project.`, "Review the Planner result and risks before any approval-gated execution."],
      confidence: Math.max(Number(decision.confidence || 0), 0.95),
      nextAction: "create_workflow",
      agentRequired: true,
      status: "ready",
      updatedAt
    };
  }
}
