# Supervisor v1.8 Beta

[English](README.md) | [简体中文](README.zh-CN.md)

Supervisor 是一个**为编码 Agent 提供审批、审计、项目连续性和人工控制的本地治理层**。ChatGPT Web 担任项目负责人，受边界约束的 Claude Code Worker 负责本地执行。用户只需输入自然语言需求，系统就会形成可持久化、可审批、可审计的工作流：

```text
用户需求
  -> Workflow 规划
  -> 只读方案
  -> 人工审批
  -> 受约束的代码修改
  -> 聚焦 Review
  -> 审计结果
```

项目不训练新模型，也不是通用 Agent 平台。它复用用户已有的 AI 能力，重点解决长期本地开发任务的稳定性、透明度和安全控制。

> **Beta 表示邀请试用，不代表生产级隔离。** Supervisor 提供策略、审批、资源、side-effect 和审计 guardrail，但不是操作系统沙箱。处理不可信代码时仍应使用受限账户、虚拟机或容器。

## 五分钟快速开始

要求：Windows PowerShell、Node.js 20 或更高版本、已配置 Provider 的 Claude Code CLI，以及支持 MCP 连接的 ChatGPT Web。

1. **安装依赖。** 克隆仓库，在仓库根目录打开 PowerShell：

   ```powershell
   .\install.ps1
   ```

2. **检查并启动本地 Runtime。**

   ```powershell
   .\scripts\doctor.ps1
   .\start.ps1
   ```

   `start.ps1` 会打印 Dashboard 地址，通常是 `http://127.0.0.1:8787/supervisor/`。

