# Real-World Validation

This document records bounded Alpha evidence, not a production-readiness claim. Claude tool auditing is event-level evidence and is not an operating-system audit trail.

## 2026-07-12 Supervised MCP Dogfood

The restarted Bridge loaded the event-auditing Harness and was exercised through ChatGPT Web and Secure MCP Tunnel.

- Plan run `20260712-233746-750` reported Glob use while the independent stream showed Read. The Harness rejected it with `unverifiable_check_evidence`, demonstrating conservative mismatch handling.
- Approved creation run `20260712-234124-202` completed with `observed_tools = [Read, Edit]`, no observed shell commands, no permission denials, and no audit issues.
- The bounded local result created only `workspace/dogfood-study-board/index.html`, `styles.css`, and `app.js`. These ignored dogfood files are not release artifacts.
- Browser checks covered adding and deleting tasks, complete/incomplete transitions, filters, overdue state, localStorage persistence, Chinese UI, responsive layout, and safe text rendering of HTML-like user input.
- A later supervised natural-language iteration added and verified a clear-completed action.

This validates one real creation and one follow-up iteration. It does not add a persistent task queue, background recovery, or asynchronous approval system.

This project uses mock tests for default regression checks and separate real-worker tests for capability validation.

## Natural-Language Worker Smokes

The main validation path is ordinary prompts translated by Codex into bounded worker tasks. OJ or algorithm tasks are only sanity checks.

Recommended prompt classes:

- local CLI tool
- static browser prototype
- existing-script refactor
- fix from error log
- README/project documentation

For each smoke, record the raw prompt, translated worker prompt, run id, fix run ids, supervisor checks, boundary violations, and result in `docs/natural-language-smoke-results-clean.md`.

For documentation outputs, run:

```powershell
.\scripts\scan-doc-hygiene.ps1
```

Do not mark documentation smoke output as release-ready if it contains mojibake, real local paths, local usernames, token-looking strings, or real tunnel URLs.

## Local Claude Code Python CLI Smoke

Use a bounded worker run that creates only `workspace/cc_python_cli_smoke_<date>/`.

Required worker boundaries:

```text
Only create or modify files under workspace/cc_python_cli_smoke_<date>/.
Do not modify .agents/, mcp-server/, scripts/, .git/, config files, package files, or lockfiles.
Do not access the network.
Do not install dependencies.
Do not delete files outside workspace/cc_python_cli_smoke_<date>/.
Do not run git commands.
Return concise JSON with summary, files_read, changes_made, commands_run, tests_or_checks, risks, blocked_on.
```

Supervisor checks:

```powershell
.\.agents\summary.ps1 -RunId latest -IncludeIncomplete
.\.agents\ledger.ps1 -Tail 5
python .\workspace\cc_python_cli_smoke_<date>\run_tests.py
```

If validation fails, start a separate bounded fix run. Do not patch the worker output directly during the smoke.

In Codex-managed environments, Python tests that delete temporary files or write `__pycache__` may fail because of sandbox filesystem permissions. Prefer final real-worker validation in a normal local PowerShell terminal and set `PYTHONDONTWRITEBYTECODE=1` for smoke tests.

## ChatGPT Web MCP Smoke

1. Start the local bridge:

   ```powershell
   .\scripts\start-mcp.ps1
   ```

2. Confirm the real MCP protocol path locally:

   ```powershell
   .\scripts\test-mcp-protocol.ps1
   ```

   After the provider canary is healthy, repeat with one bounded real read-only call:

   ```powershell
   .\scripts\test-mcp-protocol.ps1 -RealPlan -MaxBudgetUsd 0.20
   ```

   Validate the write route separately. It writes a unique marker under ignored `workspace/`, verifies the exact contents, and removes it:

   ```powershell
   .\scripts\test-mcp-protocol.ps1 -RealWrite -MaxBudgetUsd 0.20
   ```

3. In another terminal, start the configured OpenAI Secure MCP Tunnel profile:

   ```powershell
   $env:CONTROL_PLANE_API_KEY = '<runtime-api-key>'
   .\scripts\start-openai-tunnel.ps1 -Profile codex-claude-worker-noauth
   ```

4. In ChatGPT developer mode, create an app, choose **Tunnel**, and select the associated tunnel ID.

5. Ask ChatGPT web to use the tool sequence:

   ```text
   cc_ping -> cc_plan_task or cc_run_approved_task -> cc_get_latest_summary -> cc_get_result -> cc_get_ledger
   ```

6. Use a distinct target directory such as `workspace/gpt_mcp_python_cli_smoke_<date>/`.

Do not commit real local `config.json`, runtime API keys, tunnel profiles, logs, or runtime ledger files.

If `tunnel-client`, a tunnel ID, the required Platform permissions, or ChatGPT developer-mode access is unavailable in another environment, its web gate remains unverified. Mock MCP tests do not replace this web smoke.

Summarize completed validation runs in `docs/validation-results.md`.

## Validation Log Template

```text
Date:
Path:
Mode: local-claude-code | chatgpt-web-mcp
Run id:
Worker status:
Ledger checked: yes | no
Independent tests:
Boundary violations:
Fix runs:
Result:
Notes:
```
