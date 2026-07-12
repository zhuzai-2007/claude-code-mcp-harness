---
name: codex-claude-worker
description: Translate natural-language user requests into bounded Claude Code worker tasks while Codex or ChatGPT remains the supervisor. Use when the user gives an ordinary prompt and wants Codex to clarify scope, choose a safe work boundary, generate a worker prompt, approve or defer worker execution, read run summaries and ledgers, independently validate output, and send bounded fix/review runs through the Codex-Claude harness.
---

# Codex Claude Worker

Use this skill when Codex or ChatGPT is the main reasoning agent and Claude Code is a bounded local worker. The common input is a normal user prompt, not a complete specification. Treat the harness as a policy and workflow boundary, not an OS sandbox.

## Operating Model

1. Translate the user's natural-language request into a concrete worker task: goal, target path, deliverables, forbidden actions, acceptance checks, and budget.
2. Inspect the repo and choose the smallest safe worker boundary.
3. Use `plan` for read-only orientation when task scope or write boundary is uncertain.
4. Use `run` only with explicit approval metadata and a bounded prompt.
5. Read `summary.ps1`, `worker-result.normalized.json`, and the ledger after every run.
6. Independently validate worker output before reporting success, including `artifact_status` and `supervisor_notes` when the worker failed or hit budget.
7. Start a separate `fix` run when validation finds a concrete defect.

Prefer direct PowerShell harness use first. Treat the MCP bridge as optional transport, not the only interface.

## Auto-Run Rules

Auto-run is acceptable only for small tasks that create or modify files under one new directory such as `workspace/<task-id>/`.

Require a second user confirmation before run mode when the task touches existing source, `.agents/`, `mcp-server/`, `scripts/`, config files, package files, lockfiles, dependencies, network, deletion, git operations, broad scans, long tasks, or ambiguous write boundaries.

Always include these boundaries in worker prompts:

```text
Only create or modify files under <bounded-path>.
Do not modify .agents/, mcp-server/, scripts/, .git/, config files, package files, or lockfiles.
Do not access the network.
Do not install dependencies.
Do not delete files outside <bounded-path>.
Do not run git commands.
Return concise JSON with summary, files_read, changes_made, commands_run, tests_or_checks, risks, blocked_on.
```

## Prompt Translation

Before calling the worker, convert the raw user prompt into a task brief. Use `templates/worker-prompts.md` for generic build, refactor, review, and fix prompts.

The brief must preserve the user's intent, state assumptions, and add acceptance checks. Do not over-specify design choices that the user did not ask for unless needed for safety, repeatability, or validation.

For README, docs, or user-facing text, require ASCII unless the task explicitly needs non-ASCII, forbid real local paths/usernames/tokens/ngrok URLs, and keep the output short enough for Codex to inspect.

## Prompt Templates

Use `templates/worker-prompts.md` for plan, run, review, and fix prompt shapes. Keep each worker task small enough that Codex can inspect the result without trusting the worker's self-report.

Use `templates/supervisor-checklist.md` after every worker run. The worker's checks are useful evidence, but Codex's independent checks are the acceptance gate.

Use `templates/natural-language-smoke.md` when validating this skill against ordinary user prompts.

## Harness Commands

From the project root:

```powershell
.\.agents\doctor.ps1
.\.agents\claude-task.ps1 plan -Task "<bounded planning task>" -MaxBudgetUsd 0.20
.\.agents\claude-task.ps1 run -Task "<bounded implementation task>" -ApprovedBy Codex -ApprovalReason "<specific user/task approval>" -MaxBudgetUsd 0.50
.\.agents\summary.ps1 -RunId latest -IncludeIncomplete
.\.agents\ledger.ps1 -Tail 10
.\scripts\scan-doc-hygiene.ps1
```

For harness-only checks, use `-MockWorker`. For real worker calls, expect local Claude Code auth, provider config, terminal trust, and network access to matter.

## Safety Notes

Do not describe this as a secure sandbox. The worker process may still have broader OS access unless the operator separately constrains it with a VM, container, restricted user, or filesystem sandbox.

Keep the MCP bridge bound to loopback and use OpenAI Secure MCP Tunnel for ChatGPT access. Treat any direct ngrok/cloudflared exposure as an unauthenticated public write-capable endpoint and avoid it outside isolated experiments.