3. **配置并启动 Tunnel。** 首次初始化官方 OpenAI Secure MCP Tunnel，之后使用保留在本地且不受 Git 跟踪的配置启动：

   ```powershell
   .\scripts\start-openai-tunnel.ps1 -Initialize -TunnelId "<tunnel-id>"
   .\scripts\start-openai-tunnel.ps1
   ```

   某些命令行网络环境需要设置 `HTTP_PROXY` 与 `HTTPS_PROXY`；参见[网络与代理配置](#网络与代理配置)。不要提交 Tunnel Profile、API Key、代理地址或公网端点。

4. **连接 ChatGPT。** 在 ChatGPT Web 中把 Tunnel 端点添加为 MCP 连接。要求 ChatGPT Supervisor 在创建任务前调用 `cc_list_projects`、`cc_get_project_continuity` 和 `cc_list_workflow_definitions`。

5. **运行第一个任务。** 对已注册的 Demo Project，只输入：

   > 给演示任务看板增加 CSV 导出功能。

   预期流程：

   ```text
   Supervisor Decision -> Planner -> Human Approval -> Claude Code change
   -> Harness Audit -> Claude Reviewer -> ChatGPT Supervisor Review
   ```

Dashboard 是查看状态、证据和执行审批的控制台，不替代 ChatGPT 的负责人判断。完整的新会话步骤与非自动发布验收见 [ChatGPT Web 使用指南](docs/gpt-web-usage.md)。

## 主要能力

- 在本地 Supervisor Console 中创建和观察开发任务；
- Workflow 与 Task 持久化，浏览器或 MCP 客户端断开后任务仍可继续；
- 根据请求选择软件修改、只读分析或文档修改流程；
- 在任何可写 Task 创建前提供明确的 Approve / Reject；
- 使用 Resource Profile 限制预算、turn、读取文件、命令和超时；
- 展示修改文件、Review、风险、错误、成本和资源使用；
- 将 Worker JSON 自报与 Claude Code 真实工具事件交叉验证；
- 通过 OpenAI Secure MCP Tunnel 向 ChatGPT Web 暴露固定 MCP 工具。
- 在 Workflow 创建前持久化 Supervisor Decision，记录意图、目标、项目、判断依据、流程类型、置信度和下一步动作；
- 通过 `.agents/projects.json` 管理 `projectId/workspacePath`，并用项目根目录的 `AI_SUPERVISOR.md` 与 `PROJECT_MEMORY.md` 向 GPT 提供项目上下文；
- 用 Project Session 把同一项目的多个 Workflow 关联起来，但不保存 ChatGPT 聊天内容；
- 在审批中心展示决策上下文、资源上限、规则成本估算，以及来自真实 Write/Edit 工具事件的 Diff。
- 使用固定非项目 prompt、空临时目录、禁用工具和会话持久化来执行 Provider Preflight；
- failed Workflow 可以创建全新恢复 Workflow，重新规划且不复用旧审批；
- Dashboard 会显示失败阶段、用户可理解的错误分类和恢复建议。
- 提供可重复的隔离 Demo，并记录真实 Provider、完整 Workflow、Dashboard、桌面端和移动端验收结果。
- 在 Workflow 终态提供回到 ChatGPT Web 的交接入口，并生成基于证据、必须确认的 Project Memory 更新建议。
- 通过 Project Intelligence 层保存明确确认的 GPT Review，并且只在人工确认后受控应用已存储的 Memory Proposal。
- 通过 Project Continuity 层生成基于事实的 Project Brief、跨 Workflow 的 Supervisor Session、项目优先 Dashboard 和精简只读 GPT 上下文。

## Supervisor Brain

ChatGPT 可以在 `cc_create_workflow` 调用中附带结构化 `supervisorDecision`。Decision 记录用户意图、技术目标、注册项目、简洁判断依据、风险、预计资源、推荐 Workflow/动作、置信度、是否需要 Worker 和下一步动作。v1.2 进一步记录 `technical_summary`、`implementation_strategy`、`expected_changes` 和 `validation_plan`，使 GPT 负责技术方向，而不是只转发一句需求。本地 Dashboard 没有模型进程，因此使用确定性、可解释的规则作为回退；两条入口都经过同一套项目注册、Decision 持久化和 Workflow 校验。

Decision 会先写入 `runtime-data/supervisor-decisions/`。只有目标项目已经唯一确定，且 `nextAction=create_workflow` 时，才会交给 Workflow Runtime。项目有歧义时返回 `project_confirmation_required`，不会创建 Workflow，更不会启动 Worker。

调用 `cc_create_workflow` 前，ChatGPT Supervisor 必须依次调用 `cc_list_projects`、`cc_get_project_context` 和 `cc_list_workflow_definitions`。项目上下文返回 Registry 工作区、GPT-only instructions、Project Memory 和已有 Session。GPT 创建 Workflow 时必须显式传入注册的 `projectId`，也可以复用同项目的 `sessionId`；缺少项目、跨项目复用 Session 或未知 Workflow 都会被本地拒绝。若目标仍然模糊、高风险或置信度不足，Decision 会进入 `waiting_for_clarification`，不会创建 Workflow；用户明确回答后才会重新生成一个关联的新 Decision。

```text
Supervisor Decision -> Project Context -> Workflow Planner -> Workflow Runtime -> Task Runtime
```

GPT 的行为顺序是：理解真实目标，判断是否需要 Worker，查询并确认注册项目，读取 Supervisor Context，制定技术方向和验证计划，查询合法 Workflow，最后创建 Workflow。解释类请求使用 `respond_directly`，项目分析使用 `analysis_only`，代码修改使用 `software_change`。本地会拒绝 Intent/Workflow 不一致和让 Worker 猜目录的请求。Decision Layer 不直接创建 Task，不生成审批，也不能绕过既有安全边界。详细设计见 [Supervisor Brain](docs/supervisor-brain.md)。

## Windows 快速开始

环境要求：

- Windows PowerShell 5.1 或 PowerShell 7；
- Node.js 20 或更高版本；
- 已配置兼容模型 Provider 的 Claude Code CLI。

Clone 仓库后执行：

```powershell
.\install.ps1
.\scripts\doctor.ps1
.\start.ps1
```

以上三条命令即可启动本地 Dashboard。第一次执行真实 Worker 任务前，可按需运行隔离的外部模型连通性检查；该探针可能产生最低单次费用：

如果 `node` 当前不在 `PATH`，但 Doctor 发现已有 nvm 安装，必需的 Node 检查仍会失败；输出会列出 nvm 路径和已安装版本，并建议执行 `nvm use <version>`，不会误导用户重复安装 Node。

```powershell
.\scripts\doctor.ps1 -ProviderPreflight
```

打开 `start.ps1` 打印的控制台地址，默认是：

```text
http://127.0.0.1:8787/supervisor/
```

输入普通需求，例如：

```text
给任务看板增加导出 JSON 功能
```

Supervisor 会先持久化 Decision，再进行只读规划。紧凑的 Workflow 顶栏在 Workflow 摘要与阶段时间线之间切换，不再同时占用高度。时间线按需只显示 Decision/Plan、Approval、Implementation 或 Review 页面；已完成和当前阶段可查看，未来阶段不可点击。整体状态默认折叠，独立固定的 Recent Work 栏可以收起和恢复。检查有边界的计划后，填写审批人和决策理由，再明确选择 Approve 或 Reject。审批信息属于本地审计元数据，不等同于身份认证。

Dashboard 默认跟随浏览器语言，也可手动切换中文/English。Recent Work 按日期分组；显示名称和归档状态单独保存在已忽略的 `runtime-data/supervisor-workflow-metadata/`，不会重写 Workflow 快照或事件。ChatGPT Supervisor 仍是主要请求入口，Dashboard 的 **备用本地入口** 默认折叠，仅作为本地规则模式备用。

首次使用前请检查 `.agents/projects.json`。项目路径必须相对于 `projectRoot`；当控制台要求确认项目时，确认后仍然只会先启动只读 Planner。

默认 `doctor.ps1` 不会调用外部模型。显式添加 `-ProviderPreflight` 后，只会从隔离的空临时目录发送固定连通性标记，工具和会话持久化均关闭；不会发送项目内容，也不会创建 Workflow。该探针可能产生 Provider 的最低单次请求费用。

Workflow 失败后，Dashboard 会展示失败阶段，并区分 provider 连接、认证、timeout、资源、环境和审计契约问题。**Create recovery workflow** 会创建新的 Workflow、重新执行 Planner，并链接新旧历史；旧 approval/rejection 不会复制，新的可写阶段仍需重新审批。

## 自主 Beta 验收

v0.9 使用隔离项目 `workspace/autonomous-beta-demo` 和真实 Provider 完成验收。只输入自然语言搜索需求后，系统依次完成 Decision → Planner → 显式受限测试审批 → Coder → Reviewer；随后使用 Microsoft Edge 独立验证关键词搜索、状态组合筛选、计数和空状态。验收发现 360px 小屏工具栏真实溢出，又通过第二个完整审计 Workflow 做最小修复，并在 360px 和 1280px 下重新验证。

验收驱动只在检查 Planner 结果后写入具名审批元数据；产品没有自动批准，也没有移除审批边界。详细证据见 [v0.9 自主验收记录](docs/v0.9-autonomous-validation.md)。可重复的无依赖契约测试：

```powershell
node .\workspace\autonomous-beta-demo\demo.test.mjs
```

## v1.0-beta 发布准备

v1.0-beta 是发布收敛版本，不是 Runtime 重构。它保持 v0.9 的 Decision、Workflow、Task、审批、资源和审计边界不变，只收紧首次使用说明、版本检查、发布文件可见性和可重复的 Todo 验收。详见 [v1.0-beta 发布审计](docs/v1.0-beta-release-audit.md)。

## v1.8 Beta 发布候选

v1.8 把 Decision、Project Context、Project Intelligence、Human-GPT Collaboration 与 Project Continuity 收敛成公开 Beta 候选。新增的 Project Health 与发布状态完全由已有 Workflow、Review、Memory 元数据和静态发布元数据确定，不引入 Runtime AI 判断，也不改变 Task/Workflow、Harness、审计、Resource Profile 或审批边界。参见 [Changelog](CHANGELOG.md) 与 [ChatGPT Web 发布验收](docs/gpt-web-usage.md#end-to-end-release-validation)。在完成新会话人工验证前，候选状态保持为 `pending_gpt_web_validation`。

## 架构

```text
ChatGPT Web / Supervisor Console
              |
    MCP Bridge / 本地 Product API
              |
     Supervisor Decision Layer
              |
       Project Context Layer
              |
       Workflow Planning
              |
      Workflow Orchestrator
              |
         Task Runtime
              |
 Harness / Approval / Policy / Audit
              |
       Claude Code Worker
              |
          项目工作区
```

| 层 | 职责 |
| --- | --- |
| Supervisor Console | 输入需求、查看最近任务、审批、结果和可理解的安全状态。 |
| Supervisor Decision | 持久化意图、目标、注册项目、技术方向、预期修改、验证计划、置信度、约束和下一步动作；不能创建 Task。 |
| Project Context | 管理注册的 `projectId/workspacePath`，暴露受限的 GPT-only instructions 与 Project Memory；目标有歧义时停止。 |
| Project Session | 用文件元数据把 Workflow 归属到一个项目；不保存 ChatGPT 消息。 |
| Workflow Planner | 选择数据驱动 Definition，记录目标、原因、约束和阶段。 |
| Workflow Orchestrator | 推进阶段并按顺序创建 Task，不能生成或绕过审批。 |
| Task Runtime | 持久化 Task/Attempt 生命周期、heartbeat、事件、取消和重启恢复。 |
| Harness | 执行项目路径、工具、审批、资源、副作用和审计契约。 |
| Worker | 通过 Claude Code 完成受约束的读取和已审批修改。 |

现有 MCP 工具保持兼容。v1.2 仅增量增加只读 `cc_list_workflow_definitions`，不改变现有工具输入或行为。产品控制台使用 Bridge 内的产品 API，并调用同一个 Workflow Runtime 和审批边界；不会直接调用 Worker 或 Harness。

v1.4 增加只读 `cc_get_supervisor_review_package` 投影：它持久化原始需求、Decision 时冻结的 Project Memory、实现证据和 Reviewer 结果，供 ChatGPT Web 在不重新运行 Agent 的情况下复核已完成或失败的 Workflow。旧 `cc_run_approved_task` 仍是独立任务兼容入口，不会批准或推进 Workflow；Workflow 的人工检查点必须使用 `cc_approve_workflow`。

v1.5 在 completed/failed Workflow 页面增加紧凑的 **在 ChatGPT 中审查** 交接入口。Dashboard 只提供 Workflow/Project id、现有 Review Package 工具调用和建议提示词，不调用 GPT API。需要 GPT 判断的字段在明确提交 Review Result 前保持为空。

v1.6 增加 Project Intelligence 层。`cc_record_supervisor_review_result` 可以保存经过明确确认的 ChatGPT Supervisor 结论，但不改变 Workflow 状态。待处理的证据型 Proposal 只能通过 `cc_apply_memory_update_proposal` 或本地 Dashboard，在具名确认后应用；Runtime 仅追加到 `Recent Evolution`，保留原 Memory，并记录前后 digest，整个过程不运行 Worker。详见[架构说明](docs/ARCHITECTURE.md)和 [Project Memory 分层](docs/project-memory.md)。

v1.7 增加 Project Continuity。Dashboard 默认进入 Project Overview，按页查看 Brief、Memory、Sessions、近期 Workflows 和开放问题；Artifact Center 只读展示已有 Plan、Approval、Execution Evidence、Changes、Review 和 Memory Impact。新增 MCP 仅有只读的 `cc_get_project_continuity`，不会返回庞大的事件历史。Project Brief 只有在明确确认并保存 GPT Supervisor Review 后才会包含建议，不会从 Worker 自述或未确认 Session 上下文伪造判断。

## Workflow 类型

定义保存在 `.agents/workflow-definitions.json`：

| 类型 | 使用场景 | 阶段 |
| --- | --- | --- |
| `software_change` | 功能和 bug 修复 | plan -> approval -> implementation -> review |
| `analysis_only` | 架构或项目分析 | 只读 analysis |
| `documentation_change` | README 和文档修改 | plan -> approval -> documentation change -> review |

当前 Workflow Planner 使用确定性规则，选择原因可以直接查看。模糊请求默认进入 `software_change`；MCP 调用者仍可显式传入 `definitionId`。

## 审批与安全

在需要审批的阶段之前：

- coder Task 尚不存在；
- 不会启动可写 Worker；
- 控制台展示 Planner 证据和 Resource Profile；
- Approve 会记录审批人、理由、Planner Task/Attempt、coder prompt hash 和 capability boundary；
- Reject 会终止 Workflow，不创建 coder Task。

控制台以普通用户可以理解的方式展示安全策略：

**允许**

- 读取配置项目内的文件；
- 在明确审批后修改批准的工作区；
- 使用当前模式和 policy 允许的工具。

**禁止**

- 修改项目工作区之外的文件；
- 执行未授权命令或在只读阶段写入；
- 未审批就启动可写阶段；
- 接受未通过严格审计契约的结果。

这些措施不是进程级隔离。详见 [SECURITY.md](SECURITY.md)。

## 配置与密钥

可公开、可版本化配置：

- `.agents/policy.json`：模式和工具策略；
- `.agents/resource-profiles.json`：资源包和全局硬上限；
- `.agents/workflow-definitions.json`：Workflow 选择信息和阶段；
- `.agents/projects.json`：注册的相对项目路径和选择别名；
- `AI_SUPERVISOR.md`：可选、仅供 GPT 使用的项目指令；原文不会复制到 Worker prompt；
- `PROJECT_MEMORY.md`：可选、仅供 GPT 使用的项目目标、技术决策、重要修改、已知问题与后续计划；
- `mcp-server/config.example.json`：只包含占位符的 Bridge 模板。

机器本地、已忽略配置：

- `mcp-server/config.json`：工作区路径、本地端口、超时和 Origin；
- `.agents/local.config.json`：旧版本地设置；
- runtime 数据、Worker 产物、Tunnel profile 和日志。

Provider key、`CONTROL_PLANE_API_KEY`、代理凭据、Tunnel ID 和 runtime token 只能保存在环境变量或操作系统密钥设施中。不要写入 JSON 示例或提交仓库。详见 [配置与密钥](docs/configuration.md)。

## ChatGPT Web 与 Secure MCP Tunnel

只使用本地 Dashboard 时不需要 Tunnel。连接 ChatGPT Web 时，请安装 `tunnel-client`，通过受支持的 OpenAI 流程获取 runtime key，并在单独终端执行：

```powershell
$env:CONTROL_PLANE_API_KEY="<tunnel-runtime-key>"
.\scripts\start-openai-tunnel.ps1 -Initialize -TunnelId "<tunnel-id>" -DoctorOnly
.\scripts\start-openai-tunnel.ps1
```

如果命令行访问外部网络需要代理：

```powershell
$env:HTTP_PROXY="http://127.0.0.1:<proxy-port>"
$env:HTTPS_PROXY="http://127.0.0.1:<proxy-port>"
```

浏览器能访问 ChatGPT，不代表 `tunnel-client` 或 Claude Code 能访问各自的外部服务。不要提交真实代理地址或凭据。详见 [Secure MCP Tunnel](docs/secure-mcp-tunnel.md)。

## 验证

以下检查不会调用付费 Worker：

```powershell
# Harness、审计、policy、Resource Profile 和 side-effect fixture
.\.agents\tests\smoke.ps1

# 隔离启动 Bridge，并完成 mock MCP Workflow
.\scripts\test-mcp-protocol.ps1

# Runtime 和产品 UI 测试
node .\runtime\workflow-planner.test.mjs
node .\runtime\workflow-runtime.test.mjs
node .\runtime\supervisor-brain.test.mjs
node .\runtime\project-continuity.test.mjs
node .\runtime\runtime-retention.test.mjs
node .\runtime\harness-runner.test.mjs
node .\runtime\provider-preflight.test.mjs
node .\runtime\failure-catalog.test.mjs
node .\workspace\autonomous-beta-demo\demo.test.mjs
node .\workspace\release-beta-todo-demo\demo.test.mjs
node .\mcp-server\supervisor-dashboard-routes.test.mjs
node .\mcp-server\supervisor-product-view.test.mjs
node .\workspace\supervisor-dashboard\dashboard-ui.test.mjs
.\scripts\doctor-nvm.test.ps1
```

只有在确认模型费用和项目边界后，才应执行真实 Worker 测试。

一次脱敏后的 Planner → 审批 → Coder → Reviewer 真实成功记录见 [Beta dogfood](docs/beta-dogfood.md)。

Runtime retention 默认在启动时执行一次：保留 30 天内最多 200 个终态 Workflow、200 个终态独立 Task 和 500 个未关联 Decision；对应历史过期时一并清理关联 Attempt 产物，活动任务不会被选中。可先预览，再显式执行：

```powershell
node .\scripts\cleanup-runtime.mjs
node .\scripts\cleanup-runtime.mjs --apply
```

发布前运行 `.\scripts\check-release-baseline.ps1`。它会拒绝未收敛的 Git 工作区，以及被错误跟踪的本地配置、runtime、备份或日志文件。开发过程中可用 `-SkipGitClean` 只检查版本和跟踪边界。

## 向其他项目安装便携 Harness

默认 `install.ps1` 用于准备当前 clone。如果只想把 `.agents` Harness 安装到另一个已有项目：

```powershell
.\install.ps1 -TargetProject D:\path\to\another-project
```

除非显式传入 `-Force`，否则不会覆盖已有 policy、Resource Profile 和 Workflow Definition。历史运行记录不会被复制。

## 当前 Beta 限制

- Windows 是主要验证平台；
- 本地 Dashboard 的 Decision 回退仍是规则系统；ChatGPT MCP 可提供模型生成的结构化 Decision，但仍需通过本地项目和 Workflow 校验；
- 阶段按顺序运行，不支持并行 Agent、分支或自动重试策略；
- Dashboard 使用轮询，没有通知服务；
- 审批人名称是本地审计元数据，不是经过认证的身份；
- Artifact 视图提供审计摘要、修改文件列表和原始结果链接，不是完整编辑器或富 Diff 工具；
- Bridge 应保持绑定本机回环地址；公网接入需要受支持的 Secure MCP Tunnel 和谨慎配置；
- 第三方模型适配器的成本统计可能与上游账单存在差异。

## 项目缘起

这个项目最初是一个个人实验：让 ChatGPT 负责高层思考和交互，让成本更低、兼容 Claude Code 的 Worker 完成本地执行。真正困难的部分并不是增加更多“Agent 智能”，而是持久化任务、明确审批、基于证据的审计、资源控制，以及让普通用户能够看懂并控制整个流程。Supervisor Beta 是向个人 Codex-like 系统继续迈出的一步。

欢迎提交保持监督和安全边界的小范围改进。安全问题请按 [SECURITY.md](SECURITY.md) 私下报告。项目使用 [MIT License](LICENSE)。
