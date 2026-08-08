import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveResourceProfile } from "./resource-profiles.mjs";
import { SupervisorSettingsService } from "./supervisor-settings.mjs";

const directory = await mkdtemp(path.join(os.tmpdir(), "supervisor-settings-"));
const resourceProfilesPath = path.join(directory, "resource-profiles.json");
const initial = {
  schemaVersion: 1,
  defaultProfile: "small",
  hardLimits: { maxBudgetUsd: 5, maxTurns: 200, maxFilesRead: 500, maxCommands: 100, timeoutSeconds: 3600 },
  profiles: {
    small: { maxBudgetUsd: 1, maxTurns: 30, maxFilesRead: 30, maxCommands: 1, timeoutSeconds: 300 },
    medium: { maxBudgetUsd: 2.5, maxTurns: 120, maxFilesRead: 100, maxCommands: 25, timeoutSeconds: 1200 }
  }
};
await writeFile(resourceProfilesPath, `${JSON.stringify(initial, null, 2)}\n`, "utf8");

try {
  const service = new SupervisorSettingsService({
    resourceProfilesPath,
    runtime: { maxConcurrentTasks: 1, heartbeatSeconds: 15, stalledAfterSeconds: 60, retention: { enabled: true, maxAgeDays: 30 } }
  });
  const loaded = await service.getSettings();
  assert.equal(loaded.resources.defaultProfile, "small");
  assert.equal(loaded.resources.absoluteLimits.maxBudgetUsd, 5);
  assert.equal(loaded.runtime.immutableSafety.explicitApproval, true);
  assert.equal(loaded.runtime.retention.applyMode, "startup");

  const updated = await service.updateResources({
    defaultProfile: "medium",
    hardLimits: { maxBudgetUsd: 4, maxTurns: 180, maxFilesRead: 400, maxCommands: 80, timeoutSeconds: 3000 },
    profiles: {
      small: { maxBudgetUsd: 1.2, maxTurns: 35, maxFilesRead: 35, maxCommands: 2, timeoutSeconds: 360 },
      medium: { maxBudgetUsd: 3, maxTurns: 140, maxFilesRead: 120, maxCommands: 30, timeoutSeconds: 1500 }
    }
  });
  assert.equal(updated.resources.defaultProfile, "medium");
  assert.equal(resolveResourceProfile("medium", {}, { configPath: resourceProfilesPath }).limits.maxBudgetUsd, 3);
  const persisted = JSON.parse(await readFile(resourceProfilesPath, "utf8"));
  assert.deepEqual(persisted.hardLimits, updated.resources.hardLimits);

  const stableText = await readFile(resourceProfilesPath, "utf8");
  await assert.rejects(() => service.updateResources({
    ...persisted,
    hardLimits: { ...persisted.hardLimits, maxBudgetUsd: 5.1 }
  }), /exceeds immutable limit/);
  assert.equal(await readFile(resourceProfilesPath, "utf8"), stableText, "invalid settings must not alter the persisted file");

  await assert.rejects(() => service.updateResources({
    ...persisted,
    hardLimits: { ...persisted.hardLimits, maxTurns: 100 }
  }), /profiles\.medium\.maxTurns=140 exceeds configured hard limit 100/);
  await assert.rejects(() => service.updateResources({
    ...persisted,
    profiles: { small: persisted.profiles.small }
  }), /names cannot be added, removed, or renamed/);
  await assert.rejects(() => service.updateResources({ ...persisted, defaultProfile: "missing" }), /Unknown default resource profile/);

  const manuallyUnsafePath = path.join(directory, "unsafe.json");
  await writeFile(manuallyUnsafePath, JSON.stringify({ ...initial, hardLimits: { ...initial.hardLimits, maxTurns: 201 } }), "utf8");
  assert.throws(() => resolveResourceProfile("small", {}, { configPath: manuallyUnsafePath }), /exceeds immutable limit 200/);

  console.log(JSON.stringify({ ok: true, persistedDefault: updated.resources.defaultProfile, immutableCapEnforced: true }, null, 2));
} finally {
  await rm(directory, { recursive: true, force: true });
}
