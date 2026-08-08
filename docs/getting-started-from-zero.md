# Getting started from zero on Windows

This guide starts with a Windows machine that has Git and Claude Code, but no Node.js or local Supervisor configuration. It ends with a first Project-bound Workflow created from ChatGPT Web.

Supervisor is local-first: the Bridge, Dashboard, project files, execution evidence, and approval checkpoint remain on this computer. OpenAI Secure MCP Tunnel is an outbound transport that lets supported ChatGPT workspaces reach the local MCP Bridge without publishing the Bridge directly on the internet.

## 1. Confirm account and machine prerequisites

You need:

- Windows PowerShell and Git;
- Node.js 20 or newer, including npm;
- Claude Code CLI installed and configured for the intended model provider;
- a ChatGPT account or workspace with developer mode, custom MCP apps, and the actions this project needs;
- access to OpenAI Platform tunnel settings, a Tunnel id, a tunnel runtime key, and `tunnel-client`.

Having ChatGPT Web access alone does not guarantee full custom-MCP or write-action availability. At the time of this release candidate, OpenAI documents full MCP write actions for supported Business and Enterprise/Edu workspaces, while other plans may have reduced or no access. Check the current [ChatGPT developer mode and MCP app availability](https://help.openai.com/en/articles/12584461-developer-mode-and-full-mcp-connectors-in-chatgpt-beta) before installing. The local Dashboard can run without a Tunnel, but the ChatGPT Supervisor path requires the applicable ChatGPT and Platform permissions.

If Node.js is not installed, install a current Node.js 20+ release from the [official Node.js download page](https://nodejs.org/en/download), reopen PowerShell, and verify:

```powershell
node --version
npm --version
claude --version
```

If you already use nvm for Windows, select an installed Node.js 20+ version with `nvm use <version>` before continuing.

## 2. Clone and install

```powershell
git clone https://github.com/zhuzai-2007/claude-code-mcp-harness.git supervisor
Set-Location supervisor
.\install.ps1
```

`install.ps1` performs two local setup steps:

1. it creates ignored `mcp-server/config.json` from the checked-in placeholder and sets `projectRoot` to this checkout;
2. it runs `npm ci` against `mcp-server/package-lock.json`.

Do not add provider keys, Tunnel ids, proxy credentials, or private project paths to the generated JSON file.

If PowerShell blocks local scripts, use a process-only policy for the current terminal:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
```

Then rerun `.\install.ps1`.

## 3. Check the local Runtime

Run the non-billable setup checks:

```powershell
.\scripts\doctor.ps1
.\start.ps1 -CheckOnly
```

Doctor must report the required Node, npm, Claude CLI, dependency, configuration, policy, Resource Profile, Workflow, and Project checks as OK. Before startup, warnings that the Bridge or Tunnel is not running are expected.

Provider connectivity is a separate, optional check that can incur the provider's minimum request cost:

```powershell
.\scripts\doctor.ps1 -ProviderPreflight
```

## 4. Start the Bridge and Dashboard

Keep this PowerShell terminal open:

```powershell
.\start.ps1
```

The script prints:

- the loopback Dashboard URL;
- the loopback MCP endpoint;
- the configured workspace root.

The Bridge must remain bound to `127.0.0.1`. Do not expose its port with router forwarding, an unauthenticated reverse proxy, or a public development tunnel.

## 5. Create and start OpenAI Secure MCP Tunnel

Follow the current [OpenAI Secure MCP Tunnel guide](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels) to:

1. create a Tunnel in OpenAI Platform;
2. associate it with the intended Platform organization and ChatGPT workspace;
3. obtain Tunnels Read, Manage, and Use permissions as applicable;
4. download the latest `tunnel-client` and place it on `PATH`;
5. create a runtime API key.

Verify the client in a new PowerShell terminal:

```powershell
tunnel-client help quickstart
```

Set the runtime key only for that terminal:

```powershell
$env:CONTROL_PLANE_API_KEY="<tunnel-runtime-key>"
```

If command-line programs require a local proxy:

```powershell
$env:HTTP_PROXY="http://127.0.0.1:<proxy-port>"
$env:HTTPS_PROXY="http://127.0.0.1:<proxy-port>"
```

Initialize the local profile once, using the Tunnel id from Platform:

```powershell
.\scripts\start-openai-tunnel.ps1 `
  -Initialize `
  -TunnelId "<tunnel-id>" `
  -DoctorOnly
```

Then start the long-running client:

```powershell
.\scripts\start-openai-tunnel.ps1
```

Leave both the Bridge terminal and Tunnel terminal open. In another terminal, readiness can be checked with:

```powershell
.\scripts\start-openai-tunnel.ps1 -ReadyOnly
```

## 6. Add the MCP app in ChatGPT Web

ChatGPT settings and plan availability can change, so use the current official developer-mode guide as the source of truth. In the supported ChatGPT workspace:

1. enable developer mode;
2. create a custom app;
3. choose **Tunnel** as the connection type;
4. select the Tunnel associated with this workspace;
5. scan tools and create the draft app.

Confirm at least these Supervisor tools appear:

- `cc_ping`
- `cc_list_projects`
- `cc_get_project_context`
- `cc_get_project_continuity`
- `cc_list_workflow_definitions`
- `cc_create_workflow`
- `cc_get_workflow`
- `cc_get_supervisor_review_package`

Start a new chat with the draft app enabled and ask:

> List the registered Projects and supported Workflow Definitions. Then prepare a Workflow to add CSV export to the release demo. Do not start a write-capable stage without explicit human approval.

Real Planner, Coder, and Reviewer stages call the configured model provider and may incur provider charges. Resource Profiles enforce local safety limits, but their estimates are not a billing guarantee.

Expected sequence:

```text
Project discovery
  -> Workflow Definition discovery
  -> Supervisor Decision
  -> read-only Planner
  -> human approval in the Dashboard
  -> Coder
  -> Claude Reviewer
  -> Supervisor Review Package
```

The user should not need to provide a filesystem path, Resource Profile, Worker prompt, or audit JSON schema.

## 7. Stop safely

1. Press `Ctrl+C` in the Tunnel terminal. This stops the remote request path.
2. Press `Ctrl+C` in the Bridge terminal. This stops the local Dashboard and MCP endpoint.
3. Disable or remove the draft app in ChatGPT when it is no longer needed.
4. Revoke or rotate the Tunnel runtime key when decommissioning the setup.

Stopping the browser alone does not stop the local Runtime or `tunnel-client`.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| `node` is not found | Install/select Node.js 20+, reopen PowerShell, rerun Doctor. |
| `npm ci` cannot reach the registry | Configure command-line `HTTP_PROXY` / `HTTPS_PROXY`; browser connectivity is not proof of CLI connectivity. |
| Doctor cannot find Claude | Confirm `claude --version` works in the same terminal. |
| Tunnel is absent in ChatGPT | Verify workspace association and Tunnels Read + Use permissions. |
| Tunnel readiness fails | Keep the Bridge running, run the wrapper with `-PrintConfiguration`, then rerun Tunnel doctor. |
| Tools changed after app creation | Refresh or recreate the draft app so ChatGPT scans the current MCP tool definitions. |
| A Workflow waits | Open the Dashboard and inspect the current stage; write-capable work requires explicit approval. |

For deeper configuration and security boundaries, see [Configuration and secrets](configuration.md), [Secure MCP Tunnel](secure-mcp-tunnel.md), and [Using Supervisor from ChatGPT Web](gpt-web-usage.md).
