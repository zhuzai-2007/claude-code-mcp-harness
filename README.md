# Supervisor v1.8 Beta

[English](README.md) | [简体中文](README.zh-CN.md)

Supervisor is a **local governance layer that gives coding agents approval, audit, project continuity, and human control**. ChatGPT Web acts as project Supervisor while a bounded Claude Code Worker performs local execution. It turns one natural-language request into a durable workflow:

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

## Five-minute quick start

Requirements: Windows PowerShell, Node.js 20+, Claude Code CLI with a configured provider, and access to ChatGPT Web with an MCP-capable connection.

1. **Install dependencies.** Clone the repository, open PowerShell in its root, and run:

   ```powershell
   .\install.ps1
   ```

2. **Check and start the local Runtime.**

   ```powershell
   .\scripts\doctor.ps1
   .\start.ps1
   ```

   The Dashboard URL is printed by `start.ps1`, normally `http://127.0.0.1:8787/supervisor/`.

3. **Configure and start the tunnel.** Initialize the official OpenAI Secure MCP Tunnel once, then start it using local secrets that remain untracked:

   ```powershell
   .\scripts\start-openai-tunnel.ps1 -Initialize -TunnelId "<tunnel-id>"
   .\scripts\start-openai-tunnel.ps1
   ```

   Some command-line network environments require `HTTP_PROXY` and `HTTPS_PROXY`; see [Network and proxy configuration](#network-and-proxy-configuration). Never commit the tunnel profile, API key, proxy address, or public endpoint.

4. **Connect ChatGPT.** Add the tunnel endpoint as an MCP connection in ChatGPT Web. Ask ChatGPT Supervisor to call `cc_list_projects`, `cc_get_project_continuity`, and `cc_list_workflow_definitions` before creating work.

5. **Run the first task.** Against a registered demo Project, enter only:

   > Add CSV export to the demo task board.

   The expected path is:

   ```text
   Supervisor Decision -> Planner -> Human Approval -> Claude Code change
   -> Harness Audit -> Claude Reviewer -> ChatGPT Supervisor Review
   ```

The Dashboard is the control console for state, evidence, and approval; it is not a replacement for ChatGPT reasoning. See [Using Supervisor from ChatGPT Web](docs/gpt-web-usage.md) for the exact first-session sequence and non-automated release validation.

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
- A registered Project Context layer that owns `projectId`/`workspacePath`, exposes GPT-only `AI_SUPERVISOR.md` and `PROJECT_MEMORY.md`, or pauses for explicit project confirmation.
- Project Sessions that associate multiple Workflows with one Project without storing ChatGPT conversation history.
- An Approval Center with decision context, bounded cost estimate, observed file scope, and tool-evidence diffs.
- An isolated Provider Preflight that sends a fixed non-project probe with no tools or session persistence.
- Safe recovery for failed Workflows: new history, a new Planner, and a new approval boundary.
- Plain-language failed-stage classification and recovery guidance in the Dashboard.
- A repeatable isolated Demo and recorded real-provider, full-Workflow, Dashboard, desktop, and mobile acceptance.
- A terminal Workflow handoff back to ChatGPT Web, with an evidence-first Review Package and a confirmation-required Project Memory update proposal.
- A Project Intelligence layer that persists explicitly confirmed GPT reviews and applies stored Memory proposals only through a traced human-confirmation flow.
- A Project Continuity layer with evidence-derived Project Briefs, cross-Workflow Supervisor Sessions, a project-first Dashboard, and a compact read-only GPT context tool.

## Supervisor Brain

ChatGPT can attach a structured `supervisorDecision` to `cc_create_workflow`. The Decision records intent, technical goal, registered project, concise reasoning, risks, expected resources, recommended Workflow/actions, confidence, whether a Worker is needed, and the next action. v1.2 also records `technical_summary`, `implementation_strategy`, `expected_changes`, and `validation_plan` so GPT owns the technical direction instead of forwarding a one-line request. The local Console uses the same Decision Layer with deterministic, explainable fallback rules when no model is present. Every Decision is persisted under `runtime-data/supervisor-decisions/` before it can reach the Workflow Runtime.

Projects are registered in `.agents/projects.json` with `projectId`, relative `workspacePath`, description, stack, aliases, constraints, and runtime-derived `lastUsed`. A project root may contain GPT-only `AI_SUPERVISOR.md` and `PROJECT_MEMORY.md`. GPT must pass the exact registered `projectId`; a GPT-authored Workflow request without it is rejected. If several projects remain plausible, Supervisor returns `project_confirmation_required`; no Workflow or Worker starts until the user confirms one candidate.

Before `cc_create_workflow`, ChatGPT Supervisor calls `cc_list_projects`, `cc_get_project_context`, and `cc_list_workflow_definitions`. Project context returns the Registry workspace, instructions, Project Memory, and Sessions. ChatGPT may reuse a Session returned for that same Project. Unknown projects, cross-project Session reuse, missing GPT `projectId`, and unknown Workflow IDs are rejected locally. If the goal itself remains ambiguous, risky, or low-confidence, the Decision enters `waiting_for_clarification`; an explicit answer regenerates a new linked Decision before any Workflow can exist.

The boundary is intentionally explicit:

```text
Supervisor Decision -> Project Context -> Workflow Planner -> Workflow Runtime -> Task Runtime
```

The expected GPT behavior is: understand the real goal, decide whether a Worker is needed, query/select a registered project, read its Supervisor Context, define the technical direction and validation plan, discover a legal Workflow, and only then create it. Explanations use `respond_directly`; project analysis uses `analysis_only`; code changes use `software_change`. Intent/Workflow mismatches and target guessing are rejected locally. The Decision Layer never creates a Task and cannot bypass Workflow approval. See [Supervisor Brain](docs/supervisor-brain.md).

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

If `node` is not currently on `PATH` but Doctor finds an existing nvm installation, the required Node check still fails. Its output now lists the nvm path and installed versions and recommends `nvm use <version>` instead of suggesting a duplicate Node installation.

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

Supervisor starts with a persisted Decision and read-only planning. The compact Workflow header switches between the Workflow summary and stage timeline instead of displaying both. The timeline navigates one relevant page at a time: Decision/Plan, Approval, Implementation, or Review. Completed and current stages are viewable; future stages remain disabled. Overall status is collapsed by default, and the independently sticky Recent Work rail can be hidden or restored. Review the bounded plan, enter your name and decision reason, then explicitly Approve or Reject. Approval metadata is audit context, not identity verification.

The Dashboard follows the browser language by default and can be switched between Chinese and English. Recent Work is grouped by date; display names and archive state are stored separately under ignored `runtime-data/supervisor-workflow-metadata/`, without rewriting Workflow snapshots or events. ChatGPT Supervisor remains the primary request entry. The Dashboard's **Local fallback entry** is retained as a collapsed, rule-based backup.

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

## v1.8 Beta release candidate

v1.8 consolidates the Decision, Project Context, Project Intelligence, Human-GPT Collaboration, and Project Continuity layers into a public-Beta candidate. It adds deterministic Project Health and explicit release-readiness metadata; it does not add Runtime AI judgment or change the Task/Workflow, Harness, audit, Resource Profile, or approval boundaries. See the [Changelog](CHANGELOG.md) and [ChatGPT Web release validation](docs/gpt-web-usage.md#end-to-end-release-validation). The candidate remains `pending_gpt_web_validation` until that manual fresh-session check is recorded.

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
| Supervisor Decision | Persist intent, goal, target project, technical direction, expected changes, validation plan, confidence, constraints, and next action. It cannot create Tasks. |
| Project Context | Own registered `projectId` and `workspacePath`; expose bounded GPT-only instructions and Project Memory; stop on ambiguity. |
| Project Session | Associate Workflow history with one Project using file-backed metadata; never store ChatGPT messages. |
| Workflow Planner | Select a data-driven Workflow Definition and record goal, reason, constraints, and stages. |
| Workflow Orchestrator | Advance stages and create one Task at a time. It cannot synthesize approval. |
| Task Runtime | Persist Task/Attempt lifecycle, heartbeat, events, cancellation, and restart recovery. |
| Harness | Enforce project root, tools, approval metadata, resources, side effects, and audit contracts. |
| Worker | Perform bounded reads and approved local edits through Claude Code. |

The existing MCP tools remain compatible. v1.2 adds the read-only `cc_get_project_context` and `cc_list_workflow_definitions` discovery tools without changing existing tool inputs or behavior. v1.7 adds only the read-only `cc_get_project_continuity` context tool; it returns a Project Brief, bounded Memory summary, Sessions, recent Workflows, and open issues without raw event history. The product console uses local Bridge product APIs that call the same Workflow Runtime and approval boundary; it never calls the Worker or Harness directly.

v1.4 adds the read-only `cc_get_supervisor_review_package` projection. It persists the original request, Decision-time Memory snapshot, implementation evidence, and Reviewer result so ChatGPT Web can assess a completed or failed Workflow without re-running an Agent. The legacy `cc_run_approved_task` remains a standalone compatibility tool; it does not approve a Workflow. Use `cc_approve_workflow` at a Workflow human checkpoint.

v1.5 adds a compact **Review in ChatGPT** handoff on completed and failed Workflow pages. The Dashboard only provides the Workflow/Project ids, existing Review Package tool call, and a suggested prompt; it never calls a GPT API. Supervisor judgment fields remain empty until an explicitly confirmed result is submitted.

v1.6 adds the Project Intelligence layer. `cc_record_supervisor_review_result` stores an explicit ChatGPT Supervisor conclusion without changing Workflow state. A pending evidence-first proposal can be applied through `cc_apply_memory_update_proposal` or the local Dashboard only after named confirmation; Runtime appends it to `Recent Evolution`, preserves existing Memory, records before/after digests, and never runs a Worker. See [Architecture](docs/ARCHITECTURE.md) and [Project Memory layers](docs/project-memory.md).

v1.7 adds Project Continuity. The Dashboard lands on a Project Overview with Brief, Memory, Sessions, recent Workflows, and open issues. Artifact Center is a read-only projection of existing Workflow artifacts. Project Brief recommendations remain empty unless they come from a saved, explicitly confirmed GPT Supervisor Review; Worker claims and unconfirmed Session context never become synthetic project direction.

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
- `AI_SUPERVISOR.md` — optional GPT-only project instructions; its raw contents are never copied into a Worker prompt;
- `PROJECT_MEMORY.md` — optional GPT-only project goals, decisions, completed work, known issues, and next steps;
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
node .\runtime\project-continuity.test.mjs
node .\runtime\runtime-retention.test.mjs
node .\runtime\harness-runner.test.mjs
node .\runtime\provider-preflight.test.mjs
node .\runtime\failure-catalog.test.mjs
node .\workspace\autonomous-beta-demo\demo.test.mjs
node .\workspace\release-beta-todo-demo\demo.test.mjs
node .\mcp-server\supervisor-dashboard-routes.test.mjs
node .\mcp-server\supervisor-product-view.test.mjs
node .\workspace\supervisor-dashboard\dashboard-ui.test.mjs
.\scripts\doctor-nvm.test.ps1
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
