# Codex-Claude Worker Harness

Portable control layer for using Claude Code as a bounded worker under Codex supervision.

## Daily flow

Run commands from the project root.

```powershell
.\.agents\doctor.ps1
.\.agents\claude-task.ps1 plan -Task "Inspect the project and propose a safe plan."
.\.agents\claude-task.ps1 run -Task "Make the approved change." -ApprovedBy Codex -ApprovalReason "User approved this worker run."
.\.agents\claude-task.ps1 review -Task "Review the current diff for bugs and missing checks."
.\.agents\summary.ps1 -RunId latest
.\.agents\ledger.ps1 -Tail 10
```

## Stable JSON CLI

Future MCP wrappers should call the CLI through JSON input and consume `worker-result.normalized.json`.

```powershell
.\.agents\claude-task.ps1 plan -InputJson .\task.json
```

The seven Worker-required fields remain stable: `summary`, `files_read`, `changes_made`, `commands_run`, `tests_or_checks`, `risks`, and `blocked_on`. A successfully parsed strict Worker `summary` is stored in full. Optional supervisor fields include `observed_tools`, `observed_commands`, `permission_denials`, `observed_file_targets`, and `audit_issues`.

Exit codes: `0=success`, `1=worker_failed`, `2=policy_blocked`, `3=invalid_input`, `4=environment_failed`.

## Mock worker

Use `-MockWorker` to verify harness run directory creation, `summary.ps1`, `result.json`, and `worker-result.normalized.json` without invoking Claude Code:

```powershell
.\.agents\claude-task.ps1 plan -Task "Return exactly OK and nothing else." -MockWorker
.\.agents\summary.ps1 -RunId latest -IncludeIncomplete
```

Mock mode is opt-in only. The default behavior still invokes Claude Code after policy checks. Mock mode does not bypass approval or policy gates; `run` mode still requires `-ApprovedBy` and `-ApprovalReason`.

## Budget

Default Claude worker budget is `0.20` USD per run. This default is intentionally conservative.

`MaxBudgetUsd` is the Claude Code / wrapper-side estimated budget. With third-party or domestic-model adapters, it may not match the actual amount charged by the upstream API platform.

For real small tasks that need more room, use a temporary explicit budget:

```powershell
.\.agents\claude-task.ps1 plan -Task "Return exactly OK and nothing else." -MaxBudgetUsd 0.20
.\.agents\claude-task.ps1 run -Task "Make the approved change." -ApprovedBy Codex -ApprovalReason "User approved this worker run." -MaxBudgetUsd 0.30
```

The budget must be positive. The portable template currently rejects values above `5.00`. Raising it can increase actual API cost, so use the smallest value that fits the task.

Project-local defaults can be placed in `.agents/local.config.json`:

```json
{
  "maxBudgetUsd": 1.00
}
```

Do not commit `.agents/local.config.json`; command-line `-MaxBudgetUsd` takes precedence over local config. If your adapter is calibrated differently and you need a higher ceiling, that requires a local wrapper/policy change and should be treated as an operator decision because it can increase real cost.

Cost control should not rely only on `MaxBudgetUsd`. Keep tasks split, use appropriate `WorkerTimeoutSeconds`, bound file reads, and keep networking, dependency installation, git operations, and deletion disabled unless explicitly required and approved.

## Safety model

`run` mode requires `-ApprovedBy` and `-ApprovalReason`. Git writes, dependency installs, network access, recursive deletes, and external directories are blocked unless the matching allow switch and approval metadata are present. Because Claude CLI treats `--allowedTools` as permission grants rather than an exclusive allowlist, plan/run also pass explicit `--disallowedTools` restrictions; run mode denies Bash and file-only work uses Read/Write/Edit. `plan` and `review` are read-only at the tool policy level.

Worker instructions still ask for concise JSON, but the Harness does not silently truncate a successfully parsed strict `summary`. `ConvertTo-ShortText` is reserved for explicitly untrusted fallback/error previews.

Real Claude calls use `--output-format stream-json --verbose`. Each run keeps the final Claude result envelope in `claude-output.json`, the original JSONL message stream in `claude-events.jsonl`, and the independently derived tool audit in `tool-events.json`. A self-reported command, check, or file read without a matching successful, non-denied tool event fails with `audit_validation_failed`; `audit_issues` contains specific reasons such as `unverifiable_check_evidence`, `command_audit_mismatch`, or `file_audit_mismatch`. The event audit proves what Claude Code reported through its event stream, not what the operating system executed outside that stream.

This harness is a policy and workflow boundary, not a full OS-level sandbox. Shell commands and child processes may still have broader system access unless constrained by the OS, container, VM, or restricted user account.

## Project ledger

Every completed run appends one JSONL record to `.agent-runs/project-ledger.jsonl`. The ledger is runtime state and is ignored by Git. It records run id, mode, status, approval metadata, allowed actions, summary, changes, checks, risks, blocked items, cost, and error.

```powershell
.\.agents\ledger.ps1 -Tail 20
.\.agents\ledger.ps1 -Tail 20 -Json
```


## Troubleshooting

If PowerShell blocks local script execution, prefer unblocking the project scripts first:

```powershell
Unblock-File .\.agents\*.ps1
Unblock-File .\install.ps1
```

Only when needed, use `powershell -NoProfile -ExecutionPolicy Bypass -File ...` for a single command.


## Approved demo run

Use the dedicated demo script to validate that approved `run` mode can make a tiny project-local edit and produce a normalized result:

```powershell
.\.agents\approved-demo.ps1
```

Real Claude worker calls can time out. Timeouts are reported as `worker_failed` with `error.code = worker_timeout`, and still write `result.json` plus `worker-result.normalized.json`.
## Migration

Install this harness into another project with:

```powershell
.\install.ps1 -TargetProject D:/path/to/your/project
```

The installer copies portable `.agents` files, initializes `.agents\runs\.gitkeep` and `.agents\local.config.json`, and does not copy historical runs. Existing `policy.json` is preserved unless `-Force` is supplied.



