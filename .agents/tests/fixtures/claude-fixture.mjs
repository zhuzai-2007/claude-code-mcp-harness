import path from "node:path";

const scenario = process.env.CLAUDE_TASK_FIXTURE_SCENARIO || "unicode-read";
const baseWorker = { summary: "fixture completed", files_read: [], proposed_changes: ["Apply the fixture proposal in a later approved run."], changes_made: [], commands_run: [], tests_or_checks: [], risks: [], blocked_on: [] };
const event = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const toolUse = (id, name, input) => event({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] } });
const toolResult = (id, isError = false) => event({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "fixture result", is_error: isError }] } });

let worker = { ...baseWorker };
let permissionDenials = [];
let terminalResult = null;
switch (scenario) {
  case "unicode-read":
    worker = { ...worker, summary: "编码检查：“中文”—OK", files_read: ["README.md"], tests_or_checks: ["Read README.md"] };
    toolUse("read-1", "Read", { file_path: path.resolve("README.md") }); toolResult("read-1"); break;
  case "long-summary":
    worker = { ...worker, summary: `LONG:${"甲乙丙丁".repeat(120)}`, files_read: ["README.md"], tests_or_checks: ["Read README.md"] };
    toolUse("read-long-summary", "Read", { file_path: path.resolve("README.md") }); toolResult("read-long-summary"); break;
  case "claimed-commands-no-events":
    worker = { ...worker, summary: "claims without events", tests_or_checks: ["Checked with `ls -la`", "Verified with `test -d workspace/example`"] }; break;
  case "ls-observed":
    worker = { ...worker, summary: "LS evidence present", files_read: ["README.md"], tests_or_checks: ["Checked directory existence with `ls -la`"] };
    toolUse("read-before-ls", "Read", { file_path: path.resolve("README.md") }); toolResult("read-before-ls");
    toolUse("ls-1", "LS", { path: "workspace" }); toolResult("ls-1"); break;
  case "bash-unreported":
    worker = { ...worker, summary: "shell command omitted", tests_or_checks: ["Ran a project check"] };
    toolUse("bash-1", "Bash", { command: "git status --short" }); toolResult("bash-1"); break;
  case "permission-denial":
    worker = { ...worker, summary: "denied check claimed", tests_or_checks: ["Read README.md"] };
    toolUse("read-denied", "Read", { file_path: "README.md" }); toolResult("read-denied", true);
    permissionDenials = [{ tool_use_id: "read-denied", tool_name: "Read", reason: "fixture denial" }]; break;
  case "failed-tool-result":
    worker = { ...worker, summary: "failed read claimed", files_read: ["README.md"], tests_or_checks: ["Read README.md"] };
    toolUse("read-failed", "Read", { file_path: path.resolve("README.md") }); toolResult("read-failed", true); break;
  case "file-read-unreported-by-events":
    worker = { ...worker, summary: "file read claimed", files_read: ["README.md"], tests_or_checks: ["Read README.md"] }; break;
  case "plan-with-proposed-changes":
    worker = { summary: "plan prepared from project evidence", files_read: ["README.md"], proposed_changes: ["Update the task board filtering UI in a later approved run."], risks: ["Search behavior must preserve existing filters."], blocked_on: [] };
    toolUse("read-plan-source", "Read", { file_path: path.resolve("README.md") }); toolResult("read-plan-source"); break;
  case "plan-approval-as-blocker":
    worker = { summary: "plan prepared but approval was misreported as a blocker", files_read: ["README.md"], proposed_changes: ["Apply the approved change later."], risks: [], blocked_on: ["Awaiting human approval before file modifications begin."] };
    toolUse("read-plan-blocker", "Read", { file_path: path.resolve("README.md") }); toolResult("read-plan-blocker"); break;
  case "plan-missing-summary-files-read":
    worker = { proposed_changes: ["Update the task board filtering UI in a later approved run."], risks: [], blocked_on: [] };
    toolUse("read-plan-missing-fields", "Read", { file_path: path.resolve("README.md") }); toolResult("read-plan-missing-fields"); break;
  case "focused-review":
    worker = { ...worker, summary: "focused review completed", files_read: ["README.md"], changes_made: [], commands_run: [], tests_or_checks: ["Read the reported modified file and checked it against the requested behavior."], risks: ["No obvious regression found in the bounded review scope."], blocked_on: [] };
    toolUse("read-focused-review", "Read", { file_path: path.resolve("README.md") }); toolResult("read-focused-review"); break;
  case "run-write-without-final-read":
    worker = { ...worker, summary: "file written without final Read", files_read: ["workspace/audit-fixture.txt"], changes_made: ["workspace/audit-fixture.txt"], tests_or_checks: ["Re-read workspace/audit-fixture.txt after writing"], run_result: { type: "modified" } };
    toolUse("write-without-read", "Write", { file_path: path.resolve("workspace/audit-fixture.txt"), content: "fixture" }); toolResult("write-without-read"); break;
  case "run-write-with-final-read":
    worker = { ...worker, summary: "file written and verified with Read", files_read: ["workspace/audit-fixture.txt"], changes_made: ["workspace/audit-fixture.txt"], tests_or_checks: ["Re-read workspace/audit-fixture.txt after writing"], run_result: { type: "modified" } };
    toolUse("write-before-read", "Write", { file_path: path.resolve("workspace/audit-fixture.txt"), content: "fixture" }); toolResult("write-before-read");
    toolUse("read-after-write", "Read", { file_path: path.resolve("workspace/audit-fixture.txt") }); toolResult("read-after-write"); break;
  case "run-noop-with-read-and-reason":
    worker = { ...worker, summary: "target state already satisfied", files_read: ["README.md"], changes_made: [], tests_or_checks: ["Read README.md and confirmed the requested state"], run_result: { type: "noop", reason: "README.md already contains the requested state." } };
    toolUse("read-noop-state", "Read", { file_path: path.resolve("README.md") }); toolResult("read-noop-state"); break;
  case "run-noop-without-evidence":
    worker = { ...worker, summary: "noop claimed without evidence", changes_made: [], tests_or_checks: [], run_result: { type: "noop", reason: "Claimed existing state without inspecting it." } }; break;
  case "run-noop-without-reason":
    worker = { ...worker, summary: "noop claimed without a reason", files_read: ["README.md"], changes_made: [], tests_or_checks: ["Read README.md and confirmed the requested state"], run_result: { type: "noop" } };
    toolUse("read-noop-without-reason", "Read", { file_path: path.resolve("README.md") }); toolResult("read-noop-without-reason"); break;
  case "run-modified-without-changes":
    worker = { ...worker, summary: "modified result omitted changes", files_read: ["README.md"], changes_made: [], tests_or_checks: ["Read README.md"], run_result: { type: "modified" } };
    toolUse("read-modified-without-changes", "Read", { file_path: path.resolve("README.md") }); toolResult("read-modified-without-changes"); break;
  case "missing-required-field": {
    const { risks: _omittedRisks, ...missingFieldWorker } = worker;
    worker = { ...missingFieldWorker, summary: "required risks field omitted", files_read: ["README.md"], tests_or_checks: ["Read README.md"] };
    toolUse("read-missing-field", "Read", { file_path: path.resolve("README.md") }); toolResult("read-missing-field"); break;
  }
  case "complete-audit-json":
    worker = { ...worker, summary: "complete audit JSON accepted", files_read: ["README.md"], tests_or_checks: ["Read README.md"] };
    toolUse("read-complete-json", "Read", { file_path: path.resolve("README.md") }); toolResult("read-complete-json"); break;
  case "dot-directory-read":
    worker = { ...worker, summary: "dot-directory read accepted", files_read: [".agents/policy.json"], tests_or_checks: ["Read .agents/policy.json"] };
    toolUse("read-dot-directory", "Read", { file_path: path.resolve(".agents/policy.json") }); toolResult("read-dot-directory"); break;
  case "budget-exceeded":
    toolUse("read-before-budget", "Read", { file_path: path.resolve("README.md") }); toolResult("read-before-budget");
    terminalResult = { type: "result", subtype: "error_max_budget_usd", is_error: true, errors: ["Reached maximum budget ($0.2)"], total_cost_usd: 0.2 };
    break;
  case "api-connection-error":
    terminalResult = { type: "result", subtype: "success", is_error: true, result: "API Error: Unable to connect to API (ConnectionRefused)", total_cost_usd: 0 };
    break;
  case "many-reads":
    worker = { ...worker, summary: "completed bounded multi-file analysis", files_read: ["README.md"], tests_or_checks: ["Read project files"] };
    for (let index = 1; index <= 35; index += 1) {
      const id = `read-many-${index}`;
      toolUse(id, "Read", { file_path: path.resolve("README.md") }); toolResult(id);
    }
    break;
  default: throw new Error(`Unknown CLAUDE_TASK_FIXTURE_SCENARIO: ${scenario}`);
}
event(terminalResult || { type: "result", subtype: "success", is_error: false, result: JSON.stringify(worker), permission_denials: permissionDenials, total_cost_usd: 0 });
