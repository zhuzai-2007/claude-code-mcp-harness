# Codex-Claude Worker Harness

Local worker harness plus MCP bridge for running Claude Code worker tasks through fixed, policy-gated PowerShell scripts.

This is a personal local workflow tool for trusted environments. Codex or ChatGPT remains the supervisor; Claude Code is only a bounded worker. This is not an OS sandbox.

The current release line is a synchronous Alpha foundation. The product direction is a ChatGPT Web control plane backed by a durable local orchestrator and replaceable Claude Code/provider adapters; see [the product roadmap](docs/v0.2-roadmap.md).

The ChatGPT Web -> Secure MCP Tunnel -> local Bridge -> Claude Code read-only path has been validated end to end. Write mode remains supervised Alpha and must pass the filesystem side-effect guard after every worker/provider change.

See [Supervised MCP Alpha release notes](docs/alpha-release-notes.md) for completed capabilities, safety boundaries, startup steps, and known limitations.

## Minimal Workflow

```powershell
.\.agents\doctor.ps1
.\.agents\claude-task.ps1 plan -Task "Return JSON with summary exactly ok." -MockWorker
.\.agents\claude-task.ps1 plan -Task "Inspect the requested bounded task and return a concise plan." -MaxBudgetUsd 0.20
.\.agents\claude-task.ps1 run -Task "Create or modify files only under workspace/<task-id>; no network, dependencies, git, or deletes." -ApprovedBy Codex -ApprovalReason "User approved this bounded worker run." -MaxBudgetUsd 0.50
.\.agents\summary.ps1 -RunId latest -IncludeIncomplete
.\.agents\ledger.ps1 -Tail 5
.\scripts\scan-doc-hygiene.ps1
```

After the worker run, the supervisor must inspect the changed files and run the smallest relevant local checks. The worker's own report is evidence, not the acceptance gate.

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

## Connect ChatGPT with Secure MCP Tunnel

Keep the MCP bridge bound to `127.0.0.1`. The supported remote path is OpenAI Secure MCP Tunnel, which creates an outbound connection instead of publishing this write-capable endpoint on the internet.

After obtaining a tunnel ID, runtime API key, and `tunnel-client`, validate the local profile:

```powershell
$env:CONTROL_PLANE_API_KEY = '<runtime-api-key>'
.\scripts\start-openai-tunnel.ps1 -Initialize -TunnelId '<tunnel-id>' -DoctorOnly
```

Then run `start-openai-tunnel.ps1` in a separate terminal and choose **Tunnel** when creating the developer-mode app in ChatGPT. See [docs/secure-mcp-tunnel.md](docs/secure-mcp-tunnel.md) for the complete operator flow and account requirements.

The legacy `start-ngrok.ps1` path is retained only for isolated compatibility experiments. It creates unauthenticated public ingress and requires an explicit risk acknowledgement.

## Test

With the MCP bridge already running:

```powershell
.\scripts\test-local.ps1
```

This checks `/health`, `.agents/summary.ps1`, and a short read-only plan task.

To start a temporary local bridge and exercise a real MCP client handshake, tool discovery, `cc_ping`, mock `cc_plan_task`, and exact `runId` retrieval:

```powershell
.\scripts\test-mcp-protocol.ps1
```

After the local Claude Code provider is known to be healthy, run the same protocol path with one bounded real read-only worker call:

```powershell
.\scripts\test-mcp-protocol.ps1 -RealPlan -MaxBudgetUsd 0.20
```

Real write validation is independent and creates, verifies, then removes a unique file under the ignored `workspace/` directory:

```powershell
.\scripts\test-mcp-protocol.ps1 -RealWrite -MaxBudgetUsd 0.20
```

To test the local harness path without calling Claude Code:

```powershell
.\scripts\test-local.ps1 -MockWorkerSmoke
```

## ChatGPT Supervisor Protocol

