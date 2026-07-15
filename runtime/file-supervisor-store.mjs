import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const DECISION_ID_PATTERN = /^decision_[a-zA-Z0-9_-]+$/;

async function writeJsonAtomic(filePath, value) {
  const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  let lastError;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try { await rename(temporaryPath, filePath); return; }
    catch (error) {
      lastError = error;
      if (!new Set(["EPERM", "EACCES", "EBUSY"]).has(error?.code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10 * 2 ** attempt));
    }
  }
  throw lastError;
}

export class FileSupervisorStore {
  constructor(dataRoot) {
    this.dataRoot = path.resolve(dataRoot);
    this.decisionsRoot = path.join(this.dataRoot, "supervisor-decisions");
    this.projectUsagePath = path.join(this.dataRoot, "project-usage.json");
  }

  async init() { await mkdir(this.decisionsRoot, { recursive: true }); }

  decisionPath(decisionId) {
    if (!DECISION_ID_PATTERN.test(String(decisionId || ""))) throw new Error(`Invalid decisionId: ${decisionId}`);
    return path.join(this.decisionsRoot, `${decisionId}.json`);
  }

  async writeDecision(decision) {
    await this.init();
    await writeJsonAtomic(this.decisionPath(decision.decisionId), decision);
    return decision;
  }

  async readDecision(decisionId) {
    try { return JSON.parse(await readFile(this.decisionPath(decisionId), "utf8")); }
    catch (error) { if (error?.code === "ENOENT") return null; throw error; }
  }

  async listDecisions({ limit = 100 } = {}) {
    await this.init();
    const decisions = [];
    for (const entry of await readdir(this.decisionsRoot, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const decision = await this.readDecision(entry.name.slice(0, -5));
      if (decision) decisions.push(decision);
    }
    return decisions.sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt))).slice(0, Math.max(1, Number(limit) || 100));
  }

  async readProjectUsage() {
    try { return JSON.parse(await readFile(this.projectUsagePath, "utf8")); }
    catch (error) { if (error?.code === "ENOENT") return {}; throw error; }
  }

  async markProjectUsed(projectId, timestamp = new Date().toISOString()) {
    const usage = await this.readProjectUsage();
    usage[projectId] = timestamp;
    await writeJsonAtomic(this.projectUsagePath, usage);
    return timestamp;
  }
}
