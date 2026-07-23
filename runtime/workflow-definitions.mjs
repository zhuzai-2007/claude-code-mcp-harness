import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveResourceProfile } from "./resource-profiles.mjs";

const directory = path.dirname(fileURLToPath(import.meta.url));
const defaultPath = path.resolve(directory, "..", ".agents", "workflow-definitions.json");
const modes = new Set(["plan", "run", "review"]);
const knownRoleModes = { planner: "plan", coder: "run", reviewer: "review" };
const promptKinds = new Set(["planner", "coder", "reviewer"]);

export async function loadWorkflowDefinitions(configPath = defaultPath) {
  const config = JSON.parse((await readFile(configPath, "utf8")).replace(/^\uFEFF/, ""));
  const definitions = config.definitions || {};
  for (const [definitionId, definition] of Object.entries(definitions)) {
    if (definition.planning?.matchAny != null && !Array.isArray(definition.planning.matchAny)) throw new Error(`Workflow definition '${definitionId}' has invalid planning matchers.`);
    if (definition.planning?.excludeAny != null && !Array.isArray(definition.planning.excludeAny)) throw new Error(`Workflow definition '${definitionId}' has invalid planning exclusions.`);
    if (definition.constraints != null && (!Array.isArray(definition.constraints) || definition.constraints.some((value) => typeof value !== "string"))) throw new Error(`Workflow definition '${definitionId}' has invalid constraints.`);
    if (!Array.isArray(definition.stages) || definition.stages.length === 0) throw new Error(`Workflow definition '${definitionId}' requires stages.`);
    const stageIds = new Set();
    for (const stage of definition.stages) {
      if (!stage.id || stageIds.has(stage.id)) throw new Error(`Workflow definition '${definitionId}' has an invalid or duplicate stage id.`);
      stageIds.add(stage.id);
      if (!/^[a-z][a-z0-9_-]*$/.test(String(stage.role || "")) || !modes.has(stage.mode)) throw new Error(`Workflow definition '${definitionId}' has an unsupported role or mode.`);
      if (knownRoleModes[stage.role] && knownRoleModes[stage.role] !== stage.mode) {
        throw new Error(`Workflow definition '${definitionId}' violates the fixed role/mode mapping.`);
      }
      if (!promptKinds.has(stage.promptKind || stage.role)) throw new Error(`Workflow definition '${definitionId}' has an unsupported promptKind.`);
      if (stage.mode === "run" && stage.requiresApproval !== true) throw new Error(`Run stage '${stage.id}' must require approval.`);
      if (stage.resourceProfile) resolveResourceProfile(stage.resourceProfile);
      if (stage.resourceProfilePolicy != null) {
        const policy = stage.resourceProfilePolicy;
        if (stage.mode !== "run" || policy.strategy !== "planner_scope") throw new Error(`Stage '${stage.id}' has an unsupported resource profile policy.`);
        if (!policy.tiers || !["small", "medium", "large"].every((tier) => typeof policy.tiers[tier] === "string" && policy.tiers[tier].trim())) {
          throw new Error(`Stage '${stage.id}' resource profile policy requires small, medium, and large tiers.`);
        }
        for (const profileName of new Set([policy.defaultProfile, ...Object.values(policy.tiers)].filter(Boolean))) resolveResourceProfile(profileName);
      }
    }
  }
  if (!definitions[config.defaultDefinition]) throw new Error(`Unknown default Workflow definition: ${config.defaultDefinition}`);
  return { schemaVersion: Number(config.schemaVersion || 1), defaultDefinition: config.defaultDefinition, definitions };
}
