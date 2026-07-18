# Supervisor Brain v1.7 Project Continuity Layer

Supervisor Brain is the responsibility layer above Workflow planning. It does not execute a Worker, create a Task directly, approve work, or weaken any Harness contract.

After execution, the read-only Supervisor Review Package projects the original request, frozen Decision-time Project Memory, implementation evidence, and Reviewer result into one persisted artifact for a later ChatGPT Web review. An explicitly confirmed GPT judgment can return as an additive Supervisor Review Result. A separate explicit confirmation can apply the evidence-first Memory Proposal through the Runtime-controlled append contract. Historical v1.4 reliability analysis remains in [Supervisor v1.4 Reliability and Review Foundation](supervisor-reliability-review.md).

## Responsibility boundary

| Layer | Owns | Does not own |
| --- | --- | --- |
| Supervisor Decision | Intent, technical goal, implementation strategy, expected changes, validation plan, registered project, reasoning, risks, resource estimate, confidence, next action | Task execution, approval, tool permissions |
| Project Context | Runtime-owned `projectId`/`workspacePath`, descriptions, stack, constraints, `AI_SUPERVISOR.md`, `PROJECT_MEMORY.md`, unique selection, user confirmation | Repository exploration, Worker execution |
| Supervisor Session | Associate purpose, explicit decisions, unresolved questions, next actions, and multiple Workflows with one registered Project | ChatGPT message history, cloud sync, model memory |
| Project Intelligence | Persist confirmed GPT Review Results, pending Memory Proposals, and audited Memory applications | Workflow state, automatic GPT calls, arbitrary Memory edits |
| Project Continuity | Build an evidence-derived Project Brief and compact read-only project context; project Workflow artifacts for the Dashboard | GPT judgment invention, raw event-history export, execution |
| Workflow Planner | Convert the Decision into the selected data-driven Workflow definition | Worker lifecycle or approval synthesis |
| Workflow Runtime | Advance Planner, approval gate, Coder, Reviewer | Model intent inference |
| Task Runtime | One durable Task/Attempt lifecycle | Workflow or product decisions |

## Decision contract

Each accepted request is persisted as `runtime-data/supervisor-decisions/<decisionId>.json`:

```json
{
  "schemaVersion": 6,
  "intent": "code_change",
  "goal": "Add CSV export to the task board",
  "goalConfidence": 0.9,
  "possibleIntentMismatch": null,
  "clarificationNeeded": false,
  "technical_summary": "Add a browser-only CSV download while preserving existing task storage.",
  "implementation_strategy": "Reuse the existing browser action pattern and serialize the current task model without changing storage.",
  "expected_changes": [
    "Add one export action to the existing task-board UI.",
    "Add browser-side CSV escaping and download logic."
  ],
  "validation_plan": [
    "Verify commas, quotes, and newlines are escaped.",
    "Verify task creation, filtering, completion, and persistence still work."
  ],
  "projectId": "dogfood-study-board",
  "workspacePath": "<projectRoot>/workspace/dogfood-study-board",
  "session": {
    "sessionId": "session_...",
    "projectId": "dogfood-study-board",
    "name": "Task board CSV export"
  },
  "reasoning": [
    "Existing browser behavior must change.",
    "The request uniquely matches a registered task-board project."
  ],
  "risks": [
    "CSV escaping must preserve commas, quotes, and newlines.",
    "Any write-capable stage remains blocked on human approval."
  ],
  "workflowType": "software_change",
  "estimated_resources": {
    "complexity": "low",
    "expected": {
      "budgetUsd": 0.5,
      "turns": 25,
      "filesRead": 8,
      "commands": 0,
      "timeoutSeconds": 360
    },
    "hard_caps": {
      "budgetUsd": 4.5,
      "turns": 230,
      "filesRead": 190,
      "commands": 12,
      "timeoutSeconds": 2700
    }
  },
  "recommended_actions": [
    "Create the software_change Workflow.",
    "Review the Planner scope and risks before approval."
  ],
  "confidence": 0.9,
  "agentRequired": true,
  "nextAction": "create_workflow"
}
```

ChatGPT may provide this structure through the optional `supervisorDecision` field of `cc_create_workflow`. Local validation still requires a known Workflow definition, a consistent intent/next-action combination, and a registered project. GPT resource numbers are estimates only: the Decision Layer adds the locally resolved stage profiles and hard caps, while Task Runtime continues to enforce the unchanged Resource Profile contract. The Dashboard uses deterministic fallback rules because it has no model process of its own.

`respond_directly` persists a decision without creating a Workflow. `confirm_project` persists candidate projects and pauses. `create_workflow` is the only action handed to the Workflow Runtime.

## Supervisor behavior contract

For every request, ChatGPT Web should follow this order:

