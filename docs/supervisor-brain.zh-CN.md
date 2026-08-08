# Supervisor Brain v1.7 Project Continuity Layer

[English](supervisor-brain.md) | [简体中文](supervisor-brain.zh-CN.md)

Supervisor Brain 是位于 Workflow Planning 之上的责任层。它不执行 Worker，不直接创建 Task，不审批工作，也不会削弱任何 Harness Contract。

执行结束后，只读 Supervisor Review Package 会把原始请求、Decision 时冻结的 Project Memory、实现证据和 Reviewer 结果投影成一个持久化 Artifact，供之后在 ChatGPT Web 中复核。经过明确确认的 GPT 判断可以作为增量 Supervisor Review Result 返回。另一次独立的明确确认可以通过 Runtime 控制的 append contract 应用 evidence-first Memory Proposal。v1.4 的历史可靠性分析仍保留在 [Supervisor v1.4 Reliability and Review Foundation（英文）](supervisor-reliability-review.md)。

## 职责边界

| Layer | 负责 | 不负责 |
| --- | --- | --- |
| Supervisor Decision | Intent、技术目标、实现策略、预期修改、验证计划、已注册 Project、判断依据、风险、资源估计、置信度和 next action | Task 执行、approval、工具权限 |
| Project Context | Runtime 所有的 `projectId`/`workspacePath`、描述、stack、constraint、`AI_SUPERVISOR.md`、`PROJECT_MEMORY.md`、唯一选择和用户确认 | Repository exploration、Worker 执行 |
| Supervisor Session | 将 purpose、明确决策、未决问题、后续行动和多个 Workflow 与一个已注册 Project 关联 | ChatGPT message history、cloud sync、model memory |
| Project Intelligence | 持久化已确认 GPT Review Result、pending Memory Proposal 和 audited Memory application | Workflow 状态、自动 GPT 调用、任意 Memory 修改 |
| Project Continuity | 生成 evidence-derived Project Brief 和精简只读 Project Context；为 Dashboard 投影 Project Workflow Artifact | 编造 GPT 判断、导出原始事件历史、执行工作 |
| Workflow Planner | 将 Decision 转换为选中的 data-driven Workflow Definition | Worker 生命周期或生成审批 |
| Workflow Runtime | 推进 Planner、approval gate、Coder、Reviewer | 推断模型意图 |
| Task Runtime | 管理一个持久 Task/Attempt 生命周期 | Workflow 或产品决策 |

## Decision Contract

每个被接受的请求都会持久化到 `runtime-data/supervisor-decisions/<decisionId>.json`：

