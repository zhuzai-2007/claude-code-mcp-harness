import { refreshDelay } from "./refresh-policy.mjs";

const $ = (id) => document.getElementById(id);
const ACTIVE = new Set(["created", "queued", "planning", "planned", "waiting_approval", "running", "reviewing"]);
const STATUS_LABELS = {
  created: "Created", queued: "Queued", planning: "Planning", planned: "Plan ready", waiting_approval: "Needs approval",
  running: "Implementing", reviewing: "Reviewing", completed: "Completed", succeeded: "Completed", failed: "Failed",
  pending: "Pending", cancelled: "Cancelled", interrupted: "Interrupted"
};
let workflows = [];
let selectedWorkflowId = null;
let selectedWorkflow = null;
let timer = null;
let actionPending = false;
let pendingDecision = null;

const escapeHtml = (value) => String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", "'":"&#39;", '"':"&quot;" })[char]);
const statusLabel = (status) => STATUS_LABELS[status] || String(status || "Unknown").replaceAll("_", " ");
const formatTime = (value) => value ? new Intl.DateTimeFormat(undefined, { dateStyle:"medium", timeStyle:"short" }).format(new Date(value)) : "—";
const formatDuration = (seconds) => seconds == null ? "—" : seconds < 60 ? `${Math.round(seconds)} sec` : seconds < 3600 ? `${Math.floor(seconds / 60)} min ${Math.round(seconds % 60)} sec` : `${Math.floor(seconds / 3600)} hr ${Math.round((seconds % 3600) / 60)} min`;
const formatCost = (value) => Number(value) > 0 ? `$${Number(value).toFixed(3)}` : "$0.000";
const badge = (status) => `<span class="status-badge ${escapeHtml(status)}"><span></span>${escapeHtml(statusLabel(status))}</span>`;
const listHtml = (values, empty = "None reported") => Array.isArray(values) && values.length ? `<ul>${values.map((value) => `<li>${escapeHtml(typeof value === "string" ? value : JSON.stringify(value))}</li>`).join("")}</ul>` : `<p class="muted">${escapeHtml(empty)}</p>`;

function resourceEstimateHtml(estimate) {
  if (!estimate) return `<p class="muted">No resource estimate recorded.</p>`;
  const expected = estimate.expected || {};
  const hard = estimate.hard_caps || {};
  return `<div class="resource-forecast">
    <span><strong>${escapeHtml(estimate.complexity || "unknown")}</strong>complexity</span>
    <span><strong>${formatCost(expected.budgetUsd)}</strong>expected cost</span>
    <span><strong>${expected.turns || 0}</strong>expected turns</span>
    <span><strong>${expected.filesRead || 0}</strong>expected reads</span>
    <span><strong>${formatCost(hard.budgetUsd)}</strong>Workflow hard caps</span>
    <span><strong>${hard.timeoutSeconds || 0}s</strong>max stage time total</span>
  </div>${listHtml(estimate.notes, "Resource Profiles remain authoritative.")}`;
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, { cache: "no-store", ...options });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || `${response.status} ${response.statusText}`);
    error.payload = payload;
    error.status = response.status;
    throw error;
  }
  return payload;
}

