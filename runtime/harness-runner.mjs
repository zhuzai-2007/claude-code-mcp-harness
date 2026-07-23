import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { writeAttemptProjectContextSnapshot } from "./project-context-snapshot.mjs";

function limitText(value, limit) {
  const text = String(value || "");
  return text.length <= limit ? text : `${text.slice(0, limit)}\n...[truncated]`;
}

function lineCount(value) { return String(value || "").split(/\r?\n/).length; }

function observedChanges(toolEvents, projectRoot) {
  const changes = [];
  for (const call of toolEvents?.tool_calls || []) {
    if (!call?.succeeded || call.denied || !["Edit", "Write"].includes(call.tool)) continue;
    const input = call.input || {};
    const absolutePath = path.resolve(String(input.file_path || input.path || ""));
    const relativePath = path.relative(projectRoot, absolutePath).replaceAll("\\", "/");
    if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) continue;
    if (call.tool === "Edit") {
      const before = String(input.old_string || "");
      const after = String(input.new_string || "");
      const diff = [`--- a/${relativePath}`, `+++ b/${relativePath}`, "@@ observed Edit tool call @@", ...before.split(/\r?\n/).map((line) => `-${line}`), ...after.split(/\r?\n/).map((line) => `+${line}`)].join("\n");
      changes.push({ file: relativePath, operation: input.replace_all ? "replace_all" : "edit", addedLines: lineCount(after), removedLines: lineCount(before), diff: limitText(diff, 20000) });
    } else {
      const content = String(input.content || "");
      const diff = [`--- /dev/null`, `+++ b/${relativePath}`, "@@ observed Write tool call @@", ...content.split(/\r?\n/).map((line) => `+${line}`)].join("\n");
      changes.push({ file: relativePath, operation: "write", addedLines: lineCount(content), removedLines: 0, diff: limitText(diff, 20000) });
    }
  }
  return changes.slice(0, 50);
}

function terminateProcessTree(child) {
  if (!child?.pid || child.exitCode !== null) return;
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
}

export class HarnessRunner {
  constructor({ projectRoot, workerTimeoutSeconds = 300, stdoutLimit = 12000, stderrLimit = 12000 }) {
    this.projectRoot = path.resolve(projectRoot);
    this.scriptPath = path.join(this.projectRoot, ".agents", "claude-task.ps1");
    this.defaultWorkerTimeoutSeconds = workerTimeoutSeconds;
    this.stdoutLimit = stdoutLimit;
    this.stderrLimit = stderrLimit;
  }

