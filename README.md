# Supervisor v1.0 Beta

[English](README.md) | [简体中文](README.zh-CN.md)

Supervisor is a local, human-controlled development runtime for connecting ChatGPT Web to a bounded Claude Code worker. It turns one natural-language request into a durable workflow:

```text
User request
  -> Workflow planning
  -> Read-only plan
  -> Human approval
  -> Bounded implementation
  -> Focused review
  -> Audited result
```

The project does not build a new model or a general Agent platform. It reuses AI capabilities the user already has and focuses on stable, transparent, long-running local development work.

> **Beta means invite-only testing, not production isolation.** Supervisor provides policy, approval, resource, side-effect, and audit guardrails. It is not an operating-system sandbox. Use a restricted account, VM, or container for untrusted code.

## What you get

- A local Supervisor Console for creating and following development requests.
- Durable Workflow and Task state that survives browser or MCP client disconnection.
- Data-driven selection among software change, analysis-only, and documentation workflows.
- Explicit Approve / Reject controls before a write-capable Task exists.
- Resource Profiles for budget, turns, file reads, commands, and timeout.
- Focused post-change review with files, checks, risks, errors, cost, and usage.
- Strict cross-validation between Worker JSON claims and observed Claude Code tool events.
- A fixed MCP surface for ChatGPT Web through OpenAI Secure MCP Tunnel.
- A persistent Supervisor Decision that records intent, goal, project, reasoning, Workflow type, confidence, and next action before a Workflow exists.
- A registered Project Context layer that selects a unique target or pauses for explicit project confirmation.
- An Approval Center with decision context, bounded cost estimate, observed file scope, and tool-evidence diffs.
- An isolated Provider Preflight that sends a fixed non-project probe with no tools or session persistence.
- Safe recovery for failed Workflows: new history, a new Planner, and a new approval boundary.
- Plain-language failed-stage classification and recovery guidance in the Dashboard.
- A repeatable isolated Demo and recorded real-provider, full-Workflow, Dashboard, desktop, and mobile acceptance.

## Supervisor Brain

ChatGPT can attach a structured `supervisorDecision` to `cc_create_workflow`. v1.0-beta preserves the existing Decision contract: intent, technical goal, registered project, concise reasoning, risks, expected resources, recommended Workflow/actions, confidence, whether a Worker is needed, and the next action. The local Console uses the same Decision Layer with deterministic, explainable fallback rules when no model is present. Every Decision is persisted under `runtime-data/supervisor-decisions/` before it can reach the Workflow Runtime.

Projects are registered in `.agents/projects.json` with a stable ID, relative path, description, language, aliases, and runtime-derived `lastUsed`. A unique request match is selected automatically. If several projects remain plausible, Supervisor returns `project_confirmation_required`; no Workflow or Worker starts until the user confirms one of the registered candidates.

The boundary is intentionally explicit:

```text
Supervisor Decision -> Project Context -> Workflow Planner -> Workflow Runtime -> Task Runtime
```

The expected GPT behavior is: decide whether a Worker is needed, query/select a registered project, produce the full Decision, and only then enter a Workflow. Explanations use `respond_directly`; project analysis uses `analysis_only`; code changes use `software_change`. Intent/Workflow mismatches and target guessing are rejected locally. The Decision Layer never creates a Task and cannot bypass Workflow approval. See [Supervisor Brain](docs/supervisor-brain.md).

## Quick start on Windows

Requirements:

- Windows PowerShell 5.1 or PowerShell 7;
- Node.js 20 or newer;
- Claude Code CLI configured with a compatible model provider.

Clone the repository, then run:

```powershell
.\install.ps1
.\scripts\doctor.ps1
.\start.ps1
```

Those three commands are sufficient to start the local Dashboard. Before the first real Worker task, optionally verify external model connectivity with the isolated, potentially billable probe:

```powershell
.\scripts\doctor.ps1 -ProviderPreflight
```

Open the Dashboard URL printed by `start.ps1`, normally:

```text
http://127.0.0.1:8787/supervisor/
```

Enter a request such as:

```text
给任务看板增加导出 JSON 功能
```

Supervisor starts with a persisted Decision and read-only planning. The console shows Decision → Planning → Approval → Execution → Review, including technical summary, project stack/default constraints, proposed scope, combined risks, expected resources, Resource Profile hard caps, and estimated impact. Review that information, enter your name and decision reason, then explicitly Approve or Reject. Approval metadata is audit context, not identity verification.

Before first use, review `.agents/projects.json`. Keep paths relative to `projectRoot`; register only directories the Supervisor should be allowed to target. When the Console asks for project confirmation, choosing a project still starts only the read-only Planner.

