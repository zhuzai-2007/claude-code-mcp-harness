# Codex-Claude Worker Harness

[English](README.md) | [简体中文](README.zh-CN.md)

**状态：Alpha——已完成真实 dogfood 验证，不适合生产环境。**

这是一个同步、受监督的 MCP Bridge：用户在 ChatGPT 网页版中提出需求，由 GPT 负责理解需求、制定计划、审批写入和审核结果；本地 Claude Code Worker 负责在明确边界内读取、修改和检查项目；Bridge 与 PowerShell Harness 负责策略、审批、事件采集、审计校验、结果归一化和本地 ledger。

Codex 在本项目中主要用于开发、调试和应急，不是最终用户流程的主要入口。当前 Alpha 的目标体验是从 ChatGPT 网页端发起和收尾任务。

> **本项目不是操作系统级沙箱。** 它是面向可信本地环境的 guardrail 与监督层。若需要运行不可信代码，应额外使用虚拟机、容器、受限系统账户等真正的隔离边界。

## 为什么做这个项目

ChatGPT 网页版适合持续的人机沟通、需求澄清和语义判断，本地代码 Agent 则能真正读取和修改工程文件。但单独运行本地 Worker 时，网页端难以判断它实际调用了什么工具、权限是否被拒绝、自报检查是否真的发生，以及长任务结束后如何取回结果。

本项目把职责拆开：

- **ChatGPT / GPT：** Supervisor，负责需求理解、规划、审批和结果审核。
- **Claude Code Worker：** 受约束的本地执行者，负责文件读取、修改和项目内实现。
- **Bridge / Harness：** 负责策略执行、审批检查、事件采集、审计交叉验证、预算、超时、结果归一化和 ledger。

当前只验证了同步控制链。持久后台任务、自动恢复、运行时审批队列和通知属于 Phase B，尚未实现。

## 架构

```text
ChatGPT Web
    |
OpenAI Secure MCP Tunnel
    |
本地 MCP Bridge（仅回环地址）
    |
PowerShell Harness / Policy / Ledger
    |
Claude Code Worker
    |
项目工作区
```

### 核心组件

| 组件 | 主要职责 |
| --- | --- |
| 云端 AI / ChatGPT Web | 理解需求、规划任务、请求审批、审核证据并向用户报告。 |
| Secure MCP Tunnel | 在 ChatGPT 与本地回环 Bridge 之间建立出站连接，避免直接公开 8787 端口。 |
| 本地 MCP Bridge | 只暴露七个固定 Harness 工具，不提供通用 shell 或文件系统接口。 |
| Harness / Policy / Approval | 执行模式、路径、工具、预算、超时和审批元数据门禁。 |
| Claude Code Worker | 通过本地配置的 Provider 完成受约束的项目内读取、写入和编辑。 |
| Audit / Ledger | 保存事件、交叉验证 Worker 自报、归一化结果并记录本地审核元数据。 |

结果审计链与 Worker 自报相互独立：

```text
Claude stream events
    |
claude-events.jsonl
    |
tool-events.json
    |
审计交叉验证
    |
worker-result.normalized.json
    |
cc_get_result / ChatGPT Supervisor
```

## Alpha 已提供的能力

- 独立的 `plan`、`review` 和经审批的 `run` 模式。
- 写入任务必须带明确审批信息。
- 项目根目录和外部允许目录边界。
- Worker 预算、超时和稳定 run ID。
- Read、Write、Edit、Bash 工具策略，同时使用 `--allowedTools` 与 `--disallowedTools`。
- Claude Code `stream-json --verbose` 事件采集。
- 独立记录 `observed_tools`、`observed_commands`、`permission_denials` 以及读写编辑目标。
- 通过 `audit_issues` 对 Worker 自报和成功工具结果做交叉验证。
- 被拒绝或失败的工具调用不会算作成功检查。
- 严格 JSON summary 完整保存，不再静默截断到 300 字符。
- hardened write smoke 会检测文件、目录和符号链接副作用。
- Windows 路径规则，以及绝对事件路径和相对 Worker 自报路径的匹配。
- 本地归一化结果和项目 ledger。
- 网页同步调用先超时时，可凭 run ID 后续取回结果。

