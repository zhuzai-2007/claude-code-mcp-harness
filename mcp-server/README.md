# Codex-Claude Worker MCP Bridge

Minimal MCP Streamable HTTP bridge for the local `.agents` PowerShell harness.

This is a Claude Code harness bridge, not a general shell server, filesystem server, or raw Claude CLI wrapper. It exposes only fixed MCP tools that call the allowlisted harness scripts:

- `.agents/claude-task.ps1`
- `.agents/summary.ps1`

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

Default bind address is `127.0.0.1:8787`.

## Local Checks

Health check:

```powershell
Invoke-RestMethod http://127.0.0.1:8787/health
```

The MCP endpoint is:

```text
http://127.0.0.1:8787/mcp
```

`/health` returns normal JSON. `/mcp` is MCP Streamable HTTP only. `GET /mcp` returns `405` and never returns fake health output.

## Tools

- `cc_ping`: checks project root and harness script presence.
- `cc_plan_task`: calls `claude-task.ps1 plan -Task ...`.
- `cc_review_task`: calls `claude-task.ps1 review -Task ...`.
- `cc_run_approved_task`: calls `claude-task.ps1 run -Task ... -ApprovedBy ... -ApprovalReason ...`.
- `cc_get_latest_summary`: calls `summary.ps1 -RunId latest -IncludeIncomplete`.
- `cc_get_result`: reads the latest `worker-result.normalized.json`; v1 only accepts `runId = "latest"`.

Recommended first tool sequence:

1. `cc_ping`
2. `cc_plan_task`
3. `cc_get_latest_summary`
4. `cc_get_result` with `runId: "latest"`

## ChatGPT + ngrok

Expose the local server:

```powershell
.\scripts\start-ngrok.ps1
```

That script runs:

```powershell
ngrok http --host-header=127.0.0.1:8787 8787
```

In ChatGPT MCP settings, use:

```text
https://example.invalid
```

When ngrok is running, this local MCP endpoint is public for the lifetime of the tunnel. Only expose it in trusted sessions.

`cc_run_approved_task` is write-capable because it invokes harness `run` mode. Only expose it in trusted sessions. Safer mode: remove `defaultApprovedBy` and `defaultApprovalReason` from `config.json`, then provide explicit `approvedBy` and `approvalReason` on every write-capable call.

## Configuration

Copy `config.example.json` to `config.json` and adjust it locally. Do not commit a real `config.json`; it may contain local paths and temporary ngrok origins.

```json
{
  "projectRoot": "D:/path/to/project",
  "workerTimeoutSeconds": 300,
  "defaultApprovedBy": "local-user",
  "defaultApprovalReason": "User explicitly approved this run through ChatGPT MCP.",
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

`requireAuth` may appear in local config files, but it is not implemented in v0.1 and does not provide real authentication. Do not rely on it as an access control boundary.

There is no authentication layer in v0.1. Keep the bridge bound to `127.0.0.1` locally and treat any ngrok URL as a temporary public endpoint.

The current implementation strips a UTF-8 BOM when reading JSON config/result files. This keeps PowerShell-edited JSON usable.

## Process I/O

`claude-task.ps1` is spawned with `stdio: inherit`. This is intentional: Claude Code can hang in a Node pipe environment in some auth, trust, permission, or terminal-interaction paths.

`summary.ps1` still uses piped stdout/stderr so the bridge can capture summary output and return it through MCP.

## Local Test

With the MCP bridge already running:

```powershell
.\scripts\test-local.ps1
```

This checks `/health`, runs `summary.ps1 -RunId latest -IncludeIncomplete`, and performs one short read-only `plan` task through the existing harness.

## Safety Boundary

This MCP server is a Claude Code harness bridge, not a sandbox and not a general command runner. It only spawns PowerShell with argument arrays for the allowlisted harness scripts, with `cwd` fixed to `projectRoot`. All internal paths are resolved and checked under `projectRoot`.

The existing harness policy, approval gate, normalized results, timeout handling, and run summaries remain responsible for worker behavior.
