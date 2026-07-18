# Minimal Task Runtime

The Task Runtime makes a development task independent from one synchronous MCP request while keeping the existing Harness as the execution and safety boundary.

```text
MCP Adapter
    |
Task Runtime
    |
Existing Claude Harness
    |
Claude Code
    |
Local project
```

## Responsibility boundary

- The MCP Adapter validates protocol input and exposes fixed tools.
- The Task Runtime owns identity, lifecycle, scheduling, heartbeat, events, cancellation, and restart reconciliation.
- The existing Harness continues to own policy, project paths, budgets, approvals at execution time, Claude invocation, detailed tool audit, normalized results, and the ledger.

The runtime does not execute arbitrary shell commands and does not replace `policy.json`.

## Supervisor Workflow Planning and Orchestrator v0.4

Workflow is an additive orchestration and observation layer stored under `runtime-data/workflows/<workflow-id>/`. It does not add Task states or change Attempt execution. A Workflow persists the original user request, a structured Workflow Plan, a snapshot of its definition, Stage state, human approvals, and Task references.

`runtime/workflow-planner.mjs` is a separate planning layer. It selects a definition from the natural-language request and returns `workflowType`, `goal`, `reason`, `constraints`, and the user-facing stage sequence. Selection rules and constraints live with definitions rather than in Task Runtime. Supplying the existing optional `definitionId` makes selection explicit and preserves operator control.

The fixed role mapping is:

| Role | Task mode |
| --- | --- |
| `planner` | `plan` |
| `coder` | `run` |
| `reviewer` | `review` |

Definitions are data in `.agents/workflow-definitions.json`:

- `software_change`: exploratory read-only planner/plan, coder/run with required approval, focused reviewer/review. The planner uses `exploration_readonly` because a natural-language feature request must first locate the relevant project surface.
- `analysis_only`: one read-only planner/plan stage using `exploration_readonly`.
- `documentation_change`: planner/plan, approval-gated documentation run, focused reviewer/review.

The Orchestrator consumes the selected plan and creates one Stage Task at a time. Definitions can add future stages and roles without adding a second Task execution engine.

The controlled state progression is:

```text
created -> planning -> planned -> waiting_approval
        -> running -> reviewing -> completed
```

Any failed, cancelled, interrupted, or missing Stage Task moves the Workflow to `failed` and records `failedStage`, role, Task ID, error code, and summary.

Planner success never starts a writer. It moves the Workflow to `waiting_approval` before a coder Task exists. `cc_approve_workflow` records the human identity, reason, time, planner Task, and planner Attempt. Only that human-triggered call creates the coder Task; the Orchestrator then passes the same approval metadata through the existing `TaskRuntime.approveTask`, which binds it to the coder prompt hash and capability boundary. There is no automatic approval path.

After coder success, the reviewer Task is created automatically with bounded planner and coder audit context. Existing v0.2 non-orchestrated Workflow files remain readable and keep their legacy aggregate behavior.

The Supervisor Console uses read APIs for observation:

- `GET /api/supervisor/workflows`
- `GET /api/supervisor/workflows/:workflowId`
- `GET /api/supervisor/workflows/:workflowId/events`
- `GET /api/supervisor/tasks`
- `GET /api/supervisor/tasks/:taskId`
- `GET /api/supervisor/tasks/:taskId/events`
- `GET /api/supervisor/tasks/:taskId/artifacts/:attemptId/:fileName`

The Beta product layer adds three bounded mutation APIs without changing Task Runtime states:

- `POST /api/supervisor/workflows` sends a natural-language request through Workflow Planning and Orchestration;
- `POST /api/supervisor/workflows/:workflowId/approve` calls the existing Workflow approval path;
- `POST /api/supervisor/workflows/:workflowId/reject` records a human rejection and ends the Workflow before the approval-gated Task is created.

The Dashboard also exposes `PATCH /api/supervisor/workflows/:workflowId/metadata` for local display names and archive state. This metadata is stored separately from Workflow snapshots and events, is protected by the same local Console Origin check, and cannot start or advance a Task.

These routes do not expose a generic Task or Harness execution endpoint. Approval still binds to the exact coder prompt hash and capability boundary. Rejection records reviewer, reason, time, Stage, and `approval_rejected` failure evidence; it never creates coder.

Artifact reads are limited to known Harness result files belonging to an Attempt recorded by that Task.

## Task and Attempt

A Task is the durable user goal. An Attempt is one concrete Harness invocation. The initial implementation creates one Attempt when a queued Task receives the single local execution slot. A later retry can create another Attempt without changing Task identity; Claude session recovery is intentionally out of scope.

Task snapshots are stored as:

```text
runtime-data/
  tasks/
    <task-id>/
      task.json
      events.jsonl
      attempts/
        <attempt-id>.json
```

