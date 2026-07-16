# Supervisor Brain v1.0-beta

Supervisor Brain is the responsibility layer above Workflow planning. It does not execute a Worker, create a Task directly, approve work, or weaken any Harness contract.

## Responsibility boundary

| Layer | Owns | Does not own |
| --- | --- | --- |
| Supervisor Decision | Intent, technical goal, registered project, concise reasoning, risks, resource estimate, recommended Workflow/actions, confidence, next action | Task execution, approval, tool permissions |
| Project Context | Registered paths, descriptions, technology stacks, aliases, default constraints, unique selection, user confirmation, last-used metadata | Repository exploration, Worker execution |
| Workflow Planner | Convert the Decision into the selected data-driven Workflow definition | Worker lifecycle or approval synthesis |
| Workflow Runtime | Advance Planner, approval gate, Coder, Reviewer | Model intent inference |
| Task Runtime | One durable Task/Attempt lifecycle | Workflow or product decisions |

## Decision contract

Each accepted request is persisted as `runtime-data/supervisor-decisions/<decisionId>.json`:

```json
{
  "schemaVersion": 2,
  "intent": "code_change",
  "goal": "Add CSV export to the task board",
  "technical_summary": "Add a browser-only CSV download while preserving existing task storage.",
  "project": {
    "id": "dogfood-study-board",
    "path": "workspace/dogfood-study-board"
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
2. Call `cc_list_projects` and select one registered project. If more than one candidate is plausible, use `confirm_project`; never ask a Worker to discover the target workspace.
3. Produce the complete Decision contract, including technical summary, risks, resource estimate, and recommended actions.
4. Call `cc_create_workflow`. If the result is `project_confirmation_required`, show the candidates and wait for the user.
5. After Planner completion, present the plan and risks. Never call `cc_approve_workflow` without an explicit informed human decision.

Intent/Workflow mismatches are rejected locally. A `conversation` Decision cannot create a Workflow, and `create_workflow` cannot proceed without one confirmed project.

## Project registry

Edit `.agents/projects.json` before use. Each entry contains `description`, `techStack`, `aliases`, and `defaultConstraints`. Paths must remain relative to the configured `projectRoot`; missing directories and paths that escape it are rejected. `lastUsed` is stored under `runtime-data/project-usage.json`, so normal use does not dirty the versioned registry.

Selection order is:

1. explicit registered project ID, name, path, or alias;
2. one unique alias match in the request;
3. the only registered project;
4. explicit user confirmation when candidates remain ambiguous.

The confirmed project and its constraints are included in every Planner, Coder, and Reviewer prompt. This prevents target guessing, but the operating-system isolation caveat remains unchanged: the Harness is a policy boundary, not a VM or container.

## Approval and diff evidence

The Console renders Decision as the first lifecycle stage, followed by Planning, Approval, Execution, and Review. Before approval it shows the original request, technical summary, modification reason, proposed changes, combined Supervisor/Planner risks, Resource Profile, expected resources, and hard caps. The approval record remains visible after the decision; observed Diff evidence appears there after execution.

After execution, the Diff Viewer is derived from successful observed `Write` and `Edit` tool events. It does not treat Worker prose as change evidence and does not replace the existing audit validator.

## Retention

Retention is configured in `mcp-server/config.json` and runs once on startup unless disabled. Defaults keep 30 days, 200 terminal Workflows, 200 terminal standalone Tasks, and 500 unlinked Decisions. Active Workflows/Tasks are never selected. Preview cleanup with `node .\scripts\cleanup-runtime.mjs`; add `--apply` to remove the planned paths.
