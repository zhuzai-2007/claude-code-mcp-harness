import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { z } from "zod";
import { FileTaskStore } from "../runtime/file-task-store.mjs";
import { FileWorkflowStore } from "../runtime/file-workflow-store.mjs";
import { FileSupervisorStore } from "../runtime/file-supervisor-store.mjs";
import { HarnessRunner } from "../runtime/harness-runner.mjs";
import { ProjectContextRegistry } from "../runtime/project-context.mjs";
import { ProjectIntelligenceService } from "../runtime/project-intelligence.mjs";
import { ProjectContinuityService } from "../runtime/project-continuity.mjs";
import { ProviderPreflightService } from "../runtime/provider-preflight.mjs";
import { SupervisorDecisionLayer } from "../runtime/supervisor-decision.mjs";
import { SupervisorService } from "../runtime/supervisor-service.mjs";
import { SupervisorReviewPackageService } from "../runtime/supervisor-review-package.mjs";
import { applyRuntimeRetention, planRuntimeRetention } from "../runtime/runtime-retention.mjs";
import { TaskRuntime } from "../runtime/task-runtime.mjs";
import { WorkflowRuntime } from "../runtime/workflow-runtime.mjs";
import { loadWorkflowDefinitions } from "../runtime/workflow-definitions.mjs";
import { WorkflowPlanner } from "../runtime/workflow-planner.mjs";
import { resolveMcpResourceProfile, resourceProfileHarnessArgs } from "./resource-profile-input.mjs";
import { registerSupervisorDashboardRoutes } from "./supervisor-dashboard-routes.mjs";
import { WorkflowMetadataStore } from "./workflow-metadata-store.mjs";
import { listWorkflowDefinitionCapabilities, unknownWorkflowDefinitionResult } from "./workflow-definition-capabilities.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const configPath = path.join(__dirname, "config.json");

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
}

const config = readJson(configPath);
const workflowDefinitions = await loadWorkflowDefinitions();
const workflowPlanner = new WorkflowPlanner({ definitions: workflowDefinitions });
const releaseStatusPath = path.join(__dirname, "..", ".agents", "release-status.json");
const releaseStatus = fs.existsSync(releaseStatusPath) ? readJson(releaseStatusPath) : null;

function normalizeSlashes(value) {
  return value.replaceAll("\\", "/");
}

function resolveInsideProject(...segments) {
  const projectRoot = path.resolve(config.projectRoot);
  const resolved = path.resolve(projectRoot, ...segments);
  const relative = path.relative(projectRoot, resolved);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    return resolved;
  }
  throw new Error(`Resolved path escapes projectRoot: ${segments.join("/")}`);
}

const projectRoot = resolveInsideProject(".");
const agentsDir = resolveInsideProject(".agents");
const claudeTaskPath = resolveInsideProject(".agents", "claude-task.ps1");
const summaryPath = resolveInsideProject(".agents", "summary.ps1");
const ledgerPath = resolveInsideProject(".agents", "ledger.ps1");
const allowedScriptPaths = new Set([claudeTaskPath, summaryPath, ledgerPath].map((p) => path.resolve(p).toLowerCase()));
const runtimeDataRoot = resolveInsideProject(process.env.SUPERVISOR_RUNTIME_DATA_ROOT || config.runtimeDataRoot || "runtime-data");
const supervisorDashboardRoot = resolveInsideProject("workspace", "supervisor-dashboard");
const taskStore = new FileTaskStore(runtimeDataRoot);
const workflowStore = new FileWorkflowStore(runtimeDataRoot);
const supervisorStore = new FileSupervisorStore(runtimeDataRoot);
const workflowMetadataStore = new WorkflowMetadataStore(runtimeDataRoot);
const providerPreflight = new ProviderPreflightService({ runtimeDataRoot });
await workflowMetadataStore.init();
const projectRegistry = new ProjectContextRegistry({
  projectRoot,
  registryPath: resolveInsideProject(".agents", "projects.json"),
  usageProvider: () => supervisorStore.readProjectUsage()
});
await projectRegistry.init();
const supervisorDecisionLayer = new SupervisorDecisionLayer({ projectRegistry, workflowPlanner });
const taskRunner = new HarnessRunner({
  projectRoot,
  workerTimeoutSeconds: config.workerTimeoutSeconds ?? 300,
  stdoutLimit: config.stdoutLimit ?? 12000,
  stderrLimit: config.stderrLimit ?? 12000
});
const taskRuntime = new TaskRuntime({
  store: taskStore,
  runner: taskRunner,
  heartbeatSeconds: limitNumber(config.taskHeartbeatSeconds, 15, 1, 300),
  stalledAfterSeconds: limitNumber(config.taskStalledAfterSeconds, 60, 5, 3600),
  maxConcurrentTasks: limitNumber(config.maxConcurrentTasks, 1, 1, 4)
});
const workflowRuntime = new WorkflowRuntime({
  store: workflowStore,
  taskRuntime,
  definitions: workflowDefinitions,
  workflowPlanner,
  resultProvider: (attemptId) => taskRunner.inspectAttempt(attemptId).audit
});
const reviewPackageService = new SupervisorReviewPackageService({ workflowRuntime, taskRuntime, projectRegistry, store: supervisorStore, attemptInspector: (attemptId) => taskRunner.inspectAttempt(attemptId) });
const projectIntelligenceService = new ProjectIntelligenceService({ workflowRuntime, projectRegistry, store: supervisorStore });
const projectContinuityService = new ProjectContinuityService({ workflowRuntime, projectRegistry, store: supervisorStore, releaseStatus });
const supervisorService = new SupervisorService({ decisionLayer: supervisorDecisionLayer, store: supervisorStore, workflowRuntime, reviewPackageService, projectIntelligenceService, projectContinuityService });

