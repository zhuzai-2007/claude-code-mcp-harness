# Worker Harness Status

Version: v0.1

Status: usable

## v0.1 Capabilities

- `plan`, `run`, and `review` modes.
- Approval gate for `run` mode through `-ApprovedBy` and `-ApprovalReason`.
- Standard result classes: `success`, `policy_blocked`, `invalid_input`, `worker_failed`, and `environment_failed`.
- Stable machine-readable output in `worker-result.normalized.json`.
- Timeout handling that writes `result.json`, `worker-result.normalized.json`, and `claude-error.txt`.
- `summary.ps1` can read latest runs and incomplete runs.
- `approved-demo.ps1` validates an approved minimal edit flow.
- `install.ps1` supports portable installation into another project.
- JSON CLI boundary is stable enough for a future thin MCP wrapper.

## Known Non-Blocking Items

- The current test directory has an invalid `.git` state. This was intentionally not repaired.
- `.agents/runs` has had ACL/fallback issues in this environment. Fallback to `.agent-runs` is available and working.
- Claude CLI non-interactive calls depend on current authentication, API, and provider availability. Before use, confirm `claude -p "Return exactly OK and nothing else."` returns `OK`.
- Human-readable `summary.ps1` output can be polished later. Machine-readable normalized results are the reliable interface.

## Final Acceptance Commands

```powershell
claude -p "Return exactly OK and nothing else."
.\.agents\approved-demo.ps1 -WorkerTimeoutSeconds 300
.\.agents\summary.ps1 -RunId latest -IncludeIncomplete
.\.agents\tests\smoke.ps1
.\.agents\claude-task.ps1 run -Task "Return slowly enough to trigger timeout." -ApprovedBy Codex -ApprovalReason "timeout regression" -WorkerTimeoutSeconds 1
```

## Freeze Notes

- Do not use `--dangerously-skip-permissions` or `bypassPermissions`.
- Do not treat this harness as an OS-level sandbox. It is a policy and workflow boundary.
- Do not implement an MCP server or HTTP server in v0.1.
- Current harness is marked as v0.1 usable.
