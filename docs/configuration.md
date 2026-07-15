# Configuration and secrets

Supervisor keeps versioned policy separate from machine-local runtime settings and credentials.

## Public, versioned configuration

These files are safe to review and commit when they contain no machine-specific values:

| File | Purpose |
| --- | --- |
| `mcp-server/config.example.json` | Complete placeholder template for the local Bridge. |
| `.agents/policy.json` | Tool permissions, read/write modes, and safety rules. |
| `.agents/resource-profiles.json` | Budget, turns, files, commands, and timeout envelopes. |
| `.agents/workflow-definitions.json` | Workflow selection metadata and Stage definitions. |
| `.agents/projects.json` | Registered project IDs, relative paths, descriptions, technology stacks, aliases, and default Supervisor constraints. |

After cloning, `scripts/init-config.ps1` copies the example into ignored `mcp-server/config.json` and replaces `projectRoot` with the current repository path. Recommended local defaults are loopback host `127.0.0.1`, port `8787`, one concurrent Task, and `null` legacy approval defaults.

`defaultApprovedBy` and `defaultApprovalReason` apply only to the legacy synchronous `cc_run_approved_task` compatibility tool. Keep them `null` for an explicit caller-supplied approval. Dashboard Workflow approval never consumes these defaults and always requires a human action with a name and reason.

## Private runtime configuration

Never place these values in committed JSON, Markdown, test fixtures, logs, or screenshots:

- model-provider API keys;
- `CONTROL_PLANE_API_KEY` and Tunnel identifiers;
- proxy credentials or private proxy endpoints;
- private MCP URLs, runtime tokens, cookies, or session data.

Set secrets only in the terminal or operating-system secret facility that starts the relevant process:

```powershell
$env:CONTROL_PLANE_API_KEY="<tunnel-runtime-key>"
$env:HTTP_PROXY="http://127.0.0.1:<proxy-port>"
$env:HTTPS_PROXY="http://127.0.0.1:<proxy-port>"
```

Supervisor Doctor reports only whether these variables are present. It does not print their values. `.env*`, `mcp-server/config.json`, `.agents/local.config.json`, Tunnel profiles, runtime data, logs, and Worker artifacts are ignored by Git.

## Configuration precedence

Resource limits resolve in this order:

1. explicit task resource overrides;
2. the selected Resource Profile;
3. the default `small_readonly` profile.

All resolved values remain bounded by `.agents/resource-profiles.json` global hard limits. Legacy `.agents/local.config.json` values do not override a Resource Profile.

## Registered projects

Every `.agents/projects.json` entry requires a stable `id`, relative `path`, `description`, `techStack`, `aliases`, and `defaultConstraints`. Paths are validated to exist inside `projectRoot`. Alias matching helps the Supervisor choose a unique project; it is not permission to explore sibling directories. Runtime-derived `lastUsed` values are kept in ignored `runtime-data/project-usage.json` rather than rewriting the public registry.

## Runtime retention

`mcp-server/config.json` may override the startup retention policy:

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

Only terminal Workflows/Tasks and their referenced attempt artifacts are eligible. Active work is always preserved. Run `node .\scripts\cleanup-runtime.mjs` for a dry-run plan and add `--apply` to execute it.

## Preflight

Run the human-readable Doctor before startup:

```powershell
.\scripts\doctor.ps1
```

For automation, use `.\scripts\doctor.ps1 -Json`. Warnings such as “Bridge not running” or “Tunnel not configured” are expected before those optional components start; `[FAIL]` items include a concrete remediation and block startup readiness.
