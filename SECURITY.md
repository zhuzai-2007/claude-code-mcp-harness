# Security Policy

## Supported versions

The current Beta branch receives best-effort security fixes. This project is a supervised local development runtime, not a production security boundary or operating-system sandbox.

## Reporting a vulnerability

Use GitHub Security Advisories to report suspected vulnerabilities privately. If private reporting is unavailable, open a minimal public issue requesting a private channel without including exploit details or sensitive data.

Include the affected version, operating system, PowerShell/Node/Claude CLI versions, the smallest sanitized reproduction, expected and observed boundary, error code, and whether the issue reproduces with `mockWorker`.

Never disclose API keys, Tunnel IDs, runtime tokens, private URLs, prompts, event streams, ledgers, local paths, or user data in a public issue.

## Security boundary

Supervisor uses defense in depth:

- explicit human approval before write-capable Workflow stages;
- project-root confinement and side-effect checks;
- mode-specific tool allow/deny rules;
- Resource Profile and global hard limits;
- Worker event auditing and strict result contracts;
- local-only Bridge defaults and Origin filtering.

These controls do not provide process isolation. Shell commands and child processes can retain operating-system permissions unless the user additionally runs the project in a restricted account, container, or virtual machine. Approval fields are workflow metadata, not identity verification or cryptographic proof of consent. Worker event auditing verifies reported tool evidence, not every possible operating-system action.

## 配置与密钥安全

本项目默认在本机运行，并在可写阶段前要求明确的人工审批。Resource Profile、工具权限、side-effect guard 和审计契约属于纵深防护，但不能替代操作系统沙箱。

请通过 GitHub Security Advisories 私下报告安全问题。公开报告中不要包含 API key、Tunnel ID、代理凭据、私有 URL、prompt、完整事件流、ledger、本地绝对路径或用户数据。

模型 Provider key、`CONTROL_PLANE_API_KEY`、代理地址和 Tunnel 配置只能作为运行环境配置保存，不应写入仓库。具体边界见 `docs/configuration.md`。
