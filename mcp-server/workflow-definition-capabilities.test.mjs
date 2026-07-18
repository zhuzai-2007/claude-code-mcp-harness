import assert from "node:assert/strict";
import { loadWorkflowDefinitions } from "../runtime/workflow-definitions.mjs";
import { listWorkflowDefinitionCapabilities, unknownWorkflowDefinitionResult } from "./workflow-definition-capabilities.mjs";

const configuration = await loadWorkflowDefinitions();
const capabilities = listWorkflowDefinitionCapabilities(configuration);
assert.equal(capabilities.defaultDefinition, "software_change");
assert.deepEqual(capabilities.definitions.map((definition) => definition.id), ["software_change", "analysis_only", "documentation_change"]);
const software = capabilities.definitions.find((definition) => definition.id === "software_change");
assert.deepEqual(software.stages.map((stage) => stage.role), ["planner", "coder", "reviewer"]);
assert.deepEqual(software.approvalRequirement, { required: true, stages: ["implementation"] });
assert(software.usageHints.some((hint) => hint.includes("Default")));
const analysis = capabilities.definitions.find((definition) => definition.id === "analysis_only");
assert.equal(analysis.approvalRequirement.required, false);
assert(analysis.usageHints.some((hint) => hint.includes("Typical request signals")));

const invalid = unknownWorkflowDefinitionResult(new Error("Unknown Workflow definition: feature_change"), { definitionId: "feature_change" }, configuration);
assert.equal(invalid.status, "invalid_input");
assert.equal(invalid.requestedDefinition, "feature_change");
assert.deepEqual(invalid.availableDefinitions.map((definition) => definition.id), capabilities.definitions.map((definition) => definition.id));
assert.match(invalid.error, /cc_list_workflow_definitions/);
assert.equal(unknownWorkflowDefinitionResult(new Error("different error"), {}, configuration), null);

console.log(JSON.stringify({ ok: true, defaultDefinition: capabilities.defaultDefinition, definitions: capabilities.definitions.map(({ id, approvalRequirement }) => ({ id, approvalRequirement })) }, null, 2));
