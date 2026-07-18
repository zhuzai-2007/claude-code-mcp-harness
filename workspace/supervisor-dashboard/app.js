import { refreshDelay } from "./refresh-policy.mjs";
import { detectLanguage, translate } from "./i18n.mjs";
import { defaultStageView, groupWorkflowsByFolder, isStageViewable, sortEventsNewestFirst, stageViewForRole } from "./dashboard-model.mjs";

const $ = (id) => document.getElementById(id);
const ACTIVE = new Set(["created", "queued", "planning", "planned", "waiting_approval", "running", "reviewing"]);
const TERMINAL = new Set(["completed", "succeeded", "failed"]);
let workflows = [];
let folders = [];
let projects = [];
let selectedProjectId = localStorage.getItem("supervisor.selectedProjectId") || null;
let selectedWorkflowId = null;
let selectedWorkflow = null;
let selectedReviewPackage = null;
let selectedProjectIntelligence = null;
let selectedProjectContinuity = null;
let selectedArtifacts = null;
let projectView = "brief";
let selectedStageView = null;
let heroView = "timeline";
let recentCollapsed = localStorage.getItem("supervisor.recentCollapsed") === "true";
let renderedWorkflowId = null;
let timer = null;
let actionPending = false;
let preflightPending = false;
let pendingDecision = null;
let latestPreflight = null;
let language = detectLanguage({ stored: localStorage.getItem("supervisor.language"), languages: navigator.languages });
let openFolderIds = (() => {
  try { return new Set(JSON.parse(localStorage.getItem("supervisor.openFolders") || '["default"]')); }
  catch { return new Set(["default"]); }
})();
// Archived sessions start collapsed on every Dashboard load. Their expansion is
// intentionally session-local so an old browser preference cannot make a
// folder look as if archived work belongs in the active list.
let openArchiveFolderIds = new Set();

const t = (key, parameters) => translate(language, key, parameters);
const escapeHtml = (value) => String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", "'":"&#39;", '"':"&quot;" })[char]);
const statusLabel = (status) => t(`status.${status}`) === `status.${status}` ? String(status || t("common.unknown")).replaceAll("_", " ") : t(`status.${status}`);
const sentenceLabel = (status) => { const label = statusLabel(status); return `${label.charAt(0).toUpperCase()}${label.slice(1)}`; };
const formatTime = (value) => value ? new Intl.DateTimeFormat(language, { dateStyle:"medium", timeStyle:"short" }).format(new Date(value)) : "—";
const formatDuration = (seconds) => seconds == null ? "—" : seconds < 60 ? `${Math.round(seconds)} ${language === "zh-CN" ? "秒" : "sec"}` : seconds < 3600 ? `${Math.floor(seconds / 60)} ${language === "zh-CN" ? "分" : "min"} ${Math.round(seconds % 60)} ${language === "zh-CN" ? "秒" : "sec"}` : `${Math.floor(seconds / 3600)} ${language === "zh-CN" ? "小时" : "hr"} ${Math.round((seconds % 3600) / 60)} ${language === "zh-CN" ? "分" : "min"}`;
const formatCost = (value) => Number(value) > 0 ? `$${Number(value).toFixed(3)}` : "$0.000";
const badge = (status) => `<span class="status-badge ${escapeHtml(status)}"><span></span>${escapeHtml(statusLabel(status))}</span>`;
const listHtml = (values, empty = t("common.none")) => Array.isArray(values) && values.length ? `<ul>${values.map((value) => `<li>${escapeHtml(typeof value === "string" ? value : JSON.stringify(value))}</li>`).join("")}</ul>` : `<p class="muted">${escapeHtml(empty)}</p>`;

function renderStaticTranslations() {
  document.documentElement.lang = language;
  $("language-switch").value = language;
  document.querySelectorAll("[data-i18n]").forEach((node) => { node.textContent = t(node.dataset.i18n); });
  document.querySelectorAll("[data-i18n-placeholder]").forEach((node) => { node.placeholder = t(node.dataset.i18nPlaceholder); });
  document.querySelectorAll("[data-i18n-title]").forEach((node) => { node.title = t(node.dataset.i18nTitle); });
}

