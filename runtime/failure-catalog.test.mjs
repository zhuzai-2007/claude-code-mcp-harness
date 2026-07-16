import assert from "node:assert/strict";
import { classifyWorkflowFailure } from "./failure-catalog.mjs";

const provider = classifyWorkflowFailure({ currentStage: "planning", failure: { failedStage: "planning", role: "planner", taskId: "task_1", failedAt: "2026-07-15T00:00:00Z", error: { code: "worker_crash", message: "API Error: Unable to connect to API (ConnectionRefused)" } } });
assert.equal(provider.category, "provider_connectivity");
assert.equal(provider.stageLabel, "Planning");
assert.equal(provider.retryable, true);
assert(provider.recoverySteps.some((step) => step.includes("Preflight")));

const audit = classifyWorkflowFailure({ failure: { failedStage: "review", role: "reviewer", error: { code: "audit_validation_failed", message: "missing_read_evidence" } } });
assert.equal(audit.category, "audit_contract");
assert.equal(audit.stageLabel, "Review");

const timeout = classifyWorkflowFailure({ failure: { failedStage: "implementation", role: "coder", error: { code: "interrupted", message: "Worker attempt failed." } } });
assert.equal(timeout.category, "worker_timeout");
assert.equal(timeout.stageLabel, "Execution");

const safe = classifyWorkflowFailure({ failure: { error: { code: "worker_crash", message: "API_KEY=secret-value sk-abcdefghijklmnopqrstuvwxyz" } } });
assert(!safe.message.includes("secret-value"));
assert(!safe.message.includes("abcdefghijklmnopqrstuvwxyz"));

console.log(JSON.stringify({ ok: true, provider: provider.category, audit: audit.category }, null, 2));
