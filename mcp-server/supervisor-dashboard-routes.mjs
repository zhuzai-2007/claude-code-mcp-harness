import express from "express";
import { buildSupervisorProductView } from "./supervisor-product-view.mjs";

const taskIdPattern = /^task_[a-zA-Z0-9_-]+$/;
const workflowIdPattern = /^workflow_[a-zA-Z0-9_-]+$/;
const attemptIdPattern = /^\d{8}-\d{6}-\d{3}$/;
const decisionIdPattern = /^decision_[a-zA-Z0-9_-]+$/;
const taskStatuses = new Set(["queued", "running", "waiting_approval", "succeeded", "failed", "cancelled", "interrupted"]);
const workflowStatuses = new Set(["created", "planning", "planned", "waiting_approval", "running", "reviewing", "completed", "failed", "queued", "succeeded"]);

function boundedInteger(value, fallback, maximum) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > maximum) return null;
  return parsed;
}

function noStore(res) { res.set("Cache-Control", "no-store"); }
function route(handler) {
  return async (req, res) => {
    try { await handler(req, res); }
    catch (error) { if (!res.headersSent) res.status(500).json({ status: "server_error", error: String(error?.message || error) }); }
  };
}

function textField(value, { name, min = 1, max }) {
  const text = String(value || "").trim();
  if (text.length < min || text.length > max) throw new Error(`${name} must contain ${min}-${max} characters.`);
  return text;
}

function isLocalConsoleOrigin(req) {
  const originHeader = req.get("origin");
  if (!originHeader) return false;
  try {
    const origin = new URL(originHeader);
    return ["127.0.0.1", "localhost", "::1", "[::1]"].includes(origin.hostname) && ["http:", "https:"].includes(origin.protocol);
  } catch { return false; }
}