function resourceEstimateHtml(estimate) {
  if (!estimate) return `<p class="muted">${escapeHtml(t("common.none"))}</p>`;
  const expected = estimate.expected || {};
  const hard = estimate.hard_caps || {};
  return `<div class="resource-forecast"><span><strong>${escapeHtml(estimate.complexity || "unknown")}</strong>${language === "zh-CN" ? "复杂度" : "complexity"}</span><span><strong>${formatCost(expected.budgetUsd)}</strong>${language === "zh-CN" ? "预计成本" : "expected cost"}</span><span><strong>${expected.turns || 0}</strong>${language === "zh-CN" ? "预计 turns" : "expected turns"}</span><span><strong>${expected.filesRead || 0}</strong>${language === "zh-CN" ? "预计读取" : "expected reads"}</span><span><strong>${formatCost(hard.budgetUsd)}</strong>${language === "zh-CN" ? "硬上限" : "hard caps"}</span><span><strong>${hard.timeoutSeconds || 0}s</strong>${language === "zh-CN" ? "阶段最长时间" : "max stage time"}</span></div>${listHtml(estimate.notes)}`;
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, { cache: "no-store", ...options });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) { const error = new Error(payload.error || `${response.status} ${response.statusText}`); error.payload = payload; error.status = response.status; throw error; }
  return payload;
}
const sendJson = (method, url, body) => requestJson(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const postJson = (url, body) => sendJson("POST", url, body);

function setMessage(message, tone = "info") { $("action-message").textContent = message || ""; $("action-message").dataset.tone = tone; }

function renderPreflight(result) {
  latestPreflight = result;
  const state = result?.status === "ok" ? "ok" : result?.status === "failed" ? "failed" : "unknown";
  $("provider-preflight").dataset.status = state;
  $("preflight-status").textContent = state === "ok" ? t("preflight.reachable") : state === "failed" ? sentenceLabel(result.classification) : t("preflight.unchecked");
  $("preflight-detail").textContent = result ? `${result.message} · ${formatTime(result.checkedAt)}` : t("preflight.detail");
  $("run-preflight").disabled = preflightPending;
  $("run-preflight").textContent = preflightPending ? t("preflight.testing") : t("preflight.test");
}

function renderOverview() {
  const active = workflows.filter((workflow) => ACTIVE.has(workflow.status)).length;
  const approvals = workflows.filter((workflow) => workflow.status === "waiting_approval").length;
  const completed = workflows.filter((workflow) => ["completed", "succeeded"].includes(workflow.status)).length;
  const failed = workflows.filter((workflow) => workflow.status === "failed").length;
  const cost = workflows.reduce((total, workflow) => total + Number(workflow.product?.totalCostUsd || 0), 0);
  $("overview").innerHTML = `<div class="overview-card"><span>${t("overview.active")}</span><strong>${active}</strong><small>${t("overview.activeHint")}</small></div><div class="overview-card ${approvals ? "attention" : ""}"><span>${t("overview.approval")}</span><strong>${approvals}</strong><small>${t("overview.approvalHint")}</small></div><div class="overview-card"><span>${t("overview.completed")}</span><strong>${completed}</strong><small>${t("overview.completedHint")}</small></div><div class="overview-card ${failed ? "warning" : ""}"><span>${t("overview.failed")}</span><strong>${failed}</strong><small>${t("overview.failedHint")}</small></div><div class="overview-card"><span>${t("overview.cost")}</span><strong>${formatCost(cost)}</strong><small>${t("overview.costHint")}</small></div>`;
}

function applyRecentVisibility() {
  $("console-grid").classList.toggle("recent-collapsed", recentCollapsed);
  document.querySelector(".recent-panel").classList.toggle("hidden", recentCollapsed);
  $("show-recent").classList.toggle("hidden", !recentCollapsed);
}

function applyHeroView() {
  $("workflow-summary-pane").classList.toggle("hidden", heroView !== "summary");
  $("workflow-timeline-pane").classList.toggle("hidden", heroView !== "timeline");
  document.querySelectorAll("[data-hero-view]").forEach((node) => {
    const active = node.dataset.heroView === heroView;
    node.classList.toggle("active", active);
    node.setAttribute("aria-selected", String(active));
  });
}

function workflowListItem(workflow) {
  const selected = workflow.workflowId === selectedWorkflowId ? " selected" : "";
  const archived = workflow.metadata?.archived ? " archived" : "";
  const title = workflow.metadata?.displayName || workflow.userRequest;
  return `<div class="workflow-item${selected}${archived}"><button class="workflow-item-main" data-workflow-id="${escapeHtml(workflow.workflowId)}" type="button"><div class="workflow-item-head">${badge(workflow.status)}<time>${formatTime(workflow.updatedAt)}</time></div><strong>${escapeHtml(title)}</strong>${workflow.metadata?.displayName ? `<small class="original-request">${escapeHtml(workflow.userRequest)}</small>` : ""}<div class="workflow-item-meta"><span>${escapeHtml(statusLabel(workflow.currentStage))}</span><span>${formatDuration(workflow.durationSeconds)}</span><span>${formatCost(workflow.product?.totalCostUsd)}</span>${workflow.metadata?.archived ? `<span class="archived-label">${t("recent.archived")}</span>` : ""}</div>${workflow.status === "waiting_approval" ? `<div class="approval-callout">${t("recent.approval")}</div>` : ""}</button><button class="workflow-item-action" data-manage-workflow="${escapeHtml(workflow.workflowId)}" type="button" aria-label="${escapeHtml(t("recent.manage"))}"><svg viewBox="0 0 18 18" aria-hidden="true"><circle cx="4" cy="9" r="1.25"/><circle cx="9" cy="9" r="1.25"/><circle cx="14" cy="9" r="1.25"/></svg></button></div>`;
}

function workflowProjectId(workflow) { return workflow?.projectId || workflow?.project?.projectId || workflow?.project?.id || workflow?.product?.projectId || null; }

function continuityList(values, empty = t("common.none")) {
  return Array.isArray(values) && values.length ? `<ul>${values.map((value) => `<li>${escapeHtml(typeof value === "string" ? value : value.goal || value.summary || JSON.stringify(value))}</li>`).join("")}</ul>` : `<p class="muted">${escapeHtml(empty)}</p>`;
}

function renderProjectOverviewContent() {
  const context = selectedProjectContinuity;
  if (!context) return;
  const brief = context.brief || {};
  document.querySelectorAll("[data-project-view]").forEach((button) => button.classList.toggle("active", button.dataset.projectView === projectView));
  if (projectView === "memory") {
    $("project-overview-content").innerHTML = `<section class="continuity-card"><h3>${language === "zh-CN" ? "项目记忆" : "Project Memory"}</h3><p class="muted">${escapeHtml(context.memorySummary?.file || "PROJECT_MEMORY.md")} · ${formatTime(context.memorySummary?.lastUpdated)}</p><pre>${escapeHtml(context.memorySummary?.summary || t("common.none"))}</pre></section>`;
  } else if (projectView === "sessions") {
    $("project-overview-content").innerHTML = `<section class="continuity-grid">${(context.sessions || []).map((session) => `<article class="continuity-card"><h3>${escapeHtml(session.name)}</h3><p>${escapeHtml(session.purpose)}</p><small>${formatTime(session.updatedAt)}</small><h4>${language === "zh-CN" ? "未决问题" : "Unresolved questions"}</h4>${continuityList(session.unresolvedQuestions)}<h4>${language === "zh-CN" ? "下一步" : "Next actions"}</h4>${continuityList(session.nextActions)}</article>`).join("") || `<p class="muted">${escapeHtml(t("projects.noSessions"))}</p>`}</section>`;
  } else if (projectView === "workflows") {
    $("project-overview-content").innerHTML = `<section class="continuity-list">${(context.recentWorkflows || []).map((workflow) => `<button type="button" data-continuity-workflow="${escapeHtml(workflow.workflowId)}"><span>${badge(workflow.status)}<strong>${escapeHtml(workflow.goal)}</strong></span><small>${formatTime(workflow.updatedAt)}</small></button>`).join("") || `<p class="muted">${escapeHtml(t("recent.empty"))}</p>`}</section>`;
    $("project-overview-content").querySelectorAll("[data-continuity-workflow]").forEach((button) => button.addEventListener("click", () => { selectedWorkflowId = button.dataset.continuityWorkflow; selectedStageView = null; renderSelectedWorkflow().catch(showError); }));
  } else if (projectView === "issues") {
    const clarification = (context.waitingClarifications || [])[0];
    const clarify = clarification ? `<form id="clarification-form" class="clarification-form" data-decision-id="${escapeHtml(clarification.decisionId)}"><strong>${language === "zh-CN" ? "Supervisor 需要澄清" : "Supervisor needs clarification"}</strong><p>${escapeHtml(clarification.possibleIntentMismatch || clarification.goal)}</p><textarea id="clarification-response" maxlength="5000" required placeholder="${language === "zh-CN" ? "明确真实目标、边界或预期结果" : "Clarify the actual goal, boundary, or expected outcome"}"></textarea><button class="primary-button compact-button" type="submit">${language === "zh-CN" ? "确认并重新生成 Decision" : "Confirm and regenerate Decision"}</button></form>` : "";
    $("project-overview-content").innerHTML = `${clarify}<section class="continuity-card"><h3>${language === "zh-CN" ? "开放问题" : "Open Issues"}</h3>${continuityList(context.openIssues)}</section>`;
    $("clarification-form")?.addEventListener("submit", async (event) => { event.preventDefault(); if (actionPending) return; actionPending = true; try { const payload = await postJson("/api/supervisor/workflows", { userRequest: clarification.originalRequest, clarificationDecisionId: clarification.decisionId, clarificationResponse: $("clarification-response").value.trim(), projectId: context.project.projectId }); selectedWorkflowId = payload.workflow.workflowId; selectedStageView = null; setMessage(language === "zh-CN" ? "澄清已确认，新 Decision 和 Workflow 已创建。" : "Clarification confirmed; a new Decision and Workflow were created.", "success"); await refresh(); } catch (error) { setMessage(error.message, "error"); } finally { actionPending = false; } });
  } else {
    const health = context.health || { status: brief.currentStatus, recent: brief.recentWorkflowSummary, attention: brief.unresolvedIssues, recommended: brief.recommendedNextSteps };
    $("project-overview-content").innerHTML = `<section class="project-health-summary"><div><span>${language === "zh-CN" ? "项目状态" : "Project status"}</span>${badge(health.status)}</div>${health.release ? `<div><span>${language === "zh-CN" ? "发布候选" : "Release candidate"}</span><strong>${escapeHtml(health.release.version)} · ${escapeHtml(health.release.readiness)}</strong></div>` : ""}</section><section class="continuity-grid health-grid"><article class="continuity-card"><h3>${language === "zh-CN" ? "当前目标" : "Active goals"}</h3>${continuityList(brief.activeGoals)}</article><article class="continuity-card"><h3>${language === "zh-CN" ? "近期" : "Recent"}</h3>${continuityList(health.recent)}</article><article class="continuity-card attention-card"><h3>${language === "zh-CN" ? "需要关注" : "Attention"}</h3>${continuityList(health.attention)}</article><article class="continuity-card"><h3>${language === "zh-CN" ? "建议下一步" : "Recommended"}</h3>${continuityList(health.recommended, language === "zh-CN" ? "没有已确认的下一步" : "No confirmed next steps")}</article></section>`;
  }
}

async function renderProjectOverview() {
  if (!selectedProjectId) { $("project-overview").classList.add("hidden"); return; }
  const payload = await requestJson(`/api/supervisor/projects/${encodeURIComponent(selectedProjectId)}/continuity`);
  selectedProjectContinuity = payload.context;
  $("workflow-empty").classList.add("hidden"); $("workflow-detail").classList.add("hidden"); $("project-overview").classList.remove("hidden");
  $("project-overview-name").textContent = payload.context.project.name;
  $("project-overview-description").textContent = payload.context.project.description || payload.context.project.workspacePath;
  $("project-overview-status").innerHTML = badge(payload.context.health?.status || payload.context.brief.currentStatus);
  renderProjectOverviewContent();
}

function renderProjects() {
  $("project-count").textContent = String(projects.length);
  const allClass = selectedProjectId ? "" : " active";
  $("project-list").innerHTML = `<button class="project-chip${allClass}" type="button" data-project-id=""><strong>${escapeHtml(t("projects.all"))}</strong><span>${workflows.length}</span></button>${projects.map((project) => `<button class="project-chip${selectedProjectId === project.projectId ? " active" : ""}" type="button" data-project-id="${escapeHtml(project.projectId)}"><strong>${escapeHtml(project.name)}</strong><span>${project.sessionCount || 0}</span></button>`).join("")}`;
  const selected = projects.find((project) => project.projectId === selectedProjectId);
  $("project-summary").classList.toggle("hidden", !selected);
  if (selected) {
    const sessions = selected.sessions || [];
    $("project-summary").innerHTML = `<div class="project-binding"><span><strong>${escapeHtml(t("projects.project"))}</strong>${escapeHtml(selected.name)}</span><span><strong>${escapeHtml(t("projects.workspace"))}</strong><code>${escapeHtml(selected.workspacePath)}</code></span><span><strong>${escapeHtml(t("projects.memory"))}</strong>${selected.memory?.available ? escapeHtml(formatTime(selected.memory.lastUpdated)) : escapeHtml(t("projects.memoryMissing"))}</span></div><div class="project-sessions"><div><strong>${escapeHtml(t("projects.sessions"))}</strong><span>${sessions.length}</span></div>${sessions.length ? sessions.map((session) => `<button type="button" data-project-session="${escapeHtml(session.sessionId)}"><span>${escapeHtml(session.name)}</span><small>${formatTime(session.updatedAt)}</small></button>`).join("") : `<p>${escapeHtml(t("projects.noSessions"))}</p>`}</div>`;
  }
  $("project-list").querySelectorAll("[data-project-id]").forEach((node) => node.addEventListener("click", () => {
    selectedProjectId = node.dataset.projectId || null;
    if (selectedProjectId) localStorage.setItem("supervisor.selectedProjectId", selectedProjectId); else localStorage.removeItem("supervisor.selectedProjectId");
    selectedWorkflowId = null; selectedStageView = null; projectView = "brief";
    renderProjects(); renderWorkflowList(); renderSelectedWorkflow().catch(showError);
  }));
  $("project-summary").querySelectorAll("[data-project-session]").forEach((node) => node.addEventListener("click", () => {
    const workflow = workflows.find((item) => item.sessionId === node.dataset.projectSession || item.product?.sessionId === node.dataset.projectSession);
    if (workflow) { selectedWorkflowId = workflow.workflowId; selectedStageView = null; renderSelectedWorkflow().catch(showError); }
  }));
}

function persistOpenFolders() { localStorage.setItem("supervisor.openFolders", JSON.stringify([...openFolderIds])); }
function folderLabel(folder) { return folder.system || folder.folderId === "default" ? t("folders.default") : folder.name; }
function folderIcon(pinned, system = false) { if (system) return '<svg viewBox="0 0 18 18" aria-hidden="true"><rect x="4" y="8" width="10" height="7" rx="2"/><path d="M6.5 8V6a2.5 2.5 0 0 1 5 0v2"/></svg>'; return pinned ? '<svg viewBox="0 0 18 18" aria-hidden="true"><path d="m6 3 6 0-.8 4 2 2H4.8l2-2zM9 9v6"/></svg>' : '<svg viewBox="0 0 18 18" aria-hidden="true"><path d="M2.5 5.5h5l1.5 1.7h6.5v7.3h-13z"/></svg>'; }

function renderWorkflowList() {
  const visibleWorkflows = selectedProjectId ? workflows.filter((workflow) => workflowProjectId(workflow) === selectedProjectId) : workflows;
  $("workflow-count").textContent = String(visibleWorkflows.length);
  const grouped = groupWorkflowsByFolder(visibleWorkflows, folders);
  $("workflow-list").innerHTML = grouped.map(({ folder, workflows: folderWorkflows }) => {
    const folderId = folder.folderId;
    const open = openFolderIds.has(folderId);
    const activeWorkflows = folderWorkflows.filter((workflow) => !workflow.metadata?.archived);
    const archivedWorkflows = folderWorkflows.filter((workflow) => workflow.metadata?.archived);
    const archivesOpen = openArchiveFolderIds.has(folderId);
    const actions = folder.system ? "" : `<div class="folder-actions"><button class="folder-action${folder.pinned ? " active" : ""}" data-pin-folder="${escapeHtml(folderId)}" type="button" title="${escapeHtml(t(folder.pinned ? "folders.unpin" : "folders.pin"))}">${folderIcon(true)}</button><button class="folder-action" data-rename-folder="${escapeHtml(folderId)}" type="button" title="${escapeHtml(t("folders.rename"))}"><svg viewBox="0 0 18 18" aria-hidden="true"><path d="m4 13.5.7-3L11.8 3.4l2.8 2.8-7.1 7.1zM10.7 4.5l2.8 2.8"/></svg></button></div>`;
    const activeContent = activeWorkflows.length ? activeWorkflows.map(workflowListItem).join("") : (!archivedWorkflows.length ? `<div class="folder-empty">${t("recent.groupEmpty")}</div>` : "");
    const archivedContent = archivedWorkflows.length ? `<div class="folder-archive"><button class="archive-toggle" data-toggle-archives="${escapeHtml(folderId)}" type="button" aria-expanded="${archivesOpen}"><span class="archive-chevron">›</span><span>${t("recent.archived")}</span><strong>${archivedWorkflows.length}</strong></button><div class="archived-sessions${archivesOpen ? "" : " hidden"}">${archivedWorkflows.map(workflowListItem).join("")}</div></div>` : "";
    const content = `${activeContent}${archivedContent}`;
    return `<section class="workflow-folder${folder.pinned ? " pinned" : ""}${open ? " open" : ""}" data-folder-id="${escapeHtml(folderId)}"><div class="folder-heading"><button class="folder-toggle" data-toggle-folder="${escapeHtml(folderId)}" type="button" aria-expanded="${open}"><span class="folder-chevron">›</span><span class="folder-icon">${folderIcon(folder.pinned, folder.system)}</span><strong>${escapeHtml(folderLabel(folder))}</strong><span class="folder-count">${folderWorkflows.length}</span></button>${actions}</div><div class="folder-sessions${open ? "" : " hidden"}">${content}</div></section>`;
  }).join("");
  $("workflow-list").querySelectorAll("[data-workflow-id]").forEach((node) => node.addEventListener("click", () => { selectedWorkflowId = node.dataset.workflowId; selectedProjectId = workflowProjectId(workflows.find((workflow) => workflow.workflowId === selectedWorkflowId)) || selectedProjectId; if (selectedProjectId) localStorage.setItem("supervisor.selectedProjectId", selectedProjectId); selectedStageView = null; renderSelectedWorkflow().catch(showError); }));
  $("workflow-list").querySelectorAll("[data-manage-workflow]").forEach((node) => node.addEventListener("click", () => openMetadataDialog(node.dataset.manageWorkflow)));
  $("workflow-list").querySelectorAll("[data-toggle-folder]").forEach((node) => node.addEventListener("click", () => { const folderId = node.dataset.toggleFolder; if (openFolderIds.has(folderId)) openFolderIds.delete(folderId); else openFolderIds.add(folderId); persistOpenFolders(); renderWorkflowList(); }));
  $("workflow-list").querySelectorAll("[data-toggle-archives]").forEach((node) => node.addEventListener("click", () => { const folderId = node.dataset.toggleArchives; if (openArchiveFolderIds.has(folderId)) openArchiveFolderIds.delete(folderId); else openArchiveFolderIds.add(folderId); renderWorkflowList(); }));
  $("workflow-list").querySelectorAll("[data-pin-folder]").forEach((node) => node.addEventListener("click", async () => { const folder = folders.find((item) => item.folderId === node.dataset.pinFolder); if (!folder) return; try { await sendJson("PATCH", `/api/supervisor/folders/${encodeURIComponent(folder.folderId)}`, { pinned: !folder.pinned }); setMessage(t("folders.updated"), "success"); await refresh(); } catch (error) { setMessage(error.message, "error"); } }));
  $("workflow-list").querySelectorAll("[data-rename-folder]").forEach((node) => node.addEventListener("click", () => openFolderDialog(node.dataset.renameFolder)));
}

function buildStageNodes(workflow) {
  const stages = workflow.stages || [];
  const planner = stages.find((stage) => stage.role === "planner");
  const coder = stages.find((stage) => stage.role === "coder");
  const reviewer = stages.find((stage) => stage.role === "reviewer");
  const approval = workflow.product?.approval;
  const nodes = [{ role: "planner", view: "plan", label: t("timeline.plan"), status: planner?.status || (workflow.product?.supervisorDecision ? "succeeded" : "pending"), subtitle: workflow.product?.supervisorDecision ? `${workflow.product.supervisorDecision.source === "gpt" ? "GPT" : t("decision.local")} · ${workflow.product.supervisorDecision.intent}` : t("timeline.awaiting") }];
  if (approval?.required || coder?.requiresApproval) {
    const status = approval?.status === "approved" ? "succeeded" : approval?.status === "rejected" ? "failed" : approval?.status === "waiting" ? "waiting_approval" : "pending";
    nodes.push({ role: "approval", view: "approval", label: t("timeline.approval"), status, subtitle: approval?.status === "approved" ? `${approval.approvedBy}` : approval?.status === "rejected" ? `${approval.rejectedBy}` : t("timeline.explicit") });
  }
  nodes.push({ role: "coder", view: "implementation", label: t("timeline.implementation"), status: coder?.status || "pending", subtitle: coder?.resourceProfile || t("timeline.defaultResources") });
  nodes.push({ role: "reviewer", view: "review", label: t("timeline.review"), status: reviewer?.status || "pending", subtitle: reviewer?.resourceProfile || t("timeline.defaultResources") });
  return nodes;
}

function applyStageView() {
  document.querySelectorAll(".stage-view").forEach((node) => node.classList.toggle("hidden", node.id !== `stage-${selectedStageView}`));
}

function stageIcon(status) {
  if (status === "succeeded") return '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 10.2 8.4 13.4 15 6.7"/></svg>';
  if (status === "failed") return '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 5.2v7.2M10 15.3v.2"/></svg>';
  if (ACTIVE.has(status)) return '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 10h10M10.5 5.5 15 10l-4.5 4.5"/></svg>';
  return '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="2.2"/></svg>';
}

function renderStageTimeline(workflow) {
  const nodes = buildStageNodes(workflow);
  const viewable = nodes.filter((node) => isStageViewable(node.status));
  if (!selectedStageView || !viewable.some((node) => node.view === selectedStageView)) selectedStageView = defaultStageView(workflow);
  if (!viewable.some((node) => node.view === selectedStageView)) selectedStageView = viewable.at(-1)?.view || "plan";
  $("stage-progress").textContent = t("timeline.progress", { done: nodes.filter((node) => node.status === "succeeded").length, total: nodes.length });
  $("stage-timeline").innerHTML = nodes.map((node, index) => {
    const enabled = isStageViewable(node.status);
    return `<button class="stage-node ${escapeHtml(node.status)} ${selectedStageView === node.view ? "active" : ""}" type="button" data-stage-view="${node.view}" ${enabled ? "" : "disabled"} ${selectedStageView === node.view ? 'aria-current="step"' : ""}><span class="stage-track" aria-hidden="true"></span><span class="stage-icon">${stageIcon(node.status)}</span><span class="stage-copy"><strong>${escapeHtml(node.label)}</strong><span>${escapeHtml(statusLabel(node.status))}</span><small>${escapeHtml(node.subtitle)}</small></span></button>`;
  }).join("");
  $("stage-timeline").querySelectorAll("[data-stage-view]:not(:disabled)").forEach((node) => node.addEventListener("click", () => { selectedStageView = node.dataset.stageView; renderStageTimeline(workflow); applyStageView(); }));
  applyStageView();
}

function resultCard(title, eyebrow, content, tone = "") { return `<article class="panel result-card ${tone}"><p class="eyebrow">${escapeHtml(eyebrow)}</p><h2>${escapeHtml(title)}</h2>${content}</article>`; }

function renderDecision(workflow) {
  const decision = workflow.product?.supervisorDecision;
  $("decision-panel").classList.toggle("legacy", !decision);
  $("decision-source").textContent = decision ? `${decision.source === "gpt" ? t("decision.gpt") : t("decision.local")} · ${Math.round(Number(decision.confidence || 0) * 100)}%` : t("decision.legacy");
  if (!decision) { $("decision-content").innerHTML = `<p class="muted">${t("decision.legacyText")}</p>`; }
  else {
    const project = decision.project || {};
    $("decision-content").innerHTML = `<div><span class="label">${t("decision.intent")}</span><strong>${escapeHtml(decision.intent)}</strong><p>${escapeHtml(decision.goal)}</p></div><div><span class="label">${t("decision.worker")}</span><strong>${decision.agentRequired ? t("decision.workerRequired") : t("decision.respondDirectly")}</strong><p>${t("decision.next")}: ${escapeHtml(decision.nextAction)}</p></div><div class="decision-wide"><span class="label">${t("decision.summary")}</span><p>${escapeHtml(decision.technicalSummary || t("decision.noSummary"))}</p></div><div class="decision-wide"><span class="label">${t("decision.strategy")}</span><p>${escapeHtml(decision.implementationStrategy || t("decision.noSummary"))}</p></div><div><span class="label">${t("decision.expectedChanges")}</span>${listHtml(decision.expectedChanges)}</div><div><span class="label">${t("decision.validationPlan")}</span>${listHtml(decision.validationPlan)}</div><div><span class="label">${t("decision.project")}</span><strong>${escapeHtml(project.name || t("decision.noProject"))}</strong><p><code>${escapeHtml(project.path || "—")}</code></p>${listHtml(project.techStack)}</div><div><span class="label">${t("decision.workflow")}</span><strong>${escapeHtml(decision.workflowType)}</strong>${listHtml(decision.reasoning)}</div><div><span class="label">${t("decision.risks")}</span>${listHtml(decision.risks)}</div><div><span class="label">${t("decision.actions")}</span>${listHtml(decision.recommendedActions)}</div><div class="decision-wide"><span class="label">${t("decision.resources")}</span>${resourceEstimateHtml(decision.estimatedResources)}</div>`;
  }
  const planner = workflow.product?.planner || {};
  $("plan-result-grid").innerHTML = resultCard(t("decision.plan"), workflow.workflowPlan?.workflowType || workflow.definitionId || t("workflow.defaultType"), `<p>${escapeHtml(workflow.workflowPlan?.reason || planner.summary || statusLabel(workflow.status))}</p><h3>${t("decision.constraints")}</h3>${listHtml(workflow.workflowPlan?.constraints)}`);
}

function renderApproval(workflow) {
  const approval = workflow.product?.approval;
  const waiting = workflow.status === "waiting_approval" && approval?.status === "waiting";
  $("approval-panel").classList.toggle("hidden", !approval?.required);
  if (!approval?.required) return;
  $("approval-form").classList.toggle("hidden", !waiting);
  $("approval-title").textContent = waiting ? t("approval.required") : approval.status === "approved" ? t("approval.approved") : approval.status === "rejected" ? t("approval.rejected") : t("approval.checkpoint");
  $("approval-reason").textContent = waiting ? approval.reason : approval.status === "approved" ? `${approval.approvedBy}: ${approval.approvalReason}` : approval.status === "rejected" ? `${approval.rejectedBy}: ${approval.rejectionReason}` : approval.reason;
  const diff = approval.changeDetails?.length ? approval.changeDetails.map(diffFile).join("") : `<p class="muted">${t("approval.noDiff")}</p>`;
  $("approval-preview").innerHTML = `<div><span class="label">${t("approval.userRequest")}</span><p>${escapeHtml(workflow.userRequest)}</p></div><div><span class="label">${t("approval.reason")}</span><p>${escapeHtml(approval.modificationReason || workflow.product?.supervisorDecision?.technicalSummary || workflow.userRequest)}</p></div><div><span class="label">${t("approval.decision")}</span><p><strong>${escapeHtml(workflow.product?.supervisorDecision?.intent || "legacy")}</strong> · ${escapeHtml(workflow.product?.supervisorDecision?.project?.name || "—")}</p>${listHtml(workflow.product?.supervisorDecision?.reasoning)}</div><div><span class="label">${t("approval.workflow")}</span><strong>${escapeHtml(workflow.workflowPlan?.workflowType || workflow.definitionId || "workflow")}</strong></div><div><span class="label">${t("approval.scope")}</span>${listHtml(approval.plannedChanges)}</div><div><span class="label">${t("approval.context")}</span>${listHtml(approval.contextualFiles)}</div><div><span class="label">${t("approval.risks")}</span>${listHtml(approval.risks)}</div><div><span class="label">${t("approval.profile")}</span><strong>${escapeHtml(approval.resourceProfile || t("common.default"))}</strong><p>${escapeHtml(approval.estimatedImpact)}</p></div><div><span class="label">${t("approval.cost")}</span><strong>${approval.estimatedCost ? `${formatCost(approval.estimatedCost.likelyUsd)} · ${formatCost(approval.estimatedCost.upperBoundUsd)}` : t("common.unavailable")}</strong></div><div class="approval-wide"><span class="label">${t("approval.estimate")}</span>${resourceEstimateHtml(approval.workflowResourceEstimate)}</div><div class="approval-wide"><span class="label">${t("approval.diff")}</span>${diff}</div>`;
  $("approve-workflow").disabled = actionPending; $("reject-workflow").disabled = actionPending;
}

function diffFile(change) { return `<details class="diff-file"><summary><strong>${escapeHtml(change.file)}</strong><span>${escapeHtml(change.summary)}</span></summary><pre>${escapeHtml(change.diff || t("implementation.noDiff"))}</pre></details>`; }

function renderImplementation(workflow) {
  const product = workflow.product || {}; const resources = product.totalUsage || {}; const details = product.changeDetails || [];
  $("implementation-result-grid").innerHTML = resultCard(t("implementation.files"), t("implementation.eyebrow"), listHtml(product.changedFiles, workflow.status === "completed" ? t("common.none") : t("implementation.noFiles"))) + resultCard(t("implementation.diff"), "Tool evidence", details.length ? details.map(diffFile).join("") : `<p class="muted">${t("implementation.noDiff")}</p>`) + resultCard(t("implementation.resources"), t("workflow.cost"), `<div class="resource-stats"><span><strong>${formatCost(product.totalCostUsd)}</strong>cost</span><span><strong>${resources.turns || 0}</strong>turns</span><span><strong>${resources.filesRead || 0}</strong>files</span><span><strong>${resources.commands || 0}</strong>commands</span></div>`);
  const policy = product.executionPolicy || { allowed: [], blocked: [] };
  $("execution-policy").innerHTML = `<div><h3>${t("implementation.allowed")}</h3>${listHtml(policy.allowed)}</div><div><h3>${t("implementation.blocked")}</h3>${listHtml(policy.blocked)}</div>`;
}

function renderReview(workflow) {
  const product = workflow.product || {}; const review = product.review || {};
  $("review-result-grid").innerHTML = resultCard(t("review.title"), t("review.eyebrow"), `<p>${escapeHtml(review.summary || (workflow.status === "reviewing" ? t("review.running") : t("review.pending")))}</p><h3>${t("review.checks")}</h3>${listHtml(review.checks, t("review.none"))}`, workflow.status === "completed" ? "success" : "") + resultCard(`${t("review.risks")} / ${t("review.errors")}`, "Attention", `<h3>${t("review.risks")}</h3>${listHtml(product.risks)}<h3>${t("review.errors")}</h3>${listHtml(product.errors)}`, product.errors?.length ? "danger" : "");
}

function collaborationValue(label, value, tone = "") {
  return `<div class="collaboration-value ${escapeHtml(tone)}"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
}

function renderProjectIntelligence(intelligence) {
  const content = $("project-intelligence-content");
  if (!intelligence) { content.innerHTML = `<p class="muted">${escapeHtml(t("common.unavailable"))}</p>`; return; }
  const reviews = intelligence.reviewResults || [];
  const proposal = intelligence.memoryProposal;
  const applications = intelligence.memoryApplications || [];
  const reviewHtml = reviews.length ? reviews.map((review) => `<article><div><strong>${escapeHtml(t(`intelligence.conclusion.${review.conclusion}`))}</strong><time>${formatTime(review.createdAt)}</time></div><p>${escapeHtml(review.goalAlignment)}</p><small>${escapeHtml(review.source?.submittedBy || review.reviewer)}</small></article>`).join("") : `<p class="muted">${escapeHtml(t("intelligence.noReviews"))}</p>`;
  const proposalHtml = proposal ? `<article><div><strong>${escapeHtml(proposal.summary || t("intelligence.memory"))}</strong><span>${escapeHtml(t(`intelligence.proposal.${proposal.status}`))}</span></div>${listHtml(proposal.affectedAreas)}${proposal.status === "proposed" && proposal.applied !== true ? `<button id="open-memory-apply" class="secondary-button compact-button" type="button">${escapeHtml(t("intelligence.apply"))}</button>` : ""}</article>` : `<p class="muted">${escapeHtml(t("intelligence.noProposal"))}</p>`;
  const applicationsHtml = applications.length ? applications.map((application) => `<article><div><strong>${escapeHtml(application.appliedBy)}</strong><time>${formatTime(application.appliedAt)}</time></div><p>${escapeHtml(application.modificationSummary)}</p><small>${escapeHtml(application.applicationId)}</small></article>`).join("") : `<p class="muted">${escapeHtml(t("intelligence.noApplications"))}</p>`;
  content.innerHTML = `<section><h3>${escapeHtml(t("intelligence.reviews"))}</h3>${reviewHtml}</section><section><h3>${escapeHtml(t("intelligence.proposals"))}</h3>${proposalHtml}</section><section><h3>${escapeHtml(t("intelligence.applications"))}</h3>${applicationsHtml}</section>`;
  $("open-memory-apply")?.addEventListener("click", openMemoryApplyDialog);
}

function renderSupervisorCollaboration(workflow, reviewPackage, intelligence) {
  const panel = $("supervisor-collaboration");
  const available = TERMINAL.has(workflow.status) && reviewPackage?.chatGptReviewGuidance?.status === "available";
  panel.classList.toggle("hidden", !TERMINAL.has(workflow.status));
  if (!TERMINAL.has(workflow.status)) return;
  const guidance = reviewPackage?.chatGptReviewGuidance || {};
  const latestReview = intelligence?.latestReview || reviewPackage?.supervisorReviewResult || null;
  const proposal = intelligence?.memoryProposal || reviewPackage?.memoryUpdateProposal || {};
  const latestApplication = intelligence?.latestMemoryApplication || null;
  const technical = guidance.technicalReview || (workflow.status === "failed" ? "failed" : "not_applicable");
  const technicalLabel = t(`collaboration.technical.${technical}`);
  const technicalTone = technical === "pass" ? "success" : ["failed", "attention"].includes(technical) ? "danger" : "";
  const supervisorLabel = latestReview ? t(`intelligence.conclusion.${latestReview.conclusion}`) : available ? t("collaboration.available") : t("common.unavailable");
  const memoryLabel = proposal.applied === true || latestApplication?.status === "applied" ? t("collaboration.memoryApplied") : proposal.status === "proposed" ? t("collaboration.memoryProposed") : t("collaboration.memoryNone");
  $("collaboration-status").innerHTML = collaborationValue(t("collaboration.technical"), technicalLabel === `collaboration.technical.${technical}` ? sentenceLabel(technical) : technicalLabel, technicalTone) + collaborationValue(t("collaboration.supervisor"), supervisorLabel, latestReview?.conclusion === "accept" ? "success" : latestReview ? "danger" : available ? "available" : "") + collaborationValue(t("collaboration.memory"), memoryLabel, proposal.applied === true ? "success" : proposal.status === "proposed" ? "available" : "");
  $("review-in-chatgpt").disabled = !available;
  renderProjectIntelligence(intelligence);
}

function openMemoryApplyDialog() {
  const proposal = selectedProjectIntelligence?.memoryProposal;
  if (!proposal || proposal.status !== "proposed" || proposal.applied === true) return;
  $("memory-apply-form").dataset.proposalId = proposal.proposalId;
  $("memory-apply-preview").innerHTML = `<strong>${escapeHtml(proposal.summary || proposal.proposalId)}</strong>${listHtml(proposal.suggestedMemoryChanges)}<small>${escapeHtml(proposal.proposalId)}</small>`;
  $("memory-confirmed").checked = false;
  $("memory-confirmation-reason").value = "";
  $("memory-apply-dialog").showModal();
}

function openChatGptReviewDialog() {
  const guidance = selectedReviewPackage?.chatGptReviewGuidance;
  if (!guidance || guidance.status !== "available") return;
  const prompt = language === "zh-CN" ? guidance.suggestedPrompts?.zhCN : guidance.suggestedPrompts?.en;
  $("chatgpt-review-workflow-id").textContent = guidance.workflowId || selectedWorkflowId;
  $("chatgpt-review-project-id").textContent = guidance.projectId || t("common.unavailable");
  $("chatgpt-review-tool-call").textContent = `${guidance.reviewPackageTool?.name || "cc_get_supervisor_review_package"}(${JSON.stringify(guidance.reviewPackageTool?.arguments || { workflowId: selectedWorkflowId })})`;
  $("chatgpt-review-prompt").value = prompt || "";
  $("copy-chatgpt-review").textContent = t("collaboration.copy");
  $("chatgpt-review-dialog").showModal();
}

function renderFailureRecovery(workflow) {
  const failure = workflow.product?.failure; const recovery = workflow.product?.recovery || {};
  $("recovery-panel").classList.toggle("hidden", !failure); if (!failure) return;
  $("failure-category").textContent = `${failure.stageLabel} · ${statusLabel(failure.category)}`;
  const history = recovery.recoveries || [];
  $("failure-content").innerHTML = `<div><span class="label">${t("recovery.stage")}</span><strong>${escapeHtml(failure.stageLabel)}</strong><p>${escapeHtml(failure.title)}</p></div><div><span class="label">${t("recovery.happened")}</span><p>${escapeHtml(failure.explanation)}</p><code>${escapeHtml(failure.code)}</code></div><div><span class="label">${t("recovery.recommended")}</span>${listHtml(failure.recoverySteps)}</div><details><summary>${t("recovery.technical")}</summary><pre>${escapeHtml(failure.message)}</pre></details>${recovery.sourceWorkflowId ? `<div><span class="label">${t("recovery.from")}</span><button class="workflow-link" type="button" data-linked-workflow="${escapeHtml(recovery.sourceWorkflowId)}">${escapeHtml(recovery.sourceWorkflowId)}</button></div>` : ""}${history.length ? `<div><span class="label">${t("recovery.history")}</span>${history.map((item) => `<button class="workflow-link" type="button" data-linked-workflow="${escapeHtml(item.workflowId)}">${escapeHtml(item.workflowId)}</button>`).join("")}</div>` : ""}`;
  $("recovery-form").classList.toggle("hidden", !recovery.available); $("retry-workflow").disabled = actionPending;
  $("recovery-panel").querySelectorAll("[data-linked-workflow]").forEach((node) => node.addEventListener("click", () => { selectedWorkflowId = node.dataset.linkedWorkflow; selectedStageView = null; renderSelectedWorkflow().catch(showError); }));
}

function renderTechnicalDetails(workflow, events) {
  const orderedEvents = sortEventsNewestFirst(events);
  $("technical-meta").innerHTML = `<div class="technical-meta"><span><strong>${t("technical.workflowId")}</strong>${escapeHtml(workflow.workflowId)}</span><span><strong>${t("projects.project")}</strong>${escapeHtml(workflow.project?.name || workflow.projectId || t("common.unavailable"))}</span><span><strong>${t("projects.workspace")}</strong><code>${escapeHtml(workflow.workspacePath || workflow.project?.workspacePath || workflow.project?.path || t("common.unavailable"))}</code></span><span><strong>${t("projects.session")}</strong><code>${escapeHtml(workflow.sessionId || t("common.unavailable"))}</code></span><span><strong>${t("technical.created")}</strong>${formatTime(workflow.createdAt)}</span><span><strong>${t("technical.updated")}</strong>${formatTime(workflow.updatedAt)}</span></div>`;
  $("task-list").innerHTML = (workflow.tasks || []).map((task) => { const artifacts = (task.attempts || []).flatMap((attempt) => Object.entries(attempt.artifactLinks || {}).map(([name, url]) => `<a href="${escapeHtml(url)}" target="_blank" rel="noreferrer">${escapeHtml(name)}</a>`)); return `<div class="technical-task"><div><strong>${escapeHtml(task.role || task.mode)}</strong>${badge(task.status)}</div><code>${escapeHtml(task.taskId)}</code><span>${escapeHtml(task.resourceProfile || task.settings?.resourceProfile || t("common.default"))}</span>${artifacts.length ? `<div class="artifact-links">${artifacts.join("")}</div>` : ""}</div>`; }).join("") || `<p class="muted">${t("technical.noTasks")}</p>`;
  $("event-count").textContent = String(orderedEvents.length); $("event-list").innerHTML = orderedEvents.length ? orderedEvents.map((event) => `<li><div><strong>${escapeHtml(event.type)}</strong><time>${formatTime(event.timestamp)}</time></div><small>${escapeHtml(event.role || event.source || "runtime")}</small><code>${escapeHtml(JSON.stringify(event.payload || {}))}</code></li>`).join("") : `<li class="muted">${t("technical.noEvents")}</li>`;
}

function renderArtifactCenter(artifacts) {
  const sections = [
    [language === "zh-CN" ? "方案" : "Plan", artifacts?.plan],
    [language === "zh-CN" ? "审批" : "Approval", artifacts?.approval],
    [language === "zh-CN" ? "执行证据" : "Execution Evidence", artifacts?.executionEvidence],
    [language === "zh-CN" ? "修改" : "Changes", artifacts?.changes],
    [language === "zh-CN" ? "审查" : "Review", artifacts?.review],
    [language === "zh-CN" ? "Memory 影响" : "Memory Impact", artifacts?.memoryImpact]
  ];
  $("artifact-center-content").innerHTML = sections.map(([title, value]) => `<section><h3>${escapeHtml(title)}</h3><pre>${escapeHtml(JSON.stringify(value ?? null, null, 2))}</pre></section>`).join("");
}

async function renderSelectedWorkflow() {
  if (!selectedWorkflowId) { selectedReviewPackage = null; selectedProjectIntelligence = null; selectedArtifacts = null; if (selectedProjectId) return renderProjectOverview(); $("project-overview").classList.add("hidden"); $("workflow-empty").classList.remove("hidden"); $("workflow-detail").classList.add("hidden"); return; }
  const [detailPayload, eventPayload, artifactPayload] = await Promise.all([requestJson(`/api/supervisor/workflows/${encodeURIComponent(selectedWorkflowId)}`), requestJson(`/api/supervisor/workflows/${encodeURIComponent(selectedWorkflowId)}/events?limit=500`), requestJson(`/api/supervisor/workflows/${encodeURIComponent(selectedWorkflowId)}/artifacts`)]);
  selectedWorkflow = detailPayload.workflow; const workflow = selectedWorkflow; const product = workflow.product || {};
  selectedArtifacts = artifactPayload.artifacts;
  if (TERMINAL.has(workflow.status)) {
    const reviewPayload = await requestJson(`/api/supervisor/workflows/${encodeURIComponent(selectedWorkflowId)}/review-package`);
    const intelligencePayload = await requestJson(`/api/supervisor/workflows/${encodeURIComponent(selectedWorkflowId)}/project-intelligence`);
    selectedReviewPackage = reviewPayload.reviewPackage;
    selectedProjectIntelligence = intelligencePayload.intelligence;
  } else { selectedReviewPackage = null; selectedProjectIntelligence = null; }
  if (renderedWorkflowId !== workflow.workflowId) { renderedWorkflowId = workflow.workflowId; selectedStageView = null; }
  $("project-overview").classList.add("hidden"); $("workflow-empty").classList.add("hidden"); $("workflow-detail").classList.remove("hidden");
  $("workflow-type").textContent = workflow.workflowPlan?.workflowType || workflow.definitionId || t("workflow.defaultType");
  const requestTitle = workflow.metadata?.displayName || workflow.userRequest;
  $("workflow-request").textContent = requestTitle;
  $("workflow-request").title = requestTitle;
  $("workflow-status").innerHTML = badge(workflow.status);
  $("workflow-summary").innerHTML = `<div><span>${t("projects.project")}</span><strong>${escapeHtml(workflow.project?.name || workflow.projectId || t("common.unavailable"))}</strong></div><div><span>${t("projects.workspace")}</span><strong title="${escapeHtml(workflow.workspacePath || "")}">${escapeHtml(workflow.workspacePath || workflow.project?.workspacePath || workflow.project?.path || t("common.unavailable"))}</strong></div><div><span>${t("workflow.currentStage")}</span><strong>${escapeHtml(statusLabel(workflow.currentStage))}</strong></div><div><span>${t("workflow.elapsed")}</span><strong>${formatDuration(workflow.durationSeconds)}</strong></div><div><span>${t("workflow.cost")}</span><strong>${formatCost(product.totalCostUsd)}</strong></div><div><span>${t("workflow.updated")}</span><strong>${formatTime(workflow.updatedAt)}</strong></div>`;
  $("next-action").innerHTML = `<span>${t("workflow.next")}</span><strong>${escapeHtml(product.nextAction || t("workflow.wait"))}</strong>`;
  renderDecision(workflow); renderApproval(workflow); renderImplementation(workflow); renderReview(workflow); renderSupervisorCollaboration(workflow, selectedReviewPackage, selectedProjectIntelligence); renderFailureRecovery(workflow); renderArtifactCenter(selectedArtifacts); renderTechnicalDetails(workflow, eventPayload.events || []); renderStageTimeline(workflow); applyHeroView(); renderWorkflowList();
}

async function refresh() {
  clearTimeout(timer);
  try {
    const [payload, folderPayload, projectPayload, preflightPayload] = await Promise.all([requestJson("/api/supervisor/workflows?limit=200"), requestJson("/api/supervisor/folders"), requestJson("/api/supervisor/projects"), requestJson("/api/supervisor/provider-preflight")]);
    workflows = payload.workflows || []; folders = folderPayload.folders || []; projects = projectPayload.projects || []; renderPreflight(preflightPayload.latest);
    if (selectedProjectId && !projects.some((project) => project.projectId === selectedProjectId)) { selectedProjectId = null; localStorage.removeItem("supervisor.selectedProjectId"); }
    if (!selectedProjectId && projects.length) {
      selectedProjectId = workflowProjectId(workflows.find((workflow) => !workflow.metadata?.archived) || workflows[0]) || projects[0].projectId;
      localStorage.setItem("supervisor.selectedProjectId", selectedProjectId);
    }
    const projectWorkflows = selectedProjectId ? workflows.filter((workflow) => workflowProjectId(workflow) === selectedProjectId) : workflows;
    if (selectedProjectId && selectedWorkflowId && !projectWorkflows.some((workflow) => workflow.workflowId === selectedWorkflowId)) selectedWorkflowId = null;
    if (selectedWorkflowId && !workflows.some((workflow) => workflow.workflowId === selectedWorkflowId)) selectedWorkflowId = null;
    renderOverview(); renderProjects(); renderWorkflowList(); await renderSelectedWorkflow();
    $("connection").textContent = t("connection.connected"); $("connection-dot").classList.add("online"); $("last-updated").textContent = t("connection.updated", { time: new Date().toLocaleTimeString(language) });
    timer = setTimeout(refresh, refreshDelay(workflows.some((workflow) => ACTIVE.has(workflow.status))));
  } catch (error) { showError(error); timer = setTimeout(refresh, 4000); }
}

function showError(error) { $("connection").textContent = t("connection.unavailable"); $("connection-dot").classList.remove("online"); $("last-updated").textContent = error.message; }

function openMetadataDialog(workflowId) {
  const workflow = workflows.find((item) => item.workflowId === workflowId); if (!workflow) return;
  $("workflow-metadata-form").dataset.workflowId = workflowId;
  $("metadata-display-name").value = workflow.metadata?.displayName || "";
  $("metadata-folder").innerHTML = folders.map((folder) => `<option value="${escapeHtml(folder.folderId)}">${escapeHtml(folderLabel(folder))}</option>`).join("");
  $("metadata-folder").value = workflow.metadata?.folderId || "default";
  $("metadata-archived").checked = Boolean(workflow.metadata?.archived);
  $("workflow-metadata-dialog").showModal();
}

function updateFolderDialogTitle() { $("folder-dialog-title").textContent = t($("folder-form").dataset.folderId ? "folders.renameTitle" : "folders.newTitle"); $("delete-folder").textContent = t($("delete-folder").dataset.confirming === "true" ? "folders.confirmDelete" : "folders.delete"); }
function openFolderDialog(folderId = null) {
  const folder = folderId ? folders.find((item) => item.folderId === folderId && !item.system) : null;
  if (folderId && !folder) return;
  $("folder-form").dataset.folderId = folder?.folderId || "";
  $("folder-name").value = folder?.name || "";
  $("delete-folder").classList.toggle("hidden", !folder);
  $("delete-folder").dataset.confirming = "false";
  $("delete-folder").textContent = t("folders.delete");
  $("folder-delete-note").classList.add("hidden");
  updateFolderDialogTitle();
  $("folder-dialog").showModal();
  $("folder-name").focus();
}

$("language-switch").addEventListener("change", () => { language = $("language-switch").value; localStorage.setItem("supervisor.language", language); renderStaticTranslations(); updateFolderDialogTitle(); renderPreflight(latestPreflight); renderOverview(); renderProjects(); renderWorkflowList(); if (selectedWorkflowId) { renderedWorkflowId = null; renderSelectedWorkflow().catch(showError); } else if (selectedProjectContinuity) renderProjectOverviewContent(); });
document.querySelectorAll("[data-project-view]").forEach((node) => node.addEventListener("click", () => { projectView = node.dataset.projectView; renderProjectOverviewContent(); }));
document.querySelectorAll("[data-hero-view]").forEach((node) => node.addEventListener("click", () => { heroView = node.dataset.heroView; applyHeroView(); }));
$("hide-recent").addEventListener("click", () => { recentCollapsed = true; localStorage.setItem("supervisor.recentCollapsed", "true"); applyRecentVisibility(); });
$("show-recent").addEventListener("click", () => { recentCollapsed = false; localStorage.setItem("supervisor.recentCollapsed", "false"); applyRecentVisibility(); });
$("new-task-form").addEventListener("submit", async (event) => { event.preventDefault(); if (actionPending) return; const userRequest = $("user-request").value.trim(); if (!userRequest) return; actionPending = true; $("create-task").disabled = true; setMessage(t("message.creating")); try { const payload = await postJson("/api/supervisor/workflows", { userRequest }); selectedWorkflowId = payload.workflow.workflowId; selectedStageView = null; $("user-request").value = ""; setMessage(t("message.created"), "success"); await refresh(); } catch (error) { if (error.payload?.status === "project_confirmation_required") { pendingDecision = error.payload.decision; $("project-options").innerHTML = pendingDecision.projectResolution.candidates.map((project) => `<option value="${escapeHtml(project.id)}">${escapeHtml(project.name)} — ${escapeHtml(project.path)}</option>`).join(""); $("project-confirmation").classList.remove("hidden"); $("local-entry").open = true; setMessage(t("message.chooseProject")); } else setMessage(error.message, "error"); } finally { actionPending = false; $("create-task").disabled = false; } });
$("confirm-project").addEventListener("click", async () => { if (actionPending || !pendingDecision) return; actionPending = true; try { const payload = await postJson("/api/supervisor/workflows", { userRequest: pendingDecision.originalRequest, decisionId: pendingDecision.decisionId, projectId: $("project-options").value }); selectedWorkflowId = payload.workflow.workflowId; selectedStageView = null; pendingDecision = null; $("project-confirmation").classList.add("hidden"); $("user-request").value = ""; setMessage(t("message.projectStarted"), "success"); await refresh(); } catch (error) { setMessage(error.message, "error"); } finally { actionPending = false; } });
$("cancel-project").addEventListener("click", () => { pendingDecision = null; $("project-confirmation").classList.add("hidden"); setMessage(t("message.projectCancelled")); });
$("approval-form").addEventListener("submit", async (event) => { event.preventDefault(); if (actionPending || !selectedWorkflowId) return; const approvedBy = $("reviewer-name").value.trim(); const approvalReason = $("decision-reason").value.trim(); if (!approvedBy || !approvalReason) return; actionPending = true; renderApproval(selectedWorkflow); setMessage(t("message.approving")); try { await postJson(`/api/supervisor/workflows/${encodeURIComponent(selectedWorkflowId)}/approve`, { approvedBy, approvalReason }); $("decision-reason").value = ""; setMessage(t("message.approved"), "success"); selectedStageView = "implementation"; await refresh(); } catch (error) { setMessage(error.message, "error"); } finally { actionPending = false; if (selectedWorkflow) renderApproval(selectedWorkflow); } });
$("reject-workflow").addEventListener("click", async () => { if (actionPending || !selectedWorkflowId) return; const rejectedBy = $("reviewer-name").value.trim(); const rejectionReason = $("decision-reason").value.trim(); if (!rejectedBy || !rejectionReason) { setMessage(t("message.rejectMissing"), "error"); return; } if (!window.confirm(t("message.rejectConfirm"))) return; actionPending = true; renderApproval(selectedWorkflow); try { await postJson(`/api/supervisor/workflows/${encodeURIComponent(selectedWorkflowId)}/reject`, { rejectedBy, rejectionReason }); $("decision-reason").value = ""; setMessage(t("message.rejected"), "success"); await refresh(); } catch (error) { setMessage(error.message, "error"); } finally { actionPending = false; if (selectedWorkflow) renderApproval(selectedWorkflow); } });
$("run-preflight").addEventListener("click", async () => { if (preflightPending) return; preflightPending = true; renderPreflight(null); setMessage(t("message.probing")); try { const payload = await postJson("/api/supervisor/provider-preflight", { timeoutSeconds: 60 }); renderPreflight(payload.result); setMessage(t("message.probeOk"), "success"); } catch (error) { renderPreflight(error.payload?.result || { status: "failed", classification: "preflight_error", message: error.message, checkedAt: new Date().toISOString() }); setMessage(error.payload?.result?.message || error.message, "error"); } finally { preflightPending = false; renderPreflight(latestPreflight); } });
$("recovery-form").addEventListener("submit", async (event) => { event.preventDefault(); if (actionPending || !selectedWorkflowId) return; const requestedBy = $("recovery-operator").value.trim(); const recoveryReason = $("recovery-reason").value.trim(); if (!requestedBy || !recoveryReason) return; actionPending = true; $("retry-workflow").disabled = true; setMessage(t("message.recovering")); try { const payload = await postJson(`/api/supervisor/workflows/${encodeURIComponent(selectedWorkflowId)}/retry`, { requestedBy, recoveryReason }); selectedWorkflowId = payload.workflow.workflowId; selectedStageView = null; $("recovery-reason").value = ""; setMessage(t("message.recovered"), "success"); await refresh(); } catch (error) { setMessage(error.message, "error"); } finally { actionPending = false; $("retry-workflow").disabled = false; } });
$("workflow-metadata-form").addEventListener("submit", async (event) => { event.preventDefault(); const workflowId = event.currentTarget.dataset.workflowId; try { await sendJson("PATCH", `/api/supervisor/workflows/${encodeURIComponent(workflowId)}/metadata`, { displayName: $("metadata-display-name").value.trim() || null, archived: $("metadata-archived").checked, folderId: $("metadata-folder").value }); $("workflow-metadata-dialog").close(); setMessage(t("message.metadataSaved"), "success"); await refresh(); } catch (error) { setMessage(error.message, "error"); } });
$("folder-form").addEventListener("submit", async (event) => { event.preventDefault(); const folderId = event.currentTarget.dataset.folderId; const name = $("folder-name").value.trim(); if (!name) return; try { const payload = folderId ? await sendJson("PATCH", `/api/supervisor/folders/${encodeURIComponent(folderId)}`, { name }) : await postJson("/api/supervisor/folders", { name }); const savedFolderId = payload.folder.folderId; openFolderIds.add(savedFolderId); persistOpenFolders(); $("folder-dialog").close(); setMessage(t(folderId ? "folders.updated" : "folders.created"), "success"); await refresh(); } catch (error) { setMessage(error.message, "error"); } });
$("delete-folder").addEventListener("click", async () => { const button = $("delete-folder"); const folderId = $("folder-form").dataset.folderId; const folder = folders.find((item) => item.folderId === folderId); if (!folder) return; if (button.dataset.confirming !== "true") { button.dataset.confirming = "true"; button.textContent = t("folders.confirmDelete"); $("folder-delete-note").classList.remove("hidden"); return; } try { await requestJson(`/api/supervisor/folders/${encodeURIComponent(folderId)}`, { method: "DELETE" }); openFolderIds.delete(folderId); openFolderIds.add("default"); persistOpenFolders(); $("folder-dialog").close(); setMessage(t("folders.deleted"), "success"); await refresh(); } catch (error) { setMessage(error.message, "error"); } });
$("create-folder").addEventListener("click", () => openFolderDialog());
$("metadata-close").addEventListener("click", () => $("workflow-metadata-dialog").close()); $("metadata-cancel").addEventListener("click", () => $("workflow-metadata-dialog").close());
$("folder-close").addEventListener("click", () => $("folder-dialog").close()); $("folder-cancel").addEventListener("click", () => $("folder-dialog").close()); $("refresh").addEventListener("click", refresh);
$("review-in-chatgpt").addEventListener("click", openChatGptReviewDialog);
$("chatgpt-review-close").addEventListener("click", () => $("chatgpt-review-dialog").close());
$("chatgpt-review-cancel").addEventListener("click", () => $("chatgpt-review-dialog").close());
$("copy-chatgpt-review").addEventListener("click", async () => {
  const prompt = $("chatgpt-review-prompt").value;
  try {
    await navigator.clipboard.writeText(prompt);
    $("copy-chatgpt-review").textContent = t("collaboration.copied");
  } catch {
    $("chatgpt-review-prompt").focus();
    $("chatgpt-review-prompt").select();
    document.execCommand("copy");
    $("copy-chatgpt-review").textContent = t("collaboration.copied");
  }
});
$("memory-apply-close").addEventListener("click", () => $("memory-apply-dialog").close());
$("memory-apply-cancel").addEventListener("click", () => $("memory-apply-dialog").close());
$("memory-apply-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (actionPending || !selectedWorkflowId || !$("memory-confirmed").checked) return;
  const appliedBy = $("memory-applied-by").value.trim();
  const confirmationReason = $("memory-confirmation-reason").value.trim();
  if (!appliedBy || !confirmationReason) return;
  actionPending = true; $("confirm-memory-apply").disabled = true;
  try {
    await postJson(`/api/supervisor/workflows/${encodeURIComponent(selectedWorkflowId)}/memory-proposal/apply`, { proposalId: event.currentTarget.dataset.proposalId, appliedBy, confirmationReason, confirmed: true });
    $("memory-apply-dialog").close(); setMessage(t("intelligence.applied"), "success"); await refresh();
  } catch (error) { setMessage(error.message, "error"); }
  finally { actionPending = false; $("confirm-memory-apply").disabled = false; }
});

renderStaticTranslations(); renderPreflight(null); applyRecentVisibility(); applyHeroView(); refresh();
