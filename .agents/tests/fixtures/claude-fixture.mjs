import path from "node:path";

const scenario = process.env.CLAUDE_TASK_FIXTURE_SCENARIO || "unicode-read";
const baseWorker = { summary: "fixture completed", files_read: [], changes_made: [], commands_run: [], tests_or_checks: [], risks: [], blocked_on: [] };
const event = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const toolUse = (id, name, input) => event({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] } });
const toolResult = (id, isError = false) => event({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "fixture result", is_error: isError }] } });

let worker = { ...baseWorker };
let permissionDenials = [];
switch (scenario) {
  case "unicode-read":
    worker = { ...worker, summary: "编码检查：“中文”—OK", files_read: ["README.md"], tests_or_checks: ["Read README.md"] };
    toolUse("read-1", "Read", { file_path: path.resolve("README.md") }); toolResult("read-1"); break;
  case "long-summary":
    worker = { ...worker, summary: `LONG:${"甲乙丙丁".repeat(120)}`, tests_or_checks: ["Inspected the project with Glob"] };
    toolUse("glob-1", "Glob", { pattern: "*.md", path: "." }); toolResult("glob-1"); break;
  case "claimed-commands-no-events":
    worker = { ...worker, summary: "claims without events", tests_or_checks: ["Checked with `ls -la`", "Verified with `test -d workspace/example`"] }; break;
  case "ls-observed":
    worker = { ...worker, summary: "LS evidence present", tests_or_checks: ["Checked directory existence with `ls -la`"] };
    toolUse("ls-1", "LS", { path: "workspace" }); toolResult("ls-1"); break;
  case "bash-unreported":
    worker = { ...worker, summary: "shell command omitted", tests_or_checks: ["Ran a project check"] };
    toolUse("bash-1", "Bash", { command: "git status --short" }); toolResult("bash-1"); break;
  case "permission-denial":
    worker = { ...worker, summary: "denied check claimed", tests_or_checks: ["Read README.md"] };
    toolUse("read-denied", "Read", { file_path: "README.md" }); toolResult("read-denied", true);
    permissionDenials = [{ tool_use_id: "read-denied", tool_name: "Read", reason: "fixture denial" }]; break;
  case "file-read-unreported-by-events":
    worker = { ...worker, summary: "file read claimed", files_read: ["README.md"], tests_or_checks: ["Read README.md"] }; break;
  default: throw new Error(`Unknown CLAUDE_TASK_FIXTURE_SCENARIO: ${scenario}`);
}
event({ type: "result", subtype: "success", is_error: false, result: JSON.stringify(worker), permission_denials: permissionDenials, total_cost_usd: 0 });
