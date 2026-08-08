# Project Memory Layers and Apply Contract

[English](project-memory.md) | [简体中文](project-memory.zh-CN.md)

`PROJECT_MEMORY.md` is operator-owned project context. Supervisor may read a bounded snapshot into a Decision and may generate an evidence-first update proposal after a Workflow, but no Worker and no background Runtime process may edit it.

## Three logical layers

New Memory files use three headings:

```markdown
# Project Memory

## Stable Facts

## Architecture Decisions

## Recent Evolution
```

### Stable Facts

Long-lived facts such as the technical stack, repository layout, supported environments, and durable constraints. These should change rarely and should not be inferred from one Worker run.

### Architecture Decisions

Decision records similar to lightweight ADRs: decision, rationale, date, and affected area. A normal completed feature does not automatically become an architecture decision.

### Recent Evolution

Confirmed recent changes, validation evidence, and short-lived risks. Supervisor v1.6 applies `MemoryUpdateProposal` records only to this layer.

## Legacy compatibility

Existing `PROJECT_MEMORY.md` content is not migrated or rewritten. On the first confirmed apply, Runtime preserves all existing bytes as text, adds a `Recent Evolution` heading only when absent, and appends one traced entry. Stable Facts and Architecture Decisions can be organized manually later without invalidating existing Decisions or frozen Memory snapshots.

If a project has no Memory file, the first confirmed apply creates the three empty logical layers and adds the approved entry under Recent Evolution. Placeholder comments are descriptive and do not assert project facts.

## Apply contract

The flow is:

```text
Evidence-backed proposal
  -> explicit human confirmation
  -> Runtime-controlled append
  -> application audit record
  -> Project Context refresh
```

Apply requires the exact `proposalId`, `workflowId`, `appliedBy`, confirmation reason, and `confirmed=true`. Runtime verifies the terminal Workflow, registered project binding, pending proposal state, regular-file target, workspace boundary, and 64 KiB Memory limit.

As with existing approval metadata, names and confirmation reasons are audit context rather than cryptographic identity proof. Operators must keep the MCP endpoint and local Dashboard access within the documented trust boundary.

Application history records the proposal, Workflow, Project, operator metadata, timestamp, modification summary, and before/after digests under `runtime-data/memory-application-history/`. Applied proposals remain applied when a Review Package is rebuilt.

The contract intentionally does not provide arbitrary Memory text editing. Proposal content comes from the persisted Decision, Harness-observed changes, Reviewer evidence, and Project Context. Manual edits remain possible outside Supervisor and remain the operator's responsibility.
