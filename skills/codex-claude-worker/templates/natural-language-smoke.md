# Natural-Language Smoke Prompts

Use these to validate that Codex can translate ordinary requests into bounded worker tasks.

1. `Build a local task manager CLI with no dependencies. It should support add/list/done/export.`
2. `Build a static HTML page for tracking study plans. Store data in localStorage.`
3. `Add a --json output mode to this existing Python script.`
4. `Fix the failing tests based on this error log.`
5. `Organize this project into a README covering installation, usage, testing, and security boundaries.`

For each smoke, record:

- raw user prompt
- Codex-translated worker prompt
- worker run id
- fix run ids
- supervisor validation commands
- boundary violations
- result
