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
  const boardContext = registry.getProjectContext("dogfood-study-board");
  assert.equal(board.schemaVersion, 6);
  assert.equal(board.clarificationNeeded, false, "A clear, bounded request must not be forced through clarification");
  assert(board.goalConfidence >= 0.6);
  assert.equal(board.project_memory.available, boardContext.memory.available);
  assert.equal(board.project_memory.content, boardContext.projectMemory);
  assert.equal(board.project_memory.digest, boardContext.memory.digest);
  assert(board.project_memory.capturedAt);
  assert.equal(board.project.id, "dogfood-study-board");
  assert.equal(board.projectId, "dogfood-study-board");
  assert.match(board.workspacePath, /workspace\/dogfood-study-board$/);
  assert.equal(board.intent, "code_change");
  assert.equal(board.workflowType, "software_change");
  assert.equal(board.nextAction, "create_workflow");
  assert(board.constraints.some((item) => item.includes("workspace/dogfood-study-board")));
  assert(board.constraints.some((item) => item.includes("dependency-free")));
  assert.match(board.technical_summary, /Dogfood Study Board/);
  assert(board.implementation_strategy.length > 20);
  assert(board.expected_changes.length >= 1);
  assert(board.validation_plan.length >= 2);
  assert.equal(board.supervisor_context.available, true);
  assert.match(board.supervisor_context.digest, /^[a-f0-9]{64}$/);
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
    async createWorkflow(input) { created.push(input); return { workflowId: `workflow_test_${created.length}`, status: "planning", tasks: [], projectId: input.supervisorDecision?.projectId || null, sessionId: input.session?.sessionId || null, userRequest: input.userRequest, updatedAt: new Date().toISOString() }; },
    async listWorkflows() { return created.map((input, index) => ({ workflowId: `workflow_test_${index + 1}`, projectId: input.supervisorDecision?.projectId || null, sessionId: input.session?.sessionId || null, userRequest: input.userRequest, status: "planning", updatedAt: new Date().toISOString() })); }
  };
  const service = new SupervisorService({ decisionLayer: layer, store, workflowRuntime });
  await service.start();
  await assert.rejects(() => service.submitRequest({
    userRequest: "给任务看板增加标签",
    supervisorDecision: { intent: "code_change", project: "dogfood-study-board", reasoning: ["需要修改代码"], workflowType: "software_change", confidence: 0.9, nextAction: "create_workflow" }
  }), /projectId_required/, "GPT must not create a Workflow without explicit projectId");
  const waiting = await service.submitRequest({ userRequest: "增加一个小功能" });
  assert.equal(waiting.status, "project_confirmation_required");
  assert.equal(created.length, 0, "Ambiguous project must not create a Workflow or Task");
  assert(await store.readDecision(waiting.decision.decisionId));
  const confirmed = await service.submitRequest({ userRequest: waiting.decision.originalRequest, decisionId: waiting.decision.decisionId, projectId: "supervisor-dashboard" });
  assert.equal(confirmed.status, "success");
  assert.equal(confirmed.decision.project.id, "supervisor-dashboard");
  assert.equal(created[0].supervisorDecision.project.path, "workspace/supervisor-dashboard");
  assert.equal(created[0].supervisorDecision.projectId, "supervisor-dashboard");
  assert.match(created[0].supervisorDecision.workspacePath, /workspace\/supervisor-dashboard$/);
  assert.equal(created[0].session.projectId, "supervisor-dashboard");

  const gpt = await service.submitRequest({
    userRequest: "分析任务看板的导出逻辑",
    projectId: "dogfood-study-board",
    supervisorDecision: { intent: "analysis", goal: "验证导出逻辑", technical_summary: "只读检查任务看板导出逻辑与风险。", project: "dogfood-study-board", reasoning: ["这是只读验证", "目标项目已在注册表中"], risks: ["导出数据格式可能与现有存储格式不一致。"], workflowType: "analysis_only", estimated_resources: { complexity: "low", expected: { budgetUsd: 0.2, turns: 12, filesRead: 6, commands: 0, timeoutSeconds: 180 }, notes: ["只检查注册项目。"] }, recommended_actions: ["创建只读分析 Workflow。"], confidence: 0.94, nextAction: "create_workflow" }
  });
  assert.equal(gpt.decision.source, "gpt");
  assert.deepEqual(gpt.decision.reasoning.slice(0, 2), ["这是只读验证", "目标项目已在注册表中"]);
  assert.equal(gpt.decision.technical_summary, "只读检查任务看板导出逻辑与风险。");
  assert(gpt.decision.implementation_strategy.includes("registered project"), "older GPT Decision input must receive a compatible strategy fallback");
  assert(gpt.decision.validation_plan.length >= 2, "older GPT Decision input must receive a compatible validation fallback");
  assert.deepEqual(gpt.decision.risks, ["导出数据格式可能与现有存储格式不一致。"]);
  assert.equal(gpt.decision.estimated_resources.basis, "gpt_estimate_with_runtime_caps");
  assert.equal(gpt.decision.estimated_resources.expected.filesRead, 6);
  assert.deepEqual(gpt.decision.recommended_actions, ["创建只读分析 Workflow。"]);
  assert.equal(gpt.workflow.workflowId, "workflow_test_2");

  const ambiguousIntent = layer.decide("导出项目数据", {
    project: "dogfood-study-board",
    proposedDecision: { intent: "code_change", goal: "增加 CSV 导出", goalConfidence: 0.45, possibleIntentMismatch: "用户可能需要数据迁移，而不只是下载文件。", clarificationNeeded: true, reasoning: ["目标可能影响数据边界"], workflowType: "software_change", confidence: 0.7, nextAction: "create_workflow" }
  });
  assert.equal(ambiguousIntent.goalConfidence, 0.45);
  assert.equal(ambiguousIntent.clarificationNeeded, true);
  assert.equal(ambiguousIntent.nextAction, "request_clarification");
  assert.equal(ambiguousIntent.status, "waiting_for_clarification");
  assert.match(ambiguousIntent.possibleIntentMismatch, /数据迁移/);
  assert(ambiguousIntent.clarificationReasons.includes("low_goal_confidence"));

  const projectContext = await service.getProjectContext("dogfood-study-board");
  assert.equal(projectContext.project.id, "dogfood-study-board");
  assert.match(projectContext.projectDescription, /browser task board/);
  assert(projectContext.technicalStack.includes("localStorage"));
  assert(projectContext.constraints.some((item) => item.includes("dependency-free")));
  assert.match(projectContext.supervisorInstructions, /dark mode/i);
  assert.equal(projectContext.supervisorContext.available, true);
  assert(Array.isArray(projectContext.sessions));

  const runtimeContext = await service.getProjectContext("supervisor-runtime");
  assert.equal(runtimeContext.memory.available, true);
  assert.match(runtimeContext.projectMemory, /Project goal/);
  assert.match(runtimeContext.projectMemorySummary, /Human approval/);

  const darkMode = await service.submitRequest({
    userRequest: "给任务看板增加暗色模式",
    projectId: "dogfood-study-board",
    sessionId: gpt.decision.session.sessionId,
    supervisorDecision: {
      intent: "code_change",
      goal: "为任务看板增加可持久化的暗色模式，同时保持现有任务数据与交互兼容。",
      technical_summary: "在静态任务看板中增加主题切换能力，使用 CSS 自定义属性表达颜色，并用浏览器偏好与 localStorage 保存用户选择。",
      implementation_strategy: "先确认现有样式入口和初始化顺序，再增加主题变量、可访问的切换控件与启动时主题恢复；不引入依赖，不改变任务数据结构。",
      expected_changes: ["调整现有 CSS 颜色为主题变量。", "增加主题切换控件和 localStorage 偏好恢复逻辑。"],
      validation_plan: ["验证首次加载遵循既定默认主题。", "验证切换和刷新后的主题持久化。", "验证任务新增、筛选和完成状态未回归。", "检查窄屏布局和文字对比度。"],
      project: "dogfood-study-board",
      reasoning: ["用户要求改变现有前端行为。", "项目 Context 要求保持静态、无依赖并兼容 localStorage。"],
      risks: ["主题初始化过晚可能导致页面闪烁。", "硬编码颜色可能造成局部对比度不足。"],
      workflowType: "software_change",
      confidence: 0.96,
      nextAction: "create_workflow"
    }
  });
  assert.equal(darkMode.decision.project.id, "dogfood-study-board");
  assert.equal(darkMode.decision.workflowType, "software_change");
  assert.match(darkMode.decision.technical_summary, /CSS 自定义属性/);
  assert.match(darkMode.decision.implementation_strategy, /主题变量/);
  assert.equal(darkMode.decision.expected_changes[0], "调整现有 CSS 颜色为主题变量。");
  assert.match(darkMode.decision.expected_changes[1], /localStorage 偏好恢复逻辑/);
  assert.equal(darkMode.decision.validation_plan.length, 4);
  assert.equal(darkMode.decision.supervisor_context.digest, projectContext.supervisorContext.digest);
  assert.equal(darkMode.decision.session.sessionId, gpt.decision.session.sessionId, "A later ChatGPT session can explicitly reuse the Runtime Project Session");
  assert.equal(darkMode.workflow.workflowId, "workflow_test_3");
  await assert.rejects(() => service.submitRequest({
    userRequest: "修改 Supervisor Dashboard",
    projectId: "supervisor-dashboard",
    sessionId: gpt.decision.session.sessionId,
    supervisorDecision: { intent: "code_change", goal: "修改 Dashboard", projectId: "supervisor-dashboard", reasoning: ["需要修改代码。"], workflowType: "software_change", confidence: 0.9, nextAction: "create_workflow" }
  }), /belongs to project 'dogfood-study-board'/, "A Project Session must never be reused across projects");

  const direct = await service.submitRequest({
    userRequest: "简单说明这个系统是什么",
    supervisorDecision: { intent: "conversation", goal: "解释系统定位", reasoning: ["该请求不需要本地 Worker。"], workflowType: "analysis_only", confidence: 0.88, nextAction: "respond_directly" }
  });
  assert.equal(direct.status, "decision_only");
  assert.equal(direct.workflow, null);
  assert.equal(direct.decision.agentRequired, false);
  assert.equal(direct.decision.estimated_resources.hard_caps.budgetUsd, 0);
  assert.equal(created.length, 3, "respond_directly must not create a Workflow or Task");

  const projects = await service.listProjects();
  const boardProject = projects.find((project) => project.id === "dogfood-study-board");
  assert(boardProject.lastUsed);
  assert(boardProject.techStack.includes("localStorage"));
  assert(boardProject.aliases.includes("任务看板"));
  assert(boardProject.defaultConstraints.some((item) => item.includes("dependency-free")));
  const projectViews = await service.listProjectViews();
  const boardView = projectViews.find((project) => project.projectId === "dogfood-study-board");
  assert.equal(boardView.sessionCount, 1);
  assert.equal(boardView.sessions[0].workflowIds.length, 2);
  assert.equal(boardView.sessions[0].relatedWorkflows.length, 2);
  assert.equal(boardView.sessions[0].purpose.length > 0, true);
  assert.throws(() => layer.decide("分析任务看板", { proposedDecision: { intent: "analysis", project: "dogfood-study-board", reasoning: ["test"], workflowType: "software_change", confidence: 0.8, nextAction: "create_workflow" } }), /requires Workflow 'analysis_only'/);
  const clarification = await service.submitRequest({
    userRequest: "Export project data",
    projectId: "dogfood-study-board",
    supervisorDecision: { intent: "code_change", goal: "Add export", goalConfidence: 0.4, possibleIntentMismatch: "The user may mean migration rather than download.", clarificationNeeded: true, projectId: "dogfood-study-board", reasoning: ["The requested data boundary is ambiguous."], workflowType: "software_change", confidence: 0.7, nextAction: "create_workflow" }
  });
  assert.equal(clarification.status, "clarification_required");
  assert.equal(clarification.workflow, null);
  assert.equal(created.length, 3, "A clarification gate must not create a Workflow");
  const clarified = await service.submitRequest({ userRequest: clarification.decision.originalRequest, clarificationDecisionId: clarification.decision.decisionId, clarificationResponse: "A browser-download CSV export of the currently visible tasks only.", projectId: "dogfood-study-board" });
  assert.equal(clarified.status, "success");
  assert.equal(clarified.decision.clarification.supersedesDecisionId, clarification.decision.decisionId);
  assert.equal((await store.readDecision(clarification.decision.decisionId)).status, "clarification_resolved");
  assert.equal(created.length, 4, "A confirmed clarification must regenerate the Decision before creating one Workflow");
  console.log(JSON.stringify({ ok: true, boardDecision: board.decisionId, confirmationDecision: waiting.decision.decisionId, gptDecision: gpt.decision.decisionId, clarificationDecision: clarification.decision.decisionId, projectCount: projects.length }, null, 2));
} finally {
  await rm(dataRoot, { recursive: true, force: true });
}
