import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { z } from "zod";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const configPath = path.join(__dirname, "config.json");

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
}

const config = readJson(configPath);

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

function limitBudget(value, fallback = 0.10) {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.round(Math.max(0.01, Math.min(5.00, parsed)) * 100) / 100;
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
    version: "0.1.1-alpha"
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

  const taskInputSchema = {
    prompt: z.string().min(1),
    workerTimeoutSeconds: z.number().int().positive().max(3600).optional(),
    maxBudgetUsd: z.number().positive().max(5).optional(),
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
      const { prompt, workerTimeoutSeconds } = input;
      const mockWorker = input?.mockWorker === true;
      const timeout = limitNumber(workerTimeoutSeconds, config.workerTimeoutSeconds ?? 300, 1, 3600);
      const budget = limitBudget(input?.maxBudgetUsd, config.maxBudgetUsd ?? 0.10);
      const runId = generateRunId();
      const args = ["plan", "-Task", prompt, "-WorkerTimeoutSeconds", timeout, "-MaxBudgetUsd", budget, "-RunId", runId];
      if (mockWorker) args.push("-MockWorker");
      return jsonToolResult(await runHarness("claude-task.ps1", args, timeout, runId));
    }
  );

  server.registerTool(
    "cc_review_task",
    {
      title: "Review Worker Task",
      description: "Run the harness in read-only review mode for a fixed task prompt.",
      inputSchema: taskInputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
    },
    async (input = {}) => {
      const { prompt, workerTimeoutSeconds } = input;
      const mockWorker = input?.mockWorker === true;
      const timeout = limitNumber(workerTimeoutSeconds, config.workerTimeoutSeconds ?? 300, 1, 3600);
      const budget = limitBudget(input?.maxBudgetUsd, config.maxBudgetUsd ?? 0.10);
      const runId = generateRunId();
      const args = ["review", "-Task", prompt, "-WorkerTimeoutSeconds", timeout, "-MaxBudgetUsd", budget, "-RunId", runId];
      if (mockWorker) args.push("-MockWorker");
      return jsonToolResult(await runHarness("claude-task.ps1", args, timeout, runId));
    }
  );

  server.registerTool(
    "cc_run_approved_task",
    {
      title: "Run Approved Worker Task",
      description: "Run the write-capable harness mode with explicit approval fields.",
      inputSchema: {
        prompt: z.string().min(1),
        approvedBy: z.string().min(1).optional(),
        approvalReason: z.string().min(1).optional(),
        workerTimeoutSeconds: z.number().int().positive().max(3600).optional(),
        maxBudgetUsd: z.number().positive().max(5).optional(),
        mockWorker: z.boolean().optional()
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false }
    },
    async (input = {}) => {
      const { prompt, approvedBy, approvalReason, workerTimeoutSeconds } = input;
      const mockWorker = input?.mockWorker === true;
      const finalApprovedBy = approvedBy || config.defaultApprovedBy;
      const finalApprovalReason = approvalReason || config.defaultApprovalReason;
      if (!finalApprovedBy || !finalApprovalReason) {
        return jsonToolResult({
          status: "invalid_input",
          error: "approvedBy and approvalReason are required when config defaults are not set."
        });
      }
      const timeout = limitNumber(workerTimeoutSeconds, config.workerTimeoutSeconds ?? 300, 1, 3600);
      const budget = limitBudget(input?.maxBudgetUsd, config.maxBudgetUsd ?? 0.10);
      const runId = generateRunId();
      const args = [
        "run",
        "-Task",
        prompt,
        "-ApprovedBy",
        finalApprovedBy,
        "-ApprovalReason",
        finalApprovalReason,
        "-WorkerTimeoutSeconds",
        timeout,
        "-MaxBudgetUsd",
        budget,
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

const app = createMcpExpressApp();

app.use((req, res, next) => {
  const origin = req.get("origin");
  if (!isAllowedOrigin(origin)) {
    res.status(403).json({ error: "origin_not_allowed" });
    return;
  }
  next();
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "codex-claude-worker-harness-bridge",
    host: config.host || "127.0.0.1",
    port: config.port || 8787,
    harness: getPingPayload()
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
