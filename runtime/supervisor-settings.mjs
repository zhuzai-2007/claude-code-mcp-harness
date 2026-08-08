import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { ABSOLUTE_RESOURCE_LIMITS } from "./resource-profiles.mjs";

const RESOURCE_FIELDS = Object.freeze(["maxBudgetUsd", "maxTurns", "maxFilesRead", "maxCommands", "timeoutSeconds"]);
const INTEGER_FIELDS = new Set(["maxTurns", "maxFilesRead", "maxCommands", "timeoutSeconds"]);

export class SupervisorSettingsValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "SupervisorSettingsValidationError";
  }
}

function positiveResourceValue(value, field, owner) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new SupervisorSettingsValidationError(`${owner}.${field} must be greater than zero.`);
  }
  if (INTEGER_FIELDS.has(field) && !Number.isInteger(number)) {
    throw new SupervisorSettingsValidationError(`${owner}.${field} must be an integer.`);
  }
  return number;
}

function validateResourceConfig(candidate, { expectedProfileNames = null } = {}) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new SupervisorSettingsValidationError("resources must be an object.");
  }
  const profileNames = Object.keys(candidate.profiles || {}).sort();
  if (!profileNames.length) throw new SupervisorSettingsValidationError("At least one resource profile is required.");
  if (expectedProfileNames) {
    const expected = [...expectedProfileNames].sort();
    if (profileNames.join("\u0000") !== expected.join("\u0000")) {
      throw new SupervisorSettingsValidationError("Resource profile names cannot be added, removed, or renamed from Dashboard settings.");
    }
  }
  const defaultProfile = String(candidate.defaultProfile || "").trim();
  if (!profileNames.includes(defaultProfile)) {
    throw new SupervisorSettingsValidationError(`Unknown default resource profile: ${defaultProfile || "<empty>"}.`);
  }

  const hardLimits = {};
  for (const field of RESOURCE_FIELDS) {
    hardLimits[field] = positiveResourceValue(candidate.hardLimits?.[field], field, "hardLimits");
    if (hardLimits[field] > ABSOLUTE_RESOURCE_LIMITS[field]) {
      throw new SupervisorSettingsValidationError(`hardLimits.${field}=${hardLimits[field]} exceeds immutable limit ${ABSOLUTE_RESOURCE_LIMITS[field]}.`);
    }
  }

  const profiles = {};
  for (const profileName of profileNames) {
    const source = candidate.profiles[profileName];
    if (!source || typeof source !== "object" || Array.isArray(source)) {
      throw new SupervisorSettingsValidationError(`profiles.${profileName} must be an object.`);
    }
    profiles[profileName] = {};
    for (const field of RESOURCE_FIELDS) {
      const value = positiveResourceValue(source[field], field, `profiles.${profileName}`);
      if (value > hardLimits[field]) {
        throw new SupervisorSettingsValidationError(`profiles.${profileName}.${field}=${value} exceeds configured hard limit ${hardLimits[field]}.`);
      }
      profiles[profileName][field] = value;
    }
  }

  return {
    schemaVersion: Number(candidate.schemaVersion || 1),
    defaultProfile,
    hardLimits,
    profiles
  };
}

async function readJson(filePath) {
  return JSON.parse((await readFile(filePath, "utf8")).replace(/^\uFEFF/, ""));
}

async function writeJsonAtomically(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(temporaryPath, filePath);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => {});
  }
}

export class SupervisorSettingsService {
  #mutation = Promise.resolve();

  constructor({ resourceProfilesPath, runtime = {} }) {
    if (!resourceProfilesPath) throw new Error("resourceProfilesPath is required.");
    this.resourceProfilesPath = path.resolve(resourceProfilesPath);
    this.runtime = Object.freeze({
      maxConcurrentTasks: runtime.maxConcurrentTasks ?? null,
      heartbeatSeconds: runtime.heartbeatSeconds ?? null,
      stalledAfterSeconds: runtime.stalledAfterSeconds ?? null,
      retention: runtime.retention ? { ...runtime.retention, applyMode: "startup" } : null
    });
  }

  async getSettings() {
    const resources = validateResourceConfig(await readJson(this.resourceProfilesPath));
    return {
      schemaVersion: 1,
      resources: { ...resources, absoluteLimits: { ...ABSOLUTE_RESOURCE_LIMITS } },
      runtime: {
        ...this.runtime,
        immutableSafety: {
          explicitApproval: true,
          strictAudit: true,
          sideEffectGuard: true,
          networkDefaultAllowed: false,
          gitWriteDefaultAllowed: false,
          recursiveDeleteDefaultAllowed: false
        }
      }
    };
  }

  async updateResources(input) {
    const operation = async () => {
      const current = validateResourceConfig(await readJson(this.resourceProfilesPath));
      const next = validateResourceConfig({
        schemaVersion: current.schemaVersion,
        defaultProfile: input?.defaultProfile,
        hardLimits: input?.hardLimits,
        profiles: input?.profiles
      }, { expectedProfileNames: Object.keys(current.profiles) });
      await writeJsonAtomically(this.resourceProfilesPath, next);
      return this.getSettings();
    };
    const result = this.#mutation.then(operation, operation);
    this.#mutation = result.catch(() => {});
    return result;
  }
}
