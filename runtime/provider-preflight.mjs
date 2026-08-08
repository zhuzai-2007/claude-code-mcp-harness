import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PREFLIGHT_MARKER = "SUPERVISOR_PROVIDER_PREFLIGHT_OK";
export const PREFLIGHT_PROMPT = `Connectivity preflight only. Do not inspect files, call tools, or modify anything. Reply with exactly ${PREFLIGHT_MARKER}.`;
const MODULE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ISOLATION_ROOT = path.join(os.tmpdir(), "claude-code-mcp-harness", "provider-preflight");

const FAILURE_RULES = [
  { classification: "authentication_failed", pattern: /\b(401|403)\b|unauthori[sz]ed|authentication|invalid api key|login required/i, message: "The Claude CLI reached an authentication boundary but was not authorized.", recovery: ["Verify the provider credentials available to the terminal that starts Supervisor.", "Run the preflight again before creating a new Workflow."] },
  { classification: "connection_refused", pattern: /connectionrefused|connection refused|econnrefused/i, message: "The configured provider endpoint refused the connection.", recovery: ["Verify the provider endpoint and command-line proxy configuration.", "Confirm the provider is reachable from this terminal, then run the preflight again."] },
  { classification: "dns_failed", pattern: /enotfound|getaddrinfo|name or service not known|could not resolve host/i, message: "The provider hostname could not be resolved.", recovery: ["Check DNS and command-line proxy configuration.", "Run the preflight again after network resolution is restored."] },
  { classification: "tls_failed", pattern: /certificate|self[- ]signed|unable to verify|tls|ssl/i, message: "TLS validation failed while connecting to the provider.", recovery: ["Check the system clock, certificate chain, and approved proxy configuration.", "Do not disable TLS verification; fix the trust path and retry."] },
  { classification: "rate_limited", pattern: /\b429\b|rate.?limit|too many requests/i, message: "The provider is reachable but is currently rate limiting requests.", recovery: ["Wait for the provider retry window.", "Run the preflight again before retrying the Workflow."] },
  { classification: "provider_unavailable", pattern: /\b(500|502|503|504)\b|service unavailable|bad gateway|gateway timeout/i, message: "The provider is reachable but unavailable.", recovery: ["Check provider status and retry later.", "Run the preflight again before retrying the Workflow."] },
  { classification: "budget_exceeded", pattern: /maximum budget|budget.*exceed|error_max_budget_usd/i, message: "The provider call reached its preflight budget limit.", recovery: ["Verify that the configured model can answer the fixed one-turn probe within the preflight budget.", "Do not increase normal Workflow limits solely to mask this failure."] }
];

function safeLimit(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.round(number)));
}

function terminateProcessTree(child) {
  if (!child?.pid || child.exitCode !== null) return;
  if (process.platform !== "win32") return child.kill("SIGTERM");
  const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { shell: false, windowsHide: true, stdio: "ignore" });
  killer.on("error", () => child.kill());
  killer.on("close", (exitCode) => { if (exitCode !== 0 && child.exitCode === null) child.kill(); });
  setTimeout(() => { if (child.exitCode === null) child.kill(); }, 2000).unref();
}

export function runProcess({ command, args = [], input = "", cwd, timeoutMs = 60000 }) {
  if (process.platform === "win32" && command === "claude") return runWindowsClaude({ args, input, cwd, timeoutMs });
  return new Promise((resolve) => {
    let child;
    try { child = spawn(command, args, { cwd, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] }); }
    catch (spawnError) { resolve({ exitCode: null, stdout: "", stderr: "", timedOut: false, spawnError }); return; }
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let timer = null;
    const finish = (exitCode, spawnError = null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ exitCode, stdout: stdout.slice(0, 16000), stderr: stderr.slice(0, 16000), timedOut, spawnError });
    };
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", (error) => finish(null, error));
    child.on("close", (exitCode) => finish(exitCode));
    child.stdin.on("error", () => {});
    child.stdin.end(input, "utf8");
    timer = setTimeout(() => { timedOut = true; terminateProcessTree(child); }, timeoutMs);
  });
}

