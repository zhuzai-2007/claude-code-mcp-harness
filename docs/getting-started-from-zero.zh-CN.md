# Windows 从零开始使用 Supervisor

[English](getting-started-from-zero.md) | [简体中文](getting-started-from-zero.zh-CN.md)

本指南假设你使用一台已有 Git 和 Claude Code、但尚未安装 Node.js，也没有 Supervisor 本地配置的 Windows 电脑。完成后，你将能够从 ChatGPT Web 创建第一个绑定 Project 的 Workflow。

Supervisor 是 local-first 系统：Bridge、Dashboard、项目文件、执行证据和人工审批点都保留在这台电脑上。OpenAI Secure MCP Tunnel 是一条出站传输通道，让受支持的 ChatGPT Workspace 能够访问本地 MCP Bridge，而不需要把 Bridge 直接发布到互联网。

## 1. 确认账户与电脑环境

你需要：

- Windows PowerShell 和 Git；
- Node.js 20 或更高版本，并包含 npm；
- 已安装 Claude Code CLI，并为计划使用的模型 Provider 完成配置；
- 支持 developer mode、custom MCP app 和本项目所需 action 的 ChatGPT 账户或 Workspace；
- OpenAI Platform Tunnel 设置权限、Tunnel ID、Tunnel Runtime Key，以及 `tunnel-client`。

