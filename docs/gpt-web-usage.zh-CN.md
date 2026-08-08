# 从 ChatGPT Web 使用 Supervisor

[English](gpt-web-usage.md) | [简体中文](gpt-web-usage.zh-CN.md)

Supervisor 将项目负责人判断与本地执行分开：ChatGPT 是 Supervisor，Claude Code 是受边界约束的 Worker，Dashboard 是人工控制台。

| 界面 | 职责 | 不负责 |
| --- | --- | --- |
| ChatGPT Web | 理解目标、选择已注册 Project 与 Workflow、保持产品上下文、解释方案，并进行最终 Supervisor Review。 | 直接执行本地修改，或替用户审批。 |
| Claude Code Worker | 在已批准的项目边界内读取或修改文件，并返回要求的审计结果。 | 选择 Project、自行决定权限，或成为文件证据的事实来源。 |
| Supervisor Dashboard | 展示 Project、Workflow、阶段、证据、成本、失败和审批控制。 | 替代 ChatGPT 推理，或调用 GPT API。 |

Dashboard 的 **Local fallback entry** 是确定性备用入口。主要自然语言入口是 ChatGPT Supervisor。

## 确定目标 Project

告诉 ChatGPT 这次工作应该在哪一个已注册 Project 中完成。Project 名称，以及必要时它在 `workspace/` 下的目录名称，只是定位线索，不是构造路径的权限。例如：

> 我要在已注册的 Project“My First Demo”中完成这个任务。它是 `workspace/` 下的 My First Demo 项目。请先确认对应 `projectId`、读取 Project Context，再规划，不要自行猜测或构造 `workspacePath`。

Dashboard 创建的受管 Project 是仓库 `workspace/` 的直接子目录。本地 Registry 条目必须使用 `workspace/` 内的仓库相对路径。ChatGPT 必须执行 Project discovery 并传入准确的已注册 `projectId`；由 Runtime Registry 负责 `projectId` 到 `workspacePath` 的映射。不要要求 ChatGPT 扫描未注册目录，也不要把任意绝对路径当作 Project。

## 连接新的 ChatGPT 会话

本地 Runtime 与 OpenAI Secure MCP Tunnel 启动后，在 ChatGPT 中连接 MCP server，并要求它遵循以下顺序：

1. 调用 `cc_list_projects`，识别已注册 Project。
2. 使用选定的 `projectId` 调用 `cc_get_project_context` 与 `cc_get_project_continuity`。
3. 在选择合法 Workflow 前调用 `cc_list_workflow_definitions`。
4. 解释理解到的目标、目标 Project、约束和建议 Workflow。
5. 使用准确的已注册 `projectId`、受支持的 `definitionId` 和 Supervisor Decision 调用 `cc_create_workflow`。
6. 展示 Planner 结果，等待用户在 Dashboard 或通过现有审批工具批准或拒绝。
7. 审批后，由 Workflow Runtime 推进 Coder 和 Reviewer。
8. 对终态 Workflow 调用 `cc_get_supervisor_review_package`，将证据与原始目标对照复核。
9. 适当时，记录一次明确确认的 Supervisor Review Result。任何 Memory Proposal 在人工确认前都保持 pending。

这条顺序不需要让 Runtime 访问 ChatGPT conversation storage，也能保持连续性。持久化标识符是 `projectId`、`sessionId` 和 `workflowId`。

## 最小首次任务

使用一个已注册 Demo Project，并明确指出它：

> 请在已注册的 Project“Release Beta Todo Demo”中为任务看板增加 CSV 导出功能。规划前先解析它的准确 `projectId`。

预期产品流程：

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

用户需要说明目标注册 Project，但不需要提供 Resource Profile、文件系统路径、Worker Prompt 或 Audit Schema。ChatGPT 通过 MCP 发现 Project 与 Workflow Definition；Runtime 提供已注册路径和安全默认值。

## 端到端发布验收

应在一个**新的 ChatGPT Web 会话**中手工执行此验收。审批后可能启动产生费用的 Claude Worker，因此它不会被自动 release test 执行。

- [ ] ChatGPT 发现 Project，并在不猜测路径的情况下识别 Demo Project。
- [ ] ChatGPT 读取 Project Context 与 Continuity，然后总结当前状态和既有决策。
- [ ] ChatGPT 在创建前发现合法 Workflow Definition。
- [ ] 创建出的 Workflow 包含预期 Decision、Project、Session 和 Workflow Definition。
- [ ] Planner 保持只读，Dashboard 显示人工检查点。
- [ ] 明确审批前没有 Coder Task 启动。
- [ ] 已审批的 Coder 结果通过严格 observed-evidence audit。
- [ ] Reviewer 验证受边界约束的修改，而不是探索无关 Project。
- [ ] Review Package 包含原始目标、Observed Changes、检查、风险和 Reviewer 结果。
- [ ] ChatGPT 完成最终 Supervisor Review，并建议后续步骤。
- [ ] 所有 Project Memory Proposal 在明确确认前都不应用。

将 Workflow ID 与结果记录在被 Git 跟踪的源码文件之外。不要提交 API Key、Tunnel URL、代理地址、本地路径或 Runtime Data。

## 在 ChatGPT 中复核已完成的 Workflow

对于 Completed 或 Failed Workflow，在 Dashboard 中选择 **Review in ChatGPT**。复制生成的 Prompt 并粘贴到 ChatGPT Web。该 Prompt 会提供 `workflowId`、`projectId`，并要求 ChatGPT 调用 `cc_get_supervisor_review_package`。

Dashboard 只生成交接信息。它不会调用 GPT、改变 Workflow 状态、审批工作或应用 Project Memory。
