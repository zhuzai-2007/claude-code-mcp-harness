# 安全策略

[English](SECURITY.md) | [简体中文](SECURITY.zh-CN.md)

## 支持版本

当前 Beta 分支会尽力提供安全修复。本项目是一个受监督的本地开发 Runtime，不是生产级安全边界，也不是操作系统沙箱。

## 报告漏洞

请使用 GitHub Security Advisories 私下报告疑似漏洞。如果无法使用私下报告，请创建一个最小化的公开 Issue，请求建立私下沟通渠道，不要包含漏洞利用细节或敏感数据。

报告中应包含受影响版本、操作系统、PowerShell/Node/Claude CLI 版本、最小且经过脱敏的复现步骤、预期边界与实际观察到的边界、错误码，以及问题是否能在 `mockWorker` 下复现。

绝不要在公开 Issue 中披露 API Key、Tunnel ID、Runtime Token、私有 URL、Prompt、Event Stream、Ledger、本地路径或用户数据。

## 安全边界

Supervisor 使用纵深防御：

- 可写 Workflow Stage 启动前需要明确人工审批；
- Project Root confinement 与 side-effect check；
- 按 Mode 区分的工具 allow/deny rule；
- Resource Profile 与 global hard limit；
- Worker Event audit 与严格 Result Contract；
- 默认仅限本地的 Bridge 与 Origin filtering。

这些控制不提供进程隔离。除非用户另外在受限账户、容器或虚拟机中运行项目，否则 Shell Command 和 Child Process 可以继续拥有操作系统权限。Approval 字段是 Workflow Metadata，不是身份验证，也不是同意操作的密码学证明。Worker Event audit 只能验证报告的 Tool Evidence，不能验证所有可能的操作系统动作。

## 配置与密钥安全

本项目默认在本机运行，并在可写阶段前要求明确的人工审批。Resource Profile、工具权限、side-effect guard 和审计契约属于纵深防护，但不能替代操作系统沙箱。

请通过 GitHub Security Advisories 私下报告安全问题。公开报告中不要包含 API key、Tunnel ID、代理凭据、私有 URL、prompt、完整事件流、ledger、本地绝对路径或用户数据。

模型 Provider key、`CONTROL_PLANE_API_KEY`、代理地址和 Tunnel 配置只能作为运行环境配置保存，不应写入仓库。具体边界见 [`docs/configuration.zh-CN.md`](docs/configuration.zh-CN.md)。
