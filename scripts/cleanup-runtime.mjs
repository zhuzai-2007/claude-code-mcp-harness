import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyRuntimeRetention, planRuntimeRetention } from "../runtime/runtime-retention.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const config = JSON.parse((await readFile(path.join(repoRoot, "mcp-server", "config.json"), "utf8")).replace(/^\uFEFF/, ""));
const dataRoot = path.resolve(repoRoot, config.runtimeDataRoot || "runtime-data");
const policy = config.retention || {};
const plan = await planRuntimeRetention({
  dataRoot,
  artifactRoots: [path.join(repoRoot, ".agents", "runs"), path.join(repoRoot, ".agent-runs")],
  maxAgeDays: policy.maxAgeDays,
  maxWorkflows: policy.maxWorkflows,
  maxStandaloneTasks: policy.maxStandaloneTasks,
  maxDecisions: policy.maxDecisions
});
const result = process.argv.includes("--apply") ? await applyRuntimeRetention(plan) : { ...plan, applied: false };
console.log(JSON.stringify(result, null, 2));
