import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => readFile(path.join(root, relative), "utf8");
const [readme, readmeZh, usage, architecture, packageText, releaseText, installSource, startSource, projectContextSource, serverSource, doctorSource, ciSource, gitignore, localExample, testRunnerSource, releaseVerifierSource] = await Promise.all([
  read("README.md"),
  read("README.zh-CN.md"),
  read("docs/gpt-web-usage.md"),
  read("docs/ARCHITECTURE.md"),
  read("mcp-server/package.json"),
  read(".agents/release-status.json"),
  read("install.ps1"),
  read("start.ps1"),
  read("runtime/project-context.mjs"),
  read("mcp-server/server.mjs"),
  read("scripts/doctor.ps1"),
  read(".github/workflows/ci.yml"),
  read(".gitignore"),
  read(".agents/projects.local.example.json"),
  read("scripts/run-node-tests.ps1"),
  read("scripts/verify-release-projects.ps1")
]);

const packageJson = JSON.parse(packageText);
const releaseStatus = JSON.parse(releaseText);
assert.equal(packageJson.version, "1.10.0-beta.1");
assert.equal(releaseStatus.version, packageJson.version);
assert.equal(releaseStatus.readiness, "pending_gpt_web_validation");
assert(installSource.includes("Supervisor v1.10 Beta"));
assert(startSource.includes("Supervisor v1.10 Beta"));

for (const [name, source] of [["README", readme], ["README.zh-CN", readmeZh]]) {
  for (const marker of [".\\install.ps1", ".\\scripts\\doctor.ps1", ".\\start.ps1", "start-openai-tunnel.ps1", "cc_list_projects", "cc_list_workflow_definitions"]) {
    assert(source.includes(marker), `${name} must document executable first-run marker: ${marker}`);
  }
  assert(source.includes('-Initialize -TunnelId "<tunnel-id>"'), `${name} must include the required tunnel id placeholder`);
}

for (const marker of ["registered Project", "projectId", "Human Approval", "Harness Audit", "ChatGPT Supervisor Review"]) {
  assert(readme.includes(marker), `README must include stable Project-first onboarding contract: ${marker}`);
}
for (const marker of ["Release Beta Todo Demo", "add CSV export to the task board"]) {
  assert(readme.includes(marker), `README must include canonical demo marker: ${marker}`);
}
for (const marker of ["已注册的 Project", "projectId", "Human Approval", "Harness Audit", "ChatGPT Supervisor Review", "Release Beta Todo Demo"]) {
  assert(readmeZh.includes(marker), `README.zh-CN must include Project-first onboarding contract: ${marker}`);
}
for (const marker of ["ChatGPT Web", "Claude Code Worker", "Supervisor Dashboard", "cc_get_supervisor_review_package", "new ChatGPT Web conversation"]) {
  assert(usage.includes(marker), `GPT Web usage guide must include: ${marker}`);
}
assert(architecture.includes("local-first, auditable execution governance layer for coding agents"));
assert(!readme.includes("just a Claude Code MCP wrapper"));

assert(projectContextSource.includes("Duplicate projectId across release and local registries"));
assert(projectContextSource.includes("Local project must be inside the workspace root"));
assert(serverSource.includes('localRegistryPath: resolveInsideProject(".agents", "projects.local.json")'));
assert(doctorSource.includes("Not configured (optional)."));
assert(gitignore.split(/\r?\n/).includes(".agents/projects.local.json"));
assert.equal(JSON.parse(localExample).projects[0].workspacePath, "workspace/my-local-project");
assert(ciSource.includes("clean-onboarding:"));
assert(ciSource.includes(".\\install.ps1"));
assert(ciSource.includes(".\\scripts\\doctor.ps1 -Json"));
assert(ciSource.includes(".\\start.ps1 -CheckOnly"));
assert(ciSource.includes(".\\scripts\\run-node-tests.ps1"));
assert(testRunnerSource.includes("ls-files --cached --others --exclude-standard"));
assert(releaseVerifierSource.includes("Release Project materialization"));

console.log(JSON.stringify({ ok: true, version: packageJson.version, quickStart: true, cleanCloneValidation: true, automaticTestDiscovery: true, gptWebValidationGuide: true }, null, 2));
