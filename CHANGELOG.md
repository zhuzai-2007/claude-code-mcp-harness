# Changelog

All notable product changes are recorded here. The project follows semantic versioning while Beta compatibility is being validated.

## [1.10.0-beta.1] - 2026-07-23

### Added

- Project-first Dashboard workspace with managed Project create, stable-id rename, pin/archive/restore, explicit Project-scoped Workflow creation, and a global archive view.
- System/light/dark themes and a responsive Project tree that expands directly into Workflows beside the detail area, without page-level horizontal scrolling.
- Bounded Dashboard mutation requests, duplicate-submit guards, in-dialog failures, compact Project polling, and stale-refresh suppression.
- Persistent Archived Projects visibility, automatic reveal after archive, and a direct restore action so archived Projects remain discoverable and reversible.
- User-controlled Project collapse state across polling, plus an independently collapsible Global Archive Workflow group.
- An active registered Project selector inside the Local fallback entry, synchronized with the workspace Project tree.
- A compact expanded Local fallback layout that keeps only the request, Project selector, safety hint, and submit control.
- Release/local/runtime Project Registry layering with conflict rejection and workspace-bound relative paths.
- Planner Resource Selection that derives the existing Resource Profile from task scope while preserving global hard limits.
- Runtime-generated, read-only Project Context Snapshots for reliable planning in empty and populated Projects.
- Persistent Dashboard Settings for operator-controlled resource defaults and maximum limits.
- Automatic Node test discovery across Runtime, MCP Server, scripts, and workspace test roots.
- Clean onboarding validation for checkout, install, doctor, start-check, release Projects, local-registry absence, and ignored Runtime data.

### Removed

- The Dashboard's obsolete Legacy / Unassigned navigation group and the local pre-Project dogfood Workflow records that populated it.

### Compatibility

- The checked-in Project Registry remains the immutable base; runtime Project metadata is an additive overlay.
- Project-bound Workflow snapshots, folder metadata, events, evidence, Review Packages, and Memory history remain readable and unchanged.
- The Task and Workflow state machines, Harness validation, Resource Profiles, approval boundary, and existing MCP tool semantics are unchanged.

### Release status

- This is a release candidate. Automated, mock, and local non-paid checks form the repeatable baseline.
- A fresh-session ChatGPT Web end-to-end validation is still required before declaring the public Beta ready.

## [1.8.0-beta.1] - 2026-07-18

### Added

- GPT-owned Supervisor Decisions, registered Project Context, and cross-Workflow Project Sessions.
- Discoverable Workflow Definitions and a stable Plan -> Approval -> Coder -> Reviewer execution path.
- Human-GPT review handoff, evidence-first Supervisor Review Packages, confirmed Review Results, and confirmation-required Memory proposals.
- Project Continuity views, Artifact Center, deterministic Project Health, and release-readiness metadata.
- Bilingual, dependency-free Supervisor Dashboard with stage navigation, approvals, recent-work folders, archives, and failure recovery guidance.

### Changed

- Repositioned the product as a local governance layer for coding agents rather than a model, general Agent framework, or thin Claude Code wrapper.
- Tightened first-run, nvm, tunnel, proxy, capability-discovery, and GPT Web operating guidance.
- Consolidated the release baseline at `1.8.0-beta.1` without changing Task/Workflow state machines, Harness validation, Resource Profiles, or approval semantics.

### Security

- Write-capable Workflow stages still require explicit human approval.
- Worker claims remain cross-validated against observed tool evidence.
- Project Memory is never updated automatically, and no GPT API is called by the Runtime.

### Release status

- This is a release candidate. Automated, mock, and local non-paid checks form the repeatable baseline.
- A fresh-session ChatGPT Web end-to-end validation is still required before declaring the public Beta ready.

## [1.0.0-beta.1] - 2026-06-21

- Established the initial Beta release baseline around durable Workflow/Task state, explicit approval, Resource Profiles, strict audit validation, and the local Dashboard.

## [0.1.0-alpha] - 2026-06-01

- Introduced the local MCP Bridge and bounded Claude Code Harness.