The Attempt stores a run ID and artifact filenames. For orchestrated v1.3 work, Workflow, Task, and Attempt also snapshot `projectId`, registered `workspacePath`, and `sessionId`. Task and Attempt separately record the actual Harness `executionDirectory`, so the bound project and process cwd remain auditable. Legacy snapshots without these additive fields remain valid. Worker artifacts are not copied from `.agents/runs` or `.agent-runs`.

## Resource Profile v0.1

Resource profiles are defined in `.agents/resource-profiles.json`. A Task selects one profile and each Attempt snapshots the resolved profile and limits so later configuration changes cannot obscure what that Attempt received.

| Profile | Budget USD | Turns | File reads | Commands | Timeout |
| --- | ---: | ---: | ---: | ---: | ---: |
| `small_readonly` | 1.00 | 30 | 30 | 1 | 300 s |
| `exploration_readonly` | 1.50 | 100 | 100 | 1 | 1200 s |
| `review_readonly` | 1.50 | 50 | 40 | 1 | 600 s |
| `small_change` | 1.50 | 80 | 50 | 10 | 900 s |
| `medium_analysis` | 2.00 | 80 | 100 | 10 | 1200 s |
| `large_change` | 4.00 | 150 | 200 | 50 | 1800 s |

`small_readonly` is the default for targeted reads of known files. `exploration_readonly` provides more turns and file reads for low-risk project discovery. `review_readonly` bounds Review to reported modified files and their direct dependencies; Review policy disallows Bash and writes. `small_change` is the bounded default for approval-gated software and documentation stages; it avoids using the $4 `large_change` allowance for routine edits. Resource resolution uses explicit per-task limits first, the selected profile defaults second, and the system default profile last; legacy Bridge or machine-local budget and timeout defaults do not override a profile. The Task Runtime API, Harness `-ResourceProfile` option, Harness InputJson, and the optional MCP `resourceProfile` argument can select another profile. Explicit per-task limits cannot exceed the global hard limits in the same file. In v0.1, the hard ceilings remain USD 5.00 and 3600 seconds. The loader requires positive counters, so read-only profiles use `maxCommands: 1`; tool policy independently disallows Bash where required.

Budget and timeout are proactive process limits. The installed Claude CLI does not expose a maximum-turn option, so turns, successful read calls, and successful commands are verified from the captured event stream after execution. Exceeding them fails strict Harness validation; it does not retroactively prevent resources already consumed. The normalized result and ledger include `resource_profile`, `resource_limits`, and observed `resource_usage`.

## State machine

The persisted states are:

- `queued`
- `running`
- `waiting_approval`
- `succeeded`
- `failed`
- `cancelled`
- `interrupted`

Read-only `plan` and `review` Tasks enter `queued`. A `run` Task enters `waiting_approval` and cannot allocate an Attempt until `cc_approve_task` records explicit approval. Runtime restart converts any formerly `running` Task and Attempt to `interrupted`; it never starts a duplicate Worker whose ownership is uncertain.

## Activity and heartbeat

`cc_get_task` returns:

- `lastHeartbeat`: last confirmation from the Runtime that it still owns the Worker process.
- `lastEventTime`: time of the latest lifecycle or phase event.
- `currentStage`: for example `queued`, `starting_worker`, `worker_running`, or a terminal stage.
- `currentAttempt`: the active or most recent Attempt ID.
- `activity`: `active`, `stalled`, or `inactive`.
- `heartbeatHealthy`: whether the Runtime heartbeat is recent.
- `progressStalled`: whether no lifecycle or phase event has appeared within the configured threshold.
- `nextExpectedAction`: a stable operator-facing hint derived from state and activity.

Heartbeat updates the Task snapshot without copying the detailed Claude event stream. Existing Claude JSONL and `tool-events.json` remain the detailed execution evidence.

## Incremental events

Every event has an integer `sequence`. Call `cc_get_task_events` with `afterSequence` equal to the last processed sequence. The response includes `lastSequence` and `hasMore`.

The first stage records lifecycle, phase, approval, Worker start/completion, cancellation, and interruption events. It intentionally does not duplicate the complete Harness audit stream.

## Approval

Task Runtime approval records bind:

- Task ID
- resulting Attempt ID
- Task revision
- prompt SHA-256 hash
- capability boundary
- approver and reason
- approval time

The MCP Bridge does not use `defaultApprovedBy` or `defaultApprovalReason` for Task Runtime Tasks. The existing synchronous compatibility tool retains its Alpha behavior.

## Compatibility

The legacy synchronous tools remain available. New clients should prefer `cc_create_task`, then poll `cc_get_task` and `cc_get_task_events`. Existing clients can continue using `cc_plan_task`, `cc_review_task`, `cc_run_approved_task`, `cc_get_result`, `cc_get_ledger`, and `cc_get_latest_summary`.
