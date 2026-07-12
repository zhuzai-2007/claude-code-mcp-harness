# Security Policy

[English](#english) | [简体中文](#简体中文)

## English

### Supported versions

Only the latest Alpha release and the current `main` branch receive best-effort security fixes. This project is not production-ready and provides no production security guarantee.

### Reporting a vulnerability

Use the repository's GitHub **Security Advisories** feature to report suspected vulnerabilities privately. If that feature is unavailable, open a minimal public issue asking the maintainers to establish a private channel, without including exploit details or sensitive data. This project does not currently publish a dedicated security email address.

Include:

- affected version or commit;
- operating system, PowerShell, Node.js, and Claude Code versions;
- the smallest safe reproduction;
- expected and observed security boundary;
- sanitized error codes and audit metadata;
- whether the issue reproduces with `mockWorker`.

Do not disclose API keys, Tunnel IDs, runtime keys, private URLs, credentials, prompts, complete event streams, ledgers, personal paths, or user data in a public issue.

### Scope and expectations

The Bridge, Harness policy, approvals, tool allow/deny rules, side-effect guard, and Claude event auditing are defense-in-depth guardrails. They are not an OS sandbox, kernel audit trail, or safe environment for arbitrary untrusted code. Provider or CLI event omissions are handled conservatively, but event-level auditing cannot prove all operating-system activity.

## 简体中文

### 支持版本

仅最新 Alpha 版本和当前 `main` 分支会尽力获得安全修复。本项目不适合生产环境，也不提供生产级安全保证。

### 私下报告安全问题

请优先使用仓库的 GitHub **Security Advisories** 私下报告疑似漏洞。如果该功能不可用，可以只创建一个不包含漏洞细节或敏感数据的最小公开 issue，请维护者建立私下沟通渠道。项目当前没有公开专用安全邮箱。

报告建议包含：

- 受影响版本或提交；
- 操作系统、PowerShell、Node.js 和 Claude Code 版本；
- 最小且安全的复现；
- 预期和实际安全边界；
- 已脱敏的错误码与审计元数据；
- 是否能在 `mockWorker` 下复现。

不要在公开 issue 中披露 API key、Tunnel ID、runtime key、私有 URL、凭据、prompt、完整事件流、ledger、个人路径或用户数据。

### 安全边界

Bridge、Harness policy、审批、工具允许/拒绝规则、side-effect guard 和 Claude 事件审计属于纵深 guardrail。它们不是操作系统级沙箱、内核审计轨迹，也不能安全执行任意不可信代码。系统会保守处理 CLI 或 Provider 缺失事件，但事件级审计不能证明全部操作系统行为。