```json
{
  "schemaVersion": 6,
  "intent": "code_change",
  "goal": "Add CSV export to the task board",
  "goalConfidence": 0.9,
  "possibleIntentMismatch": null,
  "clarificationNeeded": false,
  "technical_summary": "Add a browser-only CSV download while preserving existing task storage.",
  "implementation_strategy": "Reuse the existing browser action pattern and serialize the current task model without changing storage.",
  "expected_changes": [
    "Add one export action to the existing task-board UI.",
    "Add browser-side CSV escaping and download logic."
  ],
  "validation_plan": [
    "Verify commas, quotes, and newlines are escaped.",
    "Verify task creation, filtering, completion, and persistence still work."
  ],
  "projectId": "dogfood-study-board",
  "workspacePath": "<projectRoot>/workspace/dogfood-study-board",
  "session": {
    "sessionId": "session_...",
    "projectId": "dogfood-study-board",
    "name": "Task board CSV export"
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

ChatGPT 可以通过 `cc_create_workflow` 的可选 `supervisorDecision` 字段提供这个结构。Local validation 仍要求已知的 Workflow Definition、一致的 Intent/next-action 组合和已注册 Project。GPT Resource 数字只是估计：Decision Layer 会补充本地解析出的 Stage Profile 与 hard cap；Task Runtime 继续执行不变的 Resource Profile Contract。Dashboard 本身没有模型进程，因此使用确定性 fallback rule。

`respond_directly` 会持久化 Decision，但不创建 Workflow。`confirm_project` 会持久化候选 Project 并暂停。`create_workflow` 是唯一会交给 Workflow Runtime 的 Action。

## Supervisor 行为 Contract

对每个请求，ChatGPT Web 都应按以下顺序工作：

1. 判断是否需要本地 Worker 证据或文件修改。
   - 解释和普通问题：`respond_directly`。
   - 有边界的项目分析：`analysis_only` 加 `create_workflow`。
   - 软件修改：`software_change` 加 `create_workflow`。
   - 仅文档修改：`documentation_change` 加 `create_workflow`。
2. 调用 `cc_list_projects`，选择一个准确的 `projectId`。如果没有合适候选或多个候选都可能正确，停止并询问用户；不要推断文件系统路径。
3. 为选中的 Project 调用 `cc_get_project_context`。继续既有工作时，调用只读 `cc_get_project_continuity`，取得 Project Brief、Memory Summary、Supervisor Session、最近 Workflow 和 Open Issue。
4. 调用 `cc_list_workflow_definitions`。选择一个准确的返回 `id`；不要发明 `feature_change`、`small_change` 等 alias。
5. 生成完整 Decision Contract：technical summary、implementation strategy、expected changes、validation plan、constraint、risk、resource estimate 和 recommended action。只复述“用户想要功能 X”是不够的。
6. 使用明确的 `projectId` 调用 `cc_create_workflow`；可以选择复用返回的 `sessionId`。GPT 编写且 `nextAction=create_workflow` 的 Decision 如果没有 `projectId` 会被拒绝。如果结果是 `project_confirmation_required`，展示候选并等待用户。如果结果是 `clarification_required`，此时没有 Workflow：取得明确回答，再通过同一个工具和返回的 Decision ID 重新生成 Decision。如果 Definition 被拒绝，应使用返回的 `availableDefinitions`，不要继续猜测。
7. Planner 完成后，展示方案与风险。没有得到明确、知情的人工决定时，绝不能调用 `cc_approve_workflow`。

Intent/Workflow mismatch 会被本地拒绝。`conversation` Decision 不能创建 Workflow；没有确认一个 Project 时，`create_workflow` 也不能继续。

`cc_get_project_context` 和 `cc_list_workflow_definitions` 是只读 capability discovery。它们不会创建 Decision、Workflow、Task、approval 或 Worker Prompt。

## Project Registry

`.agents/projects.json` 保存 release-safe Project。机器本地 Project 应将 `.agents/projects.local.example.json` 复制为被 Git 忽略的 `.agents/projects.local.json`；不要把个人路径写入 release Registry。Runtime 依次加载 release definition、local definition 和持久化 metadata overlay。Schema v3 使用 `projectId`、`name`、`workspacePath`、`aliases`、`stack` 和 `constraints`；Registry 仍接受早期 `id/path/techStack/defaultConstraints` 名称。Release/local `projectId` 冲突会被拒绝。Local path 必须是相对路径并解析到 `workspace/` 内；Dashboard 创建的受管 Project 必须是 `workspace/` 的直接子目录。受版本控制的 release Registry 可以定义仓库根目录等可信 system Project。这不允许 ChatGPT 构造路径：它必须发现已注册 `projectId`，由 Registry 在每个新 Decision 与 Workflow 中解析并冻结 `workspacePath`。缺失目录和逃逸允许根目录的路径都会被拒绝。

选择顺序：

1. 显式已注册 Project ID、名称、路径或 alias；
2. 请求中唯一匹配的 alias；
3. 唯一的已注册 Project；
4. 候选仍有歧义时，要求用户明确确认。

`AI_SUPERVISOR.md` 和 `PROJECT_MEMORY.md` 供 ChatGPT Supervisor 推理使用，不是 Claude Worker instruction，也不授予权限。每个文件上限 64 KiB。原始文本绝不会插入 Worker Prompt；Decision 只记录 revision metadata 和 GPT 派生的技术方向。Planner、Coder 与 Reviewer 接收原始目标、派生 brief、Project boundary 和 constraint。

## Project、Session 与执行轨迹

Supervisor Session 存储在 `runtime-data/project-sessions/<sessionId>.json`。Session 包含 `sessionId`、`projectId`、显示名称、purpose、明确决策、未决问题、后续行动、时间戳、source 和关联 Workflow；它不保存 ChatGPT 消息。如果 ChatGPT 提供既有 `sessionId`，Runtime 会验证它属于选中的 Project。未提供时，Runtime 为 Workflow 创建新 Session。Legacy Session Snapshot 会在读取时规范化，但不重写历史。

新的 Workflow Snapshot 会冻结 `projectId`、绝对 `workspacePath` 和 `sessionId`。每个子 Task 与 Attempt 继承相同值。Task 与 Attempt 还记录 `executionDirectory`，即实际 Harness process root。目前 Harness 仍从 Supervisor runtime root 启动，同时将已注册 Project 作为有边界的 Task Context；两种路径都会展示，不会混为一谈。缺少这些字段的既有 Workflow Snapshot 仍可读取。

## Approval 与 Diff 证据

Console 将 Decision 显示为第一个生命周期 Stage，之后依次是 Planning、Approval、Execution 和 Review。审批前会展示原始请求、technical summary、modification reason、proposed changes、合并后的 Supervisor/Planner risk、Resource Profile、expected resource 与 hard cap。决定后 approval record 仍然可见；执行后显示 Observed Diff evidence。

执行结束后的 Diff Viewer 来自成功观察到的 `Write` 与 `Edit` Tool Event。它不会把 Worker prose 当作变更证据，也不会替代现有 Audit Validator。

## Retention

Retention 在 `mcp-server/config.json` 中配置，除非禁用，否则启动时运行一次。默认保留 30 天、200 个 terminal Workflow、200 个 terminal standalone Task 和 500 个 unlinked Decision。Active Workflow/Task 永远不会被选择。使用 `node .\scripts\cleanup-runtime.mjs` 预览清理；增加 `--apply` 才会删除计划中的路径。
