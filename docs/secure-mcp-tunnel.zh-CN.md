# 通过 OpenAI Secure MCP Tunnel 连接 ChatGPT

[English](secure-mcp-tunnel.md) | [简体中文](secure-mcp-tunnel.zh-CN.md)

本项目默认使用 OpenAI Secure MCP Tunnel 作为远程连接路径。MCP Bridge 继续绑定在 `127.0.0.1`；`tunnel-client` 建立到 OpenAI 的出站 HTTPS 连接，并将 MCP 请求转发回本地 Bridge。这样无需把可执行写操作的 MCP endpoint 直接发布到互联网。

## Tunnel 暴露什么

Tunnel 只把 MCP JSON-RPC 请求传输到配置的本地 MCP endpoint。它不会公开 Dashboard 端口、创建通用网络代理，也不会授予直接文件系统访问权限。本地文件与命令能力仍受现有 Project Registry、Workflow approval、Resource Profile、side-effect 和 audit 边界保护。

MCP surface 可以包含可写的 Supervisor 工具。应把 Tunnel Runtime Key、Tunnel 关联关系、ChatGPT App 权限和本地审批点视为相互独立的控制措施；拥有其中一项不能替代其他控制。

官方参考：

- [Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
- [ChatGPT developer mode 与 MCP apps](https://help.openai.com/en/articles/12584461-developer-mode-and-full-mcp-connectors-in-chatgpt-beta)

## 环境要求

- 支持所需 MCP action 的 ChatGPT 套餐与 Workspace 配置；
- ChatGPT developer-mode 访问权限；
- 具有所需 Read、Manage 和 Use 权限的 OpenAI Platform Tunnel；
- Tunnel Runtime API Key；
- 在运行本项目的电脑上安装 `tunnel-client`；
- 本地 Claude Code 已配置计划使用的兼容模型 Provider。

不要提交 Runtime API Key、本地 Claude Provider 配置、MCP `config.json` 或 tunnel-client Profile。

## 启动本地 Bridge

首次完成仓库设置，然后在一个 PowerShell 终端中启动受支持的产品入口：

```powershell
.\install.ps1
.\start.ps1
```

后续启动只需要 `.\start.ps1`。Bridge 必须保持在 `127.0.0.1`。启动输出会打印 Dashboard URL 与本地 MCP endpoint。使用 `.\start.ps1 -CheckOnly` 可以只检查配置而不启动服务。

从 clone 到第一个 Workflow 的完整路径见 [Windows 从零开始指南](getting-started-from-zero.zh-CN.md)。

## 初始化并运行 tunnel-client

只在当前操作终端中设置 Runtime API Key：

```powershell
$env:CONTROL_PLANE_API_KEY = '<runtime-api-key>'
```

在第二个终端中初始化一次命名 Profile：

```powershell
.\scripts\start-openai-tunnel.ps1 `
  -Initialize `
  -Profile codex-claude-worker-noauth `
  -TunnelId '<tunnel-id>' `
  -DoctorOnly
```

脚本会读取 `mcp-server/config.json`。当 `requireAuth` 为 false 或不存在时，它初始化 `sample_mcp_remote_no_auth`；使用认证配置时则初始化 `sample_mcp_with_dcr`。可以在不修改 Profile 的情况下查看最终选择：

```powershell
.\scripts\start-openai-tunnel.ps1 -PrintConfiguration
```

如果访问 OpenAI control plane 需要代理，请在运行环境中设置，不要提交代理配置。包装脚本会检查 `CONTROL_PLANE_HTTP_PROXY`；标准命令行工具可能还需要 `HTTP_PROXY` 与 `HTTPS_PROXY`：

```powershell
$env:CONTROL_PLANE_HTTP_PROXY="http://127.0.0.1:<proxy-port>"
$env:HTTP_PROXY="http://127.0.0.1:<proxy-port>"
$env:HTTPS_PROXY="http://127.0.0.1:<proxy-port>"
```

随后启动长期运行的 Tunnel 客户端：

```powershell
.\scripts\start-openai-tunnel.ps1 -Profile codex-claude-worker-noauth
```

在 tunnel-client v0.0.10 中，无认证 HTTP MCP endpoint 对 `/.well-known/oauth-protected-resource/mcp` 正确返回 404 时，`doctor` 可能误报失败。包装脚本只容忍这一种无认证 discovery mismatch。`run` 启动后，应将 Runtime readiness endpoint 作为权威检查：

```powershell
.\scripts\start-openai-tunnel.ps1 -ReadyOnly
```

`/readyz` 必须返回 HTTP 200。其他 doctor 失败仍然是 fatal error。

测试 ChatGPT 时必须保持 MCP Bridge 与 Tunnel Client 同时运行。

## 停止并断开

1. 在 `tunnel-client` 终端按 `Ctrl+C`，停止远程 MCP 传输。
2. 在 Bridge 终端按 `Ctrl+C`，停止本地 MCP endpoint 与 Dashboard。
3. 不再需要连接时，禁用或移除 ChatGPT Draft App。
4. 停用整个配置时，撤销或轮换 Tunnel Runtime Key。

关闭 ChatGPT Web 不会停止任何本地进程。客户端停止后，已经配置的 ChatGPT App 可能仍然可见，但在健康且已授权的客户端重新连接之前，调用会失败。

## 从 ChatGPT 连接

在 ChatGPT developer mode 中创建 App，并将 Connection Type 设为 **Tunnel**。选择与目标 ChatGPT Workspace 关联的 Tunnel，扫描工具，并确认以下工具可见：

- `cc_ping`
- `cc_list_projects`
- `cc_get_project_context`
- `cc_get_project_continuity`
- `cc_list_workflow_definitions`
- `cc_create_workflow`
- `cc_get_workflow`
- `cc_approve_workflow`
- `cc_get_supervisor_review_package`

先调用 `cc_ping`，再明确目标注册 Project，并要求 ChatGPT Supervisor 发现 Project、解析准确的 `projectId`、读取 Project Context 与 Continuity、查询合法 Workflow Definition，然后创建绑定 Project 的 Workflow。Project 名称或 `workspace/` 目录只是 discovery 线索；ChatGPT 不得根据绝对路径或猜测路径构造 `workspacePath`。Planner 保持只读。可写阶段必须停留在人工检查点，直到用户明确批准。

独立工具 `cc_plan_task`、`cc_review_task` 和 `cc_run_approved_task` 为兼容性继续保留，但不是推荐的首次使用 Supervisor 流程。`cc_run_approved_task` 不会批准或推进 Workflow。

## Public tunnel fallback

`scripts/start-ngrok.ps1` 只为隔离兼容实验保留。它会创建公网入口，并且不会增加应用认证。它不是受支持的 ChatGPT 部署路径，现在必须明确确认风险后才能运行。