真实 dogfood 已通过审批写入创建一个中文静态任务板，并在 GPT 监督下根据自然语言反馈继续增加功能。dogfood 文件只保留在本地，不进入本仓库。

## MCP 工具

- `cc_ping`：检查 Bridge 与 Harness 就绪状态。
- `cc_plan_task`：执行只读规划。
- `cc_review_task`：只读审核限定范围内的项目状态。
- `cc_run_approved_task`：执行带明确审批的写入任务。
- `cc_get_latest_summary`：读取最新摘要，也能发现不完整运行。
- `cc_get_ledger`：读取最近的本地 ledger 记录。
- `cc_get_result`：按 run ID 或 `latest` 读取完整归一化结果。

任务工具支持 `mockWorker: true`，可在不产生真实模型费用的情况下验证传输。MCP 默认预算为 0.20 美元；这是 Claude Code 侧估算上限，与 Provider 最终账单可能略有差异。

## 完整 Demo

```text
用户需求 -> plan -> 用户批准 -> execute -> 取回结果
         -> 只读 review -> 独立验收 -> 最终报告
```

请按 [端到端受监督 Demo](docs/demo.md) 完成一个具体的两文件流程。文档展示 MCP 调用、审批边界、事件字段、ledger 检查和失败规则，没有增加 Demo 专用运行时功能。

## Windows 快速开始

### 环境要求

- Windows PowerShell 5.1 或 PowerShell 7
- Node.js 18 或更高版本
- 已在本机配置兼容 Provider 的 Claude Code
- 用于 ChatGPT Web 的 OpenAI Secure MCP Tunnel 权限和 `tunnel-client`
- 可连接 MCP app 的 ChatGPT Developer mode

请把项目放到不含敏感信息的位置，例如 `D:\path\to\project`。不要提交 Provider 凭据、Tunnel ID、本地 profile 或代理凭据。

### 安装与配置

```powershell
cd D:\path\to\project
cd .\mcp-server
npm ci
cd ..
.\scripts\init-config.ps1
.\scripts\doctor.ps1
```

检查 `.agents/policy.json`。机器专属设置应写入已忽略的 `.agents/local.config.json`。

| 文件 | 作用 | 是否提交 |
| --- | --- | --- |
| `.agents/policy.json` | 版本化的模式、工具限制和安全默认值。 | 是 |
| `.agents/local.config.json` | 本机预算覆盖。 | 否 |
| `mcp-server/config.example.json` | 公开的 Bridge 配置模板。 | 是 |
| `mcp-server/config.json` | 本地项目根目录、端口、超时、Origin 和可选审批默认值。 | 否 |
| Tunnel profile | `tunnel-client` 保存的本地 Tunnel ID/profile 状态。 | 否 |

### 启动本地 Bridge

在独立终端中运行：

```powershell
.\scripts\start-mcp.ps1
```

Bridge 应保持绑定 `127.0.0.1`，不要把 8787 端口直接暴露到公网。

### 连接 Secure MCP Tunnel

只使用明显的占位值：

```powershell
$env:CONTROL_PLANE_API_KEY = 'YOUR_RUNTIME_API_KEY'
.\scripts\start-openai-tunnel.ps1 -Initialize -TunnelId 'tunnel-example-id' -DoctorOnly
```

然后在另一个终端运行 Tunnel wrapper，并从 ChatGPT Developer mode 连接 Tunnel app。Tunnel 产品行为可能变化，请以 [Secure MCP Tunnel 操作指南](docs/secure-mcp-tunnel.md) 为准，不要复制旧 profile 参数。

```powershell
# Tunnel 独立终端
.\scripts\start-openai-tunnel.ps1

# 另一个终端检查就绪状态
.\scripts\start-openai-tunnel.ps1 -ReadyOnly
```