function scriptPath(scriptName) {
  const selected = scriptName === "claude-task.ps1" ? claudeTaskPath : scriptName === "summary.ps1" ? summaryPath : scriptName === "ledger.ps1" ? ledgerPath : null;
  if (!selected || !allowedScriptPaths.has(path.resolve(selected).toLowerCase())) {
    throw new Error(`Script is not allowlisted: ${scriptName}`);
  }
  return selected;
}

function limitNumber(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

function truncate(text, limit) {
  const value = String(text ?? "");
  if (value.length <= limit) {
    return { text: value, truncated: false, length: value.length };
  }
  return {
    text: value.slice(0, limit) + `\n...[truncated ${value.length - limit} chars]`,
    truncated: true,
    length: value.length
  };
}

function jsonToolResult(payload) {
  return {
    structuredContent: payload,
    content: [
      {
        type: "text",
        text: JSON.stringify(payload, null, 2)
      }
    ]
  };
}

function classifyExit(exitCode, timedOut) {
  if (timedOut) return "bridge_timeout";
  if (exitCode === 0) return "success";
  if (exitCode === 1) return "worker_failed";
  if (exitCode === 2) return "policy_blocked";
  if (exitCode === 3) return "invalid_input";
  if (exitCode === 4) return "environment_failed";
  return "failed";
}

function terminateProcessTree(child) {
  if (!child?.pid) return;
  if (process.platform !== "win32") {
    child.kill("SIGTERM");
    return;
  }

  const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
    shell: false,
    windowsHide: true,
    stdio: "ignore"
  });
  killer.on("error", () => child.kill());
  killer.on("close", (exitCode) => {
    if (exitCode !== 0 && child.exitCode === null) child.kill();
  });
}

function runHarness(scriptName, args, workerTimeoutSeconds, requestedRunId = null) {
  const psScript = scriptPath(scriptName);
  const timeoutSeconds = limitNumber(workerTimeoutSeconds, config.workerTimeoutSeconds ?? 300, 1, 3600) + 30;
  const stdoutLimit = limitNumber(config.stdoutLimit, 12000, 1000, 200000);
  const stderrLimit = limitNumber(config.stderrLimit, 12000, 1000, 200000);
  const commandArgs = ["-NoProfile", "-File", psScript, ...args.map((arg) => String(arg))];
  const startedAt = Date.now();

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const stdioMode = scriptName === "claude-task.ps1" ? "inherit" : ["ignore", "pipe", "pipe"];
    const child = spawn("powershell", commandArgs, {
      cwd: projectRoot,
      shell: false,
      windowsHide: scriptName !== "claude-task.ps1",
      stdio: stdioMode
    });

    const timer = setTimeout(() => {
      timedOut = true;
      terminateProcessTree(child);
    }, timeoutSeconds * 1000);

    if (child.stdout) {
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });
    }
    if (child.stderr) {
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
    }
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const out = truncate(stdout, stdoutLimit);
      const err = truncate(`${stderr}${stderr ? "\n" : ""}${error.message}`, stderrLimit);
      resolve({
        status: "environment_failed",
        exitCode: null,
        stdout: out.text,
        stderr: err.text,
        stdoutTruncated: out.truncated,
        stderrTruncated: err.truncated,
        durationSeconds: (Date.now() - startedAt) / 1000,
        command: scriptName
      });
    });
    child.on("close", (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const out = truncate(stdout, stdoutLimit);
      const err = truncate(stderr, stderrLimit);
      const harnessResult = requestedRunId ? getHarnessResult(requestedRunId) : extractHarnessResult(stdout);
      resolve({
        status: classifyExit(exitCode, timedOut),
        exitCode,
        ...harnessResult,
        stdout: out.text,
        stderr: err.text,
        stdoutTruncated: out.truncated,
        stderrTruncated: err.truncated,
        durationSeconds: (Date.now() - startedAt) / 1000,
        command: scriptName
      });
    });
  });
}

