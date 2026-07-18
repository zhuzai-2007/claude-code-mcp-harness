function usageHints(definition, { isDefault = false } = {}) {
  const hints = [];
  if (isDefault) hints.push("Default when no more specific Workflow definition matches.");
  if (definition.planning?.reason) hints.push(definition.planning.reason);
  if (definition.planning?.matchAny?.length) hints.push(`Typical request signals: ${definition.planning.matchAny.join(", ")}.`);
  if (definition.planning?.excludeAny?.length) hints.push(`Do not select when these change signals are present: ${definition.planning.excludeAny.join(", ")}.`);
  return hints;
}

export function listWorkflowDefinitionCapabilities(configuration) {
  const defaultDefinition = configuration.defaultDefinition;
  const definitions = Object.entries(configuration.definitions || {}).map(([id, definition]) => {
    const approvalStages = (definition.stages || []).filter((stage) => stage.requiresApproval === true).map((stage) => stage.id);
    return {
      id,
      description: definition.description || "",
      stages: (definition.stages || []).map((stage) => ({
        id: stage.id,
        role: stage.role,
        mode: stage.mode,
        resourceProfile: stage.resourceProfile,
        requiresApproval: stage.requiresApproval === true
      })),
      approvalRequirement: { required: approvalStages.length > 0, stages: approvalStages },
      usageHints: usageHints(definition, { isDefault: id === defaultDefinition })
    };
  });
  return { schemaVersion: 1, defaultDefinition, definitions };
}

export function unknownWorkflowDefinitionResult(error, input, configuration) {
  const message = String(error?.message || error);
  if (!message.startsWith("Unknown Workflow definition:")) return null;
  const capabilities = listWorkflowDefinitionCapabilities(configuration);
  const availableDefinitionIds = capabilities.definitions.map((definition) => definition.id);
  return {
    status: "invalid_input",
    error: `${message}. Available Workflow definitions: ${availableDefinitionIds.join(", ")}. Call cc_list_workflow_definitions before retrying.`,
    requestedDefinition: input?.supervisorDecision?.workflowType || input?.definitionId || null,
    defaultDefinition: capabilities.defaultDefinition,
    availableDefinitions: capabilities.definitions
  };
}