能够使用 ChatGPT Web，并不代表一定能够使用完整 custom MCP 或写操作。在本 release candidate 编写时，OpenAI 文档将完整 MCP 写操作列为受支持 Business 与 Enterprise/Edu Workspace 的能力，其他套餐可能只能使用部分功能或完全不可用。安装前请查看当前的 [ChatGPT developer mode 和 MCP app 可用性](https://help.openai.com/en/articles/12584461-developer-mode-and-full-mcp-connectors-in-chatgpt-beta)。本地 Dashboard 不需要 Tunnel 即可运行，但 ChatGPT Supervisor 路径需要相应的 ChatGPT 与 Platform 权限。

如果尚未安装 Node.js，请从 [Node.js 官方下载页](https://nodejs.org/en/download)安装当前 Node.js 20+ 版本，重新打开 PowerShell，然后验证：

```powershell
node --version
npm --version
claude --version
```

如果你已经使用 nvm for Windows，请先用 `nvm use <version>` 选择一个已安装的 Node.js 20+ 版本。

## 2. Clone 并安装

```powershell
git clone https://github.com/zhuzai-2007/claude-code-mcp-harness.git supervisor
Set-Location supervisor
.\install.ps1
```

`install.ps1` 会执行两个本地设置步骤：

1. 从仓库中的占位模板创建被 Git 忽略的 `mcp-server/config.json`，并将 `projectRoot` 设置为当前 checkout；
2. 根据 `mcp-server/package-lock.json` 执行 `npm ci`。

不要把 Provider Key、Tunnel ID、代理凭据或私有项目路径写入生成的 JSON 文件。

如果 PowerShell 阻止本地脚本，请只为当前终端设置进程级执行策略：

```powershell
Set-ExecutionPolicy -Scope Process Bypass
```

然后重新运行 `.\install.ps1`。

## 3. 检查本地 Runtime

运行不会产生模型费用的环境检查：

```powershell
.\scripts\doctor.ps1
.\start.ps1 -CheckOnly
```

Doctor 应将必需的 Node、npm、Claude CLI、依赖、配置、policy、Resource Profile、Workflow 和 Project 检查报告为 OK。正式启动前，Bridge 或 Tunnel 尚未运行的警告属于预期情况。

Provider 连通性是单独的可选检查，可能产生 Provider 的最小请求费用：

```powershell
.\scripts\doctor.ps1 -ProviderPreflight
```

## 4. 启动 Bridge 与 Dashboard

运行下面的命令，并保持这个 PowerShell 窗口打开：

```powershell
.\start.ps1
```

脚本会打印：

- 本机回环 Dashboard URL；
- 本机回环 MCP endpoint；
- 配置的 workspace root。

Bridge 必须继续绑定在 `127.0.0.1`。不要通过路由器端口转发、未认证反向代理或公共开发 Tunnel 暴露它的端口。

## 5. 创建并启动 OpenAI Secure MCP Tunnel

按照当前 [OpenAI Secure MCP Tunnel 指南](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)完成：

1. 在 OpenAI Platform 创建 Tunnel；
2. 将它关联到准备使用的 Platform Organization 与 ChatGPT Workspace；
3. 根据需要取得 Tunnels Read、Manage 和 Use 权限；
4. 下载最新版 `tunnel-client` 并加入 `PATH`；
5. 创建 Runtime API Key。

在新的 PowerShell 窗口中验证客户端：

```powershell
tunnel-client help quickstart
```

只为当前终端设置 Runtime Key：

```powershell
$env:CONTROL_PLANE_API_KEY="<tunnel-runtime-key>"
```

如果命令行程序需要本地代理：

```powershell
$env:HTTP_PROXY="http://127.0.0.1:<proxy-port>"
$env:HTTPS_PROXY="http://127.0.0.1:<proxy-port>"
```

使用 Platform 返回的 Tunnel ID 初始化一次本地 Profile：

```powershell
.\scripts\start-openai-tunnel.ps1 `
  -Initialize `
  -TunnelId "<tunnel-id>" `
  -DoctorOnly
```

随后启动长期运行的客户端：

```powershell
.\scripts\start-openai-tunnel.ps1
```

同时保持 Bridge 与 Tunnel 两个终端窗口打开。可以在第三个终端检查 readiness：

```powershell
.\scripts\start-openai-tunnel.ps1 -ReadyOnly
```

## 6. 在 ChatGPT Web 添加 MCP App

ChatGPT 设置和套餐能力可能变化，因此请以当前官方 developer-mode 指南为准。在受支持的 ChatGPT Workspace 中：

1. 启用 developer mode；
2. 创建 custom app；
3. Connection type 选择 **Tunnel**；
4. 选择与此 Workspace 关联的 Tunnel；
5. 扫描工具并创建 Draft App。

提出任务前，请先创建或确定目标 Project。Dashboard 创建的受管 Project 是本仓库 `workspace/` 的直接子目录。Project 名称或 `workspace/` 下的目录名称只能作为 discovery 线索：ChatGPT 必须通过 `cc_list_projects` 将其解析为准确的已注册 `projectId`，再由 Runtime Registry 提供 `workspacePath`。不要向 ChatGPT 提供任意绝对路径并要求它构造或直接相信 `workspacePath`。

确认至少能看到以下 Supervisor 工具：

- `cc_ping`
- `cc_list_projects`
- `cc_get_project_context`
- `cc_get_project_continuity`
- `cc_list_workflow_definitions`
- `cc_create_workflow`
- `cc_get_workflow`
- `cc_get_supervisor_review_package`

启用 Draft App 后新建会话，并输入：

> 列出已注册的 Project 和支持的 Workflow Definition。将已注册 Project“Release Beta Todo Demo”解析为准确的 `projectId`，读取其 Project Context 与 Continuity，然后准备一个增加 CSV 导出功能的 Workflow。不要猜测 `workspacePath`，也不要在没有明确人工审批时启动可写阶段。

真实 Planner、Coder 和 Reviewer 阶段会调用配置的模型 Provider，并可能产生费用。Resource Profile 会执行本地安全上限，但其中的估计不是账单保证。

预期顺序：

```text
Project discovery
  -> Workflow Definition discovery
  -> Supervisor Decision
  -> read-only Planner
  -> human approval in the Dashboard
  -> Coder
  -> Claude Reviewer
  -> Supervisor Review Package
```

用户需要说明目标注册 Project，但不需要提供文件系统路径、Resource Profile、Worker Prompt 或审计 JSON Schema。

## 7. 安全停止

1. 在 Tunnel 终端按 `Ctrl+C`，停止远程请求路径。
2. 在 Bridge 终端按 `Ctrl+C`，停止本地 Dashboard 和 MCP endpoint。
3. 不再使用时，在 ChatGPT 中禁用或移除 Draft App。
4. 停用整个配置时，撤销或轮换 Tunnel Runtime Key。

只关闭浏览器不会停止本地 Runtime 或 `tunnel-client`。

## 故障排查

| 现象 | 检查项 |
| --- | --- |
| 找不到 `node` | 安装或选择 Node.js 20+，重新打开 PowerShell，再运行 Doctor。 |
| `npm ci` 无法连接 Registry | 为命令行设置 `HTTP_PROXY` / `HTTPS_PROXY`；浏览器联网不代表 CLI 能联网。 |
| Doctor 找不到 Claude | 确认在同一个终端中运行 `claude --version` 成功。 |
| ChatGPT 中没有 Tunnel | 检查 Workspace 关联关系，以及 Tunnels Read + Use 权限。 |
| Tunnel readiness 失败 | 保持 Bridge 运行，用 `-PrintConfiguration` 运行包装脚本，再重新执行 Tunnel doctor。 |
| App 创建后工具发生变化 | Refresh 或重新创建 Draft App，让 ChatGPT 扫描当前 MCP 工具定义。 |
| Workflow 一直等待 | 打开 Dashboard 检查当前阶段；可写工作需要明确人工审批。 |

更深入的配置和安全边界见[配置与密钥](configuration.zh-CN.md)、[Secure MCP Tunnel](secure-mcp-tunnel.zh-CN.md)与[从 ChatGPT Web 使用 Supervisor](gpt-web-usage.zh-CN.md)。
