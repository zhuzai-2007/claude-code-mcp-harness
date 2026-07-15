import { resolveResourceProfile } from "../runtime/resource-profiles.mjs";

export function resolveMcpResourceProfile(input = {}) {
  const profileWasSpecified = typeof input.resourceProfile === "string" && input.resourceProfile.trim().length > 0;
  const overrides = {};

  if (input.maxBudgetUsd != null) overrides.maxBudgetUsd = input.maxBudgetUsd;

  if (input.workerTimeoutSeconds != null) overrides.timeoutSeconds = input.workerTimeoutSeconds;

  return resolveResourceProfile(profileWasSpecified ? input.resourceProfile.trim() : null, overrides);
}

export function resourceProfileHarnessArgs(profile) {
  const limits = profile.limits;
  return [
    "-ResourceProfile", profile.name,
    "-WorkerTimeoutSeconds", limits.timeoutSeconds,
    "-MaxBudgetUsd", limits.maxBudgetUsd,
    "-MaxTurns", limits.maxTurns,
    "-MaxFilesRead", limits.maxFilesRead,
    "-MaxCommands", limits.maxCommands
  ];
}
