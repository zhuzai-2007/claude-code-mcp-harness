# Changelog

All notable product changes are recorded here. The project follows semantic versioning while Beta compatibility is being validated.

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