For ChatGPT web usage, the user can describe a high-level goal instead of manually writing MCP tool parameters. The default supervisor protocol is documented in [docs/supervisor-usage.md](docs/supervisor-usage.md).

In short: small isolated tasks that only create files under a new `workspace/<new-dir>/` may be auto-run through `cc_run_approved_task`; core-file edits, existing project edits, dependency installs, networking, deletion, git operations, long tasks, or ambiguous write boundaries require a second user confirmation.

Every run appends a local project ledger entry to `.agent-runs/project-ledger.jsonl`. Use `.\.agents\ledger.ps1 -Tail 20` to inspect recent approvals, allowed actions, changes, checks, risks, blocked items, and costs.

For third-party or domestic-model adapters, `MaxBudgetUsd` is an estimated Claude Code/wrapper budget and may not equal actual API billing. The default is conservative at `0.20`, and the portable wrapper rejects values above `5.00`. Set local defaults in `.agents/local.config.json`, for example `maxBudgetUsd` around `1.00`, and do not commit that file. Cost control should also rely on task splitting, `WorkerTimeoutSeconds`, narrow file scope, no networking, no dependency installation, and no git operations. Live worker tests should be run by the user in a real PowerShell terminal, not by Codex or another patch agent.

MCP task tools also accept `maxBudgetUsd`; their bridge-level default is `0.20` so a remote call does not silently inherit a larger local wrapper budget.

If a worker exits because of budget or provider failure, still inspect the normalized result and ledger. The wrapper records `artifact_status` and `supervisor_notes` so Codex can distinguish "no useful output" from "partial artifacts may exist and need independent validation."

## Codex Skill

The reusable skill package lives in `skills/codex-claude-worker/`. It contains the supervisor workflow, worker prompt templates, a validation checklist, and a small `verify-harness.ps1` helper.

```powershell
.\skills\codex-claude-worker\scripts\verify-harness.ps1 -ProjectRoot . -MockWorker
```

To install it into a local Codex skill directory, copy `skills/codex-claude-worker/` into `$env:CODEX_HOME\skills\` or `%USERPROFILE%\.codex\skills\`.

## Examples and Validation

Preserved smoke outputs live in `examples/`. New worker output should go under `workspace/`, which is ignored by Git.

Real worker and ChatGPT web MCP validation procedures are documented in [docs/real-world-validation.md](docs/real-world-validation.md). Secure remote connection setup is in [docs/secure-mcp-tunnel.md](docs/secure-mcp-tunnel.md). The roadmap for the future durable asynchronous control layer is in [docs/v0.2-roadmap.md](docs/v0.2-roadmap.md); it is explicitly outside this Alpha.

Natural-language smoke results are tracked in [docs/natural-language-smoke-results-clean.md](docs/natural-language-smoke-results-clean.md). Current known limits:

- Document-generation runs can produce mojibake or leak real local paths if prompts and validation are not strict.
- Budget failures may still leave useful files behind; treat them as untrusted partial artifacts until Codex validates them.
- The ChatGPT Web read-only path has passed through OpenAI Secure MCP Tunnel; the final hardened write still requires manual confirmation after the updated Bridge is restarted.
- Provider mappings remain local operator configuration and are never committed. Re-run the bounded real plan/write gates after changing a provider or model mapping.

## Safety Boundary

The MCP bridge is a Claude Code harness bridge, not a general shell or file server. It only calls the existing allowlisted harness scripts:

- `.agents/claude-task.ps1`
- `.agents/summary.ps1`
- `.agents/ledger.ps1`

It does not expose generic shell execution, arbitrary file read/write, or delete tools.

`cc_run_approved_task` is write-capable and should only be enabled for trusted users. The local bridge does not implement user authentication; remote access must be provided by OpenAI Secure MCP Tunnel or by an independently authenticated reverse proxy. Do not expose the bridge directly through a public URL.

This project is a policy and workflow boundary, not an OS-level sandbox. If you need to run untrusted code, add a real isolation layer such as a VM, container, or restricted OS user.
