# Codex-Claude Worker MCP Bridge

Minimal MCP Streamable HTTP bridge for the local `.agents` PowerShell harness. Keep it bound to loopback and use OpenAI Secure MCP Tunnel for ChatGPT access.

This is a Claude Code harness bridge, not a general shell server, filesystem server, or raw Claude CLI wrapper. It exposes only fixed MCP tools that call the allowlisted harness scripts:

- `.agents/claude-task.ps1`
- `.agents/summary.ps1`
- `.agents/ledger.ps1`

It does not expose generic `exec_shell`, `run_powershell`, `write_file`, `read_file`, or `delete_file` tools.

## Install

From `mcp-server/`:

```powershell
npm install
```

From the project root, initialize local config without overwriting an existing `config.json`:

```powershell
.\scripts\init-config.ps1
```

Run local diagnostics:

```powershell
.\scripts\doctor.ps1
```

## Start

From the project root:

```powershell
.\scripts\start-mcp.ps1
```

From `mcp-server/`:

```powershell
node .\server.mjs
```

Default bind host and port are configured in `config.json`. The default local port is `8787`.

## Local Checks

Health check:

```powershell
Invoke-RestMethod http://<local-bind-host>:<local-port>/health
```

The MCP endpoint is:

```text
http://<local-bind-host>:<local-port>/mcp
```

`/health` returns normal JSON. `/mcp` is MCP Streamable HTTP only. `GET /mcp` returns `405` and never returns fake health output.

## Tools

- `cc_ping`: checks project root and harness script presence.
- `cc_plan_task`: calls `claude-task.ps1 plan -Task ...`.
- `cc_review_task`: calls `claude-task.ps1 review -Task ...`.
- `cc_run_approved_task`: calls `claude-task.ps1 run -Task ... -ApprovedBy ... -ApprovalReason ...`.
- `cc_get_latest_summary`: calls `summary.ps1 -RunId latest -IncludeIncomplete`.
- `cc_get_ledger`: calls `ledger.ps1 -Tail <n> -Json` and returns recent project-ledger entries.
- `cc_get_result`: reads `worker-result.normalized.json` by an exact run ID, or accepts `runId = "latest"` for operator convenience. It returns the complete normalized `summary`; the Bridge does not apply the Harness stdout preview limit to this artifact response.

Recommended first tool sequence:

1. `cc_ping`
2. `cc_plan_task`
3. `cc_get_latest_summary`
4. `cc_get_result` with `runId: "latest"`
5. `cc_get_ledger`

`cc_plan_task`, `cc_review_task`, and `cc_run_approved_task` accept optional `mockWorker: true`. This passes `-MockWorker` to the harness so the bridge can validate MCP transport, PowerShell invocation, run records, summaries, and normalized results without invoking Claude Code. Defaults remain unchanged.

## ChatGPT + OpenAI Secure MCP Tunnel

Do not expose port 8787 directly. Keep the bridge running locally and follow `docs/secure-mcp-tunnel.md` from the repository root. The supported path uses `tunnel-client` to establish outbound HTTPS to OpenAI while the MCP bridge remains private.

After the profile has been initialized, run:

```powershell
.\scripts\start-openai-tunnel.ps1 -Profile codex-claude-worker
```

`cc_run_approved_task` is write-capable because it invokes harness `run` mode. Keep default approval fields unset and provide explicit audit metadata on every write-capable call. ChatGPT workspace permissions and action confirmations do not turn this harness into an OS sandbox.

The legacy `start-ngrok.ps1` wrapper is retained only for isolated compatibility experiments. It requires an explicit risk acknowledgement because it creates unauthenticated public ingress.

For ChatGPT web validation, follow `docs/real-world-validation.md` from the repository root and use a distinct bounded `workspace/<task-id>/` directory for each test.

## Configuration

Copy `config.example.json` to `config.json` and adjust it locally. Do not commit a real `config.json`; it may contain local paths.

```json
{
  "projectRoot": "D:/path/to/your/project",
  "workerTimeoutSeconds": 300,
  "maxBudgetUsd": 0.20,
  "defaultApprovedBy": null,
  "defaultApprovalReason": null,
  "host": "127.0.0.1",
  "port": 8787,
  "stdoutLimit": 12000,
  "stderrLimit": 12000,
  "allowedOrigins": [
    "https://chatgpt.com",
    "https://chat.openai.com"
  ]
}
```

If an HTTP `Origin` header is present, the bridge validates it. Localhost origins are allowed; other origins must appear in `allowedOrigins`.

There is no application authentication layer in the local bridge. Keep it bound to a local interface and use OpenAI Secure MCP Tunnel or an independently authenticated reverse proxy for remote access.

Every task tool accepts an optional `maxBudgetUsd` capped at `5.00`. The bridge default is `0.20`, independent of a larger project-local Claude wrapper default.

The current implementation strips a UTF-8 BOM when reading JSON config/result files. This keeps PowerShell-edited JSON usable.

## Process I/O

`claude-task.ps1` inherits the Bridge process stdio because some Claude Code provider/authentication paths can stall behind Node pipes. The Bridge assigns the run ID before spawning the Harness and reads the normalized result from the matching run directory. Summary and ledger scripts use piped stdout/stderr.

## Local Test

With the MCP bridge already running:

```powershell
.\scripts\test-local.ps1
```

This checks `/health`, runs `summary.ps1 -RunId latest -IncludeIncomplete`, and performs one short read-only `plan` task through the existing harness.

For a real MCP initialize/list-tools/tool-call exchange without invoking Claude Code:

```powershell
.\scripts\test-mcp-protocol.ps1
```

Use `-RealPlan` and `-RealWrite` independently after the configured Claude Code provider is healthy. Both default to a maximum budget of `$0.20`; the write smoke creates, verifies, and removes a unique marker under the ignored `workspace/` directory.

The real write smoke snapshots the project before and after the call. Outside the declared marker and known Harness runtime directories, any new directory, new file, modification, or deletion fails the smoke. This includes an empty malformed directory created when a Windows drive-letter path is incorrectly passed through Bash/MSYS.

## Safety Boundary

This MCP server is a Claude Code harness bridge, not a sandbox and not a general command runner. It only spawns PowerShell with argument arrays for the allowlisted harness scripts, with `cwd` fixed to `projectRoot`. All internal paths are resolved and checked under `projectRoot`.

The existing harness policy, approval gate, normalized results, timeout handling, and run summaries remain responsible for worker behavior.

Every completed worker run appends local runtime audit data to `.agent-runs/project-ledger.jsonl`. This ledger is intended for supervisor review and large-task decomposition; it is not a security log.

Real Worker runs also persist `claude-events.jsonl` and a normalized `tool-events.json`. The latter cross-checks Worker self-reporting against successful Claude Code tool events, including observed commands, permission denials, and read/write/edit targets. Because this depends on `server.mjs` and Harness changes, an already-running Bridge must be restarted in an operator-approved maintenance window before ChatGPT uses the new behavior.
