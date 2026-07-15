# Supervisor Beta dogfood record

Date: 2026-07-15
Input: `给任务看板增加导出 JSON 功能`
Final status: `completed`

The request was submitted through the local Dashboard with no path, Resource Profile, Worker prompt, or audit format supplied by the user. Deterministic Workflow Planning selected `software_change`, the Planner located `workspace/dogfood-study-board`, and execution paused for explicit human approval before any write-capable Task was created.

## Completed Workflow

| Item | Result |
| --- | --- |
| Workflow | `workflow_mrlu4pu2_1e2a8bb60b4a` |
| Planner Task | `task_mrlu4pwd_90d4a01d4f7d` / `exploration_readonly` / $0.175165 |
| Coder Task | `task_mrlu6kq9_6daca3dde6a2` / `small_change` / $0.212541 |
| Reviewer Task | `task_mrlu7duj_f5deae62cbff` / `review_readonly` / $0.125453 |
| Total | 155.971 seconds / $0.513159 / 66 turns / 16 successful reads / 0 commands |

Approved scope was limited to three project-local files:

- `workspace/dogfood-study-board/index.html`
- `workspace/dogfood-study-board/app.js`
- `workspace/dogfood-study-board/styles.css`

The Coder added an Export JSON control, client-side Blob download logic, and matching styles. It re-read all three modified files before returning the strict audit result. The focused Reviewer then read exactly those three files, confirmed the DOM binding, download implementation, and CSS selectors, reported no blocker, and made no changes.

## Dogfood findings fixed before the successful run

- Supervisor routes no longer parse an already consumed MCP Express request stream.
- Upstream API connection failures preserve the real provider message.
- Software Planner and Coder stages use task-appropriate bounded profiles instead of `small_readonly`.
- Normal Workflow approval is no longer described to the Planner as a Worker blocker.
- Audit path normalization preserves dot-directory names such as `.agents`.
- The Harness provides a names-only `workspace/` directory manifest for path-free discovery; it is navigation metadata, not Read evidence.
- The full system prompt is passed with `--system-prompt-file`, avoiding the Windows command-line limit.

The strict audit validator, approval boundary, side-effect guard, MCP tool surface, and global Resource Profile hard limits were not relaxed.

## v0.7 RC GPT-native acceptance attempt

On 2026-07-15 the request `给任务看板增加批量完成任务功能` was submitted through MCP with a GPT-authored Supervisor Decision. The persisted Decision selected the registered `dogfood-study-board` project explicitly, recorded the technical summary, project constraints, two risks, recommended actions, and an advisory resource estimate within the Workflow hard caps. Workflow `workflow_mrm06rw4_b5e90b284b12` and its read-only Planner Task were created normally.

The external Worker then ended after 189 seconds with `worker_crash: API Error: Unable to connect to API (ConnectionRefused)`. The attempt consumed one turn, read no files, made no changes, and never reached human approval, Coder, or Reviewer. The Dashboard product API retained the GPT Decision and the real provider error. No mock result or network-control bypass was used to claim completion.

Recovery is operational: verify that the Claude CLI can reach its configured provider from the same terminal environment, including any required proxy and credentials, then create a new Workflow. Because no Planner result existed, there is no plan or approval that should be reused.

## 中文摘要

最终真实验收只输入“给任务看板增加导出 JSON 功能”，系统完成了 Planner → 人工审批 → Coder → Reviewer。成功 Workflow 总耗时 155.971 秒，总成本 $0.513159；三个阶段均通过 Harness 审计。Coder 仅修改计划批准的三个前端文件，Reviewer 只读核验这三个文件，没有执行命令或修改文件。