async function postJson(url, body) {
  return requestJson(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

function setMessage(message, tone = "info") {
  const node = $("action-message");
  node.textContent = message || "";
  node.dataset.tone = tone;
}

function renderOverview() {
  const active = workflows.filter((workflow) => ACTIVE.has(workflow.status)).length;
  const approvals = workflows.filter((workflow) => workflow.status === "waiting_approval").length;
  const completed = workflows.filter((workflow) => ["completed", "succeeded"].includes(workflow.status)).length;
  const failed = workflows.filter((workflow) => workflow.status === "failed").length;
  const cost = workflows.reduce((total, workflow) => total + Number(workflow.product?.totalCostUsd || 0), 0);
  $("overview").innerHTML = `
    <div class="overview-card"><span>Active</span><strong>${active}</strong><small>workflows in progress</small></div>
    <div class="overview-card ${approvals ? "attention" : ""}"><span>Needs approval</span><strong>${approvals}</strong><small>waiting for your decision</small></div>
    <div class="overview-card"><span>Completed</span><strong>${completed}</strong><small>successful workflows</small></div>
    <div class="overview-card ${failed ? "warning" : ""}"><span>Failed</span><strong>${failed}</strong><small>need attention</small></div>
    <div class="overview-card"><span>Observed cost</span><strong>${formatCost(cost)}</strong><small>across recent work</small></div>`;
}

function workflowListItem(workflow) {
  const selected = workflow.workflowId === selectedWorkflowId ? " selected" : "";
  const product = workflow.product || {};
  return `<button class="workflow-item${selected}" data-workflow-id="${escapeHtml(workflow.workflowId)}" type="button">
    <div class="workflow-item-head">${badge(workflow.status)}<time>${formatTime(workflow.updatedAt)}</time></div>
    <strong>${escapeHtml(workflow.userRequest)}</strong>
    <div class="workflow-item-meta"><span>${escapeHtml(statusLabel(workflow.currentStage))}</span><span>${formatDuration(workflow.durationSeconds)}</span><span>${formatCost(product.totalCostUsd)}</span></div>
    ${workflow.status === "waiting_approval" ? `<div class="approval-callout">Your decision is required</div>` : ""}
  </button>`;
}

function renderWorkflowList() {
  $("workflow-count").textContent = String(workflows.length);
  $("workflow-list").innerHTML = workflows.length ? workflows.map(workflowListItem).join("") : `<div class="empty-state">Create your first supervised workflow above.</div>`;
  $("workflow-list").querySelectorAll("[data-workflow-id]").forEach((node) => node.addEventListener("click", () => {
    selectedWorkflowId = node.dataset.workflowId;
    renderSelectedWorkflow().catch(showError);
  }));
}

function renderStageTimeline(workflow) {
  const product = workflow.product || {};
  const decision = product.supervisorDecision;
  const nodes = [{ role: "decision", label: "Decision", status: decision ? "succeeded" : "pending", subtitle: decision ? `${decision.source === "gpt" ? "GPT" : "Local rules"} · ${decision.intent}` : "Awaiting Supervisor" }];
  for (const stage of workflow.stages || []) {
    if (stage.requiresApproval) {
      const approvalStatus = product.approval?.status === "approved" ? "succeeded" : product.approval?.status === "rejected" ? "failed" : product.approval?.status === "waiting" ? "waiting_approval" : "pending";
      nodes.push({ role: "approval", label: "Human approval", status: approvalStatus, subtitle: product.approval?.status === "approved" ? `Approved by ${product.approval.approvedBy}` : product.approval?.status === "rejected" ? `Rejected by ${product.approval.rejectedBy}` : "Explicit decision required" });
    }
    nodes.push({ role: stage.role, label: stage.role === "planner" ? "Plan" : stage.role === "coder" ? "Implement" : stage.role === "reviewer" ? "Review" : stage.role, status: stage.status, subtitle: stage.resourceProfile || "Default resources" });
  }
  const completed = nodes.filter((node) => node.status === "succeeded").length;
  $("stage-progress").textContent = `${completed} of ${nodes.length} complete`;
  $("stage-timeline").innerHTML = nodes.map((node, index) => {
    const icon = node.status === "succeeded" ? "✓" : node.status === "failed" ? "!" : ["running", "queued", "planning", "reviewing", "waiting_approval"].includes(node.status) ? "→" : "○";
    return `<div class="stage-node ${escapeHtml(node.status)}"><div class="stage-line">${index ? "" : ""}</div><span class="stage-icon">${icon}</span><div><strong>${escapeHtml(node.label)}</strong><span>${escapeHtml(statusLabel(node.status))}</span><small>${escapeHtml(node.subtitle)}</small></div></div>`;
  }).join("");
}

function renderDecision(workflow) {
  const decision = workflow.product?.supervisorDecision;
  const panel = $("decision-panel");
  panel.classList.toggle("legacy", !decision);
  $("decision-source").textContent = decision ? `${decision.source === "gpt" ? "GPT-authored" : "Local rule fallback"} · ${Math.round(Number(decision.confidence || 0) * 100)}% confidence` : "Legacy Workflow";
  if (!decision) {
    $("decision-content").innerHTML = `<p class="muted">This legacy Workflow predates the Supervisor Decision contract.</p>`;
    return;
  }
  const project = decision.project || {};
  $("decision-content").innerHTML = `
    <div><span class="label">User intent</span><strong>${escapeHtml(decision.intent)}</strong><p>${escapeHtml(decision.goal)}</p></div>
    <div><span class="label">Worker decision</span><strong>${decision.agentRequired ? "Worker required" : "Respond directly"}</strong><p>Next: ${escapeHtml(decision.nextAction)}</p></div>
    <div class="decision-wide"><span class="label">Technical summary</span><p>${escapeHtml(decision.technicalSummary || "No technical summary recorded.")}</p></div>
    <div><span class="label">Registered project</span><strong>${escapeHtml(project.name || "No project required")}</strong><p><code>${escapeHtml(project.path || "—")}</code></p>${listHtml(project.techStack, "No technology stack recorded")}</div>
    <div><span class="label">Recommended Workflow</span><strong>${escapeHtml(decision.workflowType)}</strong>${listHtml(decision.reasoning, "No concise reasoning recorded")}</div>
    <div><span class="label">Supervisor risks</span>${listHtml(decision.risks, "No Supervisor risks reported")}</div>
    <div><span class="label">Recommended actions</span>${listHtml(decision.recommendedActions, "No recommended actions recorded")}</div>
    <div class="decision-wide"><span class="label">Estimated resources</span>${resourceEstimateHtml(decision.estimatedResources)}</div>`;
}

function renderApproval(workflow) {
  const approval = workflow.product?.approval;
  const panel = $("approval-panel");
  const waiting = workflow.status === "waiting_approval" && approval?.status === "waiting";
  panel.classList.toggle("hidden", !approval?.required);
  if (!approval?.required) return;
  $("approval-form").classList.toggle("hidden", !waiting);
  $("approval-title").textContent = waiting ? "Approval required" : approval.status === "approved" ? "Approved execution" : approval.status === "rejected" ? "Rejected execution" : "Approval checkpoint";
  $("approval-reason").textContent = waiting ? approval.reason : approval.status === "approved" ? `${approval.approvedBy} approved: ${approval.approvalReason}` : approval.status === "rejected" ? `${approval.rejectedBy} rejected: ${approval.rejectionReason}` : approval.reason;
  const diffPreview = approval.changeDetails?.length ? approval.changeDetails.map((change) => `<details class="diff-file"><summary><strong>${escapeHtml(change.file)}</strong><span>${escapeHtml(change.summary)}</span></summary><pre>${escapeHtml(change.diff || "No diff payload available.")}</pre></details>`).join("") : `<p class="muted">Observed Diff appears here after approved execution.</p>`;
  $("approval-preview").innerHTML = `
    <div><span class="label">User request</span><p>${escapeHtml(workflow.userRequest)}</p></div>
    <div><span class="label">Modification reason</span><p>${escapeHtml(approval.modificationReason || workflow.product?.supervisorDecision?.technicalSummary || workflow.userRequest)}</p></div>
    <div><span class="label">Supervisor decision</span><p><strong>${escapeHtml(workflow.product?.supervisorDecision?.intent || "legacy")}</strong> · ${escapeHtml(workflow.product?.supervisorDecision?.project?.name || "Configured project")}</p>${listHtml(workflow.product?.supervisorDecision?.reasoning, "No structured reasoning recorded")}</div>
    <div><span class="label">Workflow</span><strong>${escapeHtml(workflow.workflowPlan?.workflowType || workflow.definitionId || "workflow")}</strong></div>
    <div><span class="label">Proposed scope</span>${listHtml(approval.plannedChanges, "No structured file scope was reported; inspect the planner context before approving.")}</div>
    <div><span class="label">Context inspected</span>${listHtml(approval.contextualFiles)}</div>
    <div><span class="label">Risks</span>${listHtml(approval.risks, "No risks reported by planner")}</div>
    <div><span class="label">Resource profile</span><strong>${escapeHtml(approval.resourceProfile || "default")}</strong><p>${escapeHtml(approval.estimatedImpact)}</p></div>
    <div><span class="label">Estimated cost</span><strong>${approval.estimatedCost ? `${formatCost(approval.estimatedCost.likelyUsd)} likely · ${formatCost(approval.estimatedCost.upperBoundUsd)} hard cap` : "Unavailable"}</strong><p class="muted">Rule-based scope estimate; provider billing may differ.</p></div>`;
  $("approval-preview").insertAdjacentHTML("beforeend", `<div class="approval-wide"><span class="label">Workflow resource estimate</span>${resourceEstimateHtml(approval.workflowResourceEstimate)}</div><div class="approval-wide"><span class="label">Observed Diff</span>${diffPreview}</div>`);
  $("approve-workflow").disabled = actionPending;
  $("reject-workflow").disabled = actionPending;
}

function resultCard(title, eyebrow, content, tone = "") {
  return `<article class="panel result-card ${tone}"><p class="eyebrow">${escapeHtml(eyebrow)}</p><h2>${escapeHtml(title)}</h2>${content}</article>`;
}

function renderResults(workflow) {
  const product = workflow.product || {};
  const planner = product.planner || {};
  const review = product.review || {};
  const resources = product.totalUsage || {};
  const approval = product.approval || {};
  const approvalText = approval.status === "approved" ? `Approved by ${approval.approvedBy} · ${formatTime(approval.approvedAt)}` : approval.status === "rejected" ? `Rejected by ${approval.rejectedBy} · ${approval.rejectionReason}` : approval.required ? statusLabel(approval.status) : "Not required";
  const decision = product.supervisorDecision;
  const changeDetails = product.changeDetails || [];
  const diffContent = changeDetails.length ? changeDetails.map((change) => `<details class="diff-file"><summary><strong>${escapeHtml(change.file)}</strong><span>${escapeHtml(change.summary)}</span></summary><pre>${escapeHtml(change.diff || "No observed Edit/Write payload available.")}</pre></details>`).join("") : `<p class="muted">No observed Write/Edit diff is available.</p>`;
  $("result-grid").innerHTML = [
    resultCard("Supervisor decision", decision ? `${decision.intent} · ${Math.round(Number(decision.confidence || 0) * 100)}% confidence` : "Legacy workflow", decision ? `<p><strong>${escapeHtml(decision.goal)}</strong></p><p>Project: ${escapeHtml(decision.project?.name || "Unspecified")} · <code>${escapeHtml(decision.project?.path || "—")}</code></p>${listHtml(decision.reasoning)}` : `<p>No persisted Supervisor Decision is attached.</p>`),
    resultCard("Workflow plan", workflow.workflowPlan?.workflowType || workflow.definitionId || "Workflow", `<p>${escapeHtml(workflow.workflowPlan?.reason || planner.summary || "Planning in progress")}</p>${listHtml(workflow.workflowPlan?.constraints, "No additional constraints")}`),
    resultCard("Approval", "Safety checkpoint", `<p>${escapeHtml(approvalText)}</p>${approval.approvalReason ? `<blockquote>${escapeHtml(approval.approvalReason)}</blockquote>` : ""}`, approval.status === "rejected" ? "danger" : approval.status === "approved" ? "success" : ""),
    resultCard("Modified files", "Change result", listHtml(product.changedFiles, workflow.status === "completed" ? "Workflow completed without reported file changes" : "No modifications yet")),
    resultCard("Observed diff", "Tool evidence", diffContent),
    resultCard("Review result", "Verification", `<p>${escapeHtml(review.summary || (workflow.status === "reviewing" ? "Review is running" : "Review has not run yet"))}</p>${listHtml(review.checks, "No checks reported yet")}`, workflow.status === "completed" ? "success" : ""),
    resultCard("Resources", "Observed usage", `<div class="resource-stats"><span><strong>${formatCost(product.totalCostUsd)}</strong>cost</span><span><strong>${resources.turns || 0}</strong>turns</span><span><strong>${resources.filesRead || 0}</strong>files</span><span><strong>${resources.commands || 0}</strong>commands</span></div>`),
    resultCard("Risks and errors", "Attention", `<h3>Risks</h3>${listHtml(product.risks, "No risks reported")}<h3>Errors</h3>${listHtml(product.errors, "No errors reported")}`, product.errors?.length ? "danger" : "")
  ].join("");
}

function renderPolicy(workflow) {
  const policy = workflow.product?.executionPolicy || { allowed: [], blocked: [] };
  $("execution-policy").innerHTML = `<div><h3>Allowed</h3>${listHtml(policy.allowed)}</div><div><h3>Blocked</h3>${listHtml(policy.blocked)}</div>`;
}

function renderTechnicalDetails(workflow, events) {
  $("technical-meta").innerHTML = `<div class="technical-meta"><span><strong>Workflow ID</strong>${escapeHtml(workflow.workflowId)}</span><span><strong>Created</strong>${formatTime(workflow.createdAt)}</span><span><strong>Updated</strong>${formatTime(workflow.updatedAt)}</span></div>`;
  $("task-list").innerHTML = (workflow.tasks || []).map((task) => {
    const attempts = task.attempts || [];
    const artifacts = attempts.flatMap((attempt) => Object.entries(attempt.artifactLinks || {}).map(([name, url]) => `<a href="${escapeHtml(url)}" target="_blank" rel="noreferrer">${escapeHtml(name)}</a>`));
    return `<div class="technical-task"><div><strong>${escapeHtml(task.role || task.mode)}</strong>${badge(task.status)}</div><code>${escapeHtml(task.taskId)}</code><span>${escapeHtml(task.resourceProfile || task.settings?.resourceProfile || "default")}</span>${artifacts.length ? `<div class="artifact-links">${artifacts.join("")}</div>` : ""}</div>`;
  }).join("") || `<p class="muted">No runtime tasks yet.</p>`;
  $("event-count").textContent = String(events.length);
  $("event-list").innerHTML = events.length ? events.map((event) => `<li><div><strong>${escapeHtml(event.type)}</strong><time>${formatTime(event.timestamp)}</time></div><small>${escapeHtml(event.role || event.source || "runtime")}</small><code>${escapeHtml(JSON.stringify(event.payload || {}))}</code></li>`).join("") : `<li class="muted">No events yet.</li>`;
}

async function renderSelectedWorkflow() {
  if (!selectedWorkflowId) {
    $("workflow-empty").classList.remove("hidden");
    $("workflow-detail").classList.add("hidden");
    return;
  }
  const [detailPayload, eventPayload] = await Promise.all([
    requestJson(`/api/supervisor/workflows/${encodeURIComponent(selectedWorkflowId)}`),
    requestJson(`/api/supervisor/workflows/${encodeURIComponent(selectedWorkflowId)}/events?limit=500`)
  ]);
  selectedWorkflow = detailPayload.workflow;
  const workflow = selectedWorkflow;
  const product = workflow.product || {};
  $("workflow-empty").classList.add("hidden");
  $("workflow-detail").classList.remove("hidden");
  $("workflow-type").textContent = workflow.workflowPlan?.workflowType || workflow.definitionId || "Workflow";
  $("workflow-request").textContent = workflow.userRequest;
  $("workflow-status").innerHTML = badge(workflow.status);
  $("workflow-summary").innerHTML = `<div><span>Current stage</span><strong>${escapeHtml(statusLabel(workflow.currentStage))}</strong></div><div><span>Elapsed</span><strong>${formatDuration(workflow.durationSeconds)}</strong></div><div><span>Observed cost</span><strong>${formatCost(product.totalCostUsd)}</strong></div><div><span>Updated</span><strong>${formatTime(workflow.updatedAt)}</strong></div>`;
  $("next-action").innerHTML = `<span>Next action</span><strong>${escapeHtml(product.nextAction || "Wait for the runtime.")}</strong>`;
  renderStageTimeline(workflow);
  renderDecision(workflow);
  renderApproval(workflow);
  renderResults(workflow);
  renderPolicy(workflow);
  renderTechnicalDetails(workflow, eventPayload.events || []);
  renderWorkflowList();
}

async function refresh() {
  clearTimeout(timer);
  try {
    const payload = await requestJson("/api/supervisor/workflows?limit=50");
    workflows = payload.workflows || [];
    if (!selectedWorkflowId && workflows.length) selectedWorkflowId = workflows[0].workflowId;
    if (selectedWorkflowId && !workflows.some((workflow) => workflow.workflowId === selectedWorkflowId)) selectedWorkflowId = workflows[0]?.workflowId || null;
    renderOverview();
    renderWorkflowList();
    await renderSelectedWorkflow();
    $("connection").textContent = "Runtime connected";
    $("connection-dot").classList.add("online");
    $("last-updated").textContent = `Updated ${new Date().toLocaleTimeString()}`;
    const active = workflows.some((workflow) => ACTIVE.has(workflow.status));
    timer = setTimeout(refresh, refreshDelay(active));
  } catch (error) {
    showError(error);
    timer = setTimeout(refresh, 4000);
  }
}

function showError(error) {
  $("connection").textContent = "Runtime unavailable";
  $("connection-dot").classList.remove("online");
  $("last-updated").textContent = error.message;
}

$("new-task-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (actionPending) return;
  const userRequest = $("user-request").value.trim();
  if (!userRequest) return;
  actionPending = true;
  $("create-task").disabled = true;
  setMessage("Creating a read-only plan…");
  try {
    const payload = await postJson("/api/supervisor/workflows", { userRequest });
    selectedWorkflowId = payload.workflow.workflowId;
    $("user-request").value = "";
    setMessage("Workflow created. Planning has started.", "success");
    await refresh();
  } catch (error) {
    if (error.payload?.status === "project_confirmation_required") {
      pendingDecision = error.payload.decision;
      $("project-options").innerHTML = pendingDecision.projectResolution.candidates.map((project) => `<option value="${escapeHtml(project.id)}">${escapeHtml(project.name)} — ${escapeHtml(project.path)}</option>`).join("");
      $("project-confirmation").classList.remove("hidden");
      setMessage("Choose the target project before any Worker starts.", "info");
    } else setMessage(error.message, "error");
  }
  finally { actionPending = false; $("create-task").disabled = false; }
});

$("confirm-project").addEventListener("click", async () => {
  if (actionPending || !pendingDecision) return;
  actionPending = true;
  try {
    const payload = await postJson("/api/supervisor/workflows", { userRequest: pendingDecision.originalRequest, decisionId: pendingDecision.decisionId, projectId: $("project-options").value });
    selectedWorkflowId = payload.workflow.workflowId;
    pendingDecision = null;
    $("project-confirmation").classList.add("hidden");
    $("user-request").value = "";
    setMessage("Project confirmed. Read-only planning has started.", "success");
    await refresh();
  } catch (error) { setMessage(error.message, "error"); }
  finally { actionPending = false; }
});

$("cancel-project").addEventListener("click", () => {
  pendingDecision = null;
  $("project-confirmation").classList.add("hidden");
  setMessage("Project confirmation cancelled. No Workflow was created.");
});

$("approval-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (actionPending || !selectedWorkflowId) return;
  const approvedBy = $("reviewer-name").value.trim();
  const approvalReason = $("decision-reason").value.trim();
  if (!approvedBy || !approvalReason) return;
  actionPending = true;
  renderApproval(selectedWorkflow);
  setMessage("Recording approval against the bounded execution…");
  try {
    await postJson(`/api/supervisor/workflows/${encodeURIComponent(selectedWorkflowId)}/approve`, { approvedBy, approvalReason });
    $("decision-reason").value = "";
    setMessage("Approved. The bounded implementation stage is starting.", "success");
    await refresh();
  } catch (error) { setMessage(error.message, "error"); }
  finally { actionPending = false; if (selectedWorkflow) renderApproval(selectedWorkflow); }
});

$("reject-workflow").addEventListener("click", async () => {
  if (actionPending || !selectedWorkflowId) return;
  const rejectedBy = $("reviewer-name").value.trim();
  const rejectionReason = $("decision-reason").value.trim();
  if (!rejectedBy || !rejectionReason) { setMessage("Enter your name and decision reason before rejecting.", "error"); return; }
  if (!window.confirm("Reject this workflow? The implementation stage will not be created.")) return;
  actionPending = true;
  renderApproval(selectedWorkflow);
  try {
    await postJson(`/api/supervisor/workflows/${encodeURIComponent(selectedWorkflowId)}/reject`, { rejectedBy, rejectionReason });
    $("decision-reason").value = "";
    setMessage("Workflow rejected. No implementation task was created.", "success");
    await refresh();
  } catch (error) { setMessage(error.message, "error"); }
  finally { actionPending = false; if (selectedWorkflow) renderApproval(selectedWorkflow); }
});

$("refresh").addEventListener("click", refresh);
refresh();
