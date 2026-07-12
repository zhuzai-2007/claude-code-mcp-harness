# Codex-Claude Worker Harness

[English](README.md) | [简体中文](README.zh-CN.md)

**Status: Alpha — dogfood validated, not production-ready.**

A synchronous, supervised MCP bridge that lets ChatGPT Web delegate bounded project work to a local Claude Code worker. ChatGPT acts as the supervisor for requirement interpretation, planning, approval, and result review. Claude Code performs project-local reads, writes, edits, and approved checks. The Bridge and PowerShell Harness enforce policy, capture events, validate audit claims, normalize results, and maintain a local ledger.

Codex is used to develop, debug, and recover this project; it is not the intended primary user interface. The intended Alpha workflow starts and ends in ChatGPT Web.

> **This project is not a sandbox.** It is a guardrail and supervision layer for trusted local environments. Use a VM, container, restricted OS account, or another real isolation boundary for untrusted code.

## Why this exists

ChatGPT Web is useful for interactive requirement discovery and supervisory decisions, while a local code agent can inspect and change a real project. Used alone, however, a local worker is difficult to supervise from the browser: its permission requests, actual tool use, and reported results can diverge.

This project separates those responsibilities:

- **ChatGPT / GPT:** supervisor, requirement interpretation, planning, approval, and result review.
- **Claude Code Worker:** bounded local execution, file inspection, and project-local implementation.
- **Bridge / Harness:** policy enforcement, approval checks, event capture, audit validation, result normalization, budgets, timeouts, and ledger records.

The Alpha proves this synchronous control path. Durable background execution, automatic recovery, runtime approval queues, and notifications belong to Phase B and are not implemented.

## Architecture

```text
ChatGPT Web
    |
OpenAI Secure MCP Tunnel
    |
Local MCP Bridge (loopback)
    |
PowerShell Harness / Policy / Ledger
    |
Claude Code Worker
    |
Project workspace
```

The audit return path is separate from the Worker's self-report:

```text
Claude stream events
    |
claude-events.jsonl
    |
tool-events.json
    |
audit cross-validation
    |
worker-result.normalized.json
    |
cc_get_result / ChatGPT Supervisor
```

## What the Alpha provides

- Separate `plan`, `review`, and approved `run` modes.
- Explicit approval metadata for write-capable runs.
- Project-root and external-directory boundaries.
- Worker budgets, timeouts, and stable run IDs.
- Read/Write/Edit/Bash policy using both `--allowedTools` and `--disallowedTools`.
- Claude Code `stream-json --verbose` event capture.
- Independent `observed_tools`, `observed_commands`, `permission_denials`, and read/write/edit targets.
- Cross-validation between Worker claims and successful tool results through `audit_issues`.
- Denied or failed tool calls never count as successful checks.
- Full strict-JSON summaries without the former silent 300-character truncation.
- File, directory, and symbolic-link side-effect detection for hardened write smoke tests.
- Windows path safeguards and matching between absolute event paths and relative Worker reports.
- Local normalized results and a project ledger for later review.
- Result recovery by run ID when the browser-side synchronous call returns or times out first.

The local dogfood flow has created a static Chinese task board through an approved write and then completed a follow-up feature iteration under GPT supervision. The dogfood files remain local and are intentionally not part of this repository.

## MCP tools

- `cc_ping` — check Bridge and Harness readiness.
- `cc_plan_task` — run a read-only planning task.
- `cc_review_task` — review a bounded project state without edits.
- `cc_run_approved_task` — perform an explicitly approved write task.
- `cc_get_latest_summary` — recover the latest summary, including incomplete runs.
- `cc_get_ledger` — read recent local ledger entries.
- `cc_get_result` — retrieve a complete normalized result by run ID or `latest`.

Task tools accept `mockWorker: true` for transport tests without a paid Worker call. The default MCP budget is USD 0.20; it is an estimated Claude Code-side limit and can differ slightly from provider billing.

## Quick start on Windows

### Requirements

- Windows PowerShell 5.1 or PowerShell 7
- Node.js 18 or newer
- Claude Code configured locally with a compatible provider
- OpenAI Secure MCP Tunnel access and `tunnel-client` for ChatGPT Web integration
- ChatGPT Developer mode for connecting the MCP app

Clone or copy the project to a non-sensitive location such as `D:\path\to\project`. Never commit provider credentials, Tunnel IDs, local profiles, or proxy credentials.

### Install and configure

```powershell
cd D:\path\to\project
cd .\mcp-server
npm ci
cd ..
.\scripts\init-config.ps1
.\scripts\doctor.ps1
```

Review `.agents/policy.json`. Keep machine-specific overrides in ignored `.agents/local.config.json`.

### Start the local Bridge

Run the loopback Bridge in a dedicated terminal:

```powershell
.\scripts\start-mcp.ps1
```

Do not expose port 8787 directly to the public internet.

### Connect Secure MCP Tunnel

Use placeholder-only environment values:

```powershell
$env:CONTROL_PLANE_API_KEY = 'YOUR_RUNTIME_API_KEY'
.\scripts\start-openai-tunnel.ps1 -Initialize -TunnelId 'tunnel-example-id' -DoctorOnly
```

