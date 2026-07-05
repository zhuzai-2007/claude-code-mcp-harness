# Codex-Claude Worker Harness

Local worker harness plus MCP bridge for running Claude Code worker tasks through fixed, policy-gated PowerShell scripts.

## Local Setup

Initialize local MCP config:

```powershell
.\scripts\init-config.ps1
```

Check local prerequisites:

```powershell
.\scripts\doctor.ps1
```

Install Node dependencies if needed:

```powershell
cd .\mcp-server
npm install
cd ..
```

## Start MCP Bridge

From the project root:

```powershell
.\scripts\start-mcp.ps1
```

This runs `node .\mcp-server\server.mjs` in the foreground. Press `Ctrl+C` to stop it.

## Expose Through ngrok

In another terminal:

```powershell
.\scripts\start-ngrok.ps1
```

The wrapper keeps the local host-header details inside `scripts/start-ngrok.ps1`.

Use this ChatGPT MCP URL format:

```text
https://example.invalid
```

The ngrok endpoint is public while the tunnel is active. Only expose the bridge in trusted sessions.

## Test

With the MCP bridge already running:

```powershell
.\scripts\test-local.ps1
```

This checks `/health`, `.agents/summary.ps1`, and a short read-only plan task.

## ChatGPT Supervisor Protocol

For ChatGPT web usage, the user can describe a high-level goal instead of manually writing MCP tool parameters. The default supervisor protocol is documented in [docs/supervisor-usage.md](docs/supervisor-usage.md).

In short: small isolated tasks that only create files under a new `workspace/<new-dir>/` may be auto-run through `cc_run_approved_task`; core-file edits, existing project edits, dependency installs, networking, deletion, git operations, long tasks, or ambiguous write boundaries require a second user confirmation.

For third-party or domestic-model adapters, `MaxBudgetUsd` is an estimated Claude Code/wrapper budget and may not equal actual API billing. The default is conservative at `0.10`, and the portable wrapper rejects values above `5.00`. Set local defaults in `.agents/local.config.json`, for example `maxBudgetUsd` around `1.00`, and do not commit that file. Cost control should also rely on task splitting, `WorkerTimeoutSeconds`, narrow file scope, no networking, no dependency installation, and no git operations. Live worker tests should be run by the user in a real PowerShell terminal, not by Codex or another patch agent.

## Safety Boundary

The MCP bridge is a Claude Code harness bridge, not a general shell or file server. It only calls the existing allowlisted harness scripts:

- `.agents/claude-task.ps1`
- `.agents/summary.ps1`

It does not expose generic shell execution, arbitrary file read/write, or delete tools.

`cc_run_approved_task` is write-capable and should only be exposed in trusted sessions. The current `requireAuth` config field is not implemented and does not provide real authentication.
