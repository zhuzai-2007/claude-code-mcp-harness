function normalizedText(value) {
  return String(value || "").trim().toLocaleLowerCase("en-US");
}

function matchesAny(text, patterns = []) {
  return patterns.some((pattern) => text.includes(normalizedText(pattern)));
}

function plannedStages(definition) {
  const stages = [];
  for (const stage of definition.stages || []) {
    if (stage.requiresApproval === true) stages.push("approval");
    stages.push(stage.role);
  }
  return stages;
}

export class WorkflowPlanner {
  constructor({ definitions }) {
    this.definitions = definitions;
  }

  plan(userRequest, { workflowType = null } = {}) {
    const goal = String(userRequest || "").trim();
    if (!goal) throw new Error("userRequest is required");

    const selectedType = workflowType ? this._requireDefinition(workflowType) : this._selectDefinition(goal);
    const definition = this.definitions.definitions[selectedType];
    return {
      schemaVersion: 1,
      workflowType: selectedType,
      goal,
      reason: workflowType
        ? `Workflow type '${selectedType}' was explicitly selected.`
        : definition.planning?.reason || `Selected the '${selectedType}' workflow for this request.`,
      constraints: [...(definition.constraints || [])],
      stages: plannedStages(definition),
      selection: workflowType ? "explicit" : "rule_based"
    };
  }

  _requireDefinition(workflowType) {
    const selected = String(workflowType || "").trim();
    if (!this.definitions.definitions[selected]) throw new Error(`Unknown Workflow definition: ${selected || "<empty>"}`);
    return selected;
  }

  _selectDefinition(userRequest) {
    const text = normalizedText(userRequest);
    const candidates = Object.entries(this.definitions.definitions)
      .filter(([, definition]) => matchesAny(text, definition.planning?.matchAny) && !matchesAny(text, definition.planning?.excludeAny))
      .map(([workflowType, definition]) => ({ workflowType, priority: Number(definition.planning?.priority || 0) }))
      .sort((left, right) => right.priority - left.priority || left.workflowType.localeCompare(right.workflowType));
    return candidates[0]?.workflowType || this.definitions.defaultDefinition;
  }
}
