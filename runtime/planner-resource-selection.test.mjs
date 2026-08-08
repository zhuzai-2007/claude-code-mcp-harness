import assert from "node:assert/strict";
import { selectPlannerResourceProfile } from "./planner-resource-selection.mjs";

const policy = {
  strategy: "planner_scope",
  defaultProfile: "small_change",
  tiers: { small: "small_change", medium: "medium_change", large: "large_change" }
};
const selectedAt = "2026-07-19T14:00:00.000Z";

const small = selectPlannerResourceProfile({
  policy,
  selectedAt,
  audit: { summary: "One bounded edit", proposed_changes: [{ file: "app.js", type: "modify" }], risks: [], blocked_on: [] }
});
assert.equal(small.tier, "small");
assert.equal(small.profile, "small_change");

const medium = selectPlannerResourceProfile({
  policy,
  selectedAt,
  audit: {
    summary: "Several related changes",
    proposed_changes: [
      { file: "app.js", type: "modify", details: ["renderer", "storage"] },
      { file: "index.html", type: "modify" },
      { file: "tests.html", type: "create" }
    ],
    risks: ["Compatibility"],
    blocked_on: []
  }
});
assert.equal(medium.tier, "medium");
assert.equal(medium.profile, "medium_change");
assert.equal(medium.metrics.createdFiles, 1);

const large = selectPlannerResourceProfile({
  policy,
  selectedAt,
  audit: {
    summary: "Broad change",
    proposed_changes: Array.from({ length: 8 }, (_, index) => ({ file: `src/file-${index}.js`, type: "modify" })),
    risks: [],
    blocked_on: []
  }
});
assert.equal(large.tier, "large");
assert.equal(large.profile, "large_change");

const supervisorFloor = selectPlannerResourceProfile({
  policy,
  selectedAt,
  audit: { summary: "One edit", proposed_changes: [{ file: "app.js", type: "modify" }], risks: [], blocked_on: [] },
  supervisorDecision: { estimated_resources: { complexity: "medium" } }
});
assert.equal(supervisorFloor.tier, "medium", "Planner selection must not undercut the persisted Supervisor estimate");
assert.equal(selectPlannerResourceProfile({ audit: small, policy: null }), null, "Legacy stages without a policy must keep their configured profile");

console.log(JSON.stringify({ ok: true, profiles: [small.profile, medium.profile, large.profile], supervisorFloor: supervisorFloor.profile }, null, 2));
