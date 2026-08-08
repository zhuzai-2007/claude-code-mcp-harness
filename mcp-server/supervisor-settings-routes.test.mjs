import assert from "node:assert/strict";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { registerSupervisorDashboardRoutes } from "./supervisor-dashboard-routes.mjs";

const directory = path.dirname(fileURLToPath(import.meta.url));
let updateInput = null;
const settings = {
  schemaVersion: 1,
  resources: {
    defaultProfile: "small",
    hardLimits: { maxBudgetUsd: 5 },
    absoluteLimits: { maxBudgetUsd: 5 },
    profiles: { small: { maxBudgetUsd: 1 } }
  },
  runtime: { immutableSafety: { explicitApproval: true } }
};
const supervisorSettings = {
  async getSettings() { return settings; },
  async updateResources(input) {
    if (input.defaultProfile === "invalid") {
      const error = new Error("Unknown default resource profile: invalid.");
      error.name = "SupervisorSettingsValidationError";
      throw error;
    }
    updateInput = input;
    return { ...settings, resources: { ...settings.resources, defaultProfile: input.defaultProfile } };
  }
};
const unavailableRuntime = new Proxy({}, { get: () => async () => { throw new Error("not used"); } });
const app = express();
registerSupervisorDashboardRoutes(app, {
  taskRuntime: unavailableRuntime,
  workflowRuntime: unavailableRuntime,
  supervisorService: unavailableRuntime,
  supervisorSettings,
  providerPreflight: unavailableRuntime,
  taskRunner: null,
  workflowMetadataStore: null,
  dashboardRoot: path.resolve(directory, "..", "workspace", "supervisor-dashboard")
});
const server = app.listen(0, "127.0.0.1");
await new Promise((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
const baseUrl = `http://127.0.0.1:${server.address().port}`;

try {
  const getResponse = await fetch(`${baseUrl}/api/supervisor/settings`);
  assert.equal(getResponse.status, 200);
  assert.equal((await getResponse.json()).settings.resources.defaultProfile, "small");
  assert.equal(getResponse.headers.get("cache-control"), "no-store");

  const denied = await fetch(`${baseUrl}/api/supervisor/settings/resources`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ defaultProfile: "medium" })
  });
  assert.equal(denied.status, 403, "mutations without a local Console Origin must remain blocked");

  const allowed = await fetch(`${baseUrl}/api/supervisor/settings/resources`, {
    method: "PUT",
    headers: { "content-type": "application/json", origin: baseUrl },
    body: JSON.stringify({ defaultProfile: "medium", hardLimits: {}, profiles: {} })
  });
  assert.equal(allowed.status, 200);
  assert.equal((await allowed.json()).settings.resources.defaultProfile, "medium");
  assert.equal(updateInput.defaultProfile, "medium");

  const invalid = await fetch(`${baseUrl}/api/supervisor/settings/resources`, {
    method: "PUT",
    headers: { "content-type": "application/json", origin: baseUrl },
    body: JSON.stringify({ defaultProfile: "invalid", hardLimits: {}, profiles: {} })
  });
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).status, "invalid_input");

  console.log(JSON.stringify({ ok: true, readOnlyGet: true, localMutationGuard: true }, null, 2));
} finally {
  await new Promise((resolve) => server.close(resolve));
}