export function registerSupervisorDashboardRoutes(app, { taskRuntime, workflowRuntime, supervisorService, taskRunner, dashboardRoot }) {
  const inspectTask = async (task) => {
    const attempts = (task.attempts || []).map((attempt) => {
      const inspection = taskRunner?.inspectAttempt?.(attempt.attemptId) || { audit: null, recentToolCalls: [], observedChanges: [], artifactFiles: [] };
      const artifactLinks = Object.fromEntries((inspection.artifactFiles || []).map((name) => [name, `/api/supervisor/tasks/${encodeURIComponent(task.taskId)}/artifacts/${encodeURIComponent(attempt.attemptId)}/${encodeURIComponent(name)}`]));
      return { ...attempt, audit: inspection.audit, recentToolCalls: inspection.recentToolCalls, observedChanges: inspection.observedChanges || [], artifactLinks };
    });
    return { ...task, attempts };
  };

  const inspectWorkflow = async (workflow) => {
    const tasks = [];
    for (const ref of workflow.tasks || []) {
      const task = await taskRuntime.getTask(ref.taskId);
      tasks.push(task ? { ...ref, ...(await inspectTask(task)) } : ref);
    }
    return { ...workflow, tasks, product: buildSupervisorProductView(workflow, tasks) };
  };

  const parseJsonBody = express.json({ limit: "32kb", strict: true });
  app.use("/api/supervisor", (req, res, next) => {
    // createMcpExpressApp already parses JSON. Standalone route tests and
    // embedders may not, so parse only when an upstream parser has not done so.
    if (req.body !== undefined) return next();
    return parseJsonBody(req, res, next);
  });
  app.use("/api/supervisor", (req, res, next) => {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method) || isLocalConsoleOrigin(req)) return next();
    res.status(403).json({ status: "local_console_required", error: "State-changing Supervisor actions require a local Console Origin." });
  });

  app.get("/api/supervisor/workflows", route(async (req, res) => {
    noStore(res);
    const status = req.query.status ? String(req.query.status) : null;
    const limit = boundedInteger(req.query.limit, 50, 200);
    if ((status && !workflowStatuses.has(status)) || limit === null || limit < 1) return res.status(400).json({ status: "invalid_input", error: "Invalid workflow status or limit." });
    const workflows = await workflowRuntime.listWorkflows({ status, limit });
    const productWorkflows = [];
    for (const workflow of workflows) productWorkflows.push(await inspectWorkflow(workflow));
    res.json({ status: "success", workflows: productWorkflows });
  }));

  app.get("/api/supervisor/projects", route(async (_req, res) => {
    noStore(res);
    res.json({ status: "success", projects: await supervisorService.listProjects() });
  }));

  app.get("/api/supervisor/decisions/:decisionId", route(async (req, res) => {
    noStore(res);
    const { decisionId } = req.params;
    if (!decisionIdPattern.test(decisionId)) return res.status(400).json({ status: "invalid_input", error: "Invalid Supervisor Decision id." });
    const decision = await supervisorService.getDecision(decisionId);
    if (!decision) return res.status(404).json({ status: "decision_not_found", decisionId });
    res.json({ status: "success", decision });
  }));

  app.post("/api/supervisor/workflows", route(async (req, res) => {
    noStore(res);
    let userRequest;
    try { userRequest = textField(req.body?.userRequest, { name: "userRequest", max: 5000 }); }
    catch (error) { return res.status(400).json({ status: "invalid_input", error: error.message }); }
    let outcome;
    try {
      outcome = await supervisorService.submitRequest({
        userRequest,
        projectId: req.body?.projectId || null,
        decisionId: req.body?.decisionId || null
      });
    } catch (error) {
      return res.status(400).json({ status: "invalid_input", error: error.message });
    }
    if (outcome.status === "project_confirmation_required") return res.status(409).json(outcome);
    if (!outcome.workflow) return res.json(outcome);
    res.status(201).json({ status: "success", decision: outcome.decision, workflow: await inspectWorkflow(outcome.workflow) });
  }));

  app.get("/api/supervisor/workflows/:workflowId", route(async (req, res) => {
    noStore(res);
    const { workflowId } = req.params;
    if (!workflowIdPattern.test(workflowId)) return res.status(400).json({ status: "invalid_input", error: "Invalid workflow id." });
    const workflow = await workflowRuntime.getWorkflow(workflowId);
    if (!workflow) return res.status(404).json({ status: "workflow_not_found", workflowId });
    res.json({ status: "success", workflow: await inspectWorkflow(workflow) });
  }));

  app.post("/api/supervisor/workflows/:workflowId/approve", route(async (req, res) => {
    noStore(res);
    const { workflowId } = req.params;
    if (!workflowIdPattern.test(workflowId)) return res.status(400).json({ status: "invalid_input", error: "Invalid workflow id." });
    let approvedBy, approvalReason;
    try {
      approvedBy = textField(req.body?.approvedBy, { name: "approvedBy", max: 100 });
      approvalReason = textField(req.body?.approvalReason, { name: "approvalReason", max: 1000 });
    } catch (error) { return res.status(400).json({ status: "invalid_input", error: error.message }); }
    try {
      const workflow = await workflowRuntime.approveWorkflow(workflowId, { approvedBy, approvalReason });
      res.json({ status: "success", workflow: await inspectWorkflow(workflow) });
    } catch (error) {
      const missing = await workflowRuntime.getWorkflow(workflowId) == null;
      res.status(missing ? 404 : 409).json({ status: missing ? "workflow_not_found" : "approval_conflict", error: error.message });
    }
  }));

  app.post("/api/supervisor/workflows/:workflowId/reject", route(async (req, res) => {
    noStore(res);
    const { workflowId } = req.params;
    if (!workflowIdPattern.test(workflowId)) return res.status(400).json({ status: "invalid_input", error: "Invalid workflow id." });
    let rejectedBy, rejectionReason;
    try {
      rejectedBy = textField(req.body?.rejectedBy, { name: "rejectedBy", max: 100 });
      rejectionReason = textField(req.body?.rejectionReason, { name: "rejectionReason", max: 1000 });
    } catch (error) { return res.status(400).json({ status: "invalid_input", error: error.message }); }
    try {
      const workflow = await workflowRuntime.rejectWorkflow(workflowId, { rejectedBy, rejectionReason });
      res.json({ status: "success", workflow: await inspectWorkflow(workflow) });
    } catch (error) {
      const missing = await workflowRuntime.getWorkflow(workflowId) == null;
      res.status(missing ? 404 : 409).json({ status: missing ? "workflow_not_found" : "rejection_conflict", error: error.message });
    }
  }));

  app.get("/api/supervisor/workflows/:workflowId/events", route(async (req, res) => {
    noStore(res);
    const { workflowId } = req.params;
    const afterSequence = boundedInteger(req.query.afterSequence, 0, Number.MAX_SAFE_INTEGER);
    const limit = boundedInteger(req.query.limit, 500, 1000);
    if (!workflowIdPattern.test(workflowId) || afterSequence === null || limit === null || limit < 1) return res.status(400).json({ status: "invalid_input", error: "Invalid workflow event query." });
    const result = await workflowRuntime.getWorkflowEvents(workflowId, { afterSequence, limit });
    if (!result) return res.status(404).json({ status: "workflow_not_found", workflowId });
    res.json({ status: "success", ...result });
  }));

  app.get("/api/supervisor/tasks", route(async (req, res) => {
    noStore(res);
    const status = req.query.status ? String(req.query.status) : null;
    const limit = boundedInteger(req.query.limit, 50, 200);
    if ((status && !taskStatuses.has(status)) || limit === null || limit < 1) return res.status(400).json({ status: "invalid_input", error: "Invalid task status or limit." });
    res.json({ status: "success", tasks: await taskRuntime.listTasks({ status, limit }) });
  }));

  app.get("/api/supervisor/tasks/:taskId", route(async (req, res) => {
    noStore(res);
    const { taskId } = req.params;
    if (!taskIdPattern.test(taskId)) return res.status(400).json({ status: "invalid_input", error: "Invalid task id." });
    const task = await taskRuntime.getTask(taskId);
    if (!task) return res.status(404).json({ status: "task_not_found", taskId });
    res.json({ status: "success", task: await inspectTask(task) });
  }));

  app.get("/api/supervisor/tasks/:taskId/events", route(async (req, res) => {
    noStore(res);
    const { taskId } = req.params;
    const afterSequence = boundedInteger(req.query.afterSequence, 0, Number.MAX_SAFE_INTEGER);
    const limit = boundedInteger(req.query.limit, 200, 500);
    if (!taskIdPattern.test(taskId) || afterSequence === null || limit === null || limit < 1) return res.status(400).json({ status: "invalid_input", error: "Invalid event query." });
    const result = await taskRuntime.getTaskEvents(taskId, { afterSequence, limit });
    if (!result) return res.status(404).json({ status: "task_not_found", taskId });
    res.json({ status: "success", ...result });
  }));

  app.get("/api/supervisor/tasks/:taskId/artifacts/:attemptId/:fileName", route(async (req, res) => {
    noStore(res);
    const { taskId, attemptId, fileName } = req.params;
    if (!taskIdPattern.test(taskId) || !attemptIdPattern.test(attemptId)) return res.status(400).json({ status: "invalid_input", error: "Invalid artifact request." });
    const task = await taskRuntime.getTask(taskId);
    if (!task) return res.status(404).json({ status: "task_not_found", taskId });
    if (!(task.attempts || []).some((attempt) => attempt.attemptId === attemptId)) return res.status(404).json({ status: "attempt_not_found", attemptId });
    const artifactPath = taskRunner?.artifactPath?.(attemptId, fileName);
    if (!artifactPath) return res.status(404).json({ status: "artifact_not_found", fileName });
    res.sendFile(artifactPath);
  }));

  app.use("/supervisor", express.static(dashboardRoot, { index: "index.html", fallthrough: false }));
}
