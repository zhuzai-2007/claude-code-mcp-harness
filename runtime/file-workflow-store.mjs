import { appendFile, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const WORKFLOW_ID_PATTERN = /^workflow_[a-zA-Z0-9_-]+$/;

function assertWorkflowId(workflowId) {
  if (!WORKFLOW_ID_PATTERN.test(String(workflowId || ""))) throw new Error(`Invalid workflowId: ${workflowId}`);
}

async function writeJsonAtomic(filePath, value) {
  const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  let lastError;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      await rename(temporaryPath, filePath);
      return;
    } catch (error) {
      lastError = error;
      if (!new Set(["EPERM", "EACCES", "EBUSY"]).has(error?.code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10 * 2 ** attempt));
    }
  }
  throw lastError;
}

export class FileWorkflowStore {
  constructor(dataRoot) {
    this.dataRoot = path.resolve(dataRoot);
    this.workflowsRoot = path.join(this.dataRoot, "workflows");
  }

  async init() { await mkdir(this.workflowsRoot, { recursive: true }); }

  workflowDirectory(workflowId) {
    assertWorkflowId(workflowId);
    return path.join(this.workflowsRoot, workflowId);
  }

  workflowPath(workflowId) { return path.join(this.workflowDirectory(workflowId), "workflow.json"); }
  eventsPath(workflowId) { return path.join(this.workflowDirectory(workflowId), "events.jsonl"); }
  eventIndexPath(workflowId) { return path.join(this.workflowDirectory(workflowId), "event-index.json"); }

  async createWorkflow(workflow) {
    await mkdir(this.workflowDirectory(workflow.workflowId), { recursive: false });
    await writeFile(this.eventsPath(workflow.workflowId), "", { encoding: "utf8", flag: "wx" });
    await writeJsonAtomic(this.workflowPath(workflow.workflowId), workflow);
  }

  async readWorkflow(workflowId) {
    try { return JSON.parse(await readFile(this.workflowPath(workflowId), "utf8")); }
    catch (error) { if (error?.code === "ENOENT") return null; throw error; }
  }

  async writeWorkflow(workflow) { await writeJsonAtomic(this.workflowPath(workflow.workflowId), workflow); }
  async appendEvent(workflowId, event) { await appendFile(this.eventsPath(workflowId), `${JSON.stringify(event)}\n`, "utf8"); }

  async readEvents(workflowId) {
    let text;
    try { text = await readFile(this.eventsPath(workflowId), "utf8"); }
    catch (error) { if (error?.code === "ENOENT") return null; throw error; }
    return text.split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line));
  }

  async maxEventSequence(workflowId) {
    const events = await this.readEvents(workflowId);
    if (!events?.length) return 0;
    return Math.max(...events.map((event) => Number(event.sequence) || 0));
  }

  async readEventIndex(workflowId) {
    try { return JSON.parse(await readFile(this.eventIndexPath(workflowId), "utf8")); }
    catch (error) { if (error?.code === "ENOENT") return null; throw error; }
  }

  async writeEventIndex(workflowId, eventIndex) {
    assertWorkflowId(workflowId);
    await writeJsonAtomic(this.eventIndexPath(workflowId), eventIndex);
  }

  async listWorkflows() {
    let entries;
    try { entries = await readdir(this.workflowsRoot, { withFileTypes: true }); }
    catch (error) { if (error?.code === "ENOENT") return []; throw error; }
    const workflows = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !WORKFLOW_ID_PATTERN.test(entry.name)) continue;
      const workflow = await this.readWorkflow(entry.name);
      if (workflow) workflows.push(workflow);
    }
    workflows.sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
    return workflows;
  }
}
