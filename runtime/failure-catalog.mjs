function sanitizeMessage(value) {
  return String(value || "Stage failed.")
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, "sk-<redacted>")
    .replace(/((?:API|AUTH|ACCESS|CONTROL_PLANE)[A-Z0-9_]*KEY\s*[=:]\s*)\S+/gi, "$1<redacted>")
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1<credentials-redacted>@")
    .slice(0, 2000);
}

function stageName(role, id) {
  return role === "planner" ? "Planning" : role === "coder" ? "Execution" : role === "reviewer" ? "Review" : id || "Workflow";
}

const CATALOG = [
  { matches: (code, message) => code === "approval_rejected", category: "human_decision", title: "Workflow rejected", explanation: "A human reviewer rejected the proposed execution scope. No new execution should start automatically.", retryable: true, recoverySteps: ["Revise or reconfirm the request and project scope.", "Create a recovery Workflow; review its new plan and provide a new approval if appropriate."] },
  { matches: (code) => code === "budget_exceeded", category: "resource_limit", title: "Worker budget exhausted", explanation: "The Worker reached its hard budget before producing an acceptable result.", retryable: true, recoverySteps: ["Inspect the failed stage and choose an appropriate existing Resource Profile.", "Create a recovery Workflow; do not reuse the previous approval."] },
  { matches: (code) => ["timeout", "interrupted", "bridge_timeout", "provider_timeout"].includes(code), category: "worker_timeout", title: "Worker timed out", explanation: "The Worker did not return a terminal result within the enforced stage timeout.", retryable: true, recoverySteps: ["Run Provider Preflight to distinguish provider connectivity from task complexity.", "Create a recovery Workflow after the environment is healthy."] },
  { matches: (code) => code === "premature_audit_output", category: "audit_contract", title: "Worker submitted audit output too early", explanation: "The Worker submitted its terminal structured audit result and then continued using tools, so the reported result cannot describe the observed execution.", retryable: true, recoverySteps: ["Inspect observed writes because partial project changes may exist.", "Create a recovery Workflow only after verifying project state; do not relax the validator or reuse approval."] },
  { matches: (code) => ["invalid_json", "audit_validation_failed"].includes(code), category: "audit_contract", title: "Worker result rejected by audit", explanation: "The Worker returned, but its structured result or evidence did not satisfy the existing audit contract.", retryable: true, recoverySteps: ["Inspect the normalized result and tool evidence without relaxing the validator.", "Create a recovery Workflow so the Worker can produce a fresh audited result."] },
  { matches: (code) => code === "resource_limit_exceeded", category: "resource_limit", title: "Resource profile limit exceeded", explanation: "Observed turns, reads, commands, or time exceeded an enforced Resource Profile limit.", retryable: true, recoverySteps: ["Inspect observed resource usage and select an existing profile appropriate for the task.", "Create a new Workflow; hard global bounds remain unchanged."] },
  { matches: (code, message) => code === "worker_crash" && /connectionrefused|connection refused|econnrefused|getaddrinfo|enotfound|unable to connect/i.test(message), category: "provider_connectivity", title: "Provider connection failed", explanation: "Claude CLI started, but its configured provider could not be reached.", retryable: true, recoverySteps: ["Run Provider Preflight from the same Supervisor environment.", "Fix provider, DNS, or proxy connectivity, then create a recovery Workflow."] },
  { matches: (code, message) => code === "worker_crash" && /\b(401|403)\b|authentication|unauthori[sz]ed|invalid api key/i.test(message), category: "provider_authentication", title: "Provider authentication failed", explanation: "Claude CLI reached an authentication boundary but was not authorized.", retryable: true, recoverySteps: ["Verify provider credentials in the terminal that starts Supervisor.", "Run Provider Preflight, then create a recovery Workflow."] },
  { matches: (code) => ["claude_not_found", "environment_failed"].includes(code), category: "environment", title: "Worker environment unavailable", explanation: "The local Worker environment could not start correctly.", retryable: true, recoverySteps: ["Run doctor and correct the reported CLI or configuration problem.", "Run Provider Preflight before creating a recovery Workflow."] },
  { matches: (code) => ["cancelled", "runtime_restarted"].includes(code), category: "interrupted", title: "Execution interrupted", explanation: "The Task ended without a terminal Worker result and cannot resume the original Claude session.", retryable: true, recoverySteps: ["Inspect partial artifacts and project state.", "Create a recovery Workflow; a new approval is required before any write stage."] }
];

export function classifyWorkflowFailure(workflow) {
  if (!workflow?.failure) return null;
  const code = String(workflow.failure.error?.code || "stage_failed");
  const rawMessage = sanitizeMessage(workflow.failure.error?.message || "Stage failed.");
  const entry = CATALOG.find((candidate) => candidate.matches(code, rawMessage)) || {
    category: "runtime_failure",
    title: "Workflow stage failed",
    explanation: "The stage ended without a successful audited result.",
    retryable: true,
    recoverySteps: ["Inspect the stage error and available artifacts.", "Run Provider Preflight when the failure may be external, then create a recovery Workflow."]
  };
  return {
    category: entry.category,
    title: entry.title,
    explanation: entry.explanation,
    retryable: entry.retryable,
    failedStage: workflow.failure.failedStage || workflow.currentStage || null,
    failedRole: workflow.failure.role || null,
    stageLabel: stageName(workflow.failure.role, workflow.failure.failedStage),
    taskId: workflow.failure.taskId || null,
    code,
    message: rawMessage,
    failedAt: workflow.failure.failedAt || null,
    recoverySteps: entry.recoverySteps
  };
}