Then run the Tunnel wrapper in a separate terminal and connect the Tunnel app from ChatGPT Developer mode. Tunnel behavior can change; follow [the maintained Secure MCP Tunnel guide](docs/secure-mcp-tunnel.md) instead of copying old profile details.

### Validate progressively

```powershell
# Harness and provider diagnostics
.\.agents\doctor.ps1

# No paid Worker call
.\.agents\claude-task.ps1 plan -Task 'Return strict JSON with summary exactly ok.' -MockWorker

# Local Bridge health and mock Worker smoke
.\scripts\test-local.ps1 -MockWorkerSmoke

# Run only when no Bridge is already using port 8787
.\scripts\test-mcp-protocol.ps1

# Small real read-only acceptance
.\scripts\test-mcp-protocol.ps1 -RealPlan -MaxBudgetUsd 0.20

# Independent approved write smoke
.\scripts\test-mcp-protocol.ps1 -RealWrite -MaxBudgetUsd 0.20
```

From ChatGPT, start with `cc_ping`, then a mock plan, then a minimal real read-only task. Use `cc_run_approved_task` only after reviewing the exact write boundary and approval metadata. If a synchronous tool call ends before the Worker, retain the run ID and call `cc_get_result` later.

## Safety model

The safety model is layered:

- the Bridge exposes fixed Harness entrypoints instead of a generic shell;
- policy constrains mode, tools, project root, external directories, budgets, and timeouts;
- write mode requires approval metadata;
- `--allowedTools` grants specific tools while `--disallowedTools` explicitly denies prohibited classes;
- the system prompt forbids secrets, destructive Git operations, recursive deletion, and unsafe Windows paths;
- stream events are persisted independently from the Worker's JSON report;
- reported commands, checks, and file operations are cross-validated against successful, non-denied events;
- mismatches fail conservatively as `audit_validation_failed`;
- write smoke tests compare files, directories, and symbolic links before and after execution;
- the local ledger records results and approval context.

These are guardrails, not strong isolation. Event auditing is evidence emitted by Claude Code, not an OS-kernel execution trace. If a CLI or provider omits required events, the result is treated as unverifiable rather than successful.

See [SECURITY.md](SECURITY.md) before enabling write access.

## Validated behavior

- Source Harness smoke: 19/19.
- Portable-install Harness smoke: 19/19.
- MCP initialize, discovery, ping, mock plan, approved mock run, and exact result retrieval.
- Strict Unicode summary round-trip beyond 300 characters through Harness and `cc_get_result`.
- `unverifiable_check_evidence`, `command_audit_mismatch`, and `file_audit_mismatch` regressions.
- Denied and failed tool results excluded from successful evidence.
- Windows absolute/relative path audit matching.
- File, directory, and symbolic-link side-effect guard.
- Real read-only and approved write paths.
- Event-mismatch rejection during real dogfood.
- Static task-board creation and a later supervised feature iteration.

Evidence and scope are documented in [validation results](docs/validation-results.md), [Alpha release notes](docs/alpha-release-notes.md), and [real-world validation](docs/real-world-validation.md).

## Known limitations

- This is Alpha software and is not production-ready.
- MCP execution is synchronous; ChatGPT can time out before a long Worker finishes.
- There is no persistent asynchronous queue, lease, heartbeat, automatic reconnect orchestration, or notification outbox.
- Runtime permission requests cannot yet pause durably and resume through ChatGPT.
- This is not an OS-level sandbox and must not run arbitrary untrusted code.
- Audit completeness depends on Claude Code and provider event completeness.
- Provider budget accounting may slightly overshoot a requested limit.
- Windows is the primary validated environment; other platforms do not have equivalent release evidence.
- Bridge, `tunnel-client`, and any required proxy must remain running.
- Tunnel and provider configuration remain environment-dependent.

## Roadmap

[Phase B](docs/v0.2-roadmap.md) proposes, but does not yet implement:

- a persistent SQLite task store;
- asynchronous submit, poll, pause, and resume;
- leases, heartbeat, cancellation, and crash recovery;
- a durable approval queue and event stream;
- a notification outbox;
- better background-process lifecycle management.

## Contributing and reporting issues

Bug reports and focused Alpha hardening contributions are welcome. Open a GitHub issue with:

- the smallest safe reproduction;
- OS, PowerShell, Node.js, and Claude Code versions;
- mode and policy details without credentials;
- sanitized status, error code, and relevant audit fields;
- whether the issue reproduces with `mockWorker`.

Do not paste API keys, Tunnel IDs, personal paths, full run logs, prompts, ledgers, or user data into an issue. Report suspected vulnerabilities privately through GitHub Security Advisories as described in [SECURITY.md](SECURITY.md).

Useful contributions include Windows portability, fixture coverage, audit validation, documentation, and narrowly scoped safety improvements. Phase B implementation is intentionally outside this Alpha release.

## License

MIT. See [LICENSE](LICENSE). Dependency licensing has been reviewed only as an engineering release check, not as legal advice.
