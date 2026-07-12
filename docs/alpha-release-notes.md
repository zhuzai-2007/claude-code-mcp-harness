# Supervised MCP Alpha Release Notes

This Alpha provides a synchronous, human-supervised path from ChatGPT Web through OpenAI Secure MCP Tunnel to a local Claude Code worker. Claude Code may use a locally configured compatible provider. The local Harness remains the policy and audit boundary.

## Completed capabilities

- Read-only plan and review tools plus an explicitly approved write tool.
- OpenAI Secure MCP Tunnel setup for no-auth and DCR profiles.
- Stable run IDs, normalized results, project ledger, bounded budgets, and worker timeouts.
- UTF-8 no-BOM worker artifacts with exact Unicode round-trip tests.
- Non-strict or incomplete worker output is rejected as `audit_validation_failed`.
- Mode-specific audit evidence requirements for plan, review, and run.
- Full preservation of strict Worker summaries and complete `cc_get_result` artifact retrieval.
- Independent Claude Code tool-event artifacts with self-report cross-validation for commands, checks, file access, and permission denials.
- Real-write smoke validation for files, directories, and symbolic links.
- Windows process-tree termination on Bridge timeout.
- CI smoke coverage, documentation hygiene checks, and portable Harness installation.

## Safety boundary

- This is a trusted-code local Harness, not an OS sandbox.
- The MCP Bridge exposes only allowlisted Harness scripts; it is not a generic shell endpoint.
- Plan and review are read-only. Run requires explicit approval metadata and uses the local policy.
- Project-root escape, secret/global-config access, recursive deletion, Git commit/push, network access, and dependency installation remain denied unless the narrow local policy explicitly allows the relevant non-destructive action.
- GPT approval cannot override the local hard boundary.
- File-only tasks must use Read, Write, or Edit. Windows drive-letter paths must not be passed to Bash/MSYS.

## Known limitations

- MCP calls remain synchronous. Browser, Tunnel, or Bridge interruptions are not yet represented by a durable task state machine.
- Runtime permission requests cannot yet pause, notify, persist, and resume through ChatGPT.
- Tool auditing is based on Claude Code `stream-json` events. It does not provide kernel-level proof, and provider/CLI variants that omit required tool events are conservatively rejected as unverifiable.
- ChatGPT cannot be assumed to wake automatically after a response ends.
- The final hardened write action still requires one manual ChatGPT Web confirmation after the updated Bridge is restarted.
- Phase B asynchronous Orchestrator, durable approvals, notification outbox, leases, and recovery are not implemented.

## Local startup

1. Initialize local MCP configuration:

   ```powershell
   .\scripts\init-config.ps1
   ```

2. Start the loopback MCP Bridge in its own terminal:

   ```powershell
   .\scripts\start-mcp.ps1
   ```

3. Inspect the Tunnel profile choice. A configuration with `requireAuth: false` selects `sample_mcp_remote_no_auth`:

   ```powershell
   .\scripts\start-openai-tunnel.ps1 -PrintConfiguration
   ```

4. If required, set `CONTROL_PLANE_HTTP_PROXY` in the operator environment. Never store the proxy credentials, runtime API key, Tunnel ID, or local profile in this repository.

5. Initialize the Tunnel profile once, then run it in a separate terminal. See `docs/secure-mcp-tunnel.md` for placeholder-only commands.

6. Verify Tunnel readiness:

   ```powershell
   .\scripts\start-openai-tunnel.ps1 -ReadyOnly
   ```

7. In ChatGPT Developer mode, refresh the app after restarting the updated Bridge, run a read-only plan first, then manually confirm one minimal hardened write.

The updated `server.mjs` is not loaded into an already-running Node process. Restart the Bridge only during an operator-approved maintenance window; this release preparation does not stop or restart it.
