# Using Supervisor from ChatGPT Web

Supervisor separates project leadership from local execution. ChatGPT is the Supervisor, Claude Code is a bounded Worker, and the Dashboard is the human control console.

| Surface | Responsibility | It does not do |
| --- | --- | --- |
| ChatGPT Web | Understand the goal, select the registered project and Workflow, keep product context, explain the plan, and perform final Supervisor review. | Execute local edits directly or approve on the user's behalf. |
| Claude Code Worker | Read or change files inside the approved project boundary and return the required audit result. | Select a project, choose its own permissions, or become the source of truth for file evidence. |
| Supervisor Dashboard | Show Projects, Workflows, stages, evidence, cost, failures, and approval controls. | Replace ChatGPT reasoning or call a GPT API. |

The Dashboard's **Local fallback entry** is a deterministic backup. The primary natural-language entry is ChatGPT Supervisor.

## Connect a new ChatGPT session

After the local Runtime and OpenAI Secure MCP Tunnel are running, connect the MCP server in ChatGPT and ask it to follow this sequence:

1. Call `cc_list_projects` and identify the registered Project.
2. Call `cc_get_project_context` and `cc_get_project_continuity` for the selected `projectId`.
3. Call `cc_list_workflow_definitions` before choosing a legal Workflow.
4. Explain the understood goal, target Project, constraints, and proposed Workflow.
5. Call `cc_create_workflow` with the exact registered `projectId`, a supported `definitionId`, and the Supervisor Decision.
6. Present the Planner result and wait for the human to approve or reject it in the Dashboard or with the existing approval tool.
7. After approval, let the Workflow Runtime advance through Coder and Reviewer.
8. Call `cc_get_supervisor_review_package` for the terminal Workflow and review the evidence against the original goal.
9. If appropriate, record an explicit Supervisor Review result. Treat any Memory proposal as pending until a human confirms it.

This sequence proves continuity without giving the Runtime access to ChatGPT conversation storage. The durable identifiers are `projectId`, `sessionId`, and `workflowId`.

## Minimal first task

Use a registered demo project and enter only:

> Add CSV export to the demo task board.

Expected product flow:

```text
Supervisor Decision
  -> Planner
  -> Human Approval
  -> Claude Code change
  -> Harness Audit
  -> Claude Reviewer
  -> Supervisor Review Package
  -> ChatGPT Supervisor Review
```

The user should not need to provide a Resource Profile, filesystem path, Worker prompt, or audit schema. ChatGPT discovers projects and Workflow Definitions through MCP; the Runtime supplies safe defaults.

## End-to-end release validation

Run this validation manually from a **new ChatGPT Web conversation**. It may start a billable Claude Worker after approval, so it is intentionally not part of automated release tests.

- [ ] ChatGPT discovers projects and identifies the demo Project without guessing a path.
- [ ] ChatGPT reads Project Context and Continuity, then summarizes current status and prior decisions.
- [ ] ChatGPT discovers legal Workflow Definitions before creation.
- [ ] The created Workflow contains the expected Decision, Project, Session, and Workflow Definition.
- [ ] The Planner remains read-only and the Dashboard shows a human checkpoint.
- [ ] No Coder Task starts before explicit approval.
- [ ] The approved Coder result passes strict observed-evidence audit.
- [ ] Reviewer validates the bounded change rather than exploring unrelated Projects.
- [ ] The Review Package contains the original goal, observed changes, checks, risks, and Reviewer result.
- [ ] ChatGPT performs a final Supervisor Review and recommends next steps.
- [ ] Any Project Memory proposal remains unapplied until explicit confirmation.

Record the Workflow id and result outside tracked source files. Do not commit API keys, tunnel URLs, proxy addresses, local paths, or Runtime data.

## Review a completed Workflow in ChatGPT

On a Completed or Failed Workflow, choose **Review in ChatGPT** in the Dashboard. Copy the generated prompt into ChatGPT Web. The prompt provides `workflowId`, `projectId`, and instructs ChatGPT to call `cc_get_supervisor_review_package`.

The Dashboard only generates handoff information. It does not call GPT, alter Workflow state, approve work, or apply Project Memory.
