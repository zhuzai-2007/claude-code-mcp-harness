import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { diffSnapshots, hasUnexpectedSideEffects, snapshotTree } from "./side-effect-guard.mjs";

const serverUrl = process.env.MCP_SERVER_URL || "http://127.0.0.1:8787/mcp";
const realPlan = process.env.MCP_REAL_PLAN === "1";
const realWrite = process.env.MCP_REAL_WRITE === "1";
const maxBudgetUsd = Number(process.env.MCP_MAX_BUDGET_USD || "0.20");
const resultRunId = process.env.MCP_RESULT_RUN_ID || "";
const expectedSummaryMinLength = Number(process.env.MCP_EXPECT_SUMMARY_MIN_LENGTH || "0");
const client = new Client({ name: "codex-claude-worker-smoke", version: "0.1.0" });
const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(moduleDirectory, "..");
const writeMarker = "MCP_REAL_WRITE_OK";
const unicodePlanMarker = "编码检查：“中文”—OK";
const writeRelativePath = `workspace/mcp-real-write-smoke-${process.pid}-${Date.now()}.txt`;
const writeAbsolutePath = path.resolve(projectRoot, writeRelativePath);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitForTask(taskId, acceptedStatuses, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await client.callTool({ name: "cc_get_task", arguments: { taskId } });
    const task = response.structuredContent?.task;
    if (task && acceptedStatuses.includes(task.status)) return task;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for Task Runtime task ${taskId}`);
}

async function waitForWorkflow(workflowId, acceptedStatuses, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await client.callTool({ name: "cc_get_workflow", arguments: { workflowId } });
    const workflow = response.structuredContent?.workflow;
    if (workflow && acceptedStatuses.includes(workflow.status)) return workflow;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for Workflow ${workflowId}`);
}

