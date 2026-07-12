# Supervisor Checklist

Run this checklist after every worker call.

1. Confirm Codex translated the raw user prompt into a concrete worker task without losing intent.
2. Read the latest summary and normalized result.
3. Confirm status is `success`; if not, report the exact status and error.
4. Inspect changed files yourself; do not rely only on worker self-report.
5. Verify the worker stayed inside the approved path or approved file list.
6. Run the smallest relevant checks: syntax, unit test, smoke test, static scan, sample run, or artifact inspection.
7. For docs or user-facing text, scan for mojibake, accidental non-ASCII where ASCII was requested, and real local paths/usernames/tokens.
8. Check for forbidden side effects: network assets, package files, lockfiles, git operations, deletes, secrets, config edits.
9. Read the ledger entry and confirm approval reason, allowed actions, changes, checks, risks, and blocked items are recorded.
10. If validation fails, start a separate bounded fix run with the exact defect summary.