async function runWindowsClaude({ args, input, cwd, timeoutMs }) {
  const suffix = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const inputPath = path.join(cwd, `preflight-input-${suffix}.txt`);
  const argumentsPath = path.join(cwd, `preflight-arguments-${suffix}.json`);
  const stdoutPath = path.join(cwd, `preflight-stdout-${suffix}.txt`);
  const stderrPath = path.join(cwd, `preflight-stderr-${suffix}.txt`);
  await Promise.all([writeFile(inputPath, input, "utf8"), writeFile(argumentsPath, JSON.stringify(args), "utf8")]);
  const wrapperPath = path.resolve(MODULE_DIRECTORY, "..", "scripts", "invoke-claude-preflight.ps1");
  return new Promise((resolve) => {
    let child;
    let settled = false;
    let timedOut = false;
    let timer = null;
    const finish = async (exitCode, spawnError = null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      const read = async (filePath) => { try { return (await readFile(filePath, "utf8")).slice(0, 16000); } catch { return ""; } };
      const [stdout, stderr] = await Promise.all([read(stdoutPath), read(stderrPath)]);
      await Promise.all([inputPath, argumentsPath, stdoutPath, stderrPath].map((filePath) => rm(filePath, { force: true }).catch(() => {})));
      resolve({ exitCode, stdout, stderr, timedOut: timedOut || exitCode === 124, spawnError });
    };
    const powershellArgs = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", wrapperPath, "-ArgumentsPath", argumentsPath, "-InputPath", inputPath, "-StdoutPath", stdoutPath, "-StderrPath", stderrPath, "-TimeoutSeconds", String(Math.max(1, Math.ceil(timeoutMs / 1000)))];
    try { child = spawn("powershell", powershellArgs, { cwd, shell: false, windowsHide: false, stdio: "inherit" }); }
    catch (spawnError) { finish(null, spawnError); return; }
    child.on("error", (error) => finish(null, error));
    child.on("close", (exitCode) => finish(exitCode));
    timer = setTimeout(() => { timedOut = true; terminateProcessTree(child); }, timeoutMs + 5000);
  });
}

function classifyFailure(result) {
  if (result.spawnError?.code === "ENOENT") return { classification: "claude_not_found", message: "Claude CLI was not found on PATH.", recovery: ["Install Claude Code CLI and ensure the Supervisor process can resolve `claude`.", "Run `claude --version`, then repeat the preflight."] };
  if (["EPERM", "EACCES"].includes(result.spawnError?.code)) return { classification: "process_launch_blocked", message: "The operating environment blocked Supervisor from launching the isolated Claude CLI probe.", recovery: ["Allow the local Supervisor process to start the installed Claude CLI without bypassing project permissions.", "Run the preflight again from the same environment that will run the Bridge."] };
  if (result.timedOut) return { classification: "provider_timeout", message: "The provider did not complete the fixed connectivity probe before the timeout.", recovery: ["Check provider and command-line proxy connectivity from the Supervisor terminal.", "Repeat the preflight; do not start a paid Workflow until it succeeds."] };
  const diagnostic = `${result.stderr || ""}\n${result.stdout || ""}`;
  const matched = FAILURE_RULES.find((rule) => rule.pattern.test(diagnostic));
  if (matched) return matched;
  return { classification: "provider_error", message: `Claude CLI exited with code ${result.exitCode ?? "unknown"} before confirming provider connectivity.`, recovery: ["Run the Claude CLI with a fixed non-project prompt in the same terminal and inspect its provider configuration.", "Repeat the Supervisor preflight after correcting the environment."] };
}