function generateRunId() {
  for (let offset = 0; offset < 1000; offset += 1) {
    const now = new Date(Date.now() + offset);
    const pad = (value, width = 2) => String(value).padStart(width, "0");
    const runId = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}-${pad(now.getMilliseconds(), 3)}`;
    const exists = [
      resolveInsideProject(".agents", "runs", runId),
      resolveInsideProject(".agent-runs", runId)
    ].some((candidate) => fs.existsSync(candidate));
    if (!exists) return runId;
  }
  throw new Error("Unable to allocate a unique runId.");
}

function getHarnessResult(runId) {
  const found = getResult(runId);
  return {
    runId,
    result: found.status === "success" ? found.result : null
  };
}

function extractHarnessResult(stdout) {
  const runIdMatch = String(stdout || "").match(/^RunId:\s*([^\r\n]+)\s*$/im);
  if (!runIdMatch) return { runId: null, result: null };
  const runId = runIdMatch[1].trim();
  if (!/^\d{8}-\d{6}-\d{3}$/.test(runId)) {
    return { runId: null, result: null };
  }
  const found = getResult(runId);
  return {
    runId,
    result: found.status === "success" ? found.result : null
  };
}

function getPingPayload() {
  return {
    ok: fs.existsSync(agentsDir) && fs.existsSync(claudeTaskPath) && fs.existsSync(summaryPath) && fs.existsSync(ledgerPath),
    projectRoot: normalizeSlashes(projectRoot),
    agentsDirExists: fs.existsSync(agentsDir) && fs.statSync(agentsDir).isDirectory(),
    claudeTaskExists: fs.existsSync(claudeTaskPath) && fs.statSync(claudeTaskPath).isFile(),
    summaryExists: fs.existsSync(summaryPath) && fs.statSync(summaryPath).isFile(),
    ledgerExists: fs.existsSync(ledgerPath) && fs.statSync(ledgerPath).isFile()
  };
}

function getRunDirectories() {
  const checkedPaths = [
    resolveInsideProject(".agents", "runs"),
    resolveInsideProject(".agent-runs")
  ];
  const candidates = [];
  for (const basePath of checkedPaths) {
    if (!fs.existsSync(basePath)) continue;
    const entries = fs.readdirSync(basePath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dirPath = path.join(basePath, entry.name);
      const stat = fs.statSync(dirPath);
      candidates.push({
        runId: entry.name,
        dir: dirPath,
        normalizedPath: path.join(dirPath, "worker-result.normalized.json"),
        mtimeMs: stat.mtimeMs
      });
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return { checkedPaths, candidates };
}

function getResult(runId = "latest") {
  const { checkedPaths, candidates } = getRunDirectories();
  const found = runId === "latest"
    ? candidates.find((candidate) => fs.existsSync(candidate.normalizedPath))
    : candidates.find((candidate) => candidate.runId === runId && fs.existsSync(candidate.normalizedPath));
  if (!found) {
    return {
      status: "result_not_found",
      runId,
      checkedPaths: checkedPaths.map(normalizeSlashes),
      runDirectoryCandidates: candidates.slice(0, 20).map((candidate) => ({
        runId: candidate.runId,
        dir: normalizeSlashes(candidate.dir),
        hasNormalizedResult: fs.existsSync(candidate.normalizedPath),
        mtimeMs: candidate.mtimeMs
      }))
    };
  }
  return {
    status: "success",
    runId: found.runId,
    runDir: normalizeSlashes(found.dir),
    normalizedResultPath: normalizeSlashes(found.normalizedPath),
    result: readJson(found.normalizedPath)
  };
}

function createServer() {
  const server = new McpServer({
    name: "codex-claude-worker-harness-bridge",
    version: "1.8.0-beta.1"
  });

  server.registerTool(
    "cc_ping",
    {
      title: "Ping Worker Harness Bridge",
      description: "Check that the fixed harness scripts exist under the configured project root.",
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
    },
    async () => jsonToolResult(getPingPayload())
  );

  server.registerTool(
    "cc_list_projects",
    {
      title: "List Registered Supervisor Projects",
      description: "Supervisor discovery step 1 of 3 before cc_create_workflow: list Runtime-managed projects and select one exact projectId. GPT must never infer or invent a local workspace path. If no unique project is confirmed, stop and ask the user to choose.",
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
    },
    async () => jsonToolResult({ status: "success", projects: await supervisorService.listProjects() })
  );

  server.registerTool(
    "cc_get_project_context",
    {
      title: "Get Registered Supervisor Project Context",
      description: "Supervisor discovery step 2 of 3 before cc_create_workflow: read the selected Runtime project, bound workspacePath, AI_SUPERVISOR.md, PROJECT_MEMORY.md summary, and existing Project Sessions. Use them to form a concrete technical direction. This read-only tool does not create a Decision, Workflow, Task, or Worker prompt.",
      inputSchema: { project: z.string().min(1) },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
    },
    async (input) => {
      try { return jsonToolResult({ status: "success", context: await supervisorService.getProjectContext(input.project) }); }
      catch (error) { return jsonToolResult({ status: "invalid_input", error: error.message }); }
    }
  );

  server.registerTool(
    "cc_get_project_continuity",
    {
      title: "Get Compact Project Continuity Context",
      description: "Read a compact, evidence-derived Project Brief, Project Memory summary, Supervisor Sessions, recent Workflows, and open issues before continuing work. This omits raw event history, never starts a Worker, and never changes Workflow or Task state.",
      inputSchema: { projectId: z.string().min(1) },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
    },
    async ({ projectId }) => {
      try { return jsonToolResult({ status: "success", context: await supervisorService.getProjectContinuity(projectId) }); }
      catch (error) { return jsonToolResult({ status: "invalid_input", error: error.message }); }
    }
  );

  server.registerTool(
    "cc_list_workflow_definitions",
    {
      title: "List Supervisor Workflow Definitions",
      description: "Supervisor discovery step 3 of 3 before cc_create_workflow: list every legal Workflow definition, its stages, approval requirement, resource profiles, and usage hints. Select only an id returned by this tool; do not invent Workflow names.",
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
    },
    async () => jsonToolResult({ status: "success", ...listWorkflowDefinitionCapabilities(workflowDefinitions) })
  );

  const taskInputSchema = {
    prompt: z.string().min(1),
    workerTimeoutSeconds: z.number().int().positive().max(3600).optional(),
    maxBudgetUsd: z.number().positive().max(5).optional(),
    resourceProfile: z.string().min(1).optional(),
    mockWorker: z.boolean().optional()
  };

  server.registerTool(
    "cc_plan_task",
    {
      title: "Plan Worker Task",
      description: "Run the harness in read-only plan mode for a fixed task prompt.",
      inputSchema: taskInputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
    },
    async (input = {}) => {
      const { prompt } = input;
      const mockWorker = input?.mockWorker === true;
      let profile;
      try { profile = resolveMcpResourceProfile(input); }
      catch (error) { return jsonToolResult({ status: "invalid_input", error: error.message }); }
      const timeout = profile.limits.timeoutSeconds;
      const runId = generateRunId();
      const args = ["plan", "-Task", prompt, ...resourceProfileHarnessArgs(profile), "-RunId", runId];
      if (mockWorker) args.push("-MockWorker");
      return jsonToolResult(await runHarness("claude-task.ps1", args, timeout, runId));
    }
  );

  server.registerTool(
    "cc_review_task",
    {
      title: "Review Worker Task",
      description: "Run a focused read-only verification of the current change. Put the original request, plan result, run result, changes_made, and modified-file list in prompt so the Worker can validate the change without exploring the repository.",
      inputSchema: taskInputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
    },
    async (input = {}) => {
      const { prompt } = input;
      const mockWorker = input?.mockWorker === true;
      let profile;
      const reviewInput = input.resourceProfile ? input : { ...input, resourceProfile: "review_readonly" };
      try { profile = resolveMcpResourceProfile(reviewInput); }
      catch (error) { return jsonToolResult({ status: "invalid_input", error: error.message }); }
      const timeout = profile.limits.timeoutSeconds;
      const runId = generateRunId();
      const args = ["review", "-Task", prompt, ...resourceProfileHarnessArgs(profile), "-RunId", runId];
      if (mockWorker) args.push("-MockWorker");
      return jsonToolResult(await runHarness("claude-task.ps1", args, timeout, runId));
    }
  );

  server.registerTool(
    "cc_run_approved_task",
    {
      title: "Run Approved Worker Task",
      description: "Legacy standalone compatibility tool: run one write-capable Harness task with explicit task-level approval fields. It does not approve or advance a Supervisor Workflow. For a Workflow waiting at its human checkpoint, use cc_approve_workflow so approval remains bound to the planned implementation stage.",
      inputSchema: {
        prompt: z.string().min(1),
        approvedBy: z.string().min(1).optional(),
        approvalReason: z.string().min(1).optional(),
        workerTimeoutSeconds: z.number().int().positive().max(3600).optional(),
        maxBudgetUsd: z.number().positive().max(5).optional(),
        resourceProfile: z.string().min(1).optional(),
        mockWorker: z.boolean().optional()
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false }
    },
    async (input = {}) => {
      const { prompt, approvedBy, approvalReason } = input;
      const mockWorker = input?.mockWorker === true;
      const finalApprovedBy = approvedBy || config.defaultApprovedBy;
      const finalApprovalReason = approvalReason || config.defaultApprovalReason;
      if (!finalApprovedBy || !finalApprovalReason) {
        return jsonToolResult({
          status: "invalid_input",
          error: "approvedBy and approvalReason are required when config defaults are not set."
        });
      }
      let profile;
      try { profile = resolveMcpResourceProfile(input); }
      catch (error) { return jsonToolResult({ status: "invalid_input", error: error.message }); }
      const timeout = profile.limits.timeoutSeconds;
      const runId = generateRunId();
      const args = [
        "run",
        "-Task",
        prompt,
        "-ApprovedBy",
        finalApprovedBy,
        "-ApprovalReason",
        finalApprovalReason,
        ...resourceProfileHarnessArgs(profile),
        "-RunId",
        runId
      ];
      if (mockWorker) args.push("-MockWorker");
      return jsonToolResult(
        await runHarness(
          "claude-task.ps1",
          args,
          timeout,
          runId
        )
      );
    }
  );

  server.registerTool(
    "cc_get_latest_summary",
    {
      title: "Get Latest Harness Summary",
      description: "Run summary.ps1 for the latest run including incomplete runs.",
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
    },
    async () => jsonToolResult(await runHarness("summary.ps1", ["-RunId", "latest", "-IncludeIncomplete"], 30))
  );

  server.registerTool(
    "cc_get_ledger",
    {
      title: "Get Worker Project Ledger",
      description: "Read recent project-ledger entries written by the worker harness.",
      inputSchema: {
        tail: z.number().int().positive().max(200).optional()
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
    },
    async (input = {}) => {
      const tail = limitNumber(input?.tail, 20, 1, 200);
      return jsonToolResult(await runHarness("ledger.ps1", ["-Tail", tail, "-Json"], 30));
    }
  );

  server.registerTool(
    "cc_get_result",
    {
      title: "Get Latest Normalized Result",
      description: "Read a worker-result.normalized.json by run ID, or use latest for operator convenience.",
      inputSchema: {
        runId: z.union([z.literal("latest"), z.string().regex(/^\d{8}-\d{6}-\d{3}$/)])
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
    },
    async ({ runId }) => {
      return jsonToolResult(getResult(runId));
    }
  );

  const taskIdSchema = z.string().regex(/^task_[a-zA-Z0-9_-]+$/);

  server.registerTool(
    "cc_create_task",
    {
      title: "Create Durable Worker Task",
      description: "Create a persistent asynchronous task and return immediately. Run-mode tasks wait for explicit approval.",
      inputSchema: {
        prompt: z.string().min(1),
        mode: z.enum(["plan", "review", "run"]).optional(),
        workerTimeoutSeconds: z.number().int().positive().max(3600).optional(),
        maxBudgetUsd: z.number().positive().max(5).optional(),
        resourceProfile: z.string().min(1).optional(),
        mockWorker: z.boolean().optional()
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
    },
    async (input = {}) => {
      try {
        const profile = resolveMcpResourceProfile(input);
        const task = await taskRuntime.createTask({
          prompt: input.prompt,
          mode: input.mode || "plan",
          resourceProfile: profile.name,
          workerTimeoutSeconds: profile.limits.timeoutSeconds,
          maxBudgetUsd: profile.limits.maxBudgetUsd,
          maxTurns: profile.limits.maxTurns,
          maxFilesRead: profile.limits.maxFilesRead,
          maxCommands: profile.limits.maxCommands,
          mockWorker: input.mockWorker === true
        });
        return jsonToolResult({ status: "success", taskId: task.taskId, task });
      } catch (error) {
        return jsonToolResult({ status: "invalid_input", error: error.message });
      }
    }
  );

  server.registerTool(
    "cc_get_task",
    {
      title: "Get Durable Worker Task",
      description: "Read the current persistent task snapshot, including activity, stage, heartbeat, and attempts.",
      inputSchema: { taskId: taskIdSchema },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
    },
    async ({ taskId }) => {
      const task = await taskRuntime.getTask(taskId);
      return jsonToolResult(task ? { status: "success", task } : { status: "task_not_found", taskId });
    }
  );

  server.registerTool(
    "cc_list_tasks",
    {
      title: "List Durable Worker Tasks",
      description: "List persistent tasks, optionally filtered by lifecycle status.",
      inputSchema: {
        status: z.enum(["queued", "running", "waiting_approval", "succeeded", "failed", "cancelled", "interrupted"]).optional(),
        limit: z.number().int().positive().max(200).optional()
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
    },
    async (input = {}) => {
      const tasks = await taskRuntime.listTasks({ status: input.status || null, limit: input.limit || 50 });
      return jsonToolResult({ status: "success", tasks });
    }
  );

  server.registerTool(
    "cc_get_task_events",
    {
      title: "Get Durable Worker Task Events",
      description: "Read task lifecycle and activity events after a sequence cursor.",
      inputSchema: {
        taskId: taskIdSchema,
        afterSequence: z.number().int().nonnegative().optional(),
        limit: z.number().int().positive().max(500).optional()
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
    },
    async (input = {}) => {
      const result = await taskRuntime.getTaskEvents(input.taskId, { afterSequence: input.afterSequence || 0, limit: input.limit || 200 });
      return jsonToolResult(result ? { status: "success", ...result } : { status: "task_not_found", taskId: input.taskId });
    }
  );

  server.registerTool(
    "cc_approve_task",
    {
      title: "Approve Durable Run Task",
      description: "Approve the exact revision, prompt hash, and capability boundary of a waiting run task.",
      inputSchema: {
        taskId: taskIdSchema,
        approvedBy: z.string().min(1),
        approvalReason: z.string().min(1)
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false }
    },
    async (input = {}) => {
      try {
        const task = await taskRuntime.approveTask(input.taskId, input);
        return jsonToolResult({ status: "success", task });
      } catch (error) {
        return jsonToolResult({ status: "approval_failed", taskId: input.taskId, error: error.message });
      }
    }
  );

  server.registerTool(
    "cc_cancel_task",
    {
      title: "Cancel Durable Worker Task",
      description: "Cancel a queued or waiting task, or request termination of its active Worker process tree.",
      inputSchema: {
        taskId: taskIdSchema,
        requestedBy: z.string().min(1).optional()
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false }
    },
    async (input = {}) => {
      const task = await taskRuntime.cancelTask(input.taskId, { requestedBy: input.requestedBy || "operator" });
      return jsonToolResult(task ? { status: "success", task } : { status: "task_not_found", taskId: input.taskId });
    }
  );

  const workflowIdSchema = z.string().regex(/^workflow_[a-zA-Z0-9_-]+$/);
  const workflowRoleSchema = z.enum(["planner", "coder", "reviewer"]);
  const supervisorDecisionInputSchema = z.object({
    intent: z.enum(["code_change", "documentation_change", "analysis", "conversation", "unknown"]),
    goal: z.string().min(1).optional(),
    goalConfidence: z.number().min(0).max(1).optional(),
    possibleIntentMismatch: z.string().min(1).max(2000).nullable().optional(),
    clarificationNeeded: z.boolean().optional(),
    technical_summary: z.string().min(1).max(4000).optional(),
    implementation_strategy: z.string().min(1).max(6000).optional(),
    expected_changes: z.array(z.string().min(1)).max(20).optional(),
    validation_plan: z.array(z.string().min(1)).max(20).optional(),
    project: z.string().min(1).optional(),
    projectId: z.string().min(1).optional(),
    reasoning: z.array(z.string().min(1)).min(1).max(12),
    risks: z.array(z.string().min(1)).max(12).optional(),
    workflowType: z.string().min(1),
    estimated_resources: z.object({
      complexity: z.enum(["low", "medium", "high"]).optional(),
      expected: z.object({
        budgetUsd: z.number().nonnegative().optional(),
        turns: z.number().int().nonnegative().optional(),
        filesRead: z.number().int().nonnegative().optional(),
        commands: z.number().int().nonnegative().optional(),
        timeoutSeconds: z.number().int().nonnegative().optional()
      }).optional(),
      notes: z.array(z.string().min(1)).max(8).optional()
    }).optional(),
    recommended_actions: z.array(z.string().min(1)).max(12).optional(),
    confidence: z.number().min(0).max(1),
    nextAction: z.enum(["create_workflow", "confirm_project", "respond_directly", "request_clarification"])
  });

  server.registerTool(
    "cc_create_workflow",
    {
      title: "Create Supervisor Workflow",
      description: "After cc_list_projects, cc_get_project_context, and cc_list_workflow_definitions, act as the accountable technical Supervisor: confirm one exact projectId, understand AI_SUPERVISOR.md and Project Memory, optionally reuse a returned sessionId, and provide technical_summary, implementation_strategy, expected_changes, and validation_plan. Never infer workspacePath or ask a Worker to guess it. A GPT-authored create_workflow Decision without explicit projectId is rejected. Approval-gated implementation remains blocked on explicit human approval.",
      inputSchema: {
        userRequest: z.string().min(1),
        definitionId: z.string().min(1).optional(),
        project: z.string().min(1).optional(),
        projectId: z.string().min(1).optional(),
        decisionId: z.string().regex(/^decision_[a-zA-Z0-9_-]+$/).optional(),
        clarificationDecisionId: z.string().regex(/^decision_[a-zA-Z0-9_-]+$/).optional(),
        clarificationResponse: z.string().min(1).max(5000).optional(),
        sessionId: z.string().regex(/^session_[a-zA-Z0-9_-]+$/).optional(),
        sessionName: z.string().min(1).max(120).optional(),
        supervisorSession: z.object({
          purpose: z.string().min(1).max(2000).optional(),
          decisions: z.array(z.string().min(1).max(2000)).max(50).optional(),
          unresolvedQuestions: z.array(z.string().min(1).max(2000)).max(50).optional(),
          nextActions: z.array(z.string().min(1).max(2000)).max(50).optional()
        }).optional(),
        supervisorDecision: supervisorDecisionInputSchema.optional(),
        mockWorker: z.boolean().optional()
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
    },
    async (input = {}) => {
      try {
        const outcome = await supervisorService.submitRequest(input);
        return jsonToolResult({ ...outcome, workflowId: outcome.workflow?.workflowId || null });
      } catch (error) {
        return jsonToolResult(unknownWorkflowDefinitionResult(error, input, workflowDefinitions) || { status: "invalid_input", error: error.message });
      }
    }
  );

  server.registerTool(
    "cc_add_workflow_task",
    {
      title: "Add Role Task to Workflow",
      description: "Compatibility operation for legacy non-orchestrated Workflows. Orchestrated Workflows create stage Tasks automatically.",
      inputSchema: {
        workflowId: workflowIdSchema,
        role: workflowRoleSchema,
        prompt: z.string().min(1),
        workerTimeoutSeconds: z.number().int().positive().max(3600).optional(),
        maxBudgetUsd: z.number().positive().max(5).optional(),
        resourceProfile: z.string().min(1).optional(),
        mockWorker: z.boolean().optional()
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
    },
    async (input = {}) => {
      try {
        const profileInput = input.role === "reviewer" && !input.resourceProfile ? { ...input, resourceProfile: "review_readonly" } : input;
        const profile = resolveMcpResourceProfile(profileInput);
        const result = await workflowRuntime.createTask(input.workflowId, {
          role: input.role,
          prompt: input.prompt,
          resourceProfile: profile.name,
          workerTimeoutSeconds: profile.limits.timeoutSeconds,
          maxBudgetUsd: profile.limits.maxBudgetUsd,
          maxTurns: profile.limits.maxTurns,
          maxFilesRead: profile.limits.maxFilesRead,
          maxCommands: profile.limits.maxCommands,
          mockWorker: input.mockWorker === true
        });
        return jsonToolResult({ status: "success", workflowId: input.workflowId, taskId: result.task.taskId, ...result });
      } catch (error) {
        return jsonToolResult({ status: "invalid_input", error: error.message });
      }
    }
  );

  server.registerTool(
    "cc_approve_workflow",
    {
      title: "Approve Workflow Implementation Stage",
      description: "Record explicit human approval for the waiting implementation stage. Only then does the Orchestrator create and approve the coder Task against its exact prompt and capability boundary.",
      inputSchema: {
        workflowId: workflowIdSchema,
        approvedBy: z.string().min(1),
        approvalReason: z.string().min(1)
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false }
    },
    async (input = {}) => {
      try {
        const workflow = await workflowRuntime.approveWorkflow(input.workflowId, input);
        return jsonToolResult({ status: "success", workflowId: input.workflowId, workflow });
      } catch (error) {
        return jsonToolResult({ status: "approval_failed", workflowId: input.workflowId, error: error.message });
      }
    }
  );

  server.registerTool(
    "cc_get_workflow",
    {
      title: "Get Supervisor Workflow",
      description: "Read a Workflow with live aggregate status and its associated role Tasks.",
      inputSchema: { workflowId: workflowIdSchema },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
    },
    async ({ workflowId }) => {
      const workflow = await workflowRuntime.getWorkflow(workflowId);
      return jsonToolResult(workflow ? { status: "success", workflow } : { status: "workflow_not_found", workflowId });
    }
  );

  server.registerTool(
    "cc_get_supervisor_review_package",
    {
      title: "Get Supervisor Review Package",
      description: "Build and persist a read-only review package for ChatGPT Web containing the original request, Supervisor Decision, implementation strategy, reported and observed changes, strict audit evidence, reviewer result, bound project context, the Project Memory snapshot captured by the Decision, Review-in-ChatGPT guidance, any explicitly persisted Supervisor Review Result, and an evidence-first Memory Update Proposal when warranted. GPT-owned judgment fields remain empty until a confirmed result is submitted. This tool never runs a Worker or modifies Project Memory.",
      inputSchema: { workflowId: workflowIdSchema },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
    },
    async ({ workflowId }) => {
      const reviewPackage = await supervisorService.getWorkflowReviewPackage(workflowId);
      return jsonToolResult(reviewPackage ? { status: "success", reviewPackage } : { status: "workflow_not_found", workflowId });
    }
  );

  server.registerTool(
    "cc_record_supervisor_review_result",
    {
      title: "Record Confirmed Supervisor Review Result",
      description: "Persist a ChatGPT Supervisor judgment as an additive record on a terminal Workflow. Call only after the user explicitly asks to save the review and supply confirmation metadata. This does not change Workflow state, approve work, start a Worker, or modify Project Memory.",
      inputSchema: {
        workflowId: workflowIdSchema,
        conclusion: z.enum(["accept", "revise", "investigate"]),
        goalAlignment: z.string().min(1).max(6000),
        architectureAssessment: z.string().min(1).max(6000),
        risks: z.array(z.string().min(1).max(2000)).max(30).optional(),
        recommendations: z.array(z.string().min(1).max(2000)).max(30).optional(),
        nextSteps: z.array(z.string().min(1).max(2000)).max(30).optional(),
        memoryUpdateNeeded: z.boolean().nullable().optional(),
        submittedBy: z.string().min(1).max(100),
        confirmationReason: z.string().min(1).max(1000),
        confirmed: z.literal(true)
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
    },
    async (input) => {
      try { return jsonToolResult({ status: "success", reviewResult: await supervisorService.recordSupervisorReview(input) }); }
      catch (error) { return jsonToolResult({ status: "invalid_input", error: error.message }); }
    }
  );

  server.registerTool(
    "cc_apply_memory_update_proposal",
    {
      title: "Apply Confirmed Project Memory Proposal",
      description: "Apply one existing evidence-first Memory Update Proposal by appending a traced Recent Evolution entry to PROJECT_MEMORY.md. Requires explicit human confirmation metadata and the exact proposalId. This never runs a Worker, rewrites history, or applies automatically.",
      inputSchema: {
        workflowId: workflowIdSchema,
        proposalId: z.string().regex(/^memory_proposal_workflow_[a-zA-Z0-9_-]+$/),
        appliedBy: z.string().min(1).max(100),
        confirmationReason: z.string().min(1).max(1000),
        confirmed: z.literal(true)
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false }
    },
    async (input) => {
      try { return jsonToolResult({ status: "success", ...(await supervisorService.applyMemoryProposal(input)) }); }
      catch (error) { return jsonToolResult({ status: "invalid_input", error: error.message }); }
    }
  );

  server.registerTool(
    "cc_list_workflows",
    {
      title: "List Supervisor Workflows",
      description: "List persistent Workflows with live status and role Task counts.",
      inputSchema: {
        status: z.enum(["created", "planning", "planned", "waiting_approval", "running", "reviewing", "completed", "failed", "queued", "succeeded"]).optional(),
        limit: z.number().int().positive().max(200).optional()
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
    },
    async (input = {}) => jsonToolResult({ status: "success", workflows: await workflowRuntime.listWorkflows({ status: input.status || null, limit: input.limit || 50 }) })
  );

  server.registerTool(
    "cc_get_workflow_events",
    {
      title: "Get Supervisor Workflow Events",
      description: "Read the merged Workflow and child Task event timeline after a cursor.",
      inputSchema: {
        workflowId: workflowIdSchema,
        afterSequence: z.number().int().nonnegative().optional(),
        limit: z.number().int().positive().max(1000).optional()
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
    },
    async (input = {}) => {
      const result = await workflowRuntime.getWorkflowEvents(input.workflowId, { afterSequence: input.afterSequence || 0, limit: input.limit || 500 });
      return jsonToolResult(result ? { status: "success", ...result } : { status: "workflow_not_found", workflowId: input.workflowId });
    }
  );

  return server;
}

function isAllowedOrigin(originHeader) {
  if (!originHeader) return true;
  try {
    const origin = new URL(originHeader);
    const configured = new Set((config.allowedOrigins || []).map((value) => String(value).toLowerCase()));
    const normalizedOrigin = `${origin.protocol}//${origin.host}`.toLowerCase();
    if (configured.has(normalizedOrigin)) return true;
    if ((origin.hostname === "localhost" || origin.hostname === "127.0.0.1" || origin.hostname === "::1") && /^https?:$/.test(origin.protocol)) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

await taskRuntime.start();
await workflowRuntime.start();
await supervisorService.start();
await providerPreflight.init();
let retentionResult = { enabled: process.env.SUPERVISOR_DISABLE_RETENTION !== "1" && config.retention?.enabled !== false, removedDirectoryCount: 0 };
if (retentionResult.enabled) {
  const retentionPlan = await planRuntimeRetention({
    dataRoot: runtimeDataRoot,
    artifactRoots: [resolveInsideProject(".agents", "runs"), resolveInsideProject(".agent-runs")],
    maxAgeDays: config.retention?.maxAgeDays,
    maxWorkflows: config.retention?.maxWorkflows,
    maxStandaloneTasks: config.retention?.maxStandaloneTasks,
    maxDecisions: config.retention?.maxDecisions
  });
  retentionResult = await applyRuntimeRetention(retentionPlan);
}

const app = createMcpExpressApp();

app.use((req, res, next) => {
  const origin = req.get("origin");
  if (!isAllowedOrigin(origin)) {
    res.status(403).json({ error: "origin_not_allowed" });
    return;
  }
  next();
});

app.get("/health", async (req, res) => {
  res.json({
    ok: true,
    service: "codex-claude-worker-harness-bridge",
    host: config.host || "127.0.0.1",
    port: config.port || 8787,
    harness: getPingPayload(),
    taskRuntime: {
      ok: taskRuntime.started,
      dataRoot: normalizeSlashes(runtimeDataRoot),
      maxConcurrentTasks: taskRuntime.maxConcurrentTasks
    },
    workflowRuntime: {
      ok: workflowRuntime.started,
      dataRoot: normalizeSlashes(path.join(runtimeDataRoot, "workflows"))
    },
    supervisor: {
      ok: true,
      projectCount: (await supervisorService.listProjects()).length,
      decisionsRoot: normalizeSlashes(supervisorStore.decisionsRoot)
    },
    providerPreflight: {
      available: true,
      latest: await providerPreflight.getLatest()
    },
    retention: retentionResult
  });
});

registerSupervisorDashboardRoutes(app, { taskRuntime, workflowRuntime, supervisorService, providerPreflight, taskRunner, workflowMetadataStore, dashboardRoot: supervisorDashboardRoot });

app.get("/.well-known/oauth-protected-resource/mcp", (req, res) => {
  res.json({
    resource: `${req.protocol}://${req.get("host")}/mcp`,
    authorization_servers: []
  });
});

app.post("/mcp", async (req, res) => {
  const server = createServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    res.on("close", () => {
      transport.close();
      server.close();
    });
  } catch (error) {
    console.error("Error handling MCP request:", error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: {
          code: -32603,
          message: "Internal server error"
        },
        id: null
      });
    }
  }
});

app.get("/mcp", (req, res) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: {
      code: -32000,
      message: "Method not allowed."
    },
    id: null
  });
});

app.delete("/mcp", (req, res) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: {
      code: -32000,
      message: "Method not allowed."
    },
    id: null
  });
});

const host = config.host || "127.0.0.1";
const port = limitNumber(config.port, 8787, 1, 65535);

app.listen(port, host, (error) => {
  if (error) {
    console.error("Failed to start MCP bridge:", error);
    process.exit(1);
  }
  console.log(`MCP bridge listening on http://${host}:${port}/mcp`);
  console.log(`Health check available at http://${host}:${port}/health`);
});