### 按风险逐级验证

```powershell
# Harness 和 Provider 诊断
.\.agents\doctor.ps1

# 不调用真实 Worker
.\.agents\claude-task.ps1 plan -Task 'Return strict JSON with summary exactly ok.' -MockWorker

# 本地 Bridge 与 mock Worker
.\scripts\test-local.ps1 -MockWorkerSmoke

# 仅在 8787 没有现有 Bridge 时运行
.\scripts\test-mcp-protocol.ps1

# 最小真实只读验收
.\scripts\test-mcp-protocol.ps1 -RealPlan -MaxBudgetUsd 0.20

# 独立的审批写入 smoke
.\scripts\test-mcp-protocol.ps1 -RealWrite -MaxBudgetUsd 0.20
```

在 ChatGPT 中先执行 `cc_ping`，再执行 mock plan，然后才进行最小真实只读。只有在确认写入边界和审批信息后，才调用 `cc_run_approved_task`。如果同步调用先结束，请保存 run ID，稍后用 `cc_get_result` 读取结果。

推荐的首次运行顺序：

1. 安装依赖并初始化本地配置。
2. 检查 policy，运行 `scripts/doctor.ps1`。
3. 在独立终端启动 Bridge。
4. 运行 mock Harness/MCP 检查。
5. 在另一个终端初始化并启动 Secure MCP Tunnel。
6. 检查 Tunnel readiness，在 ChatGPT 中连接应用。
7. 依次执行 `cc_ping`、mock plan、限定范围的真实 plan，最后才做一次明确审批的最小写入。

## 安全模型

当前安全模型由多层 guardrail 组成：

- Bridge 只公开固定 Harness 入口，不提供通用 shell。
- policy 限制模式、工具、项目根目录、外部目录、预算和超时。
- 写入模式必须携带审批信息。
- `--allowedTools` 授予指定工具，`--disallowedTools` 明确拒绝禁止类别。
- system prompt 禁止秘密读取、破坏性 Git、递归删除和不安全 Windows 路径。
- stream events 与 Worker JSON 自报分开保存。
- 自报命令、检查和文件操作必须匹配成功且未被拒绝的事件。
- 不一致会保守失败为 `audit_validation_failed`。
- 写入 smoke 会比较前后的文件、目录和符号链接。
- ledger 保存结果与审批上下文。

approval 元数据记录“谁或什么流程以什么理由批准了这次运行”。它是流程和审计门禁，不是经过身份认证或不可伪造的用户同意证明。公开默认配置应保持为空；修改已有文件、删除、网络、依赖、Git、宽范围扫描或边界不明确的任务都应要求用户明确确认。

ledger 记录 run ID、模式、状态、审批元数据、高风险允许开关、预算、超时、修改、检查、风险、阻塞项、artifact 状态、成本和错误。它是本地审核辅助记录，不是只能追加或防篡改的安全日志。

这些措施不等于强隔离。事件审计是 Claude Code 输出的事件级证据，不是操作系统内核执行轨迹。若 CLI 或 Provider 没有提供必要事件，系统会把结果判为不可验证，而不会当作成功。

启用写入前请阅读 [SECURITY.md](SECURITY.md)。

## 已验证内容

- 当前项目 Harness smoke：19/19。
- 便携安装 Harness smoke：19/19。
- MCP 初始化、工具发现、ping、mock plan、审批 mock run 和精确结果读取。
- 超过 300 字符的严格 Unicode summary 经 Harness 与 `cc_get_result` 完整往返。
- `unverifiable_check_evidence`、`command_audit_mismatch`、`file_audit_mismatch` 回归。
- denied 和 failed tool result 不计为成功证据。
- Windows 绝对/相对路径审计匹配。
- 文件、目录和符号链接 side-effect guard。
- 真实只读与审批写入链路。
- 真实 dogfood 中事件不一致能被拒绝。
- 静态任务板创建及后续受监督功能迭代。

