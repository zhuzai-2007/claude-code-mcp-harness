import { appendFile, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const TASK_ID_PATTERN = /^task_[a-zA-Z0-9_-]+$/;

function assertTaskId(taskId) {
  if (!TASK_ID_PATTERN.test(String(taskId || ""))) {
    throw new Error(`Invalid taskId: ${taskId}`);
  }
}

async function writeJsonAtomic(filePath, value) {
  const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const json = `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(temporaryPath, json, "utf8");
  let lastError = null;
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

export class FileTaskStore {
  constructor(dataRoot) {
    this.dataRoot = path.resolve(dataRoot);
    this.tasksRoot = path.join(this.dataRoot, "tasks");
  }

  async init() {
    await mkdir(this.tasksRoot, { recursive: true });
  }

  taskDirectory(taskId) {
    assertTaskId(taskId);
    return path.join(this.tasksRoot, taskId);
  }

  taskPath(taskId) {
    return path.join(this.taskDirectory(taskId), "task.json");
  }

  eventsPath(taskId) {
    return path.join(this.taskDirectory(taskId), "events.jsonl");
  }

  attemptsDirectory(taskId) {
    return path.join(this.taskDirectory(taskId), "attempts");
  }

  async createTask(task) {
    const directory = this.taskDirectory(task.taskId);
    await mkdir(directory, { recursive: false });
    await mkdir(this.attemptsDirectory(task.taskId), { recursive: true });
    await writeFile(this.eventsPath(task.taskId), "", { encoding: "utf8", flag: "wx" });
    await writeJsonAtomic(this.taskPath(task.taskId), task);
  }

  async readTask(taskId) {
    try {
      return JSON.parse(await readFile(this.taskPath(taskId), "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  }

  async writeTask(task) {
    await writeJsonAtomic(this.taskPath(task.taskId), task);
  }

  async writeAttempt(taskId, attempt) {
    const attemptPath = path.join(this.attemptsDirectory(taskId), `${attempt.attemptId}.json`);
    await writeJsonAtomic(attemptPath, attempt);
  }

  async appendEvent(taskId, event) {
    await appendFile(this.eventsPath(taskId), `${JSON.stringify(event)}\n`, "utf8");
  }

  async readEvents(taskId, { afterSequence = 0, limit = 200 } = {}) {
    assertTaskId(taskId);
    let text;
    try {
      text = await readFile(this.eventsPath(taskId), "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
    const events = [];
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const event = JSON.parse(line);
      if (Number(event.sequence) <= Number(afterSequence)) continue;
      events.push(event);
      if (events.length >= limit) break;
    }
    return events;
  }

  async maxEventSequence(taskId) {
    const events = await this.readEvents(taskId, { afterSequence: 0, limit: Number.MAX_SAFE_INTEGER });
    if (!events || events.length === 0) return 0;
    return Math.max(...events.map((event) => Number(event.sequence) || 0));
  }

  async listTasks() {
    let entries;
    try {
      entries = await readdir(this.tasksRoot, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
    const tasks = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !TASK_ID_PATTERN.test(entry.name)) continue;
      const task = await this.readTask(entry.name);
      if (task) tasks.push(task);
    }
    tasks.sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
    return tasks;
  }
}
