# 配置与密钥

[English](configuration.md) | [简体中文](configuration.zh-CN.md)

Supervisor 将受版本控制的 policy 与机器本地 Runtime 设置、凭据分开管理。

## 公开且受版本控制的配置

只要不包含机器专用值，以下文件可以安全审查和提交：

| 文件 | 用途 |
| --- | --- |
| `mcp-server/config.example.json` | 本地 Bridge 的完整占位模板。 |
| `.agents/policy.json` | 工具权限、读写模式和安全规则。 |
| `.agents/resource-profiles.json` | Budget、turn、文件、命令和 timeout envelope。 |
| `.agents/workflow-definitions.json` | Workflow 选择元数据与 Stage 定义。 |
| `.agents/projects.json` | Release Project ID、相对路径、描述、技术栈、alias 和默认 Supervisor constraint。 |
| `.agents/projects.local.example.json` | 只含占位值的机器本地 Project Registry 模板。 |

Clone 后，`scripts/init-config.ps1` 会将示例复制为被 Git 忽略的 `mcp-server/config.json`，并把 `projectRoot` 替换为当前仓库路径。推荐的本地默认值是回环 host `127.0.0.1`、port `8787`、同时运行一个 Task，以及 `null` legacy approval default。

`defaultApprovedBy` 与 `defaultApprovalReason` 只适用于 legacy synchronous `cc_run_approved_task` 兼容工具。应保持为 `null`，由调用方明确提供审批。Dashboard Workflow approval 不使用这些默认值，始终要求人工操作并填写姓名与理由。

## 私有 Runtime 配置

不要把以下内容写入提交的 JSON、Markdown、test fixture、日志或截图：

- 模型 Provider API Key；
- `CONTROL_PLANE_API_KEY` 和 Tunnel Identifier；
- 代理凭据或私有代理 endpoint；
- 私有 MCP URL、Runtime Token、Cookie 或 Session Data。

只在启动相关进程的终端或操作系统密钥设施中设置 Secret：

```powershell
$env:CONTROL_PLANE_API_KEY="<tunnel-runtime-key>"
$env:HTTP_PROXY="http://127.0.0.1:<proxy-port>"
$env:HTTPS_PROXY="http://127.0.0.1:<proxy-port>"
```

Supervisor Doctor 只报告这些环境变量是否存在，不打印其内容。`.env*`、`mcp-server/config.json`、`.agents/projects.local.json`、`.agents/local.config.json`、Tunnel Profile、Runtime Data、日志和 Worker Artifact 都被 Git 忽略。

## 配置优先级

Resource limit 按以下顺序解析：

1. Task 显式 Resource Override；
2. 选中的 Resource Profile；
3. 默认 `small_readonly` Profile。

所有最终值仍受 `.agents/resource-profiles.json` 的 global hard limit 和代码中不可变 absolute limit 约束。Legacy `.agents/local.config.json` 不会覆盖 Resource Profile。

本地 Dashboard 的 **Settings** 对话框可以修改默认 Profile、Profile envelope 和已配置的 global lock。它会原子写入同一个受版本控制的 Resource Profile 文件，只影响保存后新建的 Task，不能增加/删除 Profile 名称，也不能超过不可变 absolute limit。正在运行的 Attempt 保留其已持久化 Resource Snapshot。Approval、strict audit、side-effect protection、concurrency 和 retention 只作为操作信息展示，不能从该 Settings 界面修改。

## 已注册 Project

Project Definition 按以下顺序加载：

1. `.agents/projects.json` 中受版本控制的 release definition；
2. 被 Git 忽略的 `.agents/projects.local.json` 中可选的机器本地 definition；
3. 来自被忽略 Runtime Data 的 Dashboard-created definition 与 metadata override。

只有需要私有 Workspace Project 时，才将 `.agents/projects.local.example.json` 复制为 `.agents/projects.local.json`。Local entry 不能使用绝对路径，并且必须解析到本仓库的 `workspace/` 目录内。Release 与 local registry 出现重复 `projectId` 会导致启动错误。缺少 local registry 是合法状态。已经删除本地 definition 后残留的 Runtime metadata 会被忽略并记录 diagnostic，而不会被提升为不完整 Project。

通过 Dashboard 创建的 Project 是 `workspace/` 下的受管直接子目录；调用方不能提供或修改它的 `path` 或 `workspacePath`。受版本控制的 release Registry 也可以定义仓库根目录等可信 system Project。这一 release-only 例外并不允许用户或 ChatGPT 注册任意路径：ChatGPT 必须发现已注册 `projectId`，由 Runtime Registry 负责解析 `workspacePath`。

每个 Definition 都需要稳定的 `projectId`、相对 `workspacePath`、`description`、`stack`、`aliases` 和 `constraints`。Alias matching 只帮助 Supervisor 唯一选择 Project，不代表允许探索相邻目录。Runtime 派生的 usage 与 Dashboard metadata 保持在 ignored data 中，不会重写公共 Registry。

## Runtime Retention

`mcp-server/config.json` 可以覆盖启动时的 Retention Policy：

```json
{
  "retention": {
    "enabled": true,
    "maxAgeDays": 30,
    "maxWorkflows": 200,
    "maxStandaloneTasks": 200,
    "maxDecisions": 500
  }
}
```

只有 terminal Workflow/Task 及其引用的 Attempt Artifact 会进入清理候选；活动工作始终保留。运行 `node .\scripts\cleanup-runtime.mjs` 可查看 dry-run 计划，增加 `--apply` 才会真正执行。

## Preflight

启动前运行人类可读的 Doctor：

```powershell
.\scripts\doctor.ps1
```

默认 Doctor 不会向外部模型发送请求。要显式验证配置的 Claude CLI Provider：

```powershell
.\scripts\doctor.ps1 -ProviderPreflight
```

该 Probe 使用固定的非项目 marker、隔离空临时目录、`--tools ""` 和禁用的 Session Persistence。它不会读取或发送项目内容，也不能修改项目文件，但可能产生 Provider 的最小请求费用。最近一次从 Dashboard 触发的结果存储在被 Git 忽略的 `runtime-data/provider-preflight/latest.json`。

Failed Workflow recovery 会创建独立 Workflow 目录，并与源历史关联。它只复制原始请求、选中的 Project、Supervisor Decision、Workflow Type 和 Mock Setting；Task ID、Attempt ID、approval/rejection metadata 和 Stage Result 永远不会复用。

自动化场景使用 `.\scripts\doctor.ps1 -Json`。在相关可选组件启动前，“Bridge not running”或“Tunnel not configured”等 warning 属于正常情况；`[FAIL]` 项会包含具体修复建议，并阻止 startup readiness。
