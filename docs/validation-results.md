# Validation Results

## 2026-07-06 Local Claude Code Python CLI Smoke

- Target: `workspace/cc_python_cli_smoke_20260706/`
- Initial run: `20260706-152520-994`
- Fix run: `20260706-152952-118`
- Result: passed after one bounded fix run.
- Worker cost reported by initial run: `0.31215399999999993`.

Supervisor validation:

```powershell
$env:PYTHONDONTWRITEBYTECODE='1'
python workspace\cc_python_cli_smoke_20260706\run_tests.py
python -m py_compile workspace\cc_python_cli_smoke_20260706\tracker.py workspace\cc_python_cli_smoke_20260706\run_tests.py
```

Observed result:

```text
Ran 12 tests in 0.170s
OK
```

Notes:

- The first worker output was functionally useful but did not populate all normalized structured fields; the wrapper recovered a concise summary.
- The generated test suite initially used system temp paths that failed under this Codex/Windows environment.
- The bounded fix moved test temp files under the project directory.
- Some tests that delete temporary files or write `__pycache__` fail inside the Codex sandbox but pass when run outside the sandbox. Use `PYTHONDONTWRITEBYTECODE=1` and real local PowerShell for final smoke validation.

## 2026-07-06 Local MCP Bridge Mock Smoke

Local bridge health and mock worker smoke passed after starting `mcp-server/server.mjs` and waiting for the server to listen.

Command shape:

```powershell
node .\mcp-server\server.mjs
.\scripts\test-local.ps1 -MockWorkerSmoke
```

Observed result:

```json
{
  "ok": true,
  "mockWorkerSmoke": true
}
```

## 2026-07-06 ChatGPT Web MCP Smoke

Status in that local run: blocked.

Blocking conditions:

- The real local MCP protocol smoke passes, including initialize, tool discovery, `cc_ping`, mock `cc_plan_task`, returned `runId`, and exact `cc_get_result` retrieval.
- `tunnel-client` is not installed in this environment.
- No OpenAI Platform tunnel ID or runtime API key has been provided.
- ChatGPT developer-mode app creation requires user-side account and browser interaction.

Next validation step:

1. Obtain an OpenAI Platform tunnel ID, runtime API key, and the required tunnel permissions.
2. Install `tunnel-client` from the official OpenAI source.
3. Run `.\scripts\start-mcp.ps1`.
4. Initialize and run `.\scripts\start-openai-tunnel.ps1`.
5. Create the ChatGPT developer-mode app with connection type **Tunnel**.
6. Use a bounded target such as `workspace/gpt_mcp_python_cli_smoke_<date>/`.
7. Verify the exact returned `runId` with `cc_get_result`, `summary.ps1`, `ledger.ps1`, and the generated project tests.

## 2026-07-11 Protocol and Provider Validation

Passed locally:

- MCP initialize and tool discovery.
- `cc_ping`.
- Mock read-only `cc_plan_task` with an exact returned `runId`.
- Exact and `latest` `cc_get_result` retrieval.
- Mock approved `cc_run_approved_task` with write-capable tool annotations and `mode = run`.
- Bridge-level `maxBudgetUsd = 0.10`, independent of the larger local wrapper default.

Real provider status:

- One real read-only plan through MCP timed out after 120 seconds.
- One direct wrapper control run also timed out after 120 seconds.
- Both normalized to `worker_timeout`; neither run reported a cost or useful artifact.
- Because MCP and direct execution failed identically, current evidence points to the local Claude Code provider, authentication, model mapping, or non-interactive provider state rather than MCP transport.
- Do not claim the domestic-model real-worker gate until the provider canary succeeds again.

## 2026-07-12 Alpha Baseline Follow-up

The operator subsequently confirmed outside this Codex session:

- The DeepSeek Anthropic-compatible endpoint returned `OK`.
- Claude Code directly using `deepseek-v4-flash` returned `OK`.
- Real Harness plan and write runs passed.
- The real MCP read-only route passed.
- The default MCP budget was raised to `$0.20`.

