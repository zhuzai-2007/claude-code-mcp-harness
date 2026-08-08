import assert from "node:assert/strict";
import { resolveMcpResourceProfile, resourceProfileHarnessArgs } from "./resource-profile-input.mjs";

const bridgeConfig = { maxBudgetUsd: 0.2, workerTimeoutSeconds: 60 };

const defaultProfile = resolveMcpResourceProfile({}, bridgeConfig);
assert.equal(defaultProfile.name, "small_readonly");
assert.equal(defaultProfile.limits.maxBudgetUsd, 1);
assert.equal(defaultProfile.limits.timeoutSeconds, 300);
assert.equal(defaultProfile.limits.maxTurns, 30);
assert.equal(defaultProfile.limits.maxFilesRead, 30);

const exploration = resolveMcpResourceProfile({ resourceProfile: "exploration_readonly" }, bridgeConfig);
assert.deepEqual(exploration.limits, { maxBudgetUsd: 1.5, maxTurns: 100, maxFilesRead: 100, maxCommands: 1, timeoutSeconds: 1200 });
assert.deepEqual(resourceProfileHarnessArgs(exploration), [
  "-ResourceProfile", "exploration_readonly",
  "-WorkerTimeoutSeconds", 1200,
  "-MaxBudgetUsd", 1.5,
  "-MaxTurns", 100,
  "-MaxFilesRead", 100,
  "-MaxCommands", 1
]);

const review = resolveMcpResourceProfile({ resourceProfile: "review_readonly" }, bridgeConfig);
assert.deepEqual(review.limits, { maxBudgetUsd: 1.5, maxTurns: 50, maxFilesRead: 40, maxCommands: 1, timeoutSeconds: 600 });

const mediumChange = resolveMcpResourceProfile({ resourceProfile: "medium_change" }, bridgeConfig);
assert.deepEqual(mediumChange.limits, { maxBudgetUsd: 2.5, maxTurns: 120, maxFilesRead: 100, maxCommands: 25, timeoutSeconds: 1200 });

const boundedExploration = resolveMcpResourceProfile({ resourceProfile: "exploration_readonly", maxBudgetUsd: 0.75, workerTimeoutSeconds: 600 }, bridgeConfig);
assert.equal(boundedExploration.limits.maxBudgetUsd, 0.75);
assert.equal(boundedExploration.limits.timeoutSeconds, 600);
assert.equal(boundedExploration.limits.maxTurns, 100);
assert.equal(boundedExploration.limits.maxFilesRead, 100);

assert.throws(
  () => resolveMcpResourceProfile({ resourceProfile: "exploration_readonly", maxBudgetUsd: 5.01 }, bridgeConfig),
  /exceeds hard limit 5/
);

assert.throws(() => resolveMcpResourceProfile({ resourceProfile: "not_a_profile" }, bridgeConfig), /Unknown resource profile/);

console.log(JSON.stringify({ ok: true, defaultProfile: defaultProfile.name, selectedProfile: exploration.name }, null, 2));
