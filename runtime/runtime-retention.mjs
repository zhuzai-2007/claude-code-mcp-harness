import { readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";

const ACTIVE_WORKFLOWS = new Set(["created", "planning", "planned", "waiting_approval", "running", "reviewing", "queued"]);
const ACTIVE_TASKS = new Set(["queued", "running", "waiting_approval"]);

async function readJson(filePath) {
  try { return JSON.parse((await readFile(filePath, "utf8")).replace(/^\uFEFF/, "")); }
  catch (error) { if (error?.code === "ENOENT") return null; throw error; }
}

async function readDirectories(root, fileName) {
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); }
  catch (error) { if (error?.code === "ENOENT") return []; throw error; }
  const values = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const value = await readJson(path.join(root, entry.name, fileName));
    if (value) values.push(value);
  }
  return values;
}

async function readJsonFiles(root) {
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); }
  catch (error) { if (error?.code === "ENOENT") return []; throw error; }
  const values = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const value = await readJson(path.join(root, entry.name));
    if (value) values.push(value);
  }
  return values;
}

function timestamp(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function selectExpired(values, { active, maximum, cutoff }) {
  const terminal = values.filter((value) => !active.has(value.status)).sort((left, right) => timestamp(right.updatedAt || right.createdAt) - timestamp(left.updatedAt || left.createdAt));
  return terminal.filter((value, index) => index >= maximum || timestamp(value.updatedAt || value.createdAt) < cutoff);
}

export async function planRuntimeRetention({ dataRoot, artifactRoots = [], maxAgeDays = 30, maxWorkflows = 200, maxStandaloneTasks = 200, maxDecisions = 500, now = Date.now() }) {
  const root = path.resolve(dataRoot);
  const days = Math.max(1, Number(maxAgeDays) || 30);
  const workflowMaximum = Math.max(1, Number(maxWorkflows) || 200);
  const taskMaximum = Math.max(1, Number(maxStandaloneTasks) || 200);
  const decisionMaximum = Math.max(1, Number(maxDecisions) || 500);
  const cutoff = now - days * 86400000;
  const workflows = await readDirectories(path.join(root, "workflows"), "workflow.json");
  const tasks = await readDirectories(path.join(root, "tasks"), "task.json");
  const decisions = await readJsonFiles(path.join(root, "supervisor-decisions"));
  const expiredWorkflows = selectExpired(workflows, { active: ACTIVE_WORKFLOWS, maximum: workflowMaximum, cutoff });
  const expiredWorkflowIds = new Set(expiredWorkflows.map((workflow) => workflow.workflowId));
  const keptWorkflowTaskIds = new Set(workflows.filter((workflow) => !expiredWorkflowIds.has(workflow.workflowId)).flatMap((workflow) => workflow.tasks || []).map((task) => task.taskId));
  const workflowTaskIds = new Set(expiredWorkflows.flatMap((workflow) => workflow.tasks || []).map((task) => task.taskId));
  const standaloneCandidates = tasks.filter((task) => !task.workflowId && !keptWorkflowTaskIds.has(task.taskId));
  const expiredStandalone = selectExpired(standaloneCandidates, { active: ACTIVE_TASKS, maximum: taskMaximum, cutoff });
  const expiredTaskIds = new Set([...workflowTaskIds, ...expiredStandalone.map((task) => task.taskId)]);
  const expiredTasks = tasks.filter((task) => expiredTaskIds.has(task.taskId) && !ACTIVE_TASKS.has(task.status));
  const unlinkedDecisions = decisions.filter((decision) => !decision.workflowId).sort((left, right) => timestamp(right.updatedAt || right.createdAt) - timestamp(left.updatedAt || left.createdAt));
  const expiredDecisionIds = new Set([
    ...decisions.filter((decision) => decision.workflowId && expiredWorkflowIds.has(decision.workflowId)).map((decision) => decision.decisionId),
    ...unlinkedDecisions.filter((decision, index) => index >= decisionMaximum || timestamp(decision.updatedAt || decision.createdAt) < cutoff).map((decision) => decision.decisionId)
  ]);
  const directories = [
    ...expiredWorkflows.map((workflow) => path.join(root, "workflows", workflow.workflowId)),
    ...expiredTasks.map((task) => path.join(root, "tasks", task.taskId)),
    ...expiredTasks.flatMap((task) => (task.attempts || []).flatMap((attempt) => artifactRoots.map((artifactRoot) => path.join(path.resolve(artifactRoot), attempt.attemptId)))),
    ...[...expiredDecisionIds].map((decisionId) => path.join(root, "supervisor-decisions", `${decisionId}.json`))
  ];
  return {
    schemaVersion: 1,
    generatedAt: new Date(now).toISOString(),
    policy: { maxAgeDays: days, maxWorkflows: workflowMaximum, maxStandaloneTasks: taskMaximum, maxDecisions: decisionMaximum },
    expiredWorkflowIds: [...expiredWorkflowIds],
    expiredTaskIds: expiredTasks.map((task) => task.taskId),
    expiredDecisionIds: [...expiredDecisionIds],
    directories: [...new Set(directories)]
  };
}

export async function applyRuntimeRetention(plan) {
  for (const directory of plan.directories || []) await rm(directory, { recursive: true, force: true });
  return { ...plan, applied: true, removedPathCount: (plan.directories || []).length, removedDirectoryCount: (plan.directories || []).length };
}
