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

Worker contracts are mode-specific. Plan mode requires `summary`, `files_read`, `proposed_changes`, `risks`, and `blocked_on`; it requires real Read evidence but not execution-stage changes, commands, or checks. Review mode retains the seven execution-audit fields: `summary`, `files_read`, `changes_made`, `commands_run`, `tests_or_checks`, `risks`, and `blocked_on`. Run mode retains those seven fields and additionally requires `run_result`: `{ "type": "modified" }` keeps the strict change and final-Read requirements, while `{ "type": "noop", "reason": "..." }` permits no changes only with a concrete reason, successful Read evidence, and a reported check. A successfully parsed strict Worker `summary` is stored in full. Optional supervisor fields include `observed_tools`, `observed_commands`, `permission_denials`, `observed_file_targets`, and `audit_issues`.

Exit codes: `0=success`, `1=worker_failed`, `2=policy_blocked`, `3=invalid_input`, `4=environment_failed`.

## Mock worker

Use `-MockWorker` to verify harness run directory creation, `summary.ps1`, `result.json`, and `worker-result.normalized.json` without invoking Claude Code:

```powershell
.\.agents\claude-task.ps1 plan -Task "Return exactly OK and nothing else." -MockWorker
.\.agents\summary.ps1 -RunId latest -IncludeIncomplete
```

Mock mode is opt-in only. The default behavior still invokes Claude Code after policy checks. Mock mode does not bypass approval or policy gates; `run` mode still requires `-ApprovedBy` and `-ApprovalReason`.

## Budget

The default `small_readonly` profile allows up to `1.00` USD per run. Use a lower explicit limit for tiny checks when appropriate.

`MaxBudgetUsd` is the Claude Code / wrapper-side estimated budget. With third-party or domestic-model adapters, it may not match the actual amount charged by the upstream API platform.

For tightly bounded low-cost checks, use a temporary lower explicit budget; explicit values still override the profile:

```powershell
.\.agents\claude-task.ps1 plan -Task "Return exactly OK and nothing else." -MaxBudgetUsd 0.20
.\.agents\claude-task.ps1 run -Task "Make the approved change." -ApprovedBy Codex -ApprovalReason "User approved this worker run." -MaxBudgetUsd 0.30
```

The budget must be positive. The portable template currently rejects values above `5.00`. Raising it can increase actual API cost, so use the smallest value that fits the task.

Resource limits come from an explicit command/InputJson override or the selected Resource Profile. Legacy `.agents/local.config.json` budget values do not override a profile. If your adapter is calibrated differently, select an appropriate profile or pass an explicit `-MaxBudgetUsd`; the global hard limit still applies.

Cost control should not rely only on `MaxBudgetUsd`. Keep tasks split, use appropriate `WorkerTimeoutSeconds`, bound file reads, and keep networking, dependency installation, git operations, and deletion disabled unless explicitly required and approved.

## Resource profiles

`.agents/resource-profiles.json` defines `small_readonly` (default targeted reads), `exploration_readonly` (multi-file project discovery), `medium_analysis`, and `large_change`. Select a profile without changing the common Worker audit fields or run-result rules:

```powershell
.\.agents\claude-task.ps1 plan -Task "Explore the project structure and identify relevant architecture files." -ResourceProfile exploration_readonly
```

Profiles resolve budget, turns, successful read calls, commands, and timeout. Explicit CLI/InputJson values override the selected profile but cannot exceed the file's global hard limits. The resolved profile, limits, and observed usage are stored in run metadata, normalized results, and the project ledger.

## Safety model

`run` mode requires `-ApprovedBy` and `-ApprovalReason`. Git writes, dependency installs, network access, recursive deletes, and external directories are blocked unless the matching allow switch and approval metadata are present. Because Claude CLI treats `--allowedTools` as permission grants rather than an exclusive allowlist, plan/run also pass explicit `--disallowedTools` restrictions; run mode denies Bash and file-only work uses Read/Write/Edit. `plan` and `review` are read-only at the tool policy level.

Worker instructions still ask for concise JSON, but the Harness does not silently truncate a successfully parsed strict `summary`. `ConvertTo-ShortText` is reserved for explicitly untrusted fallback/error previews.

Real Claude calls use `--output-format stream-json --verbose`. Each run keeps the final Claude result envelope in `claude-output.json`, the original JSONL message stream in `claude-events.jsonl`, and the independently derived tool audit in `tool-events.json`. A self-reported command, check, or file read without a matching successful, non-denied tool event fails with `audit_validation_failed`; `audit_issues` contains specific reasons such as `unverifiable_check_evidence`, `command_audit_mismatch`, or `file_audit_mismatch`. The event audit proves what Claude Code reported through its event stream, not what the operating system executed outside that stream.

This harness is a policy and workflow boundary, not a full OS-level sandbox. Shell commands and child processes may still have broader system access unless constrained by the OS, container, VM, or restricted user account.

## Project ledger

Every completed run appends one JSONL record to `.agent-runs/project-ledger.jsonl`. The ledger is runtime state and is ignored by Git. It records run id, mode, status, approval metadata, allowed actions, summary, changes, checks, risks, blocked items, cost, resource profile/limits/usage, and error.

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

Real Claude worker calls can time out. Timeouts are reported as `worker_failed` with `error.code = timeout`, and still write `result.json` plus `worker-result.normalized.json`.
## Migration

Install this harness into another project with:

```powershell
.\install.ps1 -TargetProject D:/path/to/your/project
```

The installer copies portable `.agents` files, initializes `.agents\runs\.gitkeep` and `.agents\local.config.json`, and does not copy historical runs. Existing `policy.json` and `resource-profiles.json` are preserved unless `-Force` is supplied.