1. Decide whether local Worker evidence or file changes are required.
   - Explanations and ordinary questions: `respond_directly`.
   - Bounded project analysis: `analysis_only` plus `create_workflow`.
   - Software changes: `software_change` plus `create_workflow`.
   - Documentation-only changes: `documentation_change` plus `create_workflow`.
2. Call `cc_list_projects` and select one exact `projectId`. If none or more than one candidate is plausible, stop and ask the user; never infer a filesystem path.
3. Call `cc_get_project_context` for the selected project. When continuing existing work, call read-only `cc_get_project_continuity` for the Project Brief, Memory summary, Supervisor Sessions, recent Workflows, and open issues.
4. Call `cc_list_workflow_definitions`. Select an exact returned `id`; never invent aliases such as `feature_change` or `small_change`.
5. Produce the complete Decision contract: technical summary, implementation strategy, expected changes, validation plan, constraints, risks, resource estimate, and recommended actions. A restatement such as “user wants feature X” is insufficient.
6. Call `cc_create_workflow` with the explicit `projectId`; optionally reuse a returned `sessionId`. A GPT-authored `create_workflow` Decision without `projectId` is rejected. If the result is `project_confirmation_required`, show the candidates and wait for the user. If it is `clarification_required`, no Workflow exists: obtain an explicit answer and regenerate the Decision through the same tool using the returned Decision id. If a definition is rejected, use the returned `availableDefinitions` rather than guessing again.
7. After Planner completion, present the plan and risks. Never call `cc_approve_workflow` without an explicit informed human decision.

Intent/Workflow mismatches are rejected locally. A `conversation` Decision cannot create a Workflow, and `create_workflow` cannot proceed without one confirmed project.

`cc_get_project_context` and `cc_list_workflow_definitions` are read-only capability discovery. They do not create a Decision, Workflow, Task, approval, or Worker prompt.

## Project registry

Edit `.agents/projects.json` before use. Schema v3 uses `projectId`, `name`, `workspacePath`, `aliases`, `stack`, and `constraints`; the Registry still accepts the earlier `id/path/techStack/defaultConstraints` names. Registry `workspacePath` values remain relative to configured `projectRoot`; Runtime resolves and freezes the absolute path in each new Decision and Workflow. Missing directories and paths that escape `projectRoot` are rejected. `lastUsed` remains in `runtime-data/project-usage.json`.

Selection order is:

1. explicit registered project ID, name, path, or alias;
2. one unique alias match in the request;
3. the only registered project;
4. explicit user confirmation when candidates remain ambiguous.

`AI_SUPERVISOR.md` and `PROJECT_MEMORY.md` are for ChatGPT Supervisor reasoning, not for Claude Worker instructions and not for permission. Each is capped at 64 KiB. Their raw text is never inserted into a Worker prompt; the Decision records only revision metadata plus GPT-derived technical direction. Planner, Coder, and Reviewer receive the original goal plus the derived brief, project boundary, and constraints.

## Project, Session, and execution trace

Supervisor Sessions are stored under `runtime-data/project-sessions/<sessionId>.json`. A Session contains `sessionId`, `projectId`, display name, purpose, explicit decisions, unresolved questions, next actions, timestamps, source, and related Workflows; it stores no ChatGPT messages. If ChatGPT supplies an existing `sessionId`, Runtime verifies that it belongs to the selected Project. Without one, Runtime creates a new Session for the Workflow. Legacy Session snapshots are normalized on read without rewriting their history.

New Workflow snapshots freeze `projectId`, absolute `workspacePath`, and `sessionId`. Every child Task and Attempt inherits the same values. Task and Attempt also record `executionDirectory`, which is the actual Harness process root. Today the Harness still starts from the Supervisor runtime root while the registered project is carried as the bounded task context; both paths are shown rather than conflated. Existing Workflow snapshots without these fields remain readable.

## Approval and diff evidence

The Console renders Decision as the first lifecycle stage, followed by Planning, Approval, Execution, and Review. Before approval it shows the original request, technical summary, modification reason, proposed changes, combined Supervisor/Planner risks, Resource Profile, expected resources, and hard caps. The approval record remains visible after the decision; observed Diff evidence appears there after execution.

After execution, the Diff Viewer is derived from successful observed `Write` and `Edit` tool events. It does not treat Worker prose as change evidence and does not replace the existing audit validator.

## Retention

Retention is configured in `mcp-server/config.json` and runs once on startup unless disabled. Defaults keep 30 days, 200 terminal Workflows, 200 terminal standalone Tasks, and 500 unlinked Decisions. Active Workflows/Tasks are never selected. Preview cleanup with `node .\scripts\cleanup-runtime.mjs`; add `--apply` to remove the planned paths.
