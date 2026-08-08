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
| `.agents/projects.json` | Release Project IDs, relative paths, descriptions, technology stacks, aliases, and default Supervisor constraints. |
| `.agents/projects.local.example.json` | Placeholder-only template for a machine-local Project registry. |

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

Supervisor Doctor reports only whether these variables are present. It does not print their values. `.env*`, `mcp-server/config.json`, `.agents/projects.local.json`, `.agents/local.config.json`, Tunnel profiles, runtime data, logs, and Worker artifacts are ignored by Git.

## Configuration precedence

Resource limits resolve in this order:

1. explicit task resource overrides;
2. the selected Resource Profile;
3. the default `small_readonly` profile.

All resolved values remain bounded by `.agents/resource-profiles.json` global hard limits and by immutable code-owned absolute limits. Legacy `.agents/local.config.json` values do not override a Resource Profile.

The local Dashboard **Settings** dialog can change the default profile, profile envelopes, and configured global locks. It writes the same checked-in resource-profile file atomically, affects only Tasks created after the save, and cannot add/remove profile names or exceed the immutable absolute limits. Running Attempts retain their persisted resource snapshot. Approval, strict audit, side-effect protection, concurrency, and retention are shown for operator awareness but are not mutable from this settings surface.

## Registered projects

Project definitions load in this order:

1. checked-in release definitions from `.agents/projects.json`;
2. optional machine-local definitions from ignored `.agents/projects.local.json`;
3. Dashboard-created definitions and metadata overrides from ignored runtime data.

Copy `.agents/projects.local.example.json` to `.agents/projects.local.json` only when a private workspace Project is needed. Local entries cannot use absolute paths and must resolve inside this repository's `workspace/` directory. A `projectId` duplicated across release and local registries is a startup error. Missing local registry is valid. Runtime metadata for a removed local definition is ignored with a diagnostic rather than being promoted into an incomplete Project.

Every definition requires a stable `projectId`, relative `workspacePath`, `description`, `stack`, `aliases`, and `constraints`. Alias matching helps the Supervisor choose a unique project; it is not permission to explore sibling directories. Runtime-derived usage and Dashboard metadata remain ignored rather than rewriting the public registry.

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

Default Doctor does not make an external model request. To verify the configured Claude CLI provider explicitly:

```powershell
.\scripts\doctor.ps1 -ProviderPreflight
```

This probe uses a fixed non-project marker, an isolated empty temporary directory, `--tools ""`, and disabled session persistence. It does not read or send project content and cannot modify project files. It may incur the provider's minimum request cost. The latest Dashboard-triggered result is stored in ignored `runtime-data/provider-preflight/latest.json`.

Failed Workflow recovery creates a separate Workflow directory and links it to the source history. It copies the original request, selected project, Supervisor Decision, Workflow type, and mock setting only. Task IDs, Attempt IDs, approval/rejection metadata, and stage results are never reused.

For automation, use `.\scripts\doctor.ps1 -Json`. Warnings such as “Bridge not running” or “Tunnel not configured” are expected before those optional components start; `[FAIL]` items include a concrete remediation and block startup readiness.
