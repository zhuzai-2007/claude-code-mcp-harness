# ChatGPT Supervisor Usage Protocol

This document defines the default operating protocol for ChatGPT acting as the supervisor for the Codex-Claude Worker MCP bridge.

## User-Facing Rule

The user should provide a high-level goal in normal language. The user does not need to hand-write `cc_plan_task`, `cc_run_approved_task`, or other MCP tool parameters.

ChatGPT is responsible for translating the goal into the correct MCP tool calls, worker prompt, approval text, and follow-up result checks.

Approval metadata is a workflow and audit record, not authenticated or cryptographic proof of human consent. Keep Bridge approval defaults null unless the local operator deliberately accepts an auto-approval policy.

## Natural-Language Request Translation

Most user requests are ordinary prompts, not full specifications. Before invoking the worker, ChatGPT/Codex must create a bounded task brief:

- raw user intent
- target path or approved file list
- deliverables
- assumptions made by the supervisor
- actions that are explicitly forbidden
- acceptance checks the supervisor will run after completion

Do not ask the user to write worker tool parameters. Ask a clarification only when the write boundary, risk level, or expected artifact is genuinely ambiguous.

## Default Auto-Run Scope

For small tasks that only create files under a new directory inside `workspace/`, ChatGPT may call `cc_run_approved_task` by default without a second user confirmation.

The target must be a new bounded directory such as:

```text
workspace/<new-dir>/
```

This default auto-run path is intended for low-risk artifact creation, demos, scratch outputs, and isolated prototypes.

For workspace-isolated tasks, prefer one directory, few file reads, no network, no dependency installation, and no git operations.

Example successful loop:

1. User asks for a small study task planner utility.
2. ChatGPT directs the worker to touch only `workspace/study-task-planner/`.
3. ChatGPT later asks the worker only to add `workspace/study-task-planner/run_tests.py`.
4. User runs `python run_tests.py` locally from that directory and reports the result.

## Required Worker Prompt Boundary

When ChatGPT auto-generates the worker prompt for a default auto-run task, it must include explicit boundaries:

```text
Only create or modify files under workspace/<new-dir>/.
Do not modify .agents/, mcp-server/, scripts/, .git/, config files, package files, or lockfiles.
Do not access the network.
Do not install dependencies.
Do not delete files outside workspace/<new-dir>/.
Do not run git commands.
Keep the task small and report concise results.
```

ChatGPT should adapt `<new-dir>` to the user's goal and keep it unique enough to avoid colliding with existing work.

## Required Follow-Up Checks

After every worker run, ChatGPT must call:

1. `cc_get_latest_summary`
2. `cc_get_result` with `runId = "latest"`
3. `cc_get_ledger` when using the MCP bridge, or `.\.agents\ledger.ps1 -Tail 5` when using PowerShell directly

The ledger records run metadata and evidence for local review. It is not append-only, tamper-proof, or a substitute for an operating-system audit log.

ChatGPT should use the normalized result as the primary source of truth. If the normalized result reports failure, timeout, policy blocking, invalid input, or incomplete output, ChatGPT must report that state clearly instead of assuming success.

For real Worker runs, the normalized result also exposes event-derived `observed_tools`, `observed_commands`, `permission_denials`, `observed_file_targets`, and `audit_issues`. Worker claims are not sufficient when they conflict with successful, non-denied Claude Code events. Any `audit_validation_failed` result remains a failure and requires supervisor review.

If ChatGPT's synchronous tool call ends before the Worker completes, retain the run ID and use `cc_get_result` later. This recovery path does not make the Alpha asynchronous and does not automatically reconnect, notify, or resume a conversation.

When `artifact_status` is `unvalidated_partial_artifacts_possible`, the worker failed but reported files, changes, or checks. Treat those files as untrusted partial output: inspect the run directory, run independent validation, and record whether the artifacts are usable. Do not convert the run to success based only on the worker report.

The worker's own `tests_or_checks` field is not sufficient for acceptance. ChatGPT must independently inspect the changed files and run the smallest relevant syntax, unit, smoke, static, or artifact check available in the local context.

For natural-language tasks, also check whether the worker output actually satisfies the original user intent, not only the translated prompt.

For README, documentation, or user-facing text, also run or mirror:

```powershell
.\scripts\scan-doc-hygiene.ps1
```

This catches mojibake, real local paths, local usernames, token-looking strings, and real tunnel URLs before artifacts are treated as release-ready.

## Budget Guidance

For third-party or domestic-model adapters, `MaxBudgetUsd` is the Claude Code or wrapper-side estimated budget. It may not match the actual amount charged by the upstream API platform.

For local use, prefer setting a project-local default in `.agents/local.config.json`, for example `maxBudgetUsd` around `1.00` for practical small tasks. That file is git ignored and must not be committed. The portable template currently rejects values above `5.00`. If your adapter is calibrated differently and you need a higher ceiling, that requires a local wrapper/policy change and should be treated as an operator decision because it can increase real cost.

ChatGPT should avoid repeatedly raising the budget inside a live task. Cost control should not rely only on `MaxBudgetUsd`; it should also rely on task splitting, `WorkerTimeoutSeconds`, narrow file-read scope, no networking, no dependency installation, and no git operations. Split the task or ask the user to run a real local test first.

## Live Worker Testing

Do not use Codex or another patch agent to run live Claude worker tests as part of ordinary supervisor operation. Live worker tests should be run by the user in a real PowerShell terminal where Claude Code can use its normal terminal, auth, trust, and adapter environment.

Use mock worker mode only to validate the MCP bridge, PowerShell harness, summaries, and normalized result plumbing. A mock success does not prove that the real Claude worker or adapter can complete the task.

Recommended cycle:

1. `generate` or `patch-only` worker run with a narrow write boundary.
2. User runs local tests in PowerShell.
3. If needed, start a separate fix run with the test failure summary.

This avoids long compound worker runs and keeps each run easier to inspect.

For real local and ChatGPT web MCP smoke procedures, see `docs/real-world-validation.md`.

## When To Ask For Second Confirmation

ChatGPT must ask the user for explicit second confirmation before calling `cc_run_approved_task` when the task may involve any of these:

- Modifying core harness files, including `.agents/`, `mcp-server/`, or `scripts/`.
- Modifying existing project files outside a new `workspace/<new-dir>/`.
- Editing config files, package files, lockfiles, or dependency manifests.
- Installing dependencies.
- Accessing the network.
- Deleting files.
- Running git operations.
- Running long tasks or broad project scans.
- Any task where the intended write boundary is ambiguous.

For these cases, ChatGPT should first produce a plan or ask a concise clarification.

## Tool Boundary

The MCP bridge is not a general shell or file server. ChatGPT must not expect or request generic tools such as `exec_shell`, `run_powershell`, `read_file`, `write_file`, or `delete_file`.

The intended flow is:

1. User gives a high-level goal.
2. ChatGPT decides whether the task fits the default auto-run scope.
3. ChatGPT generates a bounded worker prompt.
4. ChatGPT calls the fixed MCP harness tools.
5. ChatGPT reads latest summary and normalized result.
6. ChatGPT reads the project ledger entry.
7. ChatGPT performs independent validation.
8. ChatGPT reports the result and any next required user decision.
