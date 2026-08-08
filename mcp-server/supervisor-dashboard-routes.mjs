import express from "express";
import { buildSupervisorProductView } from "./supervisor-product-view.mjs";

const taskIdPattern = /^task_[a-zA-Z0-9_-]+$/;
const workflowIdPattern = /^workflow_[a-zA-Z0-9_-]+$/;
const folderIdPattern = /^(?:default|folder_[a-zA-Z0-9_-]+)$/;
const attemptIdPattern = /^\d{8}-\d{6}-\d{3}$/;
const decisionIdPattern = /^decision_[a-zA-Z0-9_-]+$/;
const projectIdPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const taskStatuses = new Set(["queued", "running", "waiting_approval", "succeeded", "failed", "cancelled", "interrupted"]);
const workflowStatuses = new Set(["created", "planning", "planned", "waiting_approval", "running", "reviewing", "completed", "failed", "queued", "succeeded"]);
const terminalWorkflowStatuses = new Set(["completed", "succeeded", "failed"]);

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

export function registerSupervisorDashboardRoutes(app, { taskRuntime, workflowRuntime, supervisorService, supervisorSettings, providerPreflight, taskRunner, workflowMetadataStore, dashboardRoot }) {
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
    const metadata = workflowMetadataStore ? await workflowMetadataStore.read(workflow.workflowId) : { schemaVersion: 1, workflowId: workflow.workflowId, displayName: null, archived: false, updatedAt: null };
    return { ...workflow, metadata, tasks, product: buildSupervisorProductView(workflow, tasks) };
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

  app.get("/api/supervisor/settings", route(async (_req, res) => {
    noStore(res);
    if (!supervisorSettings) return res.status(503).json({ status: "settings_unavailable", error: "Supervisor settings are unavailable." });
    res.json({ status: "success", settings: await supervisorSettings.getSettings() });
  }));

  app.put("/api/supervisor/settings/resources", route(async (req, res) => {
    noStore(res);
    if (!supervisorSettings) return res.status(503).json({ status: "settings_unavailable", error: "Supervisor settings are unavailable." });
    try {
      res.json({ status: "success", settings: await supervisorSettings.updateResources(req.body) });
    } catch (error) {
      if (error?.name === "SupervisorSettingsValidationError") {
        return res.status(400).json({ status: "invalid_input", error: error.message });
      }
      throw error;
    }
  }));

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

  app.get("/api/supervisor/folders", route(async (_req, res) => {
    noStore(res);
    if (!workflowMetadataStore) return res.status(503).json({ status: "metadata_unavailable", error: "Workflow metadata storage is unavailable." });
    res.json({ status: "success", folders: await workflowMetadataStore.listFolders() });
  }));

  app.post("/api/supervisor/folders", route(async (req, res) => {
    noStore(res);
    if (!workflowMetadataStore) return res.status(503).json({ status: "metadata_unavailable", error: "Workflow metadata storage is unavailable." });
    let name;
    try { name = textField(req.body?.name, { name: "name", max: 60 }); }
    catch (error) { return res.status(400).json({ status: "invalid_input", error: error.message }); }
    res.status(201).json({ status: "success", folder: await workflowMetadataStore.createFolder(name) });
  }));

  app.patch("/api/supervisor/folders/:folderId", route(async (req, res) => {
    noStore(res);
    const { folderId } = req.params;
    if (!folderIdPattern.test(folderId) || folderId === "default") return res.status(400).json({ status: "invalid_input", error: "The default folder cannot be changed." });
    if (!workflowMetadataStore) return res.status(503).json({ status: "metadata_unavailable", error: "Workflow metadata storage is unavailable." });
    const body = req.body || {};
    if (!Object.hasOwn(body, "name") && !Object.hasOwn(body, "pinned")) return res.status(400).json({ status: "invalid_input", error: "Provide name or pinned." });
    const patch = {};
    if (Object.hasOwn(body, "name")) {
      try { patch.name = textField(body.name, { name: "name", max: 60 }); }
      catch (error) { return res.status(400).json({ status: "invalid_input", error: error.message }); }
    }
    if (Object.hasOwn(body, "pinned")) {
      if (typeof body.pinned !== "boolean") return res.status(400).json({ status: "invalid_input", error: "pinned must be a boolean." });
      patch.pinned = body.pinned;
    }
    try { res.json({ status: "success", folder: await workflowMetadataStore.updateFolder(folderId, patch) }); }
    catch (error) { res.status(404).json({ status: "folder_not_found", error: error.message }); }
  }));

  app.delete("/api/supervisor/folders/:folderId", route(async (req, res) => {
    noStore(res);
    const { folderId } = req.params;
    if (!folderIdPattern.test(folderId) || folderId === "default") return res.status(400).json({ status: "invalid_input", error: "The default folder cannot be deleted." });
    if (!workflowMetadataStore) return res.status(503).json({ status: "metadata_unavailable", error: "Workflow metadata storage is unavailable." });
    try { res.json({ status: "success", result: await workflowMetadataStore.deleteFolder(folderId) }); }
    catch (error) { res.status(404).json({ status: "folder_not_found", error: error.message }); }
  }));

  app.get("/api/supervisor/projects", route(async (req, res) => {
    noStore(res);
    const compact = req.query.compact === "1";
    const projects = compact || !supervisorService.listProjectViews ? await supervisorService.listProjects() : await supervisorService.listProjectViews();
    res.json({ status: "success", projects });
  }));

  app.post("/api/supervisor/projects", route(async (req, res) => {
    noStore(res);
    const unsupported = Object.keys(req.body || {}).filter((key) => key !== "name");
    if (unsupported.length) return res.status(400).json({ status: "invalid_input", error: `Unsupported Project field(s): ${unsupported.join(", ")}. Paths are assigned under the managed workspace root.` });
    let name;
    try { name = textField(req.body?.name, { name: "name", max: 80 }); }
    catch (error) { return res.status(400).json({ status: "invalid_input", error: error.message }); }
    try { res.status(201).json({ status: "success", project: await supervisorService.createProject({ name }) }); }
    catch (error) { res.status(409).json({ status: "project_conflict", error: error.message }); }
  }));

  app.patch("/api/supervisor/projects/:projectId", route(async (req, res) => {
    noStore(res);
    const { projectId } = req.params;
    if (!projectIdPattern.test(projectId)) return res.status(400).json({ status: "invalid_input", error: "Invalid projectId." });
    const body = req.body || {};
    const unsupported = Object.keys(body).filter((key) => !["name", "pinned", "archived"].includes(key));
    if (unsupported.length) return res.status(400).json({ status: "invalid_input", error: `Unsupported Project field(s): ${unsupported.join(", ")}. Project paths cannot be changed directly.` });
    if (!Object.hasOwn(body, "name") && !Object.hasOwn(body, "pinned") && !Object.hasOwn(body, "archived")) return res.status(400).json({ status: "invalid_input", error: "Provide name, pinned, or archived." });
    const patch = {};
    if (Object.hasOwn(body, "name")) {
      try { patch.name = textField(body.name, { name: "name", max: 80 }); }
      catch (error) { return res.status(400).json({ status: "invalid_input", error: error.message }); }
    }
    for (const field of ["pinned", "archived"]) {
      if (!Object.hasOwn(body, field)) continue;
      if (typeof body[field] !== "boolean") return res.status(400).json({ status: "invalid_input", error: `${field} must be a boolean.` });
      patch[field] = body[field];
    }
    try { res.json({ status: "success", project: await supervisorService.updateProject(projectId, patch) }); }
    catch (error) { res.status(/Unknown registered project/i.test(error.message) ? 404 : 409).json({ status: "project_conflict", error: error.message }); }
  }));

  app.get("/api/supervisor/projects/:projectId", route(async (req, res) => {
    noStore(res);
    if (!projectIdPattern.test(req.params.projectId)) return res.status(400).json({ status: "invalid_input", error: "Invalid projectId." });
    try { res.json({ status: "success", context: await supervisorService.getProjectContext(req.params.projectId) }); }
    catch (error) { res.status(404).json({ status: "project_not_found", error: error.message }); }
  }));

  app.get("/api/supervisor/projects/:projectId/continuity", route(async (req, res) => {
    noStore(res);
    if (!projectIdPattern.test(req.params.projectId)) return res.status(400).json({ status: "invalid_input", error: "Invalid projectId." });
    try { res.json({ status: "success", context: await supervisorService.getProjectContinuity(req.params.projectId) }); }
    catch (error) { res.status(404).json({ status: "project_not_found", error: error.message }); }
  }));

  app.get("/api/supervisor/provider-preflight", route(async (_req, res) => {
    noStore(res);
    res.json({ status: "success", latest: await providerPreflight.getLatest() });
  }));

  app.post("/api/supervisor/provider-preflight", route(async (req, res) => {
    noStore(res);
    const timeoutSeconds = boundedInteger(req.body?.timeoutSeconds, 60, 300);
    if (timeoutSeconds === null || timeoutSeconds < 10) return res.status(400).json({ status: "invalid_input", error: "timeoutSeconds must be between 10 and 300." });
    const result = await providerPreflight.run({ timeoutSeconds });
    res.status(result.status === "ok" ? 200 : 503).json({ status: result.status === "ok" ? "success" : "preflight_failed", result });
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
    const projectId = String(req.body?.projectId || "").trim();
    if (!projectIdPattern.test(projectId)) return res.status(400).json({ status: "invalid_input", error: "projectId must identify a registered active Project." });
    let outcome;
    try {
      outcome = await supervisorService.submitRequest({
        userRequest,
        projectId,
        decisionId: req.body?.decisionId || null,
        clarificationDecisionId: req.body?.clarificationDecisionId || null,
        clarificationResponse: req.body?.clarificationResponse || null,
        sessionId: req.body?.sessionId || null,
        sessionName: req.body?.sessionName || null,
        supervisorSession: req.body?.supervisorSession || null
      });
    } catch (error) {
      return res.status(400).json({ status: "invalid_input", error: error.message });
    }
    if (outcome.status === "project_confirmation_required") return res.status(409).json(outcome);
    if (outcome.status === "clarification_required") return res.status(409).json(outcome);
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

  app.get("/api/supervisor/workflows/:workflowId/review-package", route(async (req, res) => {
    noStore(res);
    const { workflowId } = req.params;
    if (!workflowIdPattern.test(workflowId)) return res.status(400).json({ status: "invalid_input", error: "Invalid workflow id." });
    const reviewPackage = await supervisorService.getWorkflowReviewPackage(workflowId);
    if (!reviewPackage) return res.status(404).json({ status: "workflow_not_found", workflowId });
    res.json({ status: "success", reviewPackage });
  }));

  app.get("/api/supervisor/workflows/:workflowId/artifacts", route(async (req, res) => {
    noStore(res);
    const { workflowId } = req.params;
    if (!workflowIdPattern.test(workflowId)) return res.status(400).json({ status: "invalid_input", error: "Invalid workflow id." });
    const artifacts = await supervisorService.getWorkflowArtifactCenter(workflowId);
    if (!artifacts) return res.status(404).json({ status: "workflow_not_found", workflowId });
    res.json({ status: "success", artifacts });
  }));

  app.get("/api/supervisor/workflows/:workflowId/project-intelligence", route(async (req, res) => {
    noStore(res);
    const { workflowId } = req.params;
    if (!workflowIdPattern.test(workflowId)) return res.status(400).json({ status: "invalid_input", error: "Invalid workflow id." });
    const intelligence = await supervisorService.getWorkflowProjectIntelligence(workflowId);
    if (!intelligence) return res.status(404).json({ status: "workflow_not_found", workflowId });
    res.json({ status: "success", intelligence });
  }));

  app.post("/api/supervisor/workflows/:workflowId/memory-proposal/apply", route(async (req, res) => {
    noStore(res);
    const { workflowId } = req.params;
    if (!workflowIdPattern.test(workflowId)) return res.status(400).json({ status: "invalid_input", error: "Invalid workflow id." });
    let proposalId, appliedBy, confirmationReason;
    try {
      proposalId = textField(req.body?.proposalId, { name: "proposalId", max: 200 });
      appliedBy = textField(req.body?.appliedBy, { name: "appliedBy", max: 100 });
      confirmationReason = textField(req.body?.confirmationReason, { name: "confirmationReason", max: 1000 });
      if (req.body?.confirmed !== true) throw new Error("confirmed must be true after explicit human confirmation.");
    } catch (error) { return res.status(400).json({ status: "invalid_input", error: error.message }); }
    try {
      res.json({ status: "success", ...(await supervisorService.applyMemoryProposal({ workflowId, proposalId, appliedBy, confirmationReason, confirmed: true })) });
    } catch (error) {
      res.status(/not found/i.test(error.message) ? 404 : 409).json({ status: "memory_apply_conflict", error: error.message });
    }
  }));

  app.patch("/api/supervisor/workflows/:workflowId/metadata", route(async (req, res) => {
    noStore(res);
    const { workflowId } = req.params;
    if (!workflowIdPattern.test(workflowId)) return res.status(400).json({ status: "invalid_input", error: "Invalid workflow id." });
    const workflow = await workflowRuntime.getWorkflow(workflowId);
    if (!workflow) return res.status(404).json({ status: "workflow_not_found", workflowId });
    if (!workflowMetadataStore) return res.status(503).json({ status: "metadata_unavailable", error: "Workflow metadata storage is unavailable." });
    const body = req.body || {};
    if (!Object.hasOwn(body, "displayName") && !Object.hasOwn(body, "archived") && !Object.hasOwn(body, "folderId")) return res.status(400).json({ status: "invalid_input", error: "Provide displayName, archived, or folderId." });
    const patch = {};
    if (Object.hasOwn(body, "displayName")) {
      if (body.displayName === null || String(body.displayName).trim() === "") patch.displayName = null;
      else {
        const displayName = String(body.displayName).trim();
        if (displayName.length > 120) return res.status(400).json({ status: "invalid_input", error: "displayName must contain at most 120 characters." });
        patch.displayName = displayName;
      }
    }
    if (Object.hasOwn(body, "archived")) {
      if (typeof body.archived !== "boolean") return res.status(400).json({ status: "invalid_input", error: "archived must be a boolean." });
      if (body.archived && !terminalWorkflowStatuses.has(workflow.status)) return res.status(409).json({ status: "archive_conflict", error: "Only completed, succeeded, or failed Workflows can be archived." });
      patch.archived = body.archived;
    }
    if (Object.hasOwn(body, "folderId")) {
      if (!folderIdPattern.test(String(body.folderId || ""))) return res.status(400).json({ status: "invalid_input", error: "Invalid folderId." });
      patch.folderId = String(body.folderId);
    }
    try { res.json({ status: "success", metadata: await workflowMetadataStore.update(workflowId, patch) }); }
    catch (error) { res.status(400).json({ status: "invalid_input", error: error.message }); }
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

  app.post("/api/supervisor/workflows/:workflowId/retry", route(async (req, res) => {
    noStore(res);
    const { workflowId } = req.params;
    if (!workflowIdPattern.test(workflowId)) return res.status(400).json({ status: "invalid_input", error: "Invalid workflow id." });
    let requestedBy, recoveryReason;
    try {
      requestedBy = textField(req.body?.requestedBy, { name: "requestedBy", max: 100 });
      recoveryReason = textField(req.body?.recoveryReason, { name: "recoveryReason", max: 1000 });
    } catch (error) { return res.status(400).json({ status: "invalid_input", error: error.message }); }
    try {
      const recovered = await workflowRuntime.retryWorkflow(workflowId, { requestedBy, recoveryReason });
      res.status(201).json({ status: "success", sourceWorkflow: await inspectWorkflow(recovered.sourceWorkflow), workflow: await inspectWorkflow(recovered.workflow) });
    } catch (error) {
      const missing = await workflowRuntime.getWorkflow(workflowId) == null;
      res.status(missing ? 404 : 409).json({ status: missing ? "workflow_not_found" : "recovery_conflict", error: error.message });
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
