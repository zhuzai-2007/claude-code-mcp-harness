# Supervisor Architecture

Supervisor is a **local-first, auditable execution governance layer for coding agents**. It connects a human and a GPT Supervisor to durable, bounded local execution without embedding a GPT API client in the Runtime.

It is deliberately not a general Agent framework or a multi-Agent platform. The Runtime does not invent teams, run parallel Agents, auto-approve work, or treat Worker self-reports as authoritative evidence.

```text
Human + ChatGPT Web
        |
Decision Layer ---- Project Context / Project Memory snapshot
        |
Workflow Orchestration Layer ---- explicit approval checkpoint
        |
Task Lifecycle Layer
        |
Execution Harness Layer ---- policy / resource / side-effect / audit controls
        |
Worker Layer ---- Claude Code or a compatible execution worker
        |
Evidence Layer ---- events / observed changes / audit / review package
        |
Human + ChatGPT Supervisor Review
        |
Project Intelligence Layer ---- confirmed reviews / proposals / Memory apply history
```

## Decision Layer

The Decision Layer understands and records the user's goal before execution. A `SupervisorDecision` contains intent, registered project, technical direction, expected changes, validation plan, confidence, constraints, risks, and the requested Workflow type.

`goalConfidence`, `possibleIntentMismatch`, and `clarificationNeeded` are execution gates. A clear bounded task proceeds normally; an ambiguous, high-impact, or low-confidence goal is persisted as `waiting_for_clarification` and cannot create a Workflow. An explicit user response regenerates a new Decision and links it to the superseded Decision. This layer persists decisions and a Project Memory snapshot, but it does not create Tasks or approve execution.

## Workflow Orchestration Layer

The Workflow Planner selects a legal, discoverable Workflow Definition. The Workflow Runtime controls ordered stages such as Planner, human Approval, Coder, and Reviewer. It creates work only through the existing orchestrator and never synthesizes human approval.

## Task Lifecycle Layer

The Task Runtime owns one Task and its Attempts. It persists lifecycle state, events, resource limits, heartbeat, cancellation, result references, and restart recovery. Browser or ChatGPT disconnection does not make Task state disappear.

## Execution Harness Layer

The Harness is the local enforcement boundary. It applies the registered project root, mode-specific allowed tools, Resource Profiles, timeouts, approval metadata, side-effect guards, and the strict audit contract. Worker output that conflicts with observed tool evidence remains a failure.

## Evidence Layer

The Evidence Layer records what the Runtime observed: Task and Workflow events, tool calls, changed file targets, normalized audit results, checks, costs, and failures. `cc_get_supervisor_review_package` projects these facts together with the original request, Decision, Reviewer result, Project Context, and Decision-time Memory snapshot.

The Review Package reserves `goalAlignment`, `architectureImpact`, `futureRecommendations`, and `memoryUpdateNeeded` for a later GPT Supervisor judgment. Empty fields are intentional until a confirmed `SupervisorReviewResult` is submitted. Once submitted, the package projects that exact persisted judgment without inventing or recomputing it.

After a terminal Workflow, the Runtime can also create a `MemoryUpdateProposal`. A proposal is generated only from sufficient strict-audit evidence, Harness-observed changes, and Reviewer checks. It is stored separately, requires confirmation, and never edits `PROJECT_MEMORY.md` automatically.

## Project Intelligence Layer

Project Intelligence is additive metadata around a terminal Workflow:

- `SupervisorReviewResult` persists an explicitly submitted ChatGPT judgment and its source/confirmation metadata;
- `MemoryUpdateProposal` remains evidence-first and pending until a human confirms it;
- `MemoryApplication` records the controlled append, operator, timestamp, summary, and before/after digests.

The layer does not change Workflow status. Review Result submission and Memory application are explicit write operations; neither starts a Worker. Memory application accepts no arbitrary content and appends only the stored proposal to the `Recent Evolution` layer. See [Project Memory layers](project-memory.md).

## Project Continuity Layer

Project Continuity is a read model above Project Context and Project Intelligence. It keeps long-lived project work understandable without retaining a ChatGPT transcript:

- `ProjectBrief` summarizes current factual status, active goals, observed recent changes, recent terminal Workflows, unresolved issues, and confirmed next steps;
- `SupervisorSession` groups purpose, explicit decisions, unresolved questions, next actions, and related Workflows for exactly one registered Project;
- the compact continuity context exposes the Brief, bounded Memory summary, Sessions, recent Workflows, and open issues through the read-only `cc_get_project_continuity` tool;
- Artifact Center projects the existing Plan, Approval, execution evidence, observed changes, Review, and Memory impact without moving Workflow state or introducing new storage.

The Brief is deterministic. Harness-observed changes and saved review evidence are facts; GPT recommendations appear only when they came from an explicitly persisted `SupervisorReviewResult`. Empty recommendation fields are intentional and are never filled from Worker self-report.

### Project Health projection

The Dashboard projects a compact Project Health view from the Project Brief, recent Workflow statuses, persisted Review Results, Project Memory metadata, and the checked-in release-status record. It shows current status, recent evidence, attention items, confirmed recommendations, and release readiness. This is deterministic presentation logic: it does not ask a model to judge health, does not move Workflow state, and does not turn Worker self-report into project direction.

## Worker Layer

The Worker reads or modifies code within the capability boundary supplied by the Harness. It executes the task; it does not select the project, approve itself, define the Workflow, or become the source of truth for observed changes.

## Human-GPT Collaboration

The Dashboard's **Review in ChatGPT** action is a handoff, not an API integration. It provides the Workflow id, Project id, the existing `cc_get_supervisor_review_package` call, and a suggested Supervisor review prompt. The user copies that prompt into ChatGPT Web, where GPT can assess goal alignment, long-term architecture, hidden risks, next steps, and whether a Memory update should be proposed.

No GPT API call, automatic approval, automatic follow-up Workflow, or automatic Memory mutation occurs in this path.

## Persistence boundaries

Runtime state is file-backed under the configured runtime data root:

- Supervisor Decisions, Supervisor Sessions, and derived Project Briefs;
- Workflows, Tasks, Attempts, and events;
- Review Packages, Supervisor Review Results, Memory Update Proposals, and Memory application history;
- Dashboard-only naming, folders, and archive metadata.

Project source remains in the registered workspace. `PROJECT_MEMORY.md` remains operator-owned: only an explicit confirmed apply can append a stored proposal, and every apply leaves a separate audit record.

## Stable boundaries

Human-GPT collaboration and Project Continuity are additive. They do not change the Task state machine, Workflow stage semantics, Harness validator, Resource Profiles, approval boundary, side-effect guard, or existing MCP tool behavior. Retention may remove expired Workflow artifacts, but active Project Briefs, Sessions, confirmed Memory applications, and Project source Memory remain outside that cleanup set.