export async function runProviderPreflight({ commandRunner = runProcess, timeoutSeconds = 60, isolationRoot = DEFAULT_ISOLATION_ROOT } = {}) {
  const checkedAt = new Date().toISOString();
  const startedAt = Date.now();
  const timeout = safeLimit(timeoutSeconds, 60, 10, 300);
  const resolvedIsolationRoot = path.resolve(isolationRoot || DEFAULT_ISOLATION_ROOT);
  await mkdir(resolvedIsolationRoot, { recursive: true });
  const isolatedDirectory = await mkdtemp(path.join(resolvedIsolationRoot, "probe-"));
  const safety = { projectContentSent: false, toolsEnabled: false, modificationsAllowed: false, workingDirectory: "isolated_system_temp_dir", sessionPersisted: false, safeMode: true, promptKind: "fixed_connectivity_probe" };
  try {
    const versionResult = await commandRunner({ command: "claude", args: ["--version"], cwd: isolatedDirectory, timeoutMs: 10000 });
    if (versionResult.spawnError || versionResult.exitCode !== 0) {
      const failure = classifyFailure(versionResult);
      return { schemaVersion: 1, status: "failed", checkedAt, durationSeconds: (Date.now() - startedAt) / 1000, classification: failure.classification, cli: { available: failure.classification === "claude_not_found" ? false : null, version: null }, provider: { reachable: false }, safety, message: failure.message, recoverySteps: failure.recovery };
    }
    const version = String(versionResult.stdout || versionResult.stderr || "").trim().split(/\r?\n/)[0].slice(0, 120) || null;
    const args = [
      "-p", "--safe-mode", "--disable-slash-commands", "--no-session-persistence",
      "--permission-mode", "plan", "--tools", "", "--output-format", "json",
      "--max-budget-usd", "0.05", "--system-prompt", "You are a connectivity probe. Never use tools or inspect files."
    ];
    const result = await commandRunner({ command: "claude", args, input: PREFLIGHT_PROMPT, cwd: isolatedDirectory, timeoutMs: timeout * 1000 });
    const output = String(result.stdout || "");
    if (!result.spawnError && !result.timedOut && result.exitCode === 0 && output.includes(PREFLIGHT_MARKER)) {
      return { schemaVersion: 1, status: "ok", checkedAt, durationSeconds: (Date.now() - startedAt) / 1000, classification: "reachable", cli: { available: true, version }, provider: { reachable: true }, safety, message: "Claude CLI and its configured provider completed the isolated connectivity probe.", recoverySteps: [] };
    }
    const failure = result.exitCode === 0 && !output.includes(PREFLIGHT_MARKER)
      ? { classification: "invalid_response", message: "The provider returned successfully but did not produce the expected preflight marker.", recovery: ["Check the configured model and provider response mapping.", "Repeat the preflight before starting a Workflow."] }
      : classifyFailure(result);
    return { schemaVersion: 1, status: "failed", checkedAt, durationSeconds: (Date.now() - startedAt) / 1000, classification: failure.classification, cli: { available: true, version }, provider: { reachable: false }, safety, message: failure.message, recoverySteps: failure.recovery };
  } finally {
    await rm(isolatedDirectory, { recursive: true, force: true });
  }
}

async function writeJsonAtomic(filePath, value) {
  const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  let lastError;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try { await rename(temporaryPath, filePath); return; }
    catch (error) {
      lastError = error;
      if (!["EPERM", "EACCES", "EBUSY"].includes(error?.code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10 * 2 ** attempt));
    }
  }
  throw lastError;
}

export class ProviderPreflightService {
  constructor({ runtimeDataRoot, commandRunner = runProcess }) {
    this.root = path.join(path.resolve(runtimeDataRoot), "provider-preflight");
    this.latestPath = path.join(this.root, "latest.json");
    this.commandRunner = commandRunner;
  }
  async init() { await mkdir(this.root, { recursive: true }); }
  async getLatest() {
    try { return JSON.parse(await readFile(this.latestPath, "utf8")); }
    catch (error) { if (error?.code === "ENOENT") return null; throw error; }
  }
  async run({ timeoutSeconds = 60 } = {}) {
    await this.init();
    const result = await runProviderPreflight({ commandRunner: this.commandRunner, timeoutSeconds });
    await writeJsonAtomic(this.latestPath, result);
    return result;
  }
}
