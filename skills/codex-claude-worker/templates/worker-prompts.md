# Worker Prompt Templates

## Natural-Language Translation

Use this before `run` when the user gave an ordinary prompt.

```text
Raw user request:
<raw-request>

Translate this into a bounded worker task.
Target path: <bounded-path>
Deliverables: <files-or-artifacts>
Acceptance checks: <checks Codex will run after worker completion>
Assumptions: <minimal assumptions made by Codex>
Actions not allowed: no network, no dependency installation, no git commands, no deleting outside the target path, no editing project config or lockfiles.
```

## Generic Build

```text
Build the requested artifact only under <bounded-path>.
User intent:
<raw-user-request>

Deliverables:
<deliverables>

Acceptance checks Codex will run after completion:
<checks>

Boundaries:
- Only create or modify files under <bounded-path>.
- Do not modify .agents/, mcp-server/, scripts/, docs/, skills/, examples/, .git/, config files, package files, or lockfiles unless explicitly requested.
- Do not access the network.
- Do not install dependencies.
- Do not run git commands.
- Do not delete files outside <bounded-path>.

Return only a raw JSON object with summary, files_read, changes_made, commands_run, tests_or_checks, risks, blocked_on.
```

## Plan

```text
Inspect the project for this task and return a concise implementation plan.
Do not modify files.
Focus on the bounded path: <bounded-path>.
Return JSON with summary, files_read, changes_made, commands_run, tests_or_checks, risks, blocked_on.

Task:
<task>
```

## Run

```text
Implement the task only under <bounded-path>.
Do not modify .agents/, mcp-server/, scripts/, .git/, config files, package files, or lockfiles.
Do not access the network.
Do not install dependencies.
Do not delete files outside <bounded-path>.
Do not run git commands.
Keep the implementation small and readable.
After edits, return only a raw JSON object with summary, files_read, changes_made, commands_run, tests_or_checks, risks, blocked_on.

Task:
<task>
```

## Refactor Existing File

```text
Modify only the approved target files listed below.
User intent:
<raw-user-request>

Approved files:
<file-list>

Required behavior:
<behavior>

Acceptance checks Codex will run:
<checks>

Do not modify any unlisted file. Do not access the network, install dependencies, run git commands, or delete files.
Return only a raw JSON object with summary, files_read, changes_made, commands_run, tests_or_checks, risks, blocked_on.
```

## Documentation Draft

```text
Create or update documentation only under <bounded-path-or-approved-files>.
User intent:
<raw-user-request>

Required topics:
<topics>

Documentation constraints:
- Use ASCII-only text unless the user explicitly requested another language or character set.
- Do not include real local paths, usernames, tokens, secrets, or ngrok/cloudflared URLs.
- Use placeholders such as <project-root>, <ngrok-domain>, and <task-id>.
- Keep the output short enough for Codex to inspect.

Boundaries:
- Do not edit any unapproved file.
- Do not access the network.
- Do not install dependencies.
- Do not run git commands.
- Do not delete files.

Acceptance checks Codex will run:
- Read the document.
- Scan for mojibake, real local paths, usernames, tokens, and real tunnel URLs.
- Confirm the required topics are covered.

Return only a raw JSON object with summary, files_read, changes_made, commands_run, tests_or_checks, risks, blocked_on.
```

## Review

```text
Review the current diff or bounded path for correctness risks.
Do not modify files.
Check behavior, tests, file boundaries, dependency/network/git usage, and any encoding issues.
Return JSON with summary, files_read, changes_made, commands_run, tests_or_checks, risks, blocked_on.

Target:
<bounded-path-or-diff-scope>
```

## Fix

```text
Fix only the concrete defects listed below and only under <bounded-path>.
Do not broaden scope.
Use ASCII-only text unless the existing file clearly requires non-ASCII.
Do not access the network, install dependencies, delete files outside <bounded-path>, or run git commands.
After edits, return only a raw JSON object with summary, files_read, changes_made, commands_run, tests_or_checks, risks, blocked_on.

Defects found by supervisor validation:
<defects>
```