  generateAttemptId() {
    for (let offset = 0; offset < 1000; offset += 1) {
      const now = new Date(Date.now() + offset);
      const pad = (value, width = 2) => String(value).padStart(width, "0");
      const attemptId = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}-${pad(now.getMilliseconds(), 3)}`;
      const exists = [
        path.join(this.projectRoot, ".agents", "runs", attemptId),
        path.join(this.projectRoot, ".agent-runs", attemptId)
      ].some((candidate) => fs.existsSync(candidate));
      if (!exists) return attemptId;
    }
    throw new Error("Unable to allocate a unique attemptId.");
  }

  prepareAttemptContext({ attemptId, mode, projectContext = null }) {
    if (mode !== "plan" || !projectContext?.workspacePath) return null;
    const prepared = writeAttemptProjectContextSnapshot({
      projectRoot: this.projectRoot,
      workspacePath: projectContext.workspacePath,
      attemptId
    });
    return {
      projectContextSnapshot: prepared,
      metadata: {
        fileName: "project-context-snapshot.json",
        projectRoot: prepared.snapshot.projectRoot,
        generatedAt: prepared.snapshot.generatedAt,
        empty: prepared.snapshot.empty,
        entryCount: prepared.snapshot.entries.length,
        truncated: prepared.snapshot.truncated
      }
    };
  }

  findResult(attemptId) {
    for (const root of [path.join(this.projectRoot, ".agents", "runs"), path.join(this.projectRoot, ".agent-runs")]) {
      const runDir = path.join(root, attemptId);
      const normalizedPath = path.join(runDir, "worker-result.normalized.json");
      if (!fs.existsSync(normalizedPath)) continue;
      return {
        runDir,
        normalizedPath,
        result: JSON.parse(fs.readFileSync(normalizedPath, "utf8").replace(/^\uFEFF/, ""))
      };
    }
    return { runDir: null, normalizedPath: null, result: null };
  }

  inspectAttempt(attemptId) {
    const found = this.findResult(attemptId);
    if (!found.runDir) return { audit: null, recentToolCalls: [], observedChanges: [], artifactFiles: [] };
    const readJsonIfPresent = (name) => {
      const filePath = path.join(found.runDir, name);
      if (!fs.existsSync(filePath)) return null;
      return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
    };
    const toolEvents = readJsonIfPresent("tool-events.json");
    const artifactFiles = ["worker-result.normalized.json", "result.json", "tool-events.json", "claude-output.json", "project-context-snapshot.json", "capability-diagnostics.json"]
      .filter((name) => fs.existsSync(path.join(found.runDir, name)));
    return {
      audit: found.result,
      recentToolCalls: (toolEvents?.tool_calls || []).slice(-10),
      observedChanges: observedChanges(toolEvents, this.projectRoot),
      artifactFiles
    };
  }

  artifactPath(attemptId, fileName) {
    const allowed = new Set(["worker-result.normalized.json", "result.json", "tool-events.json", "claude-output.json", "project-context-snapshot.json", "capability-diagnostics.json"]);
    if (!allowed.has(fileName)) return null;
    const found = this.findResult(attemptId);
    if (!found.runDir) return null;
    const candidate = path.join(found.runDir, fileName);
    return fs.existsSync(candidate) ? candidate : null;
  }

  runAttempt({ attemptId, mode, prompt, resourceProfile, resourceLimits = {}, workerTimeoutSeconds, maxBudgetUsd, maxTurns, maxFilesRead, maxCommands, mockWorker = false, approval = null, projectContext = null, preparedAttemptContext = null, signal = null, onSpawn = null }) {
    const timeout = Number(workerTimeoutSeconds || this.defaultWorkerTimeoutSeconds);
    const effective = {
      maxBudgetUsd: maxBudgetUsd ?? resourceLimits.maxBudgetUsd,
      maxTurns: maxTurns ?? resourceLimits.maxTurns,
      maxFilesRead: maxFilesRead ?? resourceLimits.maxFilesRead,
      maxCommands: maxCommands ?? resourceLimits.maxCommands
    };
    const args = [
      "-NoProfile", "-File", this.scriptPath, mode, "-Task", prompt,
      "-ResourceProfile", String(resourceProfile),
      "-WorkerTimeoutSeconds", String(timeout),
      "-MaxBudgetUsd", String(effective.maxBudgetUsd),
      "-MaxTurns", String(effective.maxTurns),
      "-MaxFilesRead", String(effective.maxFilesRead),
      "-MaxCommands", String(effective.maxCommands),
      "-RunId", attemptId
    ];
    const preparedContext = preparedAttemptContext || this.prepareAttemptContext({ attemptId, mode, projectContext });
    const preparedSnapshot = preparedContext?.projectContextSnapshot || null;
    if (preparedSnapshot?.filePath) args.push("-ProjectContextSnapshotFile", preparedSnapshot.filePath);
    if (mockWorker) args.push("-MockWorker");
    if (mode === "run") {
      if (!approval?.approvedBy || !approval?.approvalReason) {
        throw new Error("Approved run attempt is missing approval metadata.");
      }
      args.push("-ApprovedBy", approval.approvedBy, "-ApprovalReason", approval.approvalReason);
    }

    return new Promise((resolve) => {
      const startedAt = Date.now();
      let stdout = "";
      let stderr = "";
      let settled = false;
      let timedOut = false;
      let cancelled = false;
      const child = spawn("powershell", args, {
        cwd: this.projectRoot,
        shell: false,
        windowsHide: false,
        stdio: "inherit"
      });
      onSpawn?.({ pid: child.pid });

      const finish = (exitCode, spawnError = null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abortHandler);
        const found = this.findResult(attemptId);
        if (preparedSnapshot?.filePath) {
          try { fs.rmSync(preparedSnapshot.filePath, { force: true }); } catch {}
        }
        const bridgeStatus = cancelled
          ? "cancelled"
          : timedOut
            ? "interrupted"
            : spawnError
              ? "environment_failed"
              : exitCode === 0 && !found.result
                ? "artifact_missing"
              : exitCode === 0
                ? "success"
                : "failed";
        resolve({
          attemptId,
          runId: attemptId,
          bridgeStatus,
          exitCode,
          durationSeconds: (Date.now() - startedAt) / 1000,
          stdout: limitText(stdout, this.stdoutLimit),
          stderr: limitText(`${stderr}${spawnError ? `\n${spawnError.message}` : ""}`, this.stderrLimit),
          ...found
        });
      };

      const abortHandler = () => {
        cancelled = true;
        terminateProcessTree(child);
      };
      signal?.addEventListener("abort", abortHandler, { once: true });
      const timer = setTimeout(() => {
        timedOut = true;
        terminateProcessTree(child);
      }, (timeout + 30) * 1000);

      child.stdout?.on("data", (chunk) => { stdout += chunk.toString(); });
      child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
      child.on("error", (error) => finish(null, error));
      child.on("close", (exitCode) => finish(exitCode));
    });
  }
}
