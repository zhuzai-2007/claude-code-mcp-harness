# Worker Harness Status

Product version: v1.0.0-beta.1

Status: v1.0-beta release candidate for single-user, operator-controlled local use; local gates pass, while the release Todo real-provider acceptance is pending provider connectivity.

## Current Capabilities

- `plan`, `run`, and `review` worker modes.
- A Streamable HTTP MCP Bridge with fixed plan, review, approved-run, summary, result, and ledger tools.
- Approval metadata gate for `run` mode through `ApprovedBy` and `ApprovalReason`.
- Project-root, external-directory, tool, budget, and timeout boundaries.
- Claude Code `stream-json` capture and independent tool-event auditing.
- Cross-validation of Worker claims against successful, non-denied tool results.
- Stable normalized results and run-ID recovery.
- Portable Harness installation and Secure MCP Tunnel integration.
- File-backed Task and Attempt identity with asynchronous creation, persistent states, lifecycle events, cursor queries, heartbeat, and stage reporting.
- Explicit Task Runtime approval bound to Task revision, prompt hash, capability boundary, and Attempt.
- Runtime restart reconciliation: queued Tasks resume scheduling and formerly running Tasks become `interrupted` rather than being duplicated.
- Persistent Supervisor Decision contract for GPT-authored intent, technical summary, registered project, risks, resource estimate, recommended actions, confidence, and next action.
- Registered Project Context with technology stack, aliases, default constraints, confirmation on ambiguity, and runtime-derived last-used metadata.
- Data-driven Workflow planning and sequential Planner -> human approval -> Coder -> Reviewer orchestration.
- Local Dashboard for Decision, lifecycle, approval, observed resource use, artifacts, evidence-derived Diff, and review results.
- Runtime retention and release-baseline checks for terminal history and repository hygiene.
- Explicit provider preflight using a fixed prompt, isolated empty directory, no tools, no session persistence, and no project content.
- Failed Workflow recovery that creates new history from Planning and never reuses approval metadata.
- User-facing failure categories, failed-stage explanations, recovery steps, and linked recovery history in the Dashboard.
- An isolated static validation project with repeatable behavior checks and recorded real Provider/Workflow/browser acceptance.

## Important Boundaries

- Approval metadata is a workflow and audit gate, not cryptographic proof of human consent.
- The ledger is a local review aid, not an append-only or tamper-proof security log.
- MCP annotations, prompts, policy, approval fields, and event auditing are defense-in-depth guardrails; none is a standalone sandbox.
- Live behavior depends on the Claude CLI, provider, terminal trust, and event completeness.
- Legacy synchronous browser calls may time out before the Worker; recover those calls by run ID with `cc_get_result`.
- Durable Tasks continue after their creating MCP client disconnects as long as the local Bridge remains running.
- Runtime restart does not resume a Claude session. A formerly running Attempt is marked `interrupted` for operator review.
- Detailed Claude tool events are still written by the Harness after completion; the first-stage Runtime records lifecycle, phase, approval, heartbeat, and terminal events rather than duplicating the audit stream.
- Notifications, multi-Agent orchestration, distributed queues, databases, OS-level sandboxing, and Claude session recovery are not implemented.

## Release Checks

```powershell
.\.agents\tests\smoke.ps1
node .\runtime\task-runtime.test.mjs
node .\runtime\supervisor-brain.test.mjs
node .\runtime\workflow-runtime.test.mjs
node .\mcp-server\supervisor-dashboard-routes.test.mjs
node .\workspace\autonomous-beta-demo\demo.test.mjs
node .\workspace\release-beta-todo-demo\demo.test.mjs
.\scripts\test-mcp-protocol.ps1
.\scripts\scan-doc-hygiene.ps1
.\scripts\check-release-baseline.ps1
.\scripts\validate-skill-lite.ps1
```

Run real plan/write acceptance only in an operator-controlled environment with the intended provider and the smallest practical budget.

## Safety Invariants

- Do not use `--dangerously-skip-permissions` or `bypassPermissions`.
- Do not treat this Harness as an OS-level sandbox.
- Do not expose the loopback Bridge directly to unauthenticated public ingress.
- Do not treat Worker self-reporting as sufficient acceptance evidence.
