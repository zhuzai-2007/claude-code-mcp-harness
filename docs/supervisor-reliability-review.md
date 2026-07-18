# Supervisor v1.4 Reliability and Review Foundation

## Reliability audit

The v1.4 audit treated each external report as a hypothesis and checked the current implementation before changing it.

| Area | Finding | v1.4 action |
| --- | --- | --- |
| Legacy Workflow Task creation | Confirmed defect: the compatibility `createTask` path read Project and Session binding from an undefined `workflow` variable. | Use the already loaded `existing` Workflow and cover the legacy path with a regression test. |
| Workflow event sequence | Confirmed defect: every query merged Workflow and Task events by timestamp and reassigned `sequence`, so a late event could move an old cursor. | Persist a source-event-to-global-sequence index per Workflow. Existing events keep their assigned number; newly discovered events append monotonically. |
| Approval binding | The legacy `cc_run_approved_task` still requires explicit task-level approval metadata and the Harness boundary, but it is not bound to a Workflow plan or approval stage. It can therefore bypass the product-level Workflow process if a Supervisor selects the wrong compatibility tool. | Keep the interface compatible and label it as standalone-only. Workflow execution must use `cc_approve_workflow`, which binds approval to the Planner Task, planned stage, generated Coder prompt, prompt hash, and capability boundary. A future hardening option is a deployment setting that disables standalone writes after clients migrate; v1.4 does not silently change existing behavior. |
| Restart recovery | Current behavior is honest: queued Tasks are re-enqueued, while an in-process `running` attempt becomes terminal `interrupted` with `runtime_restarted`; its Workflow then fails and can be retried as a new Workflow. | No change. The runtime does not claim to resume a Claude session it cannot actually restore. |
| Resource Profile loading | The small JSON file is loaded when resolving a Task. Personal-runtime Task creation volume is low, and re-reading preserves predictable config updates without cache invalidation. | No cache added. Revisit only with measured load evidence. |
| `claude-task.ps1` size | The script has separable policy, invocation, parsing, and audit sections, but splitting it would touch the most security-sensitive execution path without solving a current reliability failure. | No refactor. Extract only behind contract-level tests in a dedicated future change. |

## Stable Workflow event cursor

`runtime-data/workflows/<workflowId>/event-index.json` records the mapping from each immutable source event identity to one Workflow-global sequence. The first read preserves timestamp order for existing data. Later reads never renumber known events, even if a newly discovered Task event has an older timestamp. The API keeps the existing numeric `afterSequence` cursor.

This is a single-process file-runtime guarantee. Running multiple Bridge processes against the same `runtimeDataRoot` remains unsupported because the stores do not provide cross-process locking.

## Supervisor Review Package v1

ChatGPT Web can call the read-only `cc_get_supervisor_review_package` tool with a `workflowId`. Building a package does not run a Worker, approve a stage, edit the project, or update Project Memory. The generated package is persisted at:

`runtime-data/supervisor-review-packages/<workflowId>.json`

The package contains:

- `originalRequest` and the full persisted Supervisor `decision`;
- Supervisor strategy, Planner summary, proposed changes, and validation plan;
- Coder run result, reported files, and Harness-observed changes;
- approval, failure, per-stage resource limits, normalized audit output, recent tool evidence, and artifact names;
- the Reviewer result;
- frozen Project binding, description, stack, constraints, and Supervisor Context metadata;
- the `PROJECT_MEMORY.md` content and digest captured when the Decision was created.

`reviewReadiness` is `complete`, `failed_workflow`, or `in_progress`. The Package can therefore support failure review without pretending incomplete work succeeded.

The Memory snapshot represents the context used for that Decision rather than silently substituting newer Memory. It is read-only audit data; v1.4 never writes back to `PROJECT_MEMORY.md`.

Workflows created before Decision schema v5 may contain only Memory metadata. Their package reports `memorySnapshot.status = legacy_metadata_only` and leaves `content` empty instead of presenting current Memory as historical evidence.

Recommended ChatGPT Web flow after a Workflow finishes:

1. Call `cc_get_supervisor_review_package` with the exact Workflow id.
2. Compare the original request, Decision, Planner strategy, Coder changes, and Reviewer evidence.
3. State whether the original goal is met, distinguish reported from observed changes, and list remaining risk or a next bounded action.
4. Do not approve, retry, or create another Workflow unless the user explicitly requests it.
