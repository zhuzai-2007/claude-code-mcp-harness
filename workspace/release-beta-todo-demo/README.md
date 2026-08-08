# Release Beta Todo Demo

This dependency-free browser Todo application is the isolated target for the Supervisor v1.0-beta release acceptance. It has no build step, package manager, persistence, or network access.

The baseline intentionally displays priority labels without offering a priority filter. The release dogfood request is expected to add that behavior through the normal Supervisor Decision, Workflow, approval, Coder, and Reviewer path.

Run the contract test with:

```powershell
node .\workspace\release-beta-todo-demo\demo.test.mjs
```