Current automated checks passed:

- Harness smoke, including a regression where exit code 0 plus non-empty `blocked_on` must normalize to non-success.
- MCP initialize, tool discovery, ping, mock plan, exact result lookup, mock approved run, and latest result lookup.
- Node syntax checks, JSON parsing, skill validation, harness verification, documentation hygiene, and `git diff --check`.
- Candidate release-file scan found no local absolute paths, private keys, obvious API key values, or concrete tunnel domains.

Protocol validation now has independent paid-worker switches:

```powershell
.\scripts\test-mcp-protocol.ps1 -RealPlan -MaxBudgetUsd 0.20
.\scripts\test-mcp-protocol.ps1 -RealWrite -MaxBudgetUsd 0.20
```

The real write smoke creates a unique marker under ignored `workspace/`, verifies the exact contents, and removes it. In this Codex session the route reached the Harness but normalized to `environment_failed` because `claude` was not present on this session's `PATH`; no provider diagnosis was repeated and no paid call was made. A successful real MCP write remains an explicit release gate.

At that point, Secure MCP Tunnel and ChatGPT Developer mode end-to-end validation were still pending; the later result is recorded below. The durable asynchronous orchestrator described in `docs/v0.2-roadmap.md` remains the product architecture, while the current Bridge is a synchronous Alpha foundation.

## 2026-07-12 ChatGPT Web Secure Tunnel Validation

The operator completed the real read-only path:

```text
ChatGPT Web -> OpenAI Secure MCP Tunnel -> tunnel-client v0.0.10
-> local loopback MCP Bridge -> Harness -> Claude Code
```

Verified evidence:

- The Tunnel was associated with the intended Personal organization and Personal ChatGPT workspace.
- ChatGPT discovered the MCP tools through a no-auth Tunnel profile.
- A real `cc_plan_task` completed with run ID `20260712-132815-320`.
- Reported cost was `$0.176357` under a `$0.20` maximum.
- `files_read`, `commands_run`, and `tests_or_checks` were recorded, and no file modification was reported.

This passes the read-only synchronous Alpha end-to-end gate. It does not prove unattended asynchronous execution or runtime approval/resume.

Follow-up hardening implemented after the validation:

- Tunnel initialization auto-selects the no-auth sample when local MCP authentication is disabled.
- The known no-auth OAuth discovery 404 from tunnel-client v0.0.10 is tolerated narrowly; `/readyz` is exposed as the authoritative runtime check.
- Native Claude stdout is forced through UTF-8, and a fixture verifies exact Chinese text plus Unicode punctuation through the full local artifact chain.
- Non-strict output recovery now returns `worker_failed` with `audit_validation_failed` instead of success.
- Real plan/review runs require at least one read, command, or check evidence item; real run mode requires non-empty `changes_made` and `tests_or_checks` reports.
- Real write smoke snapshots files and directories and rejects undeclared new, changed, deleted, or empty-directory side effects.
- File-only prompts prohibit Bash and Windows drive-letter paths; workers are instructed to use project-relative forward-slash paths when Bash/MSYS is unavoidable.

The write-capable ChatGPT path remains supervised Alpha until the hardened real write smoke passes again after restarting the MCP Bridge.

### Hardened real worker follow-up

The hardened checks then passed through the already-running MCP Bridge:

- Real write run: `20260712-154831-968`
- Reported cost: `$0.036021`
- Exact marker content verified and removed.
- `changes_made` and `tests_or_checks` were populated.
- The before/after filesystem guard found no undeclared files, changes, deletions, or directories.
- No malformed U+F03A drive-letter directory was present after the run.

A second real read-only plan verified the encoding fix with an exact Unicode assertion:

- Real plan run: `20260712-154930-356`
- Reported cost: `$0.035912`
- Exact marker containing Chinese text, curly quotes, and an em dash was preserved byte-for-byte.
- `files_read` was populated and no changes were reported.

These results pass the hardened synchronous read and bounded-write gates. Write mode remains supervised because the current product still lacks the durable asynchronous approval and recovery layer.
