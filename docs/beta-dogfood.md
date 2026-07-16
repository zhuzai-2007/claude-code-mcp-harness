# Supervisor Beta dogfood record

Date: 2026-07-15

This record distinguishes a completed product Workflow from the later reliability-layer acceptance. No mock result or network-control bypass is counted as real dogfood.

## Completed Plan -> Approval -> Run -> Review Workflow

Input: `给任务看板增加导出 JSON 功能`

The request was submitted through the local Dashboard with no path, Resource Profile, Worker prompt, or audit format supplied by the user. Workflow Planning selected `software_change`, the Planner located the registered `workspace/dogfood-study-board` project, and execution paused for explicit human approval before any write-capable Task was created.

| Item | Result |
| --- | --- |
| Workflow | `workflow_mrlu4pu2_1e2a8bb60b4a` / `completed` |
| Planner Task | `task_mrlu4pwd_90d4a01d4f7d` / `exploration_readonly` / $0.175165 |
| Coder Task | `task_mrlu6kq9_6daca3dde6a2` / `small_change` / $0.212541 |
| Reviewer Task | `task_mrlu7duj_f5deae62cbff` / `review_readonly` / $0.125453 |
| Total | 155.971 seconds / $0.513159 / 66 turns / 16 successful reads / 0 commands |

The approved scope contained only `index.html`, `app.js`, and `styles.css` under the registered task-board directory. The Coder added the control and browser download logic, re-read every modified file, and returned a strict audit result. The focused Reviewer read those same files, reported no blocker, and made no changes.

## v0.8 Reliability acceptance

### Provider Preflight

The final persisted probe ran against Claude CLI `2.1.201` from an isolated system temporary directory and completed in 7.028 seconds with classification `reachable`. The returned safety record confirmed:

- `projectContentSent=false`
- `toolsEnabled=false`
- `modificationsAllowed=false`
- `sessionPersisted=false`
- `safeMode=true`

The prompt was the product-owned connectivity marker; no project request, file content, Workflow, approval, or Worker Task was supplied. The request cost $0.00833 in this environment and remained below the $0.05 preflight hard limit.

The same Dashboard API path was also exercised inside the restricted development sandbox. It persisted `provider_timeout` instead of hanging or reporting an audit failure. This is expected evidence that the product separates a provider/environment failure from Worker audit validation.

### Failed Workflow recovery

Input: `给任务看板增加批量完成任务功能`

The failed source Workflow `workflow_mrm06rw4_b5e90b284b12` was retried through the v0.8 recovery API. Recovery created `workflow_mrm3dsto_e81f72abe293` with a new Planner Task `task_mrm3dsuo_a4bf8d6fef2b` and linked both histories. The source remained `failed`; the recovered Workflow contained zero approvals and zero rejections.

The real recovered Planner later failed at provider access with `API Error: Unable to connect to API (ConnectionRefused)`. The Dashboard classified this as:

- failed stage: `Planning`
- category: `provider_connectivity`
- retryable: `true`
- next step: run Provider Preflight, repair provider/proxy access, then create another recovery Workflow

No Coder or Reviewer was started, no approval was reused, and no file was modified. This failure is intentionally not described as a completed feature Workflow.

## Findings fixed during dogfood

- Provider Preflight now has a hard timeout and reliably reaps the direct Claude process on Windows.
- PowerShell 5.1 JSON-array argument handling explicitly expands each CLI argument, including the empty `--tools` value.
- The probe executes outside the project tree while its sanitized latest result is persisted under ignored runtime data.
- A failed Workflow is recreated from Planning with new Task and Attempt identities and fresh approval state.
- Dashboard product data exposes the failed stage, a stable failure category, plain-language explanation, recovery steps, and linked history.

The strict audit validator, approval boundary, side-effect guard, MCP tool surface, Workflow definitions, Agent roles, and global Resource Profile limits were not relaxed.

## 中文摘要

已有真实功能请求完成了 Planner、人工审批、Coder、Reviewer 全流程。v0.8 可靠性验收另外验证了两条路径：固定 Provider Preflight 在系统临时目录成功连通，未发送项目内容且未开放工具；失败 Workflow 恢复会创建新的 Workflow 和 Planner Task，保留旧历史但不复用审批。恢复后的真实 Planner 因外部 provider 拒绝连接而失败，Dashboard 正确显示为 `Planning / provider_connectivity`，没有误报为审计失败，也没有进入写入阶段。
