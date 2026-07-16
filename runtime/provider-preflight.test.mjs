import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PREFLIGHT_MARKER, PREFLIGHT_PROMPT, ProviderPreflightService, runProviderPreflight } from "./provider-preflight.mjs";

const calls = [];
const successfulRunner = async (input) => {
  calls.push(input);
  if (input.args.includes("--version")) return { exitCode: 0, stdout: "2.1.0\n", stderr: "", timedOut: false, spawnError: null };
  return { exitCode: 0, stdout: JSON.stringify({ type: "result", result: PREFLIGHT_MARKER }), stderr: "", timedOut: false, spawnError: null };
};

const success = await runProviderPreflight({ commandRunner: successfulRunner, timeoutSeconds: 20 });
assert.equal(success.status, "ok");
assert.equal(success.classification, "reachable");
assert.equal(success.safety.projectContentSent, false);
assert.equal(success.safety.toolsEnabled, false);
assert.equal(success.safety.modificationsAllowed, false);
assert.equal(calls.length, 2);
assert.equal(calls[1].input, PREFLIGHT_PROMPT);
assert(calls[1].args.includes("--safe-mode"));
assert(calls[1].args.includes("--no-session-persistence"));
assert.equal(calls[1].args[calls[1].args.indexOf("--tools") + 1], "");
assert.equal(calls[1].args[calls[1].args.indexOf("--permission-mode") + 1], "plan");
assert.equal(calls[1].args[calls[1].args.indexOf("--max-budget-usd") + 1], "0.05");
assert.match(path.basename(calls[1].cwd), /^probe-/);
assert.equal(success.safety.workingDirectory, "isolated_system_temp_dir");
const relativePreflightCwd = path.relative(path.resolve("."), calls[1].cwd);
assert(path.isAbsolute(relativePreflightCwd) || relativePreflightCwd.startsWith(".."), "Preflight cwd must stay outside the project tree");

const refused = await runProviderPreflight({ commandRunner: async (input) => input.args.includes("--version")
  ? { exitCode: 0, stdout: "2.1.0", stderr: "", timedOut: false, spawnError: null }
  : { exitCode: 1, stdout: "", stderr: "API Error: Unable to connect to API (ConnectionRefused)", timedOut: false, spawnError: null } });
assert.equal(refused.status, "failed");
assert.equal(refused.classification, "connection_refused");
assert.equal(refused.provider.reachable, false);
assert(!JSON.stringify(refused).includes("ConnectionRefused"), "Raw provider output must not be persisted in the product result");

const timeout = await runProviderPreflight({ commandRunner: async (input) => input.args.includes("--version")
  ? { exitCode: 0, stdout: "2.1.0", stderr: "", timedOut: false, spawnError: null }
  : { exitCode: null, stdout: "", stderr: "", timedOut: true, spawnError: null } });
assert.equal(timeout.classification, "provider_timeout");

const blocked = await runProviderPreflight({ commandRunner: async () => ({ exitCode: null, stdout: "", stderr: "", timedOut: false, spawnError: Object.assign(new Error("blocked"), { code: "EPERM" }) }) });
assert.equal(blocked.classification, "process_launch_blocked");
assert.equal(blocked.cli.available, null);

const dataRoot = await mkdtemp(path.join(os.tmpdir(), "provider-preflight-test-"));
try {
  const service = new ProviderPreflightService({ runtimeDataRoot: dataRoot, commandRunner: successfulRunner });
  assert.equal(await service.getLatest(), null);
  const persisted = await service.run({ timeoutSeconds: 20 });
  assert.equal((await service.getLatest()).checkedAt, persisted.checkedAt);
} finally {
  await rm(dataRoot, { recursive: true, force: true });
}

console.log(JSON.stringify({ ok: true, success: success.classification, failure: refused.classification, timeout: timeout.classification, blocked: blocked.classification }, null, 2));
