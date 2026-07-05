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
const allowedScriptPaths = new Set([claudeTaskPath, summaryPath].map((p) => path.resolve(p).toLowerCase()));

function scriptPath(scriptName) {
  const selected = scriptName === "claude-task.ps1" ? claudeTaskPath : scriptName === "summary.ps1" ? summaryPath : null;
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

function runHarness(scriptName, args, workerTimeoutSeconds) {
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
      child.kill();
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
        command: ["powershell", ...commandArgs],
        cwd: projectRoot
      });
    });
    child.on("close", (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const out = truncate(stdout, stdoutLimit);
      const err = truncate(stderr, stderrLimit);
      resolve({
        status: classifyExit(exitCode, timedOut),
        exitCode,
        stdout: out.text,
        stderr: err.text,
        stdoutTruncated: out.truncated,
        stderrTruncated: err.truncated,
        durationSeconds: (Date.now() - startedAt) / 1000,
        command: ["powershell", ...commandArgs],
        cwd: projectRoot
      });
    });
  });
}

function getPingPayload() {
  return {
    ok: fs.existsSync(agentsDir) && fs.existsSync(claudeTaskPath) && fs.existsSync(summaryPath),
    projectRoot: normalizeSlashes(projectRoot),
    agentsDirExists: fs.existsSync(agentsDir) && fs.statSync(agentsDir).isDirectory(),
    claudeTaskExists: fs.existsSync(claudeTaskPath) && fs.statSync(claudeTaskPath).isFile(),
    summaryExists: fs.existsSync(summaryPath) && fs.statSync(summaryPath).isFile()
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

function getLatestResult() {
  const { checkedPaths, candidates } = getRunDirectories();
  const found = candidates.find((candidate) => fs.existsSync(candidate.normalizedPath));
  if (!found) {
    return {
      status: "result_not_found",
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
    version: "0.1.0"
  });

  server.registerTool(
    "cc_ping",
    {
      title: "Ping Worker Harness Bridge",
      description: "Check that the fixed harness scripts exist under the configured project root."
    },
    async () => jsonToolResult(getPingPayload())
  );

  const taskInputSchema = {
    prompt: z.string().min(1),
    workerTimeoutSeconds: z.number().int().positive().max(3600).optional()
  };

  server.registerTool(
    "cc_plan_task",
    {
      title: "Plan Worker Task",
      description: "Run the harness in read-only plan mode for a fixed task prompt.",
      inputSchema: taskInputSchema
    },
    async ({ prompt, workerTimeoutSeconds }) => {
      const timeout = limitNumber(workerTimeoutSeconds, config.workerTimeoutSeconds ?? 300, 1, 3600);
      return jsonToolResult(await runHarness("claude-task.ps1", ["plan", "-Task", prompt, "-WorkerTimeoutSeconds", timeout], timeout));
    }
  );

  server.registerTool(
    "cc_review_task",
    {
      title: "Review Worker Task",
      description: "Run the harness in read-only review mode for a fixed task prompt.",
      inputSchema: taskInputSchema
    },
    async ({ prompt, workerTimeoutSeconds }) => {
      const timeout = limitNumber(workerTimeoutSeconds, config.workerTimeoutSeconds ?? 300, 1, 3600);
      return jsonToolResult(await runHarness("claude-task.ps1", ["review", "-Task", prompt, "-WorkerTimeoutSeconds", timeout], timeout));
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
        workerTimeoutSeconds: z.number().int().positive().max(3600).optional()
      }
    },
    async ({ prompt, approvedBy, approvalReason, workerTimeoutSeconds }) => {
      const finalApprovedBy = approvedBy || config.defaultApprovedBy;
      const finalApprovalReason = approvalReason || config.defaultApprovalReason;
      if (!finalApprovedBy || !finalApprovalReason) {
        return jsonToolResult({
          status: "invalid_input",
          error: "approvedBy and approvalReason are required when config defaults are not set."
        });
      }
      const timeout = limitNumber(workerTimeoutSeconds, config.workerTimeoutSeconds ?? 300, 1, 3600);
      return jsonToolResult(
        await runHarness(
          "claude-task.ps1",
          [
            "run",
            "-Task",
            prompt,
            "-ApprovedBy",
            finalApprovedBy,
            "-ApprovalReason",
            finalApprovalReason,
            "-WorkerTimeoutSeconds",
            timeout
          ],
          timeout
        )
      );
    }
  );

  server.registerTool(
    "cc_get_latest_summary",
    {
      title: "Get Latest Harness Summary",
      description: "Run summary.ps1 for the latest run including incomplete runs."
    },
    async () => jsonToolResult(await runHarness("summary.ps1", ["-RunId", "latest", "-IncludeIncomplete"], 30))
  );

  server.registerTool(
    "cc_get_result",
    {
      title: "Get Latest Normalized Result",
      description: "Read the latest worker-result.normalized.json from known harness run directories. v1 only accepts runId=latest.",
      inputSchema: {
        runId: z.literal("latest")
      }
    },
    async ({ runId }) => {
      if (runId !== "latest") {
        return jsonToolResult({
          status: "invalid_input",
          error: "cc_get_result v1 only accepts runId = latest."
        });
      }
      return jsonToolResult(getLatestResult());
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
