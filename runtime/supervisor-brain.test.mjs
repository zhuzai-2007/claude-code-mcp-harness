import assert from "node:assert/strict";
import path from "node:path";
import { mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { loadWorkflowDefinitions } from "./workflow-definitions.mjs";
import { WorkflowPlanner } from "./workflow-planner.mjs";
import { FileSupervisorStore } from "./file-supervisor-store.mjs";
import { ProjectContextRegistry } from "./project-context.mjs";
import { SupervisorDecisionLayer } from "./supervisor-decision.mjs";
import { SupervisorService } from "./supervisor-service.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataRoot = path.join(repoRoot, ".agent-runs", `supervisor-brain-test-${process.pid}-${Date.now()}`);
await mkdir(dataRoot, { recursive: true });
try {
  const store = new FileSupervisorStore(dataRoot);
  const registry = new ProjectContextRegistry({ projectRoot: repoRoot, registryPath: path.join(repoRoot, ".agents", "projects.json"), usageProvider: () => store.readProjectUsage() });
  await registry.init();
  const planner = new WorkflowPlanner({ definitions: await loadWorkflowDefinitions() });
  const layer = new SupervisorDecisionLayer({ projectRegistry: registry, workflowPlanner: planner });

  const board = layer.decide("给任务看板增加一个导出 CSV 功能");
  assert.equal(board.schemaVersion, 2);
  assert.equal(board.project.id, "dogfood-study-board");
  assert.equal(board.intent, "code_change");
  assert.equal(board.workflowType, "software_change");
  assert.equal(board.nextAction, "create_workflow");
  assert(board.constraints.some((item) => item.includes("workspace/dogfood-study-board")));
  assert(board.constraints.some((item) => item.includes("dependency-free")));
  assert.match(board.technical_summary, /Dogfood Study Board/);
  assert(board.risks.length >= 2);
  assert(board.recommended_actions.some((item) => item.includes("software_change")));
  assert.equal(board.estimated_resources.stages.map((stage) => stage.role).join(","), "planner,coder,reviewer");
  assert(board.estimated_resources.hard_caps.budgetUsd > board.estimated_resources.expected.budgetUsd);

  const ambiguous = layer.decide("增加一个小功能");
  assert.equal(ambiguous.nextAction, "confirm_project");
  assert.equal(ambiguous.status, "waiting_project_confirmation");
  assert(ambiguous.projectResolution.candidates.length >= 2);

  const created = [];
  const workflowRuntime = {
    async createWorkflow(input) { created.push(input); return { workflowId: `workflow_test_${created.length}`, status: "planning", tasks: [] }; }
  };
  const service = new SupervisorService({ decisionLayer: layer, store, workflowRuntime });
  await service.start();
  const waiting = await service.submitRequest({ userRequest: "增加一个小功能" });
  assert.equal(waiting.status, "project_confirmation_required");
  assert.equal(created.length, 0, "Ambiguous project must not create a Workflow or Task");
  assert(await store.readDecision(waiting.decision.decisionId));
  const confirmed = await service.submitRequest({ userRequest: waiting.decision.originalRequest, decisionId: waiting.decision.decisionId, projectId: "supervisor-dashboard" });
  assert.equal(confirmed.status, "success");
  assert.equal(confirmed.decision.project.id, "supervisor-dashboard");
  assert.equal(created[0].supervisorDecision.project.path, "workspace/supervisor-dashboard");

  const gpt = await service.submitRequest({
    userRequest: "分析任务看板的导出逻辑",
    supervisorDecision: { intent: "analysis", goal: "验证导出逻辑", technical_summary: "只读检查任务看板导出逻辑与风险。", project: "dogfood-study-board", reasoning: ["这是只读验证", "目标项目已在注册表中"], risks: ["导出数据格式可能与现有存储格式不一致。"], workflowType: "analysis_only", estimated_resources: { complexity: "low", expected: { budgetUsd: 0.2, turns: 12, filesRead: 6, commands: 0, timeoutSeconds: 180 }, notes: ["只检查注册项目。"] }, recommended_actions: ["创建只读分析 Workflow。"], confidence: 0.94, nextAction: "create_workflow" }
  });
  assert.equal(gpt.decision.source, "gpt");
  assert.deepEqual(gpt.decision.reasoning.slice(0, 2), ["这是只读验证", "目标项目已在注册表中"]);
  assert.equal(gpt.decision.technical_summary, "只读检查任务看板导出逻辑与风险。");
  assert.deepEqual(gpt.decision.risks, ["导出数据格式可能与现有存储格式不一致。"]);
  assert.equal(gpt.decision.estimated_resources.basis, "gpt_estimate_with_runtime_caps");
  assert.equal(gpt.decision.estimated_resources.expected.filesRead, 6);
  assert.deepEqual(gpt.decision.recommended_actions, ["创建只读分析 Workflow。"]);
  assert.equal(gpt.workflow.workflowId, "workflow_test_2");

  const direct = await service.submitRequest({
    userRequest: "简单说明这个系统是什么",
    supervisorDecision: { intent: "conversation", goal: "解释系统定位", reasoning: ["该请求不需要本地 Worker。"], workflowType: "analysis_only", confidence: 0.88, nextAction: "respond_directly" }
  });
  assert.equal(direct.status, "decision_only");
  assert.equal(direct.workflow, null);
  assert.equal(direct.decision.agentRequired, false);
  assert.equal(direct.decision.estimated_resources.hard_caps.budgetUsd, 0);
  assert.equal(created.length, 2, "respond_directly must not create a Workflow or Task");

  const projects = await service.listProjects();
  const boardProject = projects.find((project) => project.id === "dogfood-study-board");
  assert(boardProject.lastUsed);
  assert(boardProject.techStack.includes("localStorage"));
  assert(boardProject.aliases.includes("任务看板"));
  assert(boardProject.defaultConstraints.some((item) => item.includes("dependency-free")));
  assert.throws(() => layer.decide("分析任务看板", { proposedDecision: { intent: "analysis", project: "dogfood-study-board", reasoning: ["test"], workflowType: "software_change", confidence: 0.8, nextAction: "create_workflow" } }), /requires Workflow 'analysis_only'/);
  console.log(JSON.stringify({ ok: true, boardDecision: board.decisionId, confirmationDecision: waiting.decision.decisionId, gptDecision: gpt.decision.decisionId, projectCount: projects.length }, null, 2));
} finally {
  await rm(dataRoot, { recursive: true, force: true });
}
