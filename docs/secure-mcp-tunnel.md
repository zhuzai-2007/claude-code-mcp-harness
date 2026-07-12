# Connect ChatGPT through OpenAI Secure MCP Tunnel

Use OpenAI Secure MCP Tunnel as the default remote path for this project. The MCP bridge remains bound to `127.0.0.1`; `tunnel-client` creates an outbound HTTPS connection to OpenAI and forwards MCP requests back to the local bridge. This avoids publishing the write-capable MCP endpoint on the internet.

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

In one PowerShell terminal:

```powershell
.\scripts\init-config.ps1
.\scripts\start-mcp.ps1
```

The bridge must remain on `127.0.0.1`. Confirm it locally:

```powershell
.\scripts\test-mcp-protocol.ps1
```

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

If the OpenAI control plane requires a proxy, set it in the operator environment rather than committing it:

```powershell
$env:CONTROL_PLANE_HTTP_PROXY = '<proxy-url>'
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

## Connect from ChatGPT

In ChatGPT developer mode, create an app and choose **Tunnel** as the connection type. Select the tunnel associated with the target ChatGPT workspace, scan the tools, and verify that these tools appear:

- `cc_ping`
- `cc_plan_task`
- `cc_review_task`
- `cc_run_approved_task`
- `cc_get_result`
- `cc_get_latest_summary`
- `cc_get_ledger`

Start with `cc_ping`, then a read-only `cc_plan_task`. Enable and test the write-capable action only after reviewing its input schema and confirmation behavior.

## Public tunnel fallback

`scripts/start-ngrok.ps1` is retained only for isolated compatibility experiments. It creates public ingress and does not add application authentication. It is not the supported ChatGPT deployment path and now requires an explicit acknowledgement of the risk.
