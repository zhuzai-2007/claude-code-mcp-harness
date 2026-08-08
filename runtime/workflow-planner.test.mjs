import assert from "node:assert/strict";
import { loadWorkflowDefinitions } from "./workflow-definitions.mjs";
import { WorkflowPlanner } from "./workflow-planner.mjs";

const definitions = await loadWorkflowDefinitions();
const planner = new WorkflowPlanner({ definitions });

assert.deepEqual(Object.keys(definitions.definitions).sort(), ["analysis_only", "documentation_change", "software_change"]);

const software = planner.plan("给任务看板增加导出 JSON 功能");
assert.equal(software.workflowType, "software_change");
assert.equal(software.goal, "给任务看板增加导出 JSON 功能");
assert.equal(software.selection, "rule_based");
assert.deepEqual(software.stages, ["planner", "approval", "coder", "reviewer"]);
assert(software.constraints.some((constraint) => constraint.includes("human approval")));

const analysis = planner.plan("分析当前项目架构并说明风险");
assert.equal(analysis.workflowType, "analysis_only");
assert.deepEqual(analysis.stages, ["planner"]);
assert(analysis.constraints.some((constraint) => constraint.includes("Read-only")));

const documentation = planner.plan("更新 README 使用说明");
assert.equal(documentation.workflowType, "documentation_change");
assert.deepEqual(documentation.stages, ["planner", "approval", "coder", "reviewer"]);

const modificationWins = planner.plan("分析架构并修改搜索实现");
assert.equal(modificationWins.workflowType, "software_change");

const explicit = planner.plan("分析现有 README", { workflowType: "software_change" });
assert.equal(explicit.workflowType, "software_change");
assert.equal(explicit.selection, "explicit");

assert.throws(() => planner.plan("test", { workflowType: "missing" }), /Unknown Workflow definition/);
console.log(JSON.stringify({ ok: true, software, analysis, documentation }, null, 2));
