import assert from "node:assert/strict";
import { selectNodeTests } from "./test-discovery.mjs";

const selected = selectNodeTests([
  "runtime/task-runtime.test.mjs",
  "runtime/nested/resource.test.mjs",
  "mcp-server\\bridge.test.mjs",
  "scripts/onboarding.test.mjs",
  "workspace/demo/demo.test.mjs",
  "scripts/fixtures/worker.test.mjs",
  "workspace/node_modules/package/internal.test.mjs",
  "runtime/task-runtime.mjs",
  "docs/architecture.test.mjs",
  "runtime/task-runtime.test.mjs"
]);

assert.deepEqual(selected, [
  "mcp-server/bridge.test.mjs",
  "runtime/nested/resource.test.mjs",
  "runtime/task-runtime.test.mjs",
  "scripts/onboarding.test.mjs",
  "workspace/demo/demo.test.mjs"
]);

console.log(JSON.stringify({ ok: true, discovered: selected.length, fixturesExcluded: true }, null, 2));
