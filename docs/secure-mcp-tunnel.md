# Connect ChatGPT through OpenAI Secure MCP Tunnel

[English](secure-mcp-tunnel.md) | [简体中文](secure-mcp-tunnel.zh-CN.md)

Use OpenAI Secure MCP Tunnel as the default remote path for this project. The MCP bridge remains bound to `127.0.0.1`; `tunnel-client` creates an outbound HTTPS connection to OpenAI and forwards MCP requests back to the local bridge. This avoids publishing the write-capable MCP endpoint on the internet.

## What the Tunnel exposes

The Tunnel transports MCP JSON-RPC requests only to the configured local MCP endpoint. It does not publish the Dashboard port, create a general-purpose network proxy, or grant direct filesystem access. Local file and command capabilities remain behind the existing Project Registry, Workflow approval, Resource Profile, side-effect, and audit boundaries.

The MCP surface can include write-capable Supervisor tools. Treat the Tunnel runtime key, Tunnel association, ChatGPT app permissions, and local approval checkpoint as separate controls; possession of one does not replace the others.

Official references:

- [Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
- [ChatGPT developer mode and MCP apps](https://help.openai.com/en/articles/12584461-developer-mode-and-full-mcp-connectors-in-chatgpt-beta)

## Requirements

- A ChatGPT plan and workspace configuration that supports the required MCP actions.
- ChatGPT developer-mode access.
- An OpenAI Platform tunnel with the required Read, Manage, and Use permissions.
- A tunnel runtime API key.
- `tunnel-client` installed on the machine that runs this project.
- Local Claude Code configured to use the intended compatible model provider.

Do not commit the runtime API key, local Claude provider configuration, MCP `config.json`, or tunnel-client profiles.

## Start the local bridge

Complete the repository setup once, then start the supported product entrypoint in one PowerShell terminal:

```powershell
.\install.ps1
.\start.ps1
```

On later runs, only `.\start.ps1` is required. The Bridge must remain on `127.0.0.1`. The startup output prints the Dashboard URL and local MCP endpoint. Use `.\start.ps1 -CheckOnly` for a non-starting configuration check.

For the complete clone-to-first-Workflow path, see [Getting started from zero on Windows](getting-started-from-zero.md).

## Initialize and run tunnel-client

Set the runtime API key only in the current operator environment:

```powershell
$env:CONTROL_PLANE_API_KEY = '<runtime-api-key>'
```

In a second terminal, initialize a named profile once:

```powershell
.\scripts\start-openai-tunnel.ps1 `
  -Initialize `
  -Profile codex-claude-worker-noauth `
  -TunnelId '<tunnel-id>' `
  -DoctorOnly
```

The script reads `mcp-server/config.json`. When `requireAuth` is false or absent, it initializes `sample_mcp_remote_no_auth`; authenticated configurations use `sample_mcp_with_dcr`. Inspect the resolved choice without changing a profile:

```powershell
.\scripts\start-openai-tunnel.ps1 -PrintConfiguration
```

If the OpenAI control plane requires a proxy, set it in the operator environment rather than committing it. The wrapper checks `CONTROL_PLANE_HTTP_PROXY`; standard command-line tools may also require `HTTP_PROXY` and `HTTPS_PROXY`:

```powershell
$env:CONTROL_PLANE_HTTP_PROXY="http://127.0.0.1:<proxy-port>"
$env:HTTP_PROXY="http://127.0.0.1:<proxy-port>"
$env:HTTPS_PROXY="http://127.0.0.1:<proxy-port>"
```

Then start the long-running tunnel client:

```powershell
.\scripts\start-openai-tunnel.ps1 -Profile codex-claude-worker-noauth
```

In tunnel-client v0.0.10, `doctor` may report a false failure when a no-auth HTTP MCP endpoint correctly returns 404 for `/.well-known/oauth-protected-resource/mcp`. The wrapper tolerates only that specific no-auth discovery mismatch. After `run` starts, use the runtime readiness endpoint as the authoritative check:

```powershell
.\scripts\start-openai-tunnel.ps1 -ReadyOnly
```

`/readyz` must return HTTP 200. Other doctor failures remain fatal.

Keep both the MCP bridge and tunnel client running while testing ChatGPT.

## Stop and disconnect

1. Press `Ctrl+C` in the `tunnel-client` terminal to stop the remote MCP transport.
2. Press `Ctrl+C` in the Bridge terminal to stop the local MCP endpoint and Dashboard.
3. Disable or remove the ChatGPT draft app when the connection is no longer needed.
4. Revoke or rotate the Tunnel runtime key when decommissioning the setup.

Closing ChatGPT Web does not stop either local process. A configured ChatGPT app may remain visible after the client stops, but calls fail until a healthy authorized client reconnects.

## Connect from ChatGPT

In ChatGPT developer mode, create an app and choose **Tunnel** as the connection type. Select the tunnel associated with the target ChatGPT workspace, scan the tools, and verify that these tools appear:

- `cc_ping`
- `cc_list_projects`
- `cc_get_project_context`
- `cc_get_project_continuity`
- `cc_list_workflow_definitions`
- `cc_create_workflow`
- `cc_get_workflow`
- `cc_approve_workflow`
- `cc_get_supervisor_review_package`

Start with `cc_ping`, then name the target registered Project and ask ChatGPT Supervisor to discover Projects, resolve the exact `projectId`, read its Project Context and Continuity, discover legal Workflow Definitions, and create a Project-bound Workflow. A Project name or `workspace/` directory is only a discovery hint; ChatGPT must not construct `workspacePath` from an absolute or guessed path. The Planner remains read-only. A write-capable stage must remain at the human checkpoint until the user explicitly approves it.

The standalone `cc_plan_task`, `cc_review_task`, and `cc_run_approved_task` tools remain available for compatibility, but they are not the recommended first-run Supervisor workflow. `cc_run_approved_task` does not approve or advance a Workflow.

## Public tunnel fallback

`scripts/start-ngrok.ps1` is retained only for isolated compatibility experiments. It creates public ingress and does not add application authentication. It is not the supported ChatGPT deployment path and now requires an explicit acknowledgement of the risk.
