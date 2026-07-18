import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => readFile(path.join(root, relative), "utf8");
const [readme, readmeZh, usage, architecture, packageText, releaseText, installSource, startSource] = await Promise.all([
  read("README.md"),
  read("README.zh-CN.md"),
  read("docs/gpt-web-usage.md"),
  read("docs/ARCHITECTURE.md"),
  read("mcp-server/package.json"),
  read(".agents/release-status.json"),
  read("install.ps1"),
  read("start.ps1")
]);

const packageJson = JSON.parse(packageText);
const releaseStatus = JSON.parse(releaseText);
assert.equal(packageJson.version, "1.8.0-beta.1");
assert.equal(releaseStatus.version, packageJson.version);
assert.equal(releaseStatus.readiness, "pending_gpt_web_validation");
assert(installSource.includes("Supervisor v1.8 Beta"));
assert(startSource.includes("Supervisor v1.8 Beta"));

for (const [name, source] of [["README", readme], ["README.zh-CN", readmeZh]]) {
  for (const marker of [".\\install.ps1", ".\\scripts\\doctor.ps1", ".\\start.ps1", "start-openai-tunnel.ps1", "cc_list_projects", "cc_list_workflow_definitions"]) {
    assert(source.includes(marker), `${name} must document executable first-run marker: ${marker}`);
  }
  assert(source.includes('-Initialize -TunnelId "<tunnel-id>"'), `${name} must include the required tunnel id placeholder`);
}

for (const marker of ["Add CSV export to the demo task board", "Human Approval", "Harness Audit", "ChatGPT Supervisor Review"]) {
  assert(readme.includes(marker), `README must include demo marker: ${marker}`);
}
for (const marker of ["ChatGPT Web", "Claude Code Worker", "Supervisor Dashboard", "cc_get_supervisor_review_package", "new ChatGPT Web conversation"]) {
  assert(usage.includes(marker), `GPT Web usage guide must include: ${marker}`);
}
assert(architecture.includes("local-first, auditable execution governance layer for coding agents"));
assert(!readme.includes("just a Claude Code MCP wrapper"));

console.log(JSON.stringify({ ok: true, version: packageJson.version, quickStart: true, gptWebValidationGuide: true }, null, 2));