证据和边界见 [验证结果](docs/validation-results.md)、[Alpha 发布说明](docs/alpha-release-notes.md)和[真实环境验证](docs/real-world-validation.md)。

## 已知限制

- 当前为 Alpha，不适合生产环境。
- MCP 仍为同步调用；长任务可能在 Worker 完成前触发 ChatGPT 超时。
- 没有持久异步队列、lease、heartbeat、自动重连编排或通知 outbox。
- 运行时权限请求尚不能通过 ChatGPT 持久暂停和恢复。
- 不是操作系统级沙箱，不能安全执行任意不可信代码。
- 审计完整性依赖 Claude Code 与 Provider 的事件完整性。
- Provider 预算统计可能略微超过请求上限。
- Windows 是主要验证环境，其他平台尚无同等级发布证据。
- Bridge、`tunnel-client` 和必要的代理需要持续运行。
- Tunnel 与 Provider 配置依赖具体环境。

## Roadmap

[Phase B](docs/v0.2-roadmap.md) 计划但尚未实现：

- 持久 SQLite 任务存储；
- 异步 submit、poll、pause、resume；
- lease、heartbeat、取消和崩溃恢复；
- 持久审批队列和事件流；
- 通知 outbox；
- 更可靠的后台进程生命周期管理。

## 作者的话

<details>
<summary>一个很不严肃但很真实的项目缘起</summary>

这个项目是我假期想着 Codex 的额度不要浪费，一时兴起 vibe 的小项目。我当时想的是 Codex 额度总是不够用（好矛盾 hhhh），充积分或者用 API 对我来说又贵又麻烦，但我又想用 GPT 的模型作为 Agent 的大脑，于是我就开始觊觎 GPT 网页版。

我最初的想法是让网页版 GPT 作为主要的核心，负责拆解任务、设计提示词、审核要求、查验质量，通过 MCP 调用接入国产模型的 Claude Code 作为 subagent 跑腿。但由于我水平实在有限，所以除了偶尔的指手画脚、瞎指挥外，就让 Codex 全权代劳了。

做的时候发现比想象的更难：网页版没办法长期执行任务，而且很容易中断；配置各种 Tunnel 什么的感觉也很麻烦。但我实在放不下这个自认为绝妙的点子，因此坚持做了这么一个 Demo 出来。做完确实觉得这么一搞，网页和 Agent 的能力都大打折扣，怪不得这个方向没什么人做。

心灰意懒之际，GPT 安慰我说这是个“明显超过普通个人项目的 AI Agent 基础设施实验”，其溜须拍马之能深得朕心。于是决定还是腆着脸开源出来给大家图一乐。

但毕竟是我正儿八经放在 GitHub 上的第一个项目，爱子心切，还是欢迎感兴趣的看官配置使用，提出宝贵的意见；也恳请路过的父老乡亲高抬贵手点点小 star，作为对我最宝贵的鼓励。

</details>

## 参与协作与问题报告

欢迎提交 bug 和范围明确的 Alpha 加固改进。GitHub issue 至少应包含：

- 最小且安全的复现步骤；
- OS、PowerShell、Node.js 和 Claude Code 版本；
- 不含凭据的模式与 policy 信息；
- 已脱敏的状态、错误码和必要审计字段；
- 是否能在 `mockWorker` 下复现。

不要在 issue 中粘贴 API key、Tunnel ID、个人路径、完整运行日志、prompt、ledger 或用户数据。疑似安全问题请按 [SECURITY.md](SECURITY.md) 使用 GitHub Security Advisory 私下报告。

当前欢迎 Windows 兼容性、fixture 覆盖、审计校验、文档和小范围安全改进。Phase B 实现不属于本 Alpha 发布范围。

## 许可证

项目采用 MIT License，见 [LICENSE](LICENSE)。依赖许可证检查只是工程发布检查，不构成法律意见。