`doctor.ps1` performs no external model call by default. The explicit `-ProviderPreflight` switch sends only a fixed connectivity marker from an isolated empty temporary directory, with tools disabled and session persistence off. It never sends project content or creates a Workflow. The probe can incur the provider's minimum request cost.

If a Workflow fails, the Dashboard identifies the failed stage and classifies common provider, timeout, resource, environment, and audit-contract errors. **Create recovery workflow** creates a distinct Workflow from Planning and links both histories. Previous approval or rejection metadata is never copied; every new write stage requires fresh review and approval.

## Autonomous Beta validation

v0.9 was accepted against the isolated `workspace/autonomous-beta-demo` project with the real configured provider. A plain-language search request completed Decision → Planner → explicit bounded test approval → Coder → Reviewer. Independent Microsoft Edge checks then exercised keyword search, combined status filtering, counts, and the empty state. A measured 360px overflow was fixed through a second fully audited Workflow and rechecked at 360px and 1280px.

The validation driver supplied named approval metadata after inspecting each Planner result; the product did not auto-approve and no approval boundary was removed. See [v0.9 autonomous validation](docs/v0.9-autonomous-validation.md) and run the dependency-free contract test with:

```powershell
node .\workspace\autonomous-beta-demo\demo.test.mjs
```

## v1.0-beta release preparation

v1.0-beta is a release-convergence milestone, not a Runtime redesign. It keeps the v0.9 Decision, Workflow, Task, approval, resource, and audit boundaries intact while tightening first-run guidance, version checks, release artifact visibility, and repeatable Todo acceptance. See [v1.0-beta release audit](docs/v1.0-beta-release-audit.md).

## Architecture

```text
ChatGPT Web / Supervisor Console
              |
   MCP Bridge / local Product API
              |
     Supervisor Decision Layer
              |
       Project Context Layer
              |
      Workflow Planning Layer
              |
      Workflow Orchestrator
              |
         Task Runtime
              |
 Harness / Approval / Policy / Audit
              |
       Claude Code Worker
              |
       Project workspace
```

| Layer | Responsibility |
| --- | --- |
| Supervisor Console | User request entry, recent work, approvals, results, and explainable safety status. |
| Supervisor Decision | Persist intent, goal, target project, reasoning, confidence, constraints, and next action. It cannot create Tasks. |
| Project Context | Resolve only registered project paths; stop for confirmation when selection is ambiguous. |
| Workflow Planner | Select a data-driven Workflow Definition and record goal, reason, constraints, and stages. |
| Workflow Orchestrator | Advance stages and create one Task at a time. It cannot synthesize approval. |
| Task Runtime | Persist Task/Attempt lifecycle, heartbeat, events, cancellation, and restart recovery. |
| Harness | Enforce project root, tools, approval metadata, resources, side effects, and audit contracts. |
| Worker | Perform bounded reads and approved local edits through Claude Code. |

The existing MCP tools remain compatible. The product console uses local Bridge product APIs that call the same Workflow Runtime and approval boundary; it never calls the Worker or Harness directly.

## Workflow types

Definitions live in `.agents/workflow-definitions.json`:

| Type | Intended use | Stages |
| --- | --- | --- |
| `software_change` | Features and bug fixes | plan -> approval -> implementation -> review |
| `analysis_only` | Architecture or project analysis | read-only analysis |
| `documentation_change` | README and documentation edits | plan -> approval -> documentation change -> review |

The current Workflow Planner is deterministic and explainable. Ambiguous requests default to `software_change`; MCP callers can explicitly pass `definitionId` when operator control is preferred.

## Approval and safety

Before an approval-gated Stage:

- no coder Task exists;
- no write-capable Worker starts;
- the console shows planner evidence and the selected Resource Profile;
- Approve records the reviewer, reason, exact planner Task/Attempt, coder prompt hash, and capability boundary;
- Reject ends the Workflow without creating a coder Task.

Execution policy is shown in plain language in the console:

**Allowed**

- read files inside the configured project;
- modify the approved workspace after explicit approval;
- use tools allowed by the current mode and policy.

**Blocked**

- project-root escape;
- unauthorized commands or writes in read-only stages;
- approval-gated execution without approval;
- results that fail the strict audit contract.

These are guardrails, not process isolation. See [SECURITY.md](SECURITY.md).

## Configuration and secrets

Public, versioned configuration:

- `.agents/policy.json` — mode and tool policy;
- `.agents/resource-profiles.json` — resource envelopes and global hard limits;
- `.agents/workflow-definitions.json` — Workflow selection metadata and stages;
- `.agents/projects.json` — registered relative project paths and selection aliases;
- `mcp-server/config.example.json` — placeholder-only Bridge template.

Machine-local, ignored configuration:

