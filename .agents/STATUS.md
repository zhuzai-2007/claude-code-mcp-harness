# Worker Harness Status

Version: v0.1.1-alpha

Status: dogfood-validated synchronous Alpha; not production-ready.

## Current Capabilities

- `plan`, `run`, and `review` worker modes.
- A Streamable HTTP MCP Bridge with fixed plan, review, approved-run, summary, result, and ledger tools.
- Approval metadata gate for `run` mode through `ApprovedBy` and `ApprovalReason`.
- Project-root, external-directory, tool, budget, and timeout boundaries.
- Claude Code `stream-json` capture and independent tool-event auditing.
- Cross-validation of Worker claims against successful, non-denied tool results.
- Stable normalized results and run-ID recovery.
- Portable Harness installation and Secure MCP Tunnel integration.

## Important Boundaries

- Approval metadata is a workflow and audit gate, not cryptographic proof of human consent.
- The ledger is a local review aid, not an append-only or tamper-proof security log.
- MCP annotations, prompts, policy, approval fields, and event auditing are defense-in-depth guardrails; none is a standalone sandbox.
- Live behavior depends on the Claude CLI, provider, terminal trust, and event completeness.
- Synchronous browser calls may time out before the Worker; recover by run ID with `cc_get_result`.
- Phase B queues, leases, runtime approvals, notifications, and automatic recovery are not implemented.

## Release Checks

```powershell
.\.agents\tests\smoke.ps1
.\scripts\test-mcp-protocol.ps1
.\scripts\scan-doc-hygiene.ps1
.\scripts\validate-skill-lite.ps1
```

Run real plan/write acceptance only in an operator-controlled environment with the intended provider and the smallest practical budget.

## Safety Invariants

- Do not use `--dangerously-skip-permissions` or `bypassPermissions`.
- Do not treat this Harness as an OS-level sandbox.
- Do not expose the loopback Bridge directly to unauthenticated public ingress.
- Do not treat Worker self-reporting as sufficient acceptance evidence.
