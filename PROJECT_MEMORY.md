# Supervisor Runtime Project Memory

## Project goal

Provide a personal, local software-engineering Supervisor in which ChatGPT owns intent and technical direction while bounded Claude Code Workers perform audited execution.

## Architecture

- ChatGPT Web uses the MCP Bridge for project discovery and Workflow control.
- Supervisor Decisions are persisted before Workflow creation.
- Workflow Runtime coordinates Planner, explicit approval, Coder, and Reviewer stages.
- Task Runtime persists attempts and events; the Harness enforces resource, tool, side-effect, and audit boundaries.
- The Dashboard is a dependency-free local console for projects, sessions, approvals, events, and results.

## Technical decisions

- Registered project paths are the source of truth; GPT must not invent workspace paths.
- `AI_SUPERVISOR.md` and this file are GPT Supervisor context, not raw Worker prompts.
- Runtime metadata remains file-backed under `runtime-data`; no database is used.
- Human approval and strict Worker audit validation remain mandatory for write-capable stages.

## Completed milestones

- Durable Task and Workflow lifecycles.
- Resource Profiles and classified Worker failures.
- Separate plan, run, and review audit contracts.
- GPT-native Supervisor Decision and project context discovery.
- Local Dashboard with staged navigation, workflow folders, approval, artifacts, and diffs.
- Human-GPT Review handoff, confirmed Supervisor Review Results, and confirmation-required Memory proposals.
- Project Continuity with Project Briefs, Sessions, Artifact Center, and deterministic Project Health.

## Known limitations

- ChatGPT session identity must be passed explicitly; the Runtime cannot inspect ChatGPT conversation storage.
- The Worker process is launched from the Supervisor runtime root, while the registered project workspace is enforced as task context and an auditable boundary.
- Project Memory is maintained as Markdown and is not automatically summarized or modified by another model.
- Public Beta readiness still requires the documented fresh-session ChatGPT Web validation.

## Next steps

- Run and record the v1.10 fresh-session ChatGPT Web end-to-end validation.
- Use real dogfood feedback to calibrate onboarding and Project Health without adding Runtime AI judgment.
- Continue tightening traceability between registered workspace, Workflow, Task, Attempt, Review Package, and observed tool evidence.
