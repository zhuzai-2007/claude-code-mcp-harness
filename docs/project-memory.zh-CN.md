# Project Memory 分层与 Apply Contract

[English](project-memory.md) | [简体中文](project-memory.zh-CN.md)

`PROJECT_MEMORY.md` 是由 Operator 管理的项目上下文。Supervisor 可以把一个有边界的 Snapshot 读入 Decision，也可以在 Workflow 结束后生成 evidence-first Update Proposal，但 Worker 和后台 Runtime Process 都不能编辑它。

## 三个逻辑层

新的 Memory 文件使用三个 Heading：

```markdown
# Project Memory

## Stable Facts

## Architecture Decisions

## Recent Evolution
```

### Stable Facts

长期事实，例如技术栈、仓库布局、支持环境和持久约束。这些内容很少变化，也不应根据一次 Worker Run 推断。

### Architecture Decisions

类似轻量 ADR 的 Decision Record：decision、rationale、date 和 affected area。一个普通的已完成功能不会自动成为 Architecture Decision。

### Recent Evolution

已经确认的近期修改、验证证据和短期风险。Supervisor v1.6 只把 `MemoryUpdateProposal` Record 应用到这一层。

## Legacy 兼容

现有 `PROJECT_MEMORY.md` 不会迁移或重写。第一次确认 Apply 时，Runtime 会原样保留全部既有内容；只有在缺少 `Recent Evolution` Heading 时才增加该 Heading，然后追加一条可追踪 Entry。之后可以手工整理 Stable Facts 和 Architecture Decisions，而不会让既有 Decision 或冻结的 Memory Snapshot 失效。

如果 Project 没有 Memory 文件，第一次确认 Apply 会创建三个空逻辑层，并在 Recent Evolution 下添加已批准 Entry。Placeholder Comment 只是说明，不会断言项目事实。

## Apply Contract

流程如下：

```text
Evidence-backed proposal
  -> explicit human confirmation
  -> Runtime-controlled append
  -> application audit record
  -> Project Context refresh
```

Apply 需要准确的 `proposalId`、`workflowId`、`appliedBy`、确认理由和 `confirmed=true`。Runtime 会验证 terminal Workflow、已注册 Project binding、pending Proposal 状态、regular-file target、workspace boundary 和 64 KiB Memory limit。

与既有 approval metadata 一样，姓名和确认理由属于审计上下文，并不是 cryptographic identity proof。Operator 必须让 MCP endpoint 与本地 Dashboard access 保持在已记录的 trust boundary 内。

Application History 会在 `runtime-data/memory-application-history/` 下记录 Proposal、Workflow、Project、Operator metadata、时间戳、修改摘要和前后 digest。重建 Review Package 后，已应用 Proposal 仍保持 applied 状态。

该 Contract 刻意不提供任意 Memory 文本编辑。Proposal Content 来自持久化 Decision、Harness-observed changes、Reviewer evidence 和 Project Context。仍可以在 Supervisor 之外手工编辑文件，但这由 Operator 自行负责。