- `mcp-server/config.json` — workspace path, loopback port, timeouts, and Origins;
- `.agents/local.config.json` — legacy local settings;
- runtime data, Worker artifacts, Tunnel profiles, and logs.

Provider keys, `CONTROL_PLANE_API_KEY`, proxy credentials, Tunnel IDs, and runtime tokens belong only in environment variables or an OS secret facility. Do not add them to JSON examples or commit them. See [Configuration and secrets](docs/configuration.md).

## ChatGPT Web and Secure MCP Tunnel

Local Dashboard use does not require a Tunnel. For ChatGPT Web integration, install `tunnel-client`, obtain a runtime key through the supported OpenAI flow, and use a separate terminal:

```powershell
$env:CONTROL_PLANE_API_KEY="<tunnel-runtime-key>"
.\scripts\start-openai-tunnel.ps1 -Initialize -TunnelId "<tunnel-id>" -DoctorOnly
.\scripts\start-openai-tunnel.ps1
```

If command-line network access requires a proxy:

```powershell
$env:HTTP_PROXY="http://127.0.0.1:<proxy-port>"
$env:HTTPS_PROXY="http://127.0.0.1:<proxy-port>"
```

Browser access to ChatGPT does not prove that `tunnel-client` or Claude Code can reach their external control planes. Keep proxy addresses and credentials out of Git. See [Secure MCP Tunnel](docs/secure-mcp-tunnel.md).

## Validation

Safe local checks that do not require a paid Worker call:

```powershell
# Harness audit, policy, Resource Profile, and side-effect fixtures
.\.agents\tests\smoke.ps1

# Isolated Bridge and full mock MCP Workflow
.\scripts\test-mcp-protocol.ps1

# Runtime and product UI tests
node .\runtime\workflow-planner.test.mjs
node .\runtime\workflow-runtime.test.mjs
node .\runtime\supervisor-brain.test.mjs
node .\runtime\runtime-retention.test.mjs
node .\runtime\harness-runner.test.mjs
node .\runtime\provider-preflight.test.mjs
node .\runtime\failure-catalog.test.mjs
node .\workspace\autonomous-beta-demo\demo.test.mjs
node .\workspace\release-beta-todo-demo\demo.test.mjs
node .\mcp-server\supervisor-dashboard-routes.test.mjs
node .\mcp-server\supervisor-product-view.test.mjs
```

Use real Worker tests only after checking provider cost and reviewing the exact project boundary.

A sanitized successful Planner -> approval -> Coder -> Reviewer run is recorded in [Beta dogfood](docs/beta-dogfood.md).

Runtime retention runs once at startup by default. It keeps up to 200 terminal Workflows, 200 terminal standalone Tasks, and 500 unlinked Decisions for 30 days, and removes their referenced attempt artifacts when the corresponding history expires; active work is preserved. Preview or apply cleanup manually with:

```powershell
node .\scripts\cleanup-runtime.mjs
node .\scripts\cleanup-runtime.mjs --apply
```

Before tagging a release, run `.\scripts\check-release-baseline.ps1`. It rejects a dirty Git baseline and tracked local config, runtime, backup, or log files. During development, `-SkipGitClean` checks the version and tracked-file boundary without requiring a clean worktree.

## Portable Harness installation

The default installer prepares this cloned Supervisor repository. To install only the portable `.agents` Harness into another existing project:

```powershell
.\install.ps1 -TargetProject D:\path\to\another-project
```

Existing policy, Resource Profiles, and Workflow Definitions are preserved unless `-Force` is supplied. Historical runs are never copied.

## Beta limitations

- Windows is the primary validated platform.
- The local Console fallback is rule-based; model-authored decisions are available through ChatGPT MCP and remain locally validated and auditable.
- Stages run sequentially; there is no parallel Agent execution, branching, or automatic retry policy.
- The Dashboard uses polling and has no notification service.
- Approval names are local audit metadata, not authenticated identities.
- Artifact viewing provides audit summaries, changed-file lists, and raw result links, not a full code editor or rich diff engine.
- The local Bridge should remain bound to loopback; public ingress requires the supported Secure MCP Tunnel and careful operator configuration.
- Provider cost reporting can differ from upstream billing, especially through third-party adapters.

## Project origin

This project began as a personal experiment: use ChatGPT as the high-level thinking and interaction surface while a lower-cost Claude Code-compatible worker performs bounded local work. The hard part turned out not to be “more Agent intelligence”, but durable tasks, explicit approval, evidence-based auditing, resource control, and a workflow a real person can understand. Supervisor Beta is the next step toward that personal Codex-like system.

Contributions are welcome when they preserve the supervision and safety boundaries. Report vulnerabilities privately according to [SECURITY.md](SECURITY.md). Licensed under the [MIT License](LICENSE).
