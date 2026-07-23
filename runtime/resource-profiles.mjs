import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultConfigPath = path.resolve(moduleDirectory, "..", ".agents", "resource-profiles.json");
const FIELDS = ["maxBudgetUsd", "maxTurns", "maxFilesRead", "maxCommands", "timeoutSeconds"];

// These limits are intentionally code-owned. Dashboard settings may tighten the
// configured hard limits, but cannot turn the settings surface into a way to
// remove the final safety boundary.
export const ABSOLUTE_RESOURCE_LIMITS = Object.freeze({
  maxBudgetUsd: 5,
  maxTurns: 200,
  maxFilesRead: 500,
  maxCommands: 100,
  timeoutSeconds: 3600
});

function readConfig(configPath) {
  return JSON.parse(fs.readFileSync(configPath, "utf8").replace(/^\uFEFF/, ""));
}

function positiveNumber(value, field, profileName) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`Resource profile '${profileName}' has invalid ${field}.`);
  return number;
}

export function resolveResourceProfile(profileName, overrides = {}, { configPath = defaultConfigPath } = {}) {
  const config = readConfig(configPath);
  const selectedName = String(profileName || config.defaultProfile || "").trim();
  const selected = config.profiles?.[selectedName];
  if (!selected) throw new Error(`Unknown resource profile: ${selectedName || "<empty>"}`);

  const limits = {};
  const hardLimits = {};
  for (const field of FIELDS) {
    hardLimits[field] = positiveNumber(config.hardLimits?.[field], field, "hardLimits");
    if (hardLimits[field] > ABSOLUTE_RESOURCE_LIMITS[field]) {
      throw new Error(`Configured hard limit ${field}=${hardLimits[field]} exceeds immutable limit ${ABSOLUTE_RESOURCE_LIMITS[field]}.`);
    }
    const candidate = overrides[field] ?? selected[field];
    limits[field] = positiveNumber(candidate, field, selectedName);
    if (limits[field] > hardLimits[field]) {
      throw new Error(`Resource limit ${field}=${limits[field]} exceeds hard limit ${hardLimits[field]}.`);
    }
  }

  for (const field of ["maxTurns", "maxFilesRead", "maxCommands", "timeoutSeconds"]) {
    if (!Number.isInteger(limits[field])) throw new Error(`Resource limit ${field} must be an integer.`);
  }

  return { schemaVersion: Number(config.schemaVersion || 1), name: selectedName, limits, hardLimits };
}

export function getDefaultResourceProfileName({ configPath = defaultConfigPath } = {}) {
  return String(readConfig(configPath).defaultProfile || "small_readonly");
}
