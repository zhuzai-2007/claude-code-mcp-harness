# End-to-End Supervised Demo

[English](#english) | [简体中文](#简体中文)

## English

This demo uses the existing synchronous Alpha to create one dependency-free page under a new ignored workspace directory.

### 1. User request

> Create a small static project status card under `workspace/supervised-demo/`. Use only HTML and CSS. Do not modify any existing file.

### 2. Plan

ChatGPT calls `cc_plan_task` with a bounded prompt:

```text
Inspect only the context needed for this task. Propose files under
workspace/supervised-demo/. Do not modify files, use the network, install
dependencies, or run Git commands. Return the required structured result.
```

The Supervisor verifies a successful read-only result, bounded proposed paths, actual read events, risks, and `blocked_on`.

### 3. Approval

The user approves this exact boundary:

```text
Create only workspace/supervised-demo/index.html and styles.css.
No Bash, network, dependencies, deletion, Git, or changes elsewhere.
```

Approval fields record this workflow decision; they are not cryptographic proof of user identity.

### 4. Execute

ChatGPT calls `cc_run_approved_task`:

```json
{
  "prompt": "Create only workspace/supervised-demo/index.html and workspace/supervised-demo/styles.css. Use only Read, Write, or Edit. Do not use Bash or modify any other path. Return strict structured JSON.",
  "approvedBy": "chatgpt-supervisor-after-user-confirmation",
  "approvalReason": "User approved the two-file supervised demo boundary.",
  "maxBudgetUsd": 0.2
}
```

### 5. Result recovery and audit

ChatGPT keeps the run ID and calls:

1. `cc_get_result` with that exact run ID;
2. `cc_get_latest_summary` if the synchronous call ended early;
3. `cc_get_ledger` to inspect approval and result metadata.

The Supervisor checks `status`, `changes_made`, `observed_tools`, `observed_commands`, `permission_denials`, `observed_file_targets`, and `audit_issues`. Failed, incomplete, denied, or mismatched evidence remains a failure.

### 6. Review and acceptance

ChatGPT calls `cc_review_task`:

```text
Review only workspace/supervised-demo/index.html and styles.css against the
approved request. Do not modify files. Check scope, basic HTML/CSS correctness,
unsafe external references, and missing requirements.
```

The Supervisor independently opens or validates the files and reports the run ID, final status, changed files, observed tools, denials, audit issues, risks, and any next user decision.

```text
user request -> plan -> user approval -> execute -> result recovery
             -> read-only review -> independent acceptance -> final report
```

## 简体中文

这个 Demo 只使用当前同步 Alpha 的已有能力，在新的已忽略 workspace 目录中创建一个零依赖静态页面。

### 1. 用户提出任务

> 在 `workspace/supervised-demo/` 下创建一个静态项目状态卡，只使用 HTML 和 CSS，不修改任何已有文件。

### 2. Plan

GPT 调用 `cc_plan_task`，要求 Worker 只读检查、给出限定路径内的计划，并禁止网络、依赖和 Git。Supervisor 检查计划状态、建议路径、风险、`blocked_on` 和实际只读事件。

### 3. Approval

用户只批准创建 `index.html` 和 `styles.css`，同时明确禁止 Bash、网络、依赖安装、删除、Git 和其他路径修改。approval 字段负责记录流程决定，但不是对用户身份的密码学证明。

### 4. Execute

GPT 调用 `cc_run_approved_task`，把精确文件范围、禁止事项、审批者、审批原因和小额预算传给 Harness。Worker 只使用 Read、Write 或 Edit 完成文件任务。

### 5. Result

GPT 保存 run ID，并调用 `cc_get_result`、必要时调用 `cc_get_latest_summary`，再用 `cc_get_ledger` 检查审批和运行记录。Supervisor 必须核对状态、实际工具、命令、拒绝、文件目标和审计问题；任何失败、不完整或不一致都不能转成成功。

### 6. Review 与验收

GPT 调用只读 `cc_review_task` 检查生成文件是否满足原始需求、是否越界、是否存在外部引用或基础 HTML/CSS 问题，最后独立查看产物并向用户报告。

```text
用户需求 -> plan -> 用户批准 -> execute -> 取回结果
         -> 只读 review -> 独立验收 -> 最终报告
```
