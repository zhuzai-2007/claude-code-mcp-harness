# Supervisor v1.10 Beta

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

要求：Windows PowerShell、Node.js 20 或更高版本、已配置 Provider 的 Claude Code CLI，以及能够使用所需 custom MCP action 的 ChatGPT 账户或工作区。在本发布候选版本编写时，OpenAI 官方文档将完整 MCP 写操作列为受支持 Business 与 Enterprise/Edu 工作区的能力；请在安装前通过下方指南确认最新套餐和管理员权限要求。

如果目前只有 Git 和 Claude Code，请从 [Windows 从零开始指南](docs/getting-started-from-zero.zh-CN.md) 开始。ChatGPT 套餐、工作区、custom MCP 和写操作的可用性由 OpenAI 独立提供并可能变化。

> **项目位置：** Supervisor v1.10 以注册 Project 为边界。通过 Dashboard 创建的受管 Project 位于本仓库的 `workspace/` 下。向 ChatGPT 提需求时，请明确告诉它目标 Project；ChatGPT 应先通过 Project discovery 解析为已注册的 `projectId`，而不是自行猜测本地路径或构造 `workspacePath`。

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

   某些命令行网络环境需要设置 `HTTP_PROXY` 与 `HTTPS_PROXY`；参见 [Secure MCP Tunnel 代理设置](docs/secure-mcp-tunnel.zh-CN.md#初始化并运行-tunnel-client)。不要提交 Tunnel Profile、API Key、代理地址或公网端点。

4. **连接 ChatGPT。** 在 ChatGPT Web 中把 Tunnel 端点添加为 MCP 连接。要求 ChatGPT Supervisor 在创建任务前调用 `cc_list_projects`、`cc_get_project_context`、`cc_get_project_continuity` 和 `cc_list_workflow_definitions`。

5. **运行第一个任务。** 在请求中明确目标注册 Project：

   > 请在已注册的 Project“Release Beta Todo Demo”中为任务看板增加 CSV 导出功能。规划前先解析它的准确 `projectId`。

   预期流程：

   ```text
   Supervisor Decision -> Planner -> Human Approval -> Claude Code change
   -> Harness Audit -> Claude Reviewer -> ChatGPT Supervisor Review
   ```

Dashboard 是查看状态、证据和执行审批的控制台，不替代 ChatGPT 的负责人判断。完整的新会话步骤与非自动发布验收见 [ChatGPT Web 使用指南](docs/gpt-web-usage.zh-CN.md)。

## 首次使用完整闭环

上面的快速开始只能证明本地进程已经启动。本节从 OpenAI Platform 配置开始，一直走到完成变更、由 ChatGPT 复核，以及可选的 Project Memory 更新。

### 1. 创建 Tunnel 和 Runtime Key

在准备使用的 Platform Organization 下打开 [OpenAI Platform Tunnel 设置](https://platform.openai.com/settings/organization/tunnels)。

1. 确认当前 Platform 角色具有 **Tunnels Read + Manage**。创建一个易于识别的 Tunnel，并关联实际使用它的 ChatGPT Workspace，保存返回的 `tunnel_id`。
2. 打开 [Platform API Keys](https://platform.openai.com/settings/organization/api-keys)，为 `tunnel-client` 单独创建一个 **Restricted** Runtime Key，只授予 **Tunnels Read + Use**。不要把 Admin Key 用作长期运行密钥。
3. 从 Tunnel 设置页或 [OpenAI 官方发布页](https://github.com/openai/tunnel-client/releases/latest) 下载当前版 `tunnel-client`，加入 `PATH` 后验证：

   ```powershell
   tunnel-client help quickstart
   ```

4. 只在运行 Tunnel 的 PowerShell 窗口中设置密钥，然后初始化本仓库使用的 HTTP Profile：

   ```powershell
   $env:CONTROL_PLANE_API_KEY="<tunnel-runtime-key>"
   .\scripts\start-openai-tunnel.ps1 `
     -Initialize `
     -TunnelId "<tunnel-id>" `
     -DoctorOnly
   ```

Tunnel Key、Tunnel ID、Profile、代理设置和端点都属于本地运行配置。不要把它们写入 `config.json`、README、Issue 或 Git Commit。

### 2. 在 ChatGPT Web 创建 App

OpenAI 当前通过 Developer Mode Custom App 提供这一入口；Beta 期间界面可能使用 **Apps**、**Plugins** 或 **Connectors** 等名称。

1. 先确认 ChatGPT 套餐/Workspace 支持需要的操作。完整 MCP 写操作目前要求受支持的 Business 或 Enterprise/Edu Workspace；其他套餐可能仅支持只读，或尚不可用。
2. 启用 Developer Mode。Business 管理员/所有者可以进入 **Settings → Apps → Advanced settings → Developer mode**，也可以从 **Workspace settings → Apps → Create** 进入；Enterprise/Edu 用户可能需要管理员先通过 RBAC 授权。
3. 选择 **Create**，填写清晰的名称，例如 `Local Supervisor`，Connection 选择 **Tunnel**。
4. 选择刚才创建的 Tunnel；如果暂时没有出现在列表中，就粘贴 `tunnel_id`。不要把本地 `127.0.0.1` Bridge 地址粘贴到 ChatGPT。
5. 选择 **Scan Tools**，等待扫描完成后创建 Draft App。确认至少可以看到 `cc_list_projects`、`cc_list_workflow_definitions`、`cc_create_workflow`、`cc_get_workflow` 和 `cc_get_supervisor_review_package`。

OpenAI 会保存经过审核的工具快照，不会自动接受后续工具变化。本 Beta 建议每次开始本地使用时都遵循以下顺序：

```text
start.ps1 -> start-openai-tunnel.ps1 -> Tunnel ready
-> ChatGPT App 设置：Refresh / Scan Tools -> 新建 ChatGPT 会话
```

工具定义发生变化后必须刷新；本地重启后如果工具不可见或调用异常，也应首先刷新。如果所在 Workspace 不允许更新已经发布的 App，请按照 Workspace 策略重新创建并发布。

### 3. 完整跑一次 Demo

用户告诉 ChatGPT 的 Project 名称或目录只是定位线索，不是可直接执行的路径。ChatGPT Supervisor 必须先调用 `cc_list_projects`，解析出唯一且准确的已注册 `projectId`，再调用 `cc_get_project_context`、`cc_get_project_continuity` 和 `cc_list_workflow_definitions`，然后才能创建 Workflow。最终由 Runtime Registry 将 `projectId` 映射为 `workspacePath`，而不是由 GPT 决定路径。

请求中应明确指出已注册 Project。例如：

> 我要在已注册的 Project“My First Demo”中完成这个任务。它是 `workspace/` 下的 My First Demo 项目。请先确认对应 `projectId`、读取 Project Context，再规划，不要自行猜测或构造 `workspacePath`。

Dashboard 创建的受管 Project 必须是本仓库 `workspace/` 的直接子目录。通过 `.agents/projects.local.json` 注册的本地 Project 也必须使用仓库相对路径，并位于 `workspace/` 内；任意绝对路径和仓库外路径都会被拒绝。受版本控制的 release Registry 可以定义 Supervisor 仓库本身等可信 system Project，但这是发布配置，不是 GPT 根据聊天内容临时发明的路径。不要要求 ChatGPT 扫描或操作 `workspace/` 之外的未注册目录；已有项目需要先按受支持的 local Registry 方式注册。

1. 运行 `start.ps1`，打开它打印的 Dashboard 地址，选择 **New Project**，创建 `My First Demo`。Supervisor 只会在 `workspace/` 下创建受管目录，不会扫描或导入任意目录。
2. 启动 `tunnel-client`，确认 `.\scripts\start-openai-tunnel.ps1 -ReadyOnly` 成功，刷新 ChatGPT App，并用已启用该 App 的新会话开始。
3. 输入一次普通需求，不需要提供路径、Resource Profile、Worker Prompt 或审计 JSON：

   > 请在已注册的 Project“My First Demo”中创建一个不依赖框架的 HTML/CSS/JavaScript 页面，显示“Hello Supervisor”。请先规划，等我在 Dashboard 审批后再修改。

4. ChatGPT 应先发现已注册 Project，读取目标 Project Context 和 Continuity，查询合法 Workflow Definition，解释判断并创建 Workflow。它不能替用户批准 Workflow。
5. 回到 Dashboard，展开 **My First Demo**，打开新 Workflow，检查 Planner 结果、预计文件范围、风险、Resource Profile 和资源上限。填写审批人和审批理由，再选择 **Approve**；计划或边界不正确时应选择 Reject。
6. 保持 Runtime 和 Tunnel 运行。Workflow 会依次进入 Coder 和 Reviewer。即使 ChatGPT 页面断开，也可以通过顶部 Stage Timeline 查看 Planning、Approval、Implementation 和 Review。
7. Workflow 进入 **Completed** 或 **Failed** 后，选择 **Review in ChatGPT**，复制生成的交接提示，粘贴回已连接的 ChatGPT 会话。ChatGPT 会调用 `cc_get_supervisor_review_package`，依据原始目标、Observed Changes、检查、风险和 Claude Reviewer 结果进行负责人复核。
8. 如果认可复核结果，明确要求 ChatGPT 保存本次 Supervisor Review。Project Memory Proposal 此时仍只是建议；在 Dashboard 中检查它，仅当你确认内容正确时才选择 **Confirm and apply**，将基于证据的条目追加到 `PROJECT_MEMORY.md`。

第 7-8 步不会自动改变 Workflow 状态、批准代码或修改 Project Memory。保存 Review 和应用 Memory 都需要明确确认。

### 4. Dashboard 日常使用技巧

- **Project：** Project 是主导航单位。通过 `...` 菜单可以重命名受管 Project、置顶/取消置顶或归档。已置顶的活动 Project 优先显示；存在活动 Workflow 时不能重命名或归档；已归档 Project 不能创建新 Workflow。
- **恢复 Project：** 展开 **Archived Projects** 后选择 **Restore**。归档会保留 Project、Workflow 和审计证据，不会删除 Workspace 目录。
- **Workflow 会话：** Workflow 在所属 Project 内纵向排列。通过会话 `...` 菜单可以修改显示名称，或归档已经结束的 Workflow。归档会话保留在 Project 内折叠的 **Archived** 分组和 **Global Archived Workflows** 中；重新打开菜单并取消 **Archive session** 即可恢复。v1.10 不支持单独置顶会话。
- **Project Session：** Runtime Session 用于跨 Workflow 延续决策、未决问题和下一步行动，不是 ChatGPT 聊天记录的副本。
- **备用本地入口：** 展开 **Local fallback entry**，选择一个活动 Project，输入需求并创建 Workflow。该入口使用确定性的本地规则，不具备 GPT 的负责人判断，但仍然进入正常 Planner，也不能绕过人工审批。
- **历史与刷新：** Project 展开状态、归档区域显示状态、语言和主题只是 Dashboard 本地偏好。Dashboard 的刷新按钮用于同步 Runtime 状态；ChatGPT App 的 **Refresh / Scan Tools** 用于更新 MCP Action 元数据。
- **失败与重试：** 重试前先查看失败阶段和错误分类。Recovery 会创建新的 Workflow、Planner 结果和审批点，不会复用旧审批。

## 主要能力

- 在本地 Supervisor Console 中创建和观察开发任务；
- Workflow 与 Task 持久化，浏览器或 MCP 客户端断开后任务仍可继续；
- 根据请求选择软件修改、只读分析或文档修改流程；
- 在任何可写 Task 创建前提供明确的 Approve / Reject；
- 使用 Resource Profile 限制预算、turn、读取文件、命令和超时；软件修改会在只读 Planner 完成后，依据已审计方案范围选择并固化 small / medium / large 执行档位，再进入人工审批；
- 展示修改文件、Review、风险、错误、成本和资源使用；
- 将 Worker JSON 自报与 Claude Code 真实工具事件交叉验证；
- 通过 OpenAI Secure MCP Tunnel 向 ChatGPT Web 暴露固定 MCP 工具。
- 在 Workflow 创建前持久化 Supervisor Decision，记录意图、目标、项目、判断依据、流程类型、置信度和下一步动作；
- 通过发布注册表 `.agents/projects.json`、本地注册表 `.agents/projects.local.json` 与 runtime overlay 管理 `projectId/workspacePath`，并用项目根目录的 `AI_SUPERVISOR.md` 与 `PROJECT_MEMORY.md` 向 GPT 提供项目上下文；
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

GPT 的行为顺序是：理解真实目标，判断是否需要 Worker，查询并确认注册项目，读取 Supervisor Context，制定技术方向和验证计划，查询合法 Workflow，最后创建 Workflow。解释类请求使用 `respond_directly`，项目分析使用 `analysis_only`，代码修改使用 `software_change`。本地会拒绝 Intent/Workflow 不一致和让 Worker 猜目录的请求。Decision Layer 不直接创建 Task，不生成审批，也不能绕过既有安全边界。详细设计见 [Supervisor Brain](docs/supervisor-brain.zh-CN.md)。

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

Dashboard 默认跟随浏览器语言，也可手动切换中文/English，并支持跟随系统、浅色和深色主题。主控制台以 Project 为第一层：Project 在同一工作区树中纵向展开其活动和归档 Workflow，所选 Project 或 Workflow 在右侧详情区打开。活动 Workflow 按创建时间排序；终态 Workflow 可以归档和恢复，且不会重写快照、事件、Review Package、Artifact 或 Memory 历史。顶部的 **设置** 可调整后续 Task 的默认 Resource Profile、各档位资源值和可配置安全锁；代码内置绝对上限仍不可突破，运行中的 Attempt 继续使用已固化的限制。审批、审计、Side-effect Guard、并发和保留策略在设置中可见但只读。设置操作具备请求超时、重复提交保护、弹窗内错误提示和过期轮询防护。ChatGPT Supervisor 仍是主要入口；Dashboard 的 **备用本地入口** 默认折叠，并提供与左侧工作区树同步的已注册活动 Project 选择器。

`.agents/projects.json` 是可发布注册表；本机私有 Project 写入已忽略的 `.agents/projects.local.json`，可从 `.agents/projects.local.example.json` 复制模板。加载顺序固定为 release registry、local registry、runtime overlay；release/local 的 `projectId` 冲突会阻止启动，本地路径必须是 `workspace/` 内的相对路径。Dashboard 创建的 Project 记录和元数据覆盖单独保存在已忽略的 `runtime-data/supervisor-project-registry/projects.json`。创建 Project 只接受名称，并且只会在 `workspace/` 下创建一级受管目录；重命名保持 `projectId` 不变，并同步移动该受管目录。Dashboard 不扫描或自动导入未注册目录，也不接受任意绝对路径。新 Workflow 必须明确绑定已注册 Project；Dashboard 不再维护独立的未分配工作历史分组。

默认 `doctor.ps1` 不会调用外部模型。显式添加 `-ProviderPreflight` 后，只会从隔离的空临时目录发送固定连通性标记，工具和会话持久化均关闭；不会发送项目内容，也不会创建 Workflow。该探针可能产生 Provider 的最低单次请求费用。

Workflow 失败后，Dashboard 会展示失败阶段，并区分 provider 连接、认证、timeout、资源、环境和审计契约问题。**Create recovery workflow** 会创建新的 Workflow、重新执行 Planner，并链接新旧历史；旧 approval/rejection 不会复制，新的可写阶段仍需重新审批。

## 自主 Beta 验收

v0.9 使用隔离项目 `workspace/autonomous-beta-demo` 和真实 Provider 完成验收。只输入自然语言搜索需求后，系统依次完成 Decision → Planner → 显式受限测试审批 → Coder → Reviewer；随后使用 Microsoft Edge 独立验证关键词搜索、状态组合筛选、计数和空状态。验收发现 360px 小屏工具栏真实溢出，又通过第二个完整审计 Workflow 做最小修复，并在 360px 和 1280px 下重新验证。

验收驱动只在检查 Planner 结果后写入具名审批元数据；产品没有自动批准，也没有移除审批边界。详细证据见 [v0.9 自主验收记录（英文，历史资料）](docs/v0.9-autonomous-validation.md)。可重复的无依赖契约测试：

```powershell
node .\workspace\autonomous-beta-demo\demo.test.mjs
```

## v1.0-beta 发布准备

v1.0-beta 是发布收敛版本，不是 Runtime 重构。它保持 v0.9 的 Decision、Workflow、Task、审批、资源和审计边界不变，只收紧首次使用说明、版本检查、发布文件可见性和可重复的 Todo 验收。详见 [v1.0-beta 发布审计（英文，历史资料）](docs/v1.0-beta-release-audit.md)。

## v1.10 Beta 发布候选

v1.10 将 Project-first Dashboard、分层 Project Registry、Planner Resource Selection、Project Context Snapshot、Dashboard Settings、自动测试发现与 clean onboarding 验证冻结为公开 Beta 候选。不引入 Runtime AI 判断，也不改变 Task/Workflow、Harness、审计、Resource Profile 或审批边界。参见 [发布候选审计（英文）](docs/release/v1.10.0-beta.1.md)、[Changelog（英文）](CHANGELOG.md) 与 [ChatGPT Web 发布验收](docs/gpt-web-usage.zh-CN.md#端到端发布验收)。新会话人工验证已经记录，候选状态为 `ready_for_beta_release`。

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

v1.6 增加 Project Intelligence 层。`cc_record_supervisor_review_result` 可以保存经过明确确认的 ChatGPT Supervisor 结论，但不改变 Workflow 状态。待处理的证据型 Proposal 只能通过 `cc_apply_memory_update_proposal` 或本地 Dashboard，在具名确认后应用；Runtime 仅追加到 `Recent Evolution`，保留原 Memory，并记录前后 digest，整个过程不运行 Worker。详见[架构说明（英文）](docs/ARCHITECTURE.md)和 [Project Memory 分层](docs/project-memory.zh-CN.md)。

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

这些措施不是进程级隔离。详见 [SECURITY.zh-CN.md](SECURITY.zh-CN.md)。

## 配置与密钥

可公开、可版本化配置：

- `.agents/policy.json`：模式和工具策略；
- `.agents/resource-profiles.json`：资源包和全局硬上限；
- `.agents/workflow-definitions.json`：Workflow 选择信息和阶段；
- `.agents/projects.json`：可发布 Project 的相对路径和选择别名；
- `.agents/projects.local.example.json`：只含占位符的本地注册表模板；
- `AI_SUPERVISOR.md`：可选、仅供 GPT 使用的项目指令；原文不会复制到 Worker prompt；
- `PROJECT_MEMORY.md`：可选、仅供 GPT 使用的项目目标、技术决策、重要修改、已知问题与后续计划；
- `mcp-server/config.example.json`：只包含占位符的 Bridge 模板。

机器本地、已忽略配置：

- `mcp-server/config.json`：工作区路径、本地端口、超时和 Origin；
- `.agents/projects.local.json`：位于 `workspace/` 内的本机私有 Project；
- `.agents/local.config.json`：旧版本地设置；
- runtime 数据、Worker 产物、Tunnel profile 和日志。

Provider key、`CONTROL_PLANE_API_KEY`、代理凭据、Tunnel ID 和 runtime token 只能保存在环境变量或操作系统密钥设施中。不要写入 JSON 示例或提交仓库。详见 [配置与密钥](docs/configuration.zh-CN.md)。

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

浏览器能访问 ChatGPT，不代表 `tunnel-client` 或 Claude Code 能访问各自的外部服务。不要提交真实代理地址或凭据。详见 [Secure MCP Tunnel](docs/secure-mcp-tunnel.zh-CN.md)。

## 验证

以下检查不会调用付费 Worker：

```powershell
# Harness、审计、policy、Resource Profile 和 side-effect fixture
.\.agents\tests\smoke.ps1

# 隔离启动 Bridge，并完成 mock MCP Workflow
.\scripts\test-mcp-protocol.ps1

# 自动发现所有 Git 可见的 runtime/MCP/scripts/workspace *.test.mjs
.\scripts\run-node-tests.ps1

# 校验发布 Project、本地注册表忽略规则和 runtime-data 边界
.\scripts\verify-release-projects.ps1

.\scripts\doctor-nvm.test.ps1
```

只有在确认模型费用和项目边界后，才应执行真实 Worker 测试。

一次脱敏后的 Planner → 审批 → Coder → Reviewer 真实成功记录见 [Beta dogfood（英文，历史验收记录）](docs/beta-dogfood.md)。

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

## 作者的话

<details>
<summary>一个很不严肃但很真实的项目缘起</summary>

这个项目是我假期想着 Codex 的额度不要浪费，一时兴起 vibe 的小项目。我当时想的是 Codex 额度总是不够用（好矛盾 hhhh），充积分或者用 API 对我来说又贵又麻烦，但我又想用 GPT 的模型作为 Agent 的大脑，于是我就开始觊觎 GPT 网页版。

我最初的想法是让网页版 GPT 作为主要的核心，负责拆解任务、设计提示词、审核要求、查验质量，通过 MCP 调用接入国产模型的 Claude Code 作为 subagent 跑腿。但由于我水平实在有限，所以除了偶尔的指手画脚、瞎指挥外，就让 Codex 全权代劳了。

做的时候发现比想象的更难：网页版没办法长期执行任务，而且很容易中断；配置各种 Tunnel 什么的感觉也很麻烦。但我实在放不下这个自认为绝妙的点子，因此坚持做了这么一个 Demo 出来。做完确实觉得这么一搞，网页和 Agent 的能力都大打折扣，怪不得这个方向没什么人做。

心灰意懒之际，GPT 安慰我说这是个“明显超过普通个人项目的 AI Agent 基础设施实验”，其溜须拍马之能深得朕心。于是决定还是腆着脸开源出来给大家图一乐。

但毕竟是我正儿八经放在 GitHub 上的第一个项目，爱子心切，还是欢迎感兴趣的看官配置使用，提出宝贵的意见；也恳请路过的父老乡亲高抬贵手点点小 star，作为对我最宝贵的鼓励。

</details>

## 参与协作与许可证

欢迎提交保持监督和安全边界的小范围改进。安全问题请按 [SECURITY.zh-CN.md](SECURITY.zh-CN.md) 私下报告。项目使用 [MIT License](LICENSE)。