try {
  await client.connect(new StreamableHTTPClientTransport(new URL(serverUrl)));

  const listed = await client.listTools();
  const toolNames = listed.tools.map((tool) => tool.name);
  assert(listed.tools.length === 26, "Project Continuity should expose exactly 26 MCP tools");
  for (const required of ["cc_ping", "cc_list_projects", "cc_get_project_context", "cc_get_project_continuity", "cc_list_workflow_definitions", "cc_plan_task", "cc_get_result", "cc_get_ledger", "cc_create_task", "cc_get_task", "cc_list_tasks", "cc_get_task_events", "cc_approve_task", "cc_cancel_task", "cc_create_workflow", "cc_add_workflow_task", "cc_approve_workflow", "cc_get_workflow", "cc_get_supervisor_review_package", "cc_record_supervisor_review_result", "cc_apply_memory_update_proposal", "cc_list_workflows", "cc_get_workflow_events"]) {
    assert(toolNames.includes(required), `Missing MCP tool: ${required}`);
  }
  const writeTool = listed.tools.find((tool) => tool.name === "cc_run_approved_task");
  assert(writeTool?.annotations?.readOnlyHint === false, "cc_run_approved_task is not marked as write-capable");
  assert(writeTool?.annotations?.destructiveHint === true, "cc_run_approved_task does not advertise overwrite risk");
  assert(writeTool?.description?.includes("does not approve or advance a Supervisor Workflow"), "Legacy standalone run tool does not explain its Workflow approval boundary");
  const reviewPackageTool = listed.tools.find((tool) => tool.name === "cc_get_supervisor_review_package");
  assert(reviewPackageTool?.annotations?.readOnlyHint === true && reviewPackageTool?.annotations?.destructiveHint === false, "Supervisor Review Package tool is not read-only");
  const recordReviewTool = listed.tools.find((tool) => tool.name === "cc_record_supervisor_review_result");
  assert(recordReviewTool?.annotations?.readOnlyHint === false && recordReviewTool?.inputSchema?.properties?.confirmed?.const === true, "Supervisor Review Result tool omitted explicit confirmation");
  const applyMemoryTool = listed.tools.find((tool) => tool.name === "cc_apply_memory_update_proposal");
  assert(applyMemoryTool?.annotations?.readOnlyHint === false && applyMemoryTool?.annotations?.destructiveHint === true && applyMemoryTool?.inputSchema?.properties?.confirmed?.const === true, "Memory apply tool omitted its write and confirmation boundary");
  const workflowDiscoveryTool = listed.tools.find((tool) => tool.name === "cc_list_workflow_definitions");
  assert(workflowDiscoveryTool?.annotations?.readOnlyHint === true && workflowDiscoveryTool?.annotations?.destructiveHint === false, "cc_list_workflow_definitions is not marked read-only");
  assert(workflowDiscoveryTool?.description?.includes("do not invent Workflow names"), "Workflow discovery description does not instruct the Supervisor to use returned IDs");
  const createWorkflowTool = listed.tools.find((tool) => tool.name === "cc_create_workflow");
  assert(createWorkflowTool?.inputSchema?.properties?.clarificationDecisionId && createWorkflowTool?.inputSchema?.properties?.clarificationResponse, "cc_create_workflow omitted the clarification regeneration inputs");
  assert(createWorkflowTool?.inputSchema?.properties?.supervisorSession, "cc_create_workflow omitted additive Supervisor Session context");
  const registeredProjects = await client.callTool({ name: "cc_list_projects", arguments: {} });
  const registeredBoard = registeredProjects.structuredContent?.projects?.find((project) => project.id === "supervisor-dashboard");
  assert(registeredBoard, "cc_list_projects omitted the release-safe Supervisor Dashboard project");
  assert(registeredBoard.techStack?.includes("Local REST API") && registeredBoard.aliases?.includes("审批中心") && registeredBoard.defaultConstraints?.length, "cc_list_projects omitted Project Context fields");
  assert(typeof registeredBoard.supervisorContext?.available === "boolean", "cc_list_projects omitted Supervisor Context availability");
  const contextTool = listed.tools.find((tool) => tool.name === "cc_get_project_context");
  assert(contextTool?.annotations?.readOnlyHint === true && contextTool?.annotations?.destructiveHint === false, "cc_get_project_context is not marked read-only");
  const projectContextResponse = await client.callTool({ name: "cc_get_project_context", arguments: { project: registeredBoard.id } });
  const projectContext = projectContextResponse.structuredContent?.context;
  assert(projectContext?.project?.id === registeredBoard.id, "Supervisor Context returned the wrong project");
  assert(projectContext?.technicalStack?.includes("Local REST API") && projectContext?.constraints?.length, "Supervisor Context omitted stack or constraints");
  assert(projectContext?.supervisorInstructions === "" && projectContext?.supervisorContext?.available === false, "Supervisor Context did not represent the optional instruction file accurately");
  assert(Array.isArray(projectContext?.sessions), "Supervisor Context omitted Project Sessions");
  const continuityTool = listed.tools.find((tool) => tool.name === "cc_get_project_continuity");
  assert(continuityTool?.annotations?.readOnlyHint === true && continuityTool?.annotations?.destructiveHint === false, "Project Continuity tool is not read-only");
  const continuityResponse = await client.callTool({ name: "cc_get_project_continuity", arguments: { projectId: registeredBoard.id } });
  const continuityContext = continuityResponse.structuredContent?.context;
  assert(continuityContext?.brief?.projectId === registeredBoard.id, "Project Continuity omitted the Project Brief");
  assert(Array.isArray(continuityContext?.recentWorkflows) && Array.isArray(continuityContext?.openIssues), "Project Continuity omitted compact Workflow or issue context");
  assert(!Object.hasOwn(continuityContext || {}, "events"), "Project Continuity must not return raw event history");
  const runtimeContextResponse = await client.callTool({ name: "cc_get_project_context", arguments: { project: "supervisor-runtime" } });
  assert(runtimeContextResponse.structuredContent?.context?.projectMemory?.includes("Project goal"), "Supervisor Context omitted PROJECT_MEMORY.md");
  const workflowDefinitions = await client.callTool({ name: "cc_list_workflow_definitions", arguments: {} });
  const discoveredDefinitions = workflowDefinitions.structuredContent?.definitions || [];
  const discoveredSoftwareDefinition = discoveredDefinitions.find((definition) => definition.id === "software_change");
  assert(workflowDefinitions.structuredContent?.defaultDefinition === "software_change", "Capability discovery omitted the default Workflow definition");
  assert(discoveredSoftwareDefinition?.description && discoveredSoftwareDefinition?.stages?.map((stage) => stage.role).join(",") === "planner,coder,reviewer", "Capability discovery omitted software_change stage details");
  assert(discoveredSoftwareDefinition?.approvalRequirement?.required === true && discoveredSoftwareDefinition?.approvalRequirement?.stages?.includes("implementation"), "Capability discovery omitted approval requirements");
  assert(discoveredSoftwareDefinition?.usageHints?.length, "Capability discovery omitted usage hints");
  const invalidDefinition = await client.callTool({ name: "cc_create_workflow", arguments: { userRequest: "Add a feature", definitionId: "feature_change", projectId: registeredBoard.id, mockWorker: true } });
  assert(invalidDefinition.structuredContent?.status === "invalid_input", "Unknown Workflow definition was not rejected");
  assert(invalidDefinition.structuredContent?.requestedDefinition === "feature_change", "Unknown Workflow response omitted the requested definition");
  assert(invalidDefinition.structuredContent?.availableDefinitions?.some((definition) => definition.id === "software_change"), "Unknown Workflow response omitted available definitions");
  assert(invalidDefinition.structuredContent?.error?.includes("cc_list_workflow_definitions"), "Unknown Workflow response omitted recovery guidance");
  for (const profileToolName of ["cc_plan_task", "cc_review_task", "cc_run_approved_task", "cc_create_task"]) {
    const profileTool = listed.tools.find((tool) => tool.name === profileToolName);
    assert(profileTool?.inputSchema?.properties?.resourceProfile, `${profileToolName} does not expose optional resourceProfile`);
    assert(!profileTool.inputSchema.required?.includes("resourceProfile"), `${profileToolName} made resourceProfile mandatory`);
  }

  const ping = await client.callTool({ name: "cc_ping", arguments: {} });
  assert(ping.structuredContent?.ok === true, "cc_ping did not report ok=true");

  const plan = await client.callTool(
    {
      name: "cc_plan_task",
      arguments: {
        prompt: realPlan
          ? `Read README.md and report its first heading in the required structured response. Include this exact Unicode marker in summary: ${unicodePlanMarker}. Do not modify files.`
          : "Read README.md and report its first heading in the required structured response. Do not modify files.",
        mockWorker: !realPlan,
        workerTimeoutSeconds: realPlan ? 120 : 30,
        maxBudgetUsd
      }
    },
    undefined,
    { timeout: realPlan ? 180000 : 60000 }
  );
  const runId = plan.structuredContent?.runId;
  assert(/^\d{8}-\d{6}-\d{3}$/.test(runId || ""), `cc_plan_task did not return a runId: ${JSON.stringify(plan)}`);
  assert(plan.structuredContent?.result?.status === "success", "cc_plan_task did not return its normalized success result");
  assert(plan.structuredContent?.result?.resource_profile === "small_readonly", "cc_plan_task without resourceProfile did not use small_readonly");
  if (realPlan) {
    assert(
      plan.structuredContent?.result?.summary?.includes(unicodePlanMarker),
      `Real plan did not preserve the exact Unicode marker: ${JSON.stringify(plan.structuredContent?.result?.summary)}`
    );
  }

  const explorationPlan = await client.callTool({
    name: "cc_plan_task",
    arguments: {
      prompt: "Mock exploration profile protocol smoke. Do not inspect or modify files.",
      resourceProfile: "exploration_readonly",
      mockWorker: true
    }
  });
  assert(explorationPlan.structuredContent?.result?.status === "success", "cc_plan_task exploration_readonly mock failed");
  assert(explorationPlan.structuredContent?.result?.resource_profile === "exploration_readonly", "cc_plan_task did not apply exploration_readonly");
  assert(explorationPlan.structuredContent?.result?.resource_limits?.maxBudgetUsd === 1.5, "cc_plan_task let a Bridge default override the exploration_readonly budget");
  assert(explorationPlan.structuredContent?.result?.resource_limits?.maxTurns === 100, "cc_plan_task did not apply exploration_readonly turns");
  assert(explorationPlan.structuredContent?.result?.resource_limits?.maxFilesRead === 100, "cc_plan_task did not apply exploration_readonly limits");

  const overriddenExplorationPlan = await client.callTool({
    name: "cc_plan_task",
    arguments: {
      prompt: "Mock exploration profile explicit budget override smoke. Do not inspect or modify files.",
      resourceProfile: "exploration_readonly",
      maxBudgetUsd: 0.75,
      mockWorker: true
    }
  });
  assert(overriddenExplorationPlan.structuredContent?.result?.status === "success", "cc_plan_task exploration_readonly override mock failed");
  assert(overriddenExplorationPlan.structuredContent?.result?.resource_profile === "exploration_readonly", "cc_plan_task budget override changed the selected profile");
  assert(overriddenExplorationPlan.structuredContent?.result?.resource_limits?.maxBudgetUsd === 0.75, "cc_plan_task did not apply the explicit budget override");
  assert(overriddenExplorationPlan.structuredContent?.result?.resource_limits?.maxTurns === 100, "cc_plan_task budget override changed profile turns");
  assert(overriddenExplorationPlan.structuredContent?.result?.resource_limits?.maxFilesRead === 100, "cc_plan_task budget override changed profile file limits");

  const invalidProfile = await client.callTool({
    name: "cc_plan_task",
    arguments: { prompt: "Reject an invalid resource profile without starting a Worker.", resourceProfile: "not_a_profile", mockWorker: true }
  });
  assert(invalidProfile.structuredContent?.status === "invalid_input", "cc_plan_task did not reject an unknown resourceProfile");
  assert(invalidProfile.structuredContent?.error?.includes("Unknown resource profile"), "Unknown profile rejection did not explain the cause");

  const focusedReview = await client.callTool({
    name: "cc_review_task",
    arguments: {
      prompt: "Original request: mock change. Plan result: mock plan. Run result: mock run. changes_made: README.md. Modified files: README.md.",
      mockWorker: true
    }
  });
  assert(focusedReview.structuredContent?.result?.status === "success", "cc_review_task focused mock failed");
  assert(focusedReview.structuredContent?.result?.resource_profile === "review_readonly", "cc_review_task without resourceProfile did not use review_readonly");
  assert(focusedReview.structuredContent?.result?.resource_limits?.maxBudgetUsd === 1.5, "cc_review_task did not apply review_readonly budget");
  assert(focusedReview.structuredContent?.result?.resource_limits?.maxTurns === 50, "cc_review_task did not apply review_readonly turns");
  assert(focusedReview.structuredContent?.result?.resource_limits?.maxFilesRead === 40, "cc_review_task did not apply review_readonly file limit");
  assert(focusedReview.structuredContent?.result?.resource_limits?.timeoutSeconds === 600, "cc_review_task did not apply review_readonly timeout");

  const exact = await client.callTool({ name: "cc_get_result", arguments: { runId } });
  assert(exact.structuredContent?.status === "success", "cc_get_result did not find the exact runId");
  assert(exact.structuredContent?.runId === runId, "cc_get_result returned a different runId");

  if (resultRunId) {
    const requested = await client.callTool({ name: "cc_get_result", arguments: { runId: resultRunId } });
    const summaryLength = requested.structuredContent?.result?.summary?.length || 0;
    assert(requested.structuredContent?.status === "success", `cc_get_result did not find requested regression run ${resultRunId}`);
    assert(summaryLength >= expectedSummaryMinLength, `cc_get_result summary was truncated: ${summaryLength} < ${expectedSummaryMinLength}`);
  }

  const beforeWrite = realWrite ? await snapshotTree(projectRoot) : null;
  const write = await client.callTool({
    name: "cc_run_approved_task",
    arguments: {
      prompt: realWrite
        ? `Using only Read, Write, or Edit tools, create the project-relative file ${writeRelativePath} with exactly this single line: ${writeMarker}. Do not use Bash or shell commands. Do not create directories. Do not modify any other path.`
        : "Mock protocol smoke only. Do not create or modify files.",
      approvedBy: "protocol-smoke",
      approvalReason: realWrite
        ? "Exercise the approved write-capable MCP route with a bounded real worker."
        : "Exercise the approved write-capable MCP route with MockWorker.",
      mockWorker: !realWrite,
      workerTimeoutSeconds: realWrite ? 120 : 30,
      maxBudgetUsd
    }
  });
  const writeRunId = write.structuredContent?.runId;
  assert(/^\d{8}-\d{6}-\d{3}$/.test(writeRunId || ""), "cc_run_approved_task did not return a runId");
  assert(
    write.structuredContent?.result?.status === "success",
    `cc_run_approved_task ${realWrite ? "real" : "mock"} route failed: ${JSON.stringify(write.structuredContent)}`
  );
  assert(write.structuredContent?.result?.mode === "run", "cc_run_approved_task returned the wrong mode");
  assert(write.structuredContent?.result?.resource_profile === "small_readonly", "cc_run_approved_task without resourceProfile did not use small_readonly");
  if (realWrite) {
    const written = await readFile(writeAbsolutePath, "utf8");
    assert(written.trim() === writeMarker, `Real write smoke produced unexpected content: ${JSON.stringify(written)}`);
    const afterWrite = await snapshotTree(projectRoot);
    const sideEffects = diffSnapshots(beforeWrite, afterWrite, {
      allowedFiles: [writeRelativePath],
      allowedDirectories: [path.posix.dirname(writeRelativePath)]
    });
    assert(!hasUnexpectedSideEffects(sideEffects), `Real write smoke produced undeclared filesystem side effects: ${JSON.stringify(sideEffects)}`);
  }

  const latest = await client.callTool({ name: "cc_get_result", arguments: { runId: "latest" } });
  assert(latest.structuredContent?.runId === writeRunId, "cc_get_result latest did not resolve to the just-completed run");

  const asyncPlanResponse = await client.callTool({
    name: "cc_create_task",
    arguments: {
      prompt: `Task Runtime protocol smoke for registered Project ${registeredBoard.name}. Inspect nothing and use the mock worker.`,
      mode: "plan",
      mockWorker: true,
      resourceProfile: "exploration_readonly"
    }
  });
  const asyncPlan = asyncPlanResponse.structuredContent?.task;
  assert(/^task_[a-zA-Z0-9_-]+$/.test(asyncPlan?.taskId || ""), "cc_create_task did not return a taskId");
  assert(asyncPlan.status === "queued", `cc_create_task did not immediately return queued: ${asyncPlan.status}`);
  assert(asyncPlan.currentAttempt === null, "New queued task already exposed an attempt in its creation response");
  assert(asyncPlan.settings.resourceProfile === "exploration_readonly", "cc_create_task did not persist exploration_readonly on the Task");
  assert(asyncPlan.projectId === registeredBoard.id && asyncPlan.workspacePath === registeredBoard.workspacePath, "cc_create_task did not bind the exact registered Project named in the prompt");
  const asyncPlanCompleted = await waitForTask(asyncPlan.taskId, ["succeeded", "failed", "interrupted"]);
  assert(asyncPlanCompleted.status === "succeeded", `Asynchronous mock plan failed: ${JSON.stringify(asyncPlanCompleted.error)}`);
  assert(asyncPlanCompleted.attempts.length === 1, "Asynchronous task did not persist exactly one attempt");
  assert(asyncPlanCompleted.attempts[0].resourceProfile === "exploration_readonly", "Attempt did not snapshot exploration_readonly");
  assert(asyncPlanCompleted.attempts[0].resourceLimits.maxFilesRead === 100, "Attempt did not snapshot exploration_readonly limits");
  assert(asyncPlanCompleted.attempts[0].projectContextSnapshot?.fileName === "project-context-snapshot.json", "Project-bound durable plan did not prepare a Project Context Snapshot before the Attempt");

  const firstEvents = await client.callTool({
    name: "cc_get_task_events",
    arguments: { taskId: asyncPlan.taskId, afterSequence: 0, limit: 2 }
  });
  const firstEventPayload = firstEvents.structuredContent;
  assert(firstEventPayload?.events?.[0]?.type === "task.created", "Task event stream does not start with task.created");
  assert(firstEventPayload?.hasMore === true, "Task event cursor did not report additional events");
  const laterEvents = await client.callTool({
    name: "cc_get_task_events",
    arguments: { taskId: asyncPlan.taskId, afterSequence: firstEventPayload.lastSequence, limit: 100 }
  });
  assert(laterEvents.structuredContent?.events?.some((event) => event.type === "task.completed"), "Incremental task events did not include task.completed");

  const disconnectClient = new Client({ name: "task-runtime-disconnect-smoke", version: "0.1.0" });
  await disconnectClient.connect(new StreamableHTTPClientTransport(new URL(serverUrl)));
  const disconnectedCreate = await disconnectClient.callTool({
    name: "cc_create_task",
    arguments: {
      prompt: "Continue after the creating MCP client disconnects. Use the mock worker.",
      mode: "plan",
      mockWorker: true,
      workerTimeoutSeconds: 30,
      maxBudgetUsd
    }
  });
  const disconnectedTaskId = disconnectedCreate.structuredContent?.taskId;
  await disconnectClient.close();
  const disconnectedCompleted = await waitForTask(disconnectedTaskId, ["succeeded", "failed", "interrupted"]);
  assert(disconnectedCompleted.status === "succeeded", "Task did not continue after its creating MCP client disconnected");

  const asyncRunResponse = await client.callTool({
    name: "cc_create_task",
    arguments: {
      prompt: "Approved Task Runtime mock run. Do not modify files.",
      mode: "run",
      mockWorker: true,
      workerTimeoutSeconds: 30,
      maxBudgetUsd
    }
  });
  const asyncRun = asyncRunResponse.structuredContent?.task;
  assert(asyncRun?.status === "waiting_approval", "Run task did not enter waiting_approval");
  assert(asyncRun.currentAttempt === null, "Run task created an attempt before approval");
  assert(asyncRun.approval === null, "Run task used default approval metadata");
  const approvedResponse = await client.callTool({
    name: "cc_approve_task",
    arguments: {
      taskId: asyncRun.taskId,
      approvedBy: "protocol-smoke",
      approvalReason: "Approve the exact Task Runtime mock capability boundary."
    }
  });
  assert(approvedResponse.structuredContent?.task?.approval?.promptHash === asyncRun.promptHash, "Approval was not bound to the task prompt hash");
  const asyncRunCompleted = await waitForTask(asyncRun.taskId, ["succeeded", "failed", "interrupted"]);
  assert(asyncRunCompleted.status === "succeeded", `Approved asynchronous mock run failed: ${JSON.stringify(asyncRunCompleted.error)}`);
  assert(asyncRunCompleted.approval.attemptId === asyncRunCompleted.currentAttempt, "Approval was not bound to the execution attempt");

  const listedTasks = await client.callTool({ name: "cc_list_tasks", arguments: { status: "succeeded", limit: 20 } });
  assert(listedTasks.structuredContent?.tasks?.some((task) => task.taskId === asyncPlan.taskId), "cc_list_tasks did not return the completed task");

  const directDecision = await client.callTool({ name: "cc_create_workflow", arguments: {
    userRequest: "Explain the Supervisor boundary",
    supervisorDecision: {
      intent: "conversation",
      goal: "Explain the Supervisor boundary",
      technical_summary: "Explain the existing boundary without using a local Worker.",
      reasoning: ["The answer does not require a local Worker."],
      risks: ["No local evidence will be gathered."],
      workflowType: "analysis_only",
      estimated_resources: { complexity: "low", expected: { budgetUsd: 0, turns: 0, filesRead: 0, commands: 0, timeoutSeconds: 0 }, notes: ["No Worker required."] },
      recommended_actions: ["Answer directly in ChatGPT."],
      confidence: 0.97,
      nextAction: "respond_directly"
    }
  } });
  assert(directDecision.structuredContent?.status === "decision_only", "GPT-authored respond_directly Decision did not stop before Workflow creation");
  assert(directDecision.structuredContent?.decision?.source === "gpt", "GPT-authored Supervisor Decision source was not preserved");
  assert(directDecision.structuredContent?.decision?.technical_summary?.includes("without using a local Worker"), "GPT technical summary was not persisted");
  assert(directDecision.structuredContent?.workflowId === null, "respond_directly unexpectedly created a Workflow");

  const missingProjectBinding = await client.callTool({ name: "cc_create_workflow", arguments: {
    userRequest: "给审批中心增加标签",
    supervisorDecision: { intent: "code_change", goal: "增加标签", project: registeredBoard.id, reasoning: ["需要修改代码。"], workflowType: "software_change", confidence: 0.9, nextAction: "create_workflow" },
    mockWorker: true
  } });
  assert(missingProjectBinding.structuredContent?.status === "invalid_input" && missingProjectBinding.structuredContent?.error?.includes("projectId_required"), "GPT Workflow creation without projectId was not rejected");

  const workflowCreated = await client.callTool({ name: "cc_create_workflow", arguments: {
    userRequest: "给审批中心增加暗色模式",
    projectId: registeredBoard.projectId,
    sessionName: "Task board dark mode",
    supervisorDecision: {
      intent: "code_change",
      goal: "为审批中心增加可持久化的暗色模式。",
      goalConfidence: 0.97,
      possibleIntentMismatch: null,
      clarificationNeeded: false,
      technical_summary: "使用 CSS 自定义属性实现主题颜色，并使用浏览器存储保存用户主题偏好。",
      implementation_strategy: "先确认现有样式和初始化入口，再增加主题变量、切换控件和启动恢复逻辑，不改变任务数据结构。",
      expected_changes: ["主题颜色迁移到 CSS 自定义属性。", "增加主题切换和偏好恢复逻辑。"],
      validation_plan: ["验证主题切换。", "验证刷新后偏好保持。", "验证任务新增、筛选和完成交互未回归。"],
      project: registeredBoard.id,
      projectId: registeredBoard.projectId,
      reasoning: ["该请求需要修改现有前端。", "项目 Context 要求保持静态前端与本地 API 边界。"],
      risks: ["主题初始化时机可能造成闪烁。"],
      workflowType: discoveredSoftwareDefinition.id,
      confidence: 0.96,
      nextAction: "create_workflow"
    },
    mockWorker: true
  } });
  const workflowId = workflowCreated.structuredContent?.workflowId;
  assert(/^workflow_[a-zA-Z0-9_-]+$/.test(workflowId || ""), "cc_create_workflow did not return a workflowId");
  assert(workflowCreated.structuredContent?.workflow?.status === "planning", "Workflow did not enter planning automatically");
  assert(workflowCreated.structuredContent?.workflow?.workflowPlan?.workflowType === "software_change", "Workflow Planner did not select software_change for the export feature");
  assert(workflowCreated.structuredContent?.workflow?.workflowPlan?.selection === "supervisor_decision", "Workflow Planner did not consume the persisted Supervisor Decision");
  assert(workflowCreated.structuredContent?.decision?.project?.id === registeredBoard.id, "Supervisor did not select the registered release project");
  assert(workflowCreated.structuredContent?.workflow?.projectId === registeredBoard.id, "Workflow did not freeze projectId");
  assert(workflowCreated.structuredContent?.workflow?.workspacePath === registeredBoard.workspacePath, "Workflow did not freeze Registry workspacePath");
  assert(/^session_/.test(workflowCreated.structuredContent?.workflow?.sessionId || ""), "Workflow did not create a Project Session");
  assert(workflowCreated.structuredContent?.decision?.implementation_strategy?.includes("主题变量"), "GPT implementation strategy was not persisted");
  assert(workflowCreated.structuredContent?.decision?.goalConfidence === 0.97 && workflowCreated.structuredContent?.decision?.clarificationNeeded === false, "Goal-alignment advisory fields were not persisted compatibly");
  assert(workflowCreated.structuredContent?.decision?.expected_changes?.length === 2, "GPT expected changes were not persisted");
  assert(workflowCreated.structuredContent?.decision?.validation_plan?.length === 3, "GPT validation plan was not persisted");
  assert(/^decision_/.test(workflowCreated.structuredContent?.decision?.decisionId || ""), "cc_create_workflow did not persist a Supervisor Decision");
  assert(workflowCreated.structuredContent?.workflow?.workflowPlan?.stages?.join(",") === "planner,approval,coder,reviewer", "Workflow Planner returned an unexpected stage plan");
  const plannerTaskId = workflowCreated.structuredContent?.workflow?.tasks?.[0]?.taskId;
  assert(/^task_/.test(plannerTaskId || ""), "Workflow did not create planner Task automatically");
  const plannerTask = await client.callTool({ name: "cc_get_task", arguments: { taskId: plannerTaskId } });
  assert(plannerTask.structuredContent?.task?.prompt?.includes("implementation_strategy") && plannerTask.structuredContent?.task?.prompt?.includes("validation_plan"), "Planner prompt omitted GPT Supervisor guidance");
  assert(plannerTask.structuredContent?.task?.projectId === registeredBoard.id && plannerTask.structuredContent?.task?.workspacePath === registeredBoard.workspacePath, "Task did not inherit Project binding");
  assert(plannerTask.structuredContent?.task?.sessionId === workflowCreated.structuredContent?.workflow?.sessionId, "Task did not inherit Project Session");
  await waitForTask(plannerTaskId, ["succeeded"]);
  const waitingWorkflow = await waitForWorkflow(workflowId, ["waiting_approval"]);
  assert(waitingWorkflow.tasks.length === 1, "Workflow created coder before approval");
  assert(waitingWorkflow.stages.find((stage) => stage.role === "coder")?.taskId === null, "Unapproved coder stage has a Task");
  const approvedWorkflow = await client.callTool({ name: "cc_approve_workflow", arguments: { workflowId, approvedBy: "workflow-protocol-smoke", approvalReason: "Approve the bounded implementation plan." } });
  assert(approvedWorkflow.structuredContent?.status === "success", "cc_approve_workflow failed");
  const coderTaskId = approvedWorkflow.structuredContent?.workflow?.stages?.find((stage) => stage.role === "coder")?.taskId;
  assert(/^task_/.test(coderTaskId || ""), "Workflow approval did not create coder Task");
  const coderTask = await client.callTool({ name: "cc_get_task", arguments: { taskId: coderTaskId } });
  assert(coderTask.structuredContent?.task?.approval?.approvedBy === "workflow-protocol-smoke", "Coder Task did not preserve human approval metadata");
  const completedWorkflow = await waitForWorkflow(workflowId, ["completed"]);
  const completedPlanner = await client.callTool({ name: "cc_get_task", arguments: { taskId: plannerTaskId } });
  assert(completedPlanner.structuredContent?.task?.attempts?.[0]?.workspacePath === registeredBoard.workspacePath, "Attempt did not inherit Project workspacePath");
  assert(completedPlanner.structuredContent?.task?.attempts?.[0]?.executionDirectory, "Attempt did not record actual executionDirectory");
  const reviewerTaskId = completedWorkflow.stages.find((stage) => stage.role === "reviewer")?.taskId;
  assert(/^task_/.test(reviewerTaskId || ""), "Orchestrator did not create reviewer Task");
  assert(completedWorkflow.tasks.find((task) => task.role === "reviewer")?.resourceProfile === "review_readonly", "Workflow reviewer did not use review_readonly");
  assert(completedWorkflow.tasks.map((task) => task.role).join(",") === "planner,coder,reviewer", "Workflow role ordering or association was lost");
  const workflowEvents = await client.callTool({ name: "cc_get_workflow_events", arguments: { workflowId, limit: 1000 } });
  assert(workflowEvents.structuredContent?.events?.some((event) => event.type === "task.completed" && event.role === "reviewer"), "Workflow timeline omitted reviewer completion");
  const reviewPackageResponse = await client.callTool({ name: "cc_get_supervisor_review_package", arguments: { workflowId } });
  const reviewPackage = reviewPackageResponse.structuredContent?.reviewPackage;
  assert(reviewPackageResponse.structuredContent?.status === "success", "cc_get_supervisor_review_package failed");
  assert(reviewPackage?.originalRequest === completedWorkflow.userRequest, "Review Package omitted the original request");
  assert(reviewPackage?.auditEvidence?.stages?.length === 3, "Review Package omitted stage audit evidence");
  assert(reviewPackage?.reviewerResult, "Review Package omitted the reviewer result");
  assert(reviewPackage?.memorySnapshot?.status && reviewPackage?.memorySnapshot?.capturedAt, "Review Package omitted the Decision-time Memory snapshot status");
  assert(reviewPackage?.schemaVersion === 2, "Review Package did not expose the additive v1.5 contract");
  assert(reviewPackage?.goalAlignment === null && reviewPackage?.architectureImpact === null && Array.isArray(reviewPackage?.futureRecommendations) && reviewPackage?.memoryUpdateNeeded === null, "Review Package fabricated or omitted GPT-owned judgment fields");
  assert(reviewPackage?.chatGptReviewGuidance?.reviewPackageTool?.name === "cc_get_supervisor_review_package", "Review in ChatGPT guidance omitted the existing MCP package call");
  assert(reviewPackage?.chatGptReviewGuidance?.suggestedPrompts?.en?.includes(workflowId), "Review in ChatGPT guidance omitted the Workflow id");
  assert(reviewPackage?.memoryUpdateProposal?.requiresConfirmation === true && reviewPackage?.memoryUpdateProposal?.applied === false, "Memory Update Proposal did not preserve the explicit-confirmation boundary");
  const recordedReviewResponse = await client.callTool({ name: "cc_record_supervisor_review_result", arguments: { workflowId, conclusion: "accept", goalAlignment: "The implementation meets the requested dark-mode goal.", architectureAssessment: "The change remains within the registered browser-only architecture.", risks: ["Theme contrast needs ongoing visual checks."], recommendations: ["Keep theme tokens centralized."], nextSteps: ["Retain focused theme regression checks."], memoryUpdateNeeded: true, submittedBy: "mcp-protocol-operator", confirmationReason: "Explicitly save the completed ChatGPT Supervisor review.", confirmed: true } });
  assert(recordedReviewResponse.structuredContent?.status === "success" && recordedReviewResponse.structuredContent?.reviewResult?.conclusion === "accept", "Confirmed Supervisor Review Result was not persisted through MCP");
  const reviewedPackageResponse = await client.callTool({ name: "cc_get_supervisor_review_package", arguments: { workflowId } });
  const reviewedPackage = reviewedPackageResponse.structuredContent?.reviewPackage;
  assert(reviewedPackage?.supervisorReviewResult?.reviewId === recordedReviewResponse.structuredContent.reviewResult.reviewId, "Review Package did not return the persisted Supervisor Review Result");
  assert(reviewedPackage?.goalAlignment?.includes("dark-mode") && reviewedPackage?.chatGptReviewGuidance?.supervisorReviewStatus === "accept", "Persisted Supervisor judgment did not flow back into the Review Package");
  const workflowAfterReviewPackage = await client.callTool({ name: "cc_get_workflow", arguments: { workflowId } });
  assert(workflowAfterReviewPackage.structuredContent?.workflow?.status === completedWorkflow.status && workflowAfterReviewPackage.structuredContent?.workflow?.tasks?.length === completedWorkflow.tasks.length, "Review Package retrieval changed Workflow state");
  const listedWorkflows = await client.callTool({ name: "cc_list_workflows", arguments: { status: "completed", limit: 20 } });
  assert(listedWorkflows.structuredContent?.workflows?.some((workflow) => workflow.workflowId === workflowId), "cc_list_workflows omitted completed Workflow");

  console.log(JSON.stringify({ ok: true, serverUrl, realPlan, realWrite, maxBudgetUsd, toolNames, capabilityDiscovery: { projectId: registeredBoard.id, definitionId: discoveredSoftwareDefinition.id, invalidDefinitionGuidance: true }, planRunId: runId, writeRunId, asyncPlanTaskId: asyncPlan.taskId, disconnectedTaskId, asyncRunTaskId: asyncRun.taskId, workflowDogfood: { workflowId, plannerTaskId, coderTaskId, reviewerTaskId, status: completedWorkflow.status } }, null, 2));
} finally {
  await client.close();
  if (realWrite) await rm(writeAbsolutePath, { force: true });
}
