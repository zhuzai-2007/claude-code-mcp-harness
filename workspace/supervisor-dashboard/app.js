import { refreshDelay } from "./refresh-policy.mjs";
import { detectLanguage, translate } from "./i18n.mjs";
import { defaultStageView, groupProjects, groupProjectWorkflows, isStageViewable, sortEventsNewestFirst, stageViewForRole, workflowsForProjectScope } from "./dashboard-model.mjs";
import { fetchDashboardJson } from "./dashboard-request.mjs";

const $ = (id) => document.getElementById(id);
const ACTIVE = new Set(["created", "queued", "planning", "planned", "waiting_approval", "running", "reviewing"]);
const TERMINAL = new Set(["completed", "succeeded", "failed"]);
let workflows = [];
let projects = [];
let selectedProjectId = localStorage.getItem("supervisor.selectedProjectId") || null;
let projectScope = localStorage.getItem("supervisor.projectScope") || "project";
if (projectScope === "legacy") {
  projectScope = "project";
  localStorage.setItem("supervisor.projectScope", projectScope);
  localStorage.removeItem("supervisor.legacyWorkflowsOpen");
}
let selectedWorkflowId = null;
let selectedWorkflow = null;
let selectedReviewPackage = null;
let selectedProjectIntelligence = null;
let selectedProjectContinuity = null;
let selectedArtifacts = null;
let projectView = "brief";
let selectedStageView = null;
let heroView = "timeline";
let renderedWorkflowId = null;
let timer = null;
let actionPending = false;
let mutationPending = false;
let preflightPending = false;
let latestPreflight = null;
let settingsSnapshot = null;
let refreshGeneration = 0;
let projectContinuityLoadedAt = 0;
let projectContinuityProjectId = null;
let language = detectLanguage({ stored: localStorage.getItem("supervisor.language"), languages: navigator.languages });
let theme = ["light", "dark"].includes(localStorage.getItem("supervisor.theme")) ? localStorage.getItem("supervisor.theme") : "system";
let expandedProjectIds = (() => {
  try { return new Set(JSON.parse(localStorage.getItem("supervisor.expandedProjects") || "[]")); }
  catch { return new Set(); }
})();
let openWorkflowArchiveProjectIds = new Set();
let archivedProjectsOpen = localStorage.getItem("supervisor.archivedProjectsOpen") === "true";

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
  $("entry-project-select").setAttribute("aria-label", t("entry.project"));
  const themeOptions = { system: language === "zh-CN" ? "跟随系统" : "System", light: language === "zh-CN" ? "浅色" : "Light", dark: language === "zh-CN" ? "深色" : "Dark" };
  for (const option of $("theme-switch").options) option.textContent = themeOptions[option.value];
}

function applyTheme() {
  if (theme === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.dataset.theme = theme;
  $("theme-switch").value = theme;
}

function selectProjectScope(scope, projectId = null) {
  projectScope = scope;
  selectedProjectId = scope === "project" ? projectId : null;
  if (selectedProjectId) expandedProjectIds.add(selectedProjectId);
  localStorage.setItem("supervisor.expandedProjects", JSON.stringify([...expandedProjectIds]));
  localStorage.setItem("supervisor.projectScope", scope);
  if (selectedProjectId) localStorage.setItem("supervisor.selectedProjectId", selectedProjectId);
  selectedWorkflowId = null;
  selectedStageView = null;
  projectView = "brief";
  projectContinuityLoadedAt = 0;
  renderProjects();
  renderSelectedWorkflow().catch(showError);
}

function resourceEstimateHtml(estimate) {
  if (!estimate) return `<p class="muted">${escapeHtml(t("common.none"))}</p>`;
  const expected = estimate.expected || {};
  const hard = estimate.hard_caps || {};
  return `<div class="resource-forecast"><span><strong>${escapeHtml(estimate.complexity || "unknown")}</strong>${language === "zh-CN" ? "复杂度" : "complexity"}</span><span><strong>${formatCost(expected.budgetUsd)}</strong>${language === "zh-CN" ? "预计成本" : "expected cost"}</span><span><strong>${expected.turns || 0}</strong>${language === "zh-CN" ? "预计 turns" : "expected turns"}</span><span><strong>${expected.filesRead || 0}</strong>${language === "zh-CN" ? "预计读取" : "expected reads"}</span><span><strong>${formatCost(hard.budgetUsd)}</strong>${language === "zh-CN" ? "硬上限" : "hard caps"}</span><span><strong>${hard.timeoutSeconds || 0}s</strong>${language === "zh-CN" ? "阶段最长时间" : "max stage time"}</span></div>${listHtml(estimate.notes)}`;
}

async function requestJson(url, { timeoutMs = 15000, ...options } = {}) {
  return fetchDashboardJson(url, { timeoutMs, language, ...options });
}
const sendJson = (method, url, body, options = {}) => requestJson(url, { ...options, method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const postJson = (url, body, options = {}) => sendJson("POST", url, body, options);

function setMessage(message, tone = "info") { $("action-message").textContent = message || ""; $("action-message").dataset.tone = tone; }
function setDialogMessage(id, message = "", tone = "info") { const node = $(id); node.textContent = message; node.dataset.tone = tone; }
function setFormBusy(form, busy) { form.setAttribute("aria-busy", String(busy)); form.querySelectorAll("button,input,select,textarea").forEach((control) => { if (busy) { control.dataset.wasDisabled = String(control.disabled); control.disabled = true; } else { control.disabled = control.dataset.wasDisabled === "true"; delete control.dataset.wasDisabled; } }); }
async function runDialogMutation({ form, messageId, operation }) {
  if (mutationPending) return null;
  mutationPending = true;
  setDialogMessage(messageId, language === "zh-CN" ? "正在保存…" : "Saving…");
  setFormBusy(form, true);
  try { return await operation(); }
  catch (error) { setDialogMessage(messageId, error.message, "error"); setMessage(error.message, "error"); return null; }
  finally { mutationPending = false; setFormBusy(form, false); }
}

const RESOURCE_FIELD_LABELS = {
  maxBudgetUsd: { en: "Budget (USD)", zh: "预算（美元）" },
  maxTurns: { en: "Maximum turns", zh: "最大 turns" },
  maxFilesRead: { en: "Files read", zh: "读取文件数" },
  maxCommands: { en: "Commands", zh: "命令数" },
  timeoutSeconds: { en: "Timeout (seconds)", zh: "超时（秒）" }
};

function localizedLabel(labels) { return language === "zh-CN" ? labels.zh : labels.en; }
function resourceInput({ owner, field, value, maximum, absolute = null }) {
  const step = field === "maxBudgetUsd" ? "0.1" : "1";
  const detail = absolute === null
    ? (language === "zh-CN" ? `安全锁：${maximum}` : `Locked at ${maximum}`)
    : (language === "zh-CN" ? `代码上限：${absolute}` : `Immutable cap ${absolute}`);
  return `<label class="resource-field"><span>${escapeHtml(localizedLabel(RESOURCE_FIELD_LABELS[field]))}</span><input type="number" min="${step}" step="${step}" max="${escapeHtml(absolute ?? maximum)}" value="${escapeHtml(value)}" data-resource-owner="${escapeHtml(owner)}" data-resource-field="${field}" required><small>${escapeHtml(detail)}</small></label>`;
}

function renderSettings(settings) {
  settingsSnapshot = settings;
  const resources = settings.resources;
  $("settings-default-profile").innerHTML = Object.keys(resources.profiles).map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join("");
  $("settings-default-profile").value = resources.defaultProfile;
  $("settings-hard-limits").innerHTML = Object.keys(RESOURCE_FIELD_LABELS).map((field) => resourceInput({ owner: "hardLimits", field, value: resources.hardLimits[field], maximum: resources.absoluteLimits[field], absolute: resources.absoluteLimits[field] })).join("");
  $("settings-profiles").innerHTML = Object.entries(resources.profiles).map(([name, profile]) => `<article class="resource-profile-card"><div class="resource-profile-heading"><strong>${escapeHtml(name)}</strong>${name === resources.defaultProfile ? `<span>${language === "zh-CN" ? "默认" : "Default"}</span>` : ""}</div><div class="resource-fields">${Object.keys(RESOURCE_FIELD_LABELS).map((field) => resourceInput({ owner: `profile:${name}`, field, value: profile[field], maximum: resources.hardLimits[field] })).join("")}</div></article>`).join("");

  const runtime = settings.runtime || {};
  const retention = runtime.retention;
  const safetyItems = language === "zh-CN"
    ? ["显式人工审批", "严格审计契约", "Side-effect Guard", "网络 / Git 写入 / 递归删除默认禁止"]
    : ["Explicit human approval", "Strict audit contract", "Side-effect Guard", "Network / Git writes / recursive deletion denied by default"];
  const runtimeFacts = [
    `${language === "zh-CN" ? "最大并发 Task" : "Concurrent Tasks"}: ${runtime.maxConcurrentTasks ?? "—"}`,
    `${language === "zh-CN" ? "心跳 / 停滞阈值" : "Heartbeat / stalled threshold"}: ${runtime.heartbeatSeconds ?? "—"}s / ${runtime.stalledAfterSeconds ?? "—"}s`,
    retention ? `${language === "zh-CN" ? "数据保留" : "Retention"}: ${retention.enabled === false ? (language === "zh-CN" ? "关闭" : "off") : `${retention.maxAgeDays ?? "—"} ${language === "zh-CN" ? "天" : "days"}`} · ${language === "zh-CN" ? "启动时应用" : "applied at startup"}` : null
  ].filter(Boolean);
  $("settings-runtime").innerHTML = `<div class="governance-card"><strong>${language === "zh-CN" ? "固定安全边界" : "Locked safety boundaries"}</strong><ul>${safetyItems.map((item) => `<li><span aria-hidden="true">✓</span>${escapeHtml(item)}</li>`).join("")}</ul></div><div class="governance-card"><strong>${language === "zh-CN" ? "运行参数（只读）" : "Runtime parameters (read-only)"}</strong><ul>${runtimeFacts.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></div>`;
}

async function openSettingsDialog() {
  setDialogMessage("settings-message", language === "zh-CN" ? "正在读取设置…" : "Loading settings…");
  $("settings-dialog").showModal();
  setFormBusy($("settings-form"), true);
  try {
    const payload = await requestJson("/api/supervisor/settings");
    renderSettings(payload.settings);
    setDialogMessage("settings-message");
  } catch (error) {
    setDialogMessage("settings-message", error.message, "error");
  } finally { setFormBusy($("settings-form"), false); }
}

function collectResourceSettings() {
  if (!settingsSnapshot) throw new Error(language === "zh-CN" ? "设置尚未加载。" : "Settings have not loaded.");
  const resources = settingsSnapshot.resources;
  const next = { defaultProfile: $("settings-default-profile").value, hardLimits: {}, profiles: {} };
  for (const name of Object.keys(resources.profiles)) next.profiles[name] = {};
  for (const input of $("settings-form").querySelectorAll("[data-resource-owner]")) {
    const value = Number(input.value);
    if (input.dataset.resourceOwner === "hardLimits") next.hardLimits[input.dataset.resourceField] = value;
    else next.profiles[input.dataset.resourceOwner.slice("profile:".length)][input.dataset.resourceField] = value;
  }
  return next;
}

function setArchivedProjectsOpen(open) {
  archivedProjectsOpen = Boolean(open);
  localStorage.setItem("supervisor.archivedProjectsOpen", String(archivedProjectsOpen));
  $("archived-projects").open = archivedProjectsOpen;
}

async function restoreArchivedProject(projectId, button) {
  if (mutationPending) return;
  mutationPending = true;
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = language === "zh-CN" ? "恢复中…" : "Restoring…";
  try {
    const payload = await sendJson("PATCH", `/api/supervisor/projects/${encodeURIComponent(projectId)}`, { archived: false });
    selectedProjectId = payload.project.projectId;
    projectScope = "project";
    expandedProjectIds.add(selectedProjectId);
    projectContinuityLoadedAt = 0;
    localStorage.setItem("supervisor.selectedProjectId", selectedProjectId);
    localStorage.setItem("supervisor.projectScope", projectScope);
    localStorage.setItem("supervisor.expandedProjects", JSON.stringify([...expandedProjectIds]));
    setMessage(language === "zh-CN" ? `Project“${payload.project.name}”已恢复到活动列表。` : `Project “${payload.project.name}” was restored to Active Projects.`, "success");
    await refresh();
  } catch (error) {
    setMessage(error.message, "error");
  } finally {
    mutationPending = false;
    if (button.isConnected) { button.disabled = false; button.textContent = originalText; }
  }
}

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

async function renderProjectOverview({ force = false, generation = null } = {}) {
  if (!selectedProjectId) { $("project-overview").classList.add("hidden"); return; }
  const requestedProjectId = selectedProjectId;
  if (generation !== null && generation !== refreshGeneration) return;
  const cacheFresh = !force && selectedProjectContinuity && projectContinuityProjectId === selectedProjectId && Date.now() - projectContinuityLoadedAt < 5000;
  if (!cacheFresh) {
    const payload = await requestJson(`/api/supervisor/projects/${encodeURIComponent(requestedProjectId)}/continuity`);
    if (requestedProjectId !== selectedProjectId || (generation !== null && generation !== refreshGeneration)) return;
    selectedProjectContinuity = payload.context;
    projectContinuityProjectId = selectedProjectId;
    projectContinuityLoadedAt = Date.now();
  }
  const context = selectedProjectContinuity;
  $("workflow-empty").classList.add("hidden"); $("workflow-detail").classList.add("hidden"); $("project-overview").classList.remove("hidden");
  $("project-overview-name").textContent = context.project.name;
  $("project-overview-description").textContent = context.project.description || context.project.workspacePath;
  $("project-overview-status").innerHTML = badge(context.health?.status || context.brief.currentStatus);
  renderProjectOverviewContent();
}

function renderEntryProjectSelector(activeProjects, selectedProject) {
  const select = $("entry-project-select");
  const signature = `${language}:${activeProjects.map((project) => `${project.projectId}:${project.name}`).join("|")}`;
  if (select.dataset.signature !== signature) {
    const emptyLabel = language === "zh-CN" ? "选择一个活动 Project" : "Select an active Project";
    select.innerHTML = `<option value="">${escapeHtml(emptyLabel)}</option>${activeProjects.map((project) => `<option value="${escapeHtml(project.projectId)}">${escapeHtml(project.name)}</option>`).join("")}`;
    select.dataset.signature = signature;
  }
  select.value = selectedProject?.projectId || "";
  select.disabled = !activeProjects.length || actionPending;
}

function renderProjects() {
  $("project-count").textContent = String(projects.length);
  const grouped = groupProjects(projects);
  if (grouped.archived.some((project) => project.projectId === selectedProjectId)) archivedProjectsOpen = true;
  setArchivedProjectsOpen(archivedProjectsOpen);
  const projectItem = (project) => {
    const projectWorkflows = workflowsForProjectScope(workflows, { projectId: project.projectId });
    const workflowGroups = groupProjectWorkflows(projectWorkflows);
    const count = projectWorkflows.length;
    const active = projectScope === "project" && selectedProjectId === project.projectId ? " active" : "";
    const open = expandedProjectIds.has(project.projectId);
    const activeWorkflows = workflowGroups.active.map(workflowListItem).join("") || (!workflowGroups.archived.length ? `<div class="project-workflow-empty">${escapeHtml(t("recent.empty"))}</div>` : "");
    const archivedWorkflows = workflowGroups.archived.length ? `<details class="workflow-archive-group" data-workflow-archive="${escapeHtml(project.projectId)}"${openWorkflowArchiveProjectIds.has(project.projectId) ? " open" : ""}><summary><span>${escapeHtml(t("recent.archived"))}</span><strong>${workflowGroups.archived.length}</strong></summary><div>${workflowGroups.archived.map(workflowListItem).join("")}</div></details>` : "";
    const restoreAction = project.archived ? `<button class="project-restore-button" type="button" data-restore-project="${escapeHtml(project.projectId)}">${escapeHtml(language === "zh-CN" ? "恢复" : "Restore")}</button>` : "";
    return `<section class="project-node${active}${open ? " open" : ""}${project.archived ? " archived" : ""}" data-project-node="${escapeHtml(project.projectId)}"><div class="project-item"><button class="project-expand" type="button" data-toggle-project="${escapeHtml(project.projectId)}" aria-expanded="${open}" aria-label="${escapeHtml(open ? (language === "zh-CN" ? "收起 Project" : "Collapse Project") : (language === "zh-CN" ? "展开 Project" : "Expand Project"))}"><span>›</span></button><button class="project-item-main" type="button" data-project-id="${escapeHtml(project.projectId)}"><span class="project-mark" aria-hidden="true">${project.pinned ? "◆" : "◇"}</span><span><strong>${escapeHtml(project.name)}</strong><small>${escapeHtml(project.managed ? (language === "zh-CN" ? "受管 Project" : "Managed Project") : (language === "zh-CN" ? "系统 Project" : "System Project"))}</small></span><em>${count}</em></button>${restoreAction}<button class="project-item-action" type="button" data-manage-project="${escapeHtml(project.projectId)}" aria-label="${escapeHtml(language === "zh-CN" ? "管理 Project" : "Manage Project")}">•••</button></div><div class="project-workflows${open ? "" : " hidden"}">${activeWorkflows}${archivedWorkflows}</div></section>`;
  };
  $("active-project-list").innerHTML = grouped.active.map(projectItem).join("") || `<p class="project-empty">${escapeHtml(language === "zh-CN" ? "暂无活动 Project" : "No active Projects")}</p>`;
  $("archived-project-list").innerHTML = grouped.archived.map(projectItem).join("") || `<p class="project-empty">${escapeHtml(language === "zh-CN" ? "暂无归档 Project" : "No archived Projects")}</p>`;
  $("archived-project-count").textContent = String(grouped.archived.length);
  $("global-archive-count").textContent = String(workflows.filter((workflow) => workflow.metadata?.archived).length);
  $("global-archived-workflows").classList.toggle("active", projectScope === "global_archive");
  const globalArchiveWorkflows = workflowsForProjectScope(workflows, { scope: "global_archive" });
  $("global-archive-workflows-list").innerHTML = globalArchiveWorkflows.map(workflowListItem).join("") || `<div class="project-workflow-empty">${escapeHtml(t("recent.empty"))}</div>`;
  const selected = projects.find((project) => project.projectId === selectedProjectId);
  $("project-summary").classList.toggle("hidden", !selected);
  if (selected) {
    const workflowCount = workflows.filter((workflow) => workflowProjectId(workflow) === selected.projectId).length;
    $("project-summary").innerHTML = `<strong>${escapeHtml(selected.name)}</strong><code title="${escapeHtml(selected.workspacePath)}">${escapeHtml(selected.workspacePath)}</code><span>${workflowCount} Workflow${workflowCount === 1 ? "" : "s"}</span>`;
  }
  const entryProject = projectScope === "project" ? selected : null;
  renderEntryProjectSelector(grouped.active, entryProject && !entryProject.archived ? entryProject : null);
  $("create-task").disabled = !entryProject || entryProject.archived || actionPending;
  const tree = document.querySelector(".project-tree");
  tree.querySelectorAll("[data-project-id]").forEach((node) => node.addEventListener("click", () => selectProjectScope("project", node.dataset.projectId)));
  tree.querySelectorAll("[data-toggle-project]").forEach((node) => node.addEventListener("click", () => {
    const projectId = node.dataset.toggleProject;
    if (expandedProjectIds.has(projectId)) expandedProjectIds.delete(projectId); else expandedProjectIds.add(projectId);
    localStorage.setItem("supervisor.expandedProjects", JSON.stringify([...expandedProjectIds]));
    renderProjects();
  }));
  tree.querySelectorAll("[data-manage-project]").forEach((node) => node.addEventListener("click", () => openProjectDialog(node.dataset.manageProject)));
  tree.querySelectorAll("[data-restore-project]").forEach((node) => node.addEventListener("click", () => restoreArchivedProject(node.dataset.restoreProject, node)));
  tree.querySelectorAll("[data-workflow-archive]").forEach((node) => node.addEventListener("toggle", () => { if (node.open) openWorkflowArchiveProjectIds.add(node.dataset.workflowArchive); else openWorkflowArchiveProjectIds.delete(node.dataset.workflowArchive); }));
  tree.querySelectorAll("[data-workflow-id]").forEach((node) => node.addEventListener("click", () => {
    selectedWorkflowId = node.dataset.workflowId;
    const boundProjectId = workflowProjectId(workflows.find((workflow) => workflow.workflowId === selectedWorkflowId));
    if (boundProjectId) { selectedProjectId = boundProjectId; projectScope = "project"; expandedProjectIds.add(boundProjectId); localStorage.setItem("supervisor.selectedProjectId", boundProjectId); localStorage.setItem("supervisor.projectScope", "project"); localStorage.setItem("supervisor.expandedProjects", JSON.stringify([...expandedProjectIds])); }
    selectedStageView = null;
    renderSelectedWorkflow().catch(showError);
  }));
  tree.querySelectorAll("[data-manage-workflow]").forEach((node) => node.addEventListener("click", () => openMetadataDialog(node.dataset.manageWorkflow)));
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

async function renderSelectedWorkflow({ generation = null } = {}) {
  if (!selectedWorkflowId) { selectedReviewPackage = null; selectedProjectIntelligence = null; selectedArtifacts = null; if (selectedProjectId) return renderProjectOverview({ generation }); $("project-overview").classList.add("hidden"); $("workflow-empty").classList.remove("hidden"); $("workflow-detail").classList.add("hidden"); return; }
  const requestedWorkflowId = selectedWorkflowId;
  const [detailPayload, eventPayload, artifactPayload] = await Promise.all([requestJson(`/api/supervisor/workflows/${encodeURIComponent(selectedWorkflowId)}`), requestJson(`/api/supervisor/workflows/${encodeURIComponent(selectedWorkflowId)}/events?limit=500`), requestJson(`/api/supervisor/workflows/${encodeURIComponent(selectedWorkflowId)}/artifacts`)]);
  if (requestedWorkflowId !== selectedWorkflowId || (generation !== null && generation !== refreshGeneration)) return;
  selectedWorkflow = detailPayload.workflow; const workflow = selectedWorkflow; const product = workflow.product || {};
  selectedArtifacts = artifactPayload.artifacts;
  if (TERMINAL.has(workflow.status)) {
    const reviewPayload = await requestJson(`/api/supervisor/workflows/${encodeURIComponent(selectedWorkflowId)}/review-package`);
    const intelligencePayload = await requestJson(`/api/supervisor/workflows/${encodeURIComponent(selectedWorkflowId)}/project-intelligence`);
    if (requestedWorkflowId !== selectedWorkflowId || (generation !== null && generation !== refreshGeneration)) return;
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
  renderDecision(workflow); renderApproval(workflow); renderImplementation(workflow); renderReview(workflow); renderSupervisorCollaboration(workflow, selectedReviewPackage, selectedProjectIntelligence); renderFailureRecovery(workflow); renderArtifactCenter(selectedArtifacts); renderTechnicalDetails(workflow, eventPayload.events || []); renderStageTimeline(workflow); applyHeroView(); renderProjects();
}

async function refresh() {
  clearTimeout(timer);
  const generation = ++refreshGeneration;
  try {
    const [payload, projectPayload, preflightPayload] = await Promise.all([requestJson("/api/supervisor/workflows?limit=200"), requestJson("/api/supervisor/projects?compact=1"), requestJson("/api/supervisor/provider-preflight")]);
    if (generation !== refreshGeneration) return;
    workflows = payload.workflows || []; projects = projectPayload.projects || []; renderPreflight(preflightPayload.latest);
    if (selectedProjectId && !projects.some((project) => project.projectId === selectedProjectId)) { selectedProjectId = null; localStorage.removeItem("supervisor.selectedProjectId"); }
    if (projectScope === "project" && !selectedProjectId) {
      const activeProjects = groupProjects(projects).active;
      selectedProjectId = activeProjects[0]?.projectId || null;
    }
    if (selectedProjectId) {
      localStorage.setItem("supervisor.selectedProjectId", selectedProjectId);
    }
    const scopedWorkflows = workflowsForProjectScope(workflows, { scope: projectScope, projectId: selectedProjectId });
    if (selectedWorkflowId && !scopedWorkflows.some((workflow) => workflow.workflowId === selectedWorkflowId)) selectedWorkflowId = null;
    if (selectedWorkflowId && !workflows.some((workflow) => workflow.workflowId === selectedWorkflowId)) selectedWorkflowId = null;
    renderOverview(); renderProjects(); await renderSelectedWorkflow({ generation });
    if (generation !== refreshGeneration) return;
    $("connection").textContent = t("connection.connected"); $("connection-dot").classList.add("online"); $("last-updated").textContent = t("connection.updated", { time: new Date().toLocaleTimeString(language) });
    timer = setTimeout(refresh, refreshDelay(workflows.some((workflow) => ACTIVE.has(workflow.status))));
  } catch (error) { if (generation !== refreshGeneration) return; showError(error); timer = setTimeout(refresh, 4000); }
}

function showError(error) { $("connection").textContent = t("connection.unavailable"); $("connection-dot").classList.remove("online"); $("last-updated").textContent = error.message; }

function openMetadataDialog(workflowId) {
  const workflow = workflows.find((item) => item.workflowId === workflowId); if (!workflow) return;
  setDialogMessage("workflow-metadata-message");
  $("workflow-metadata-form").dataset.workflowId = workflowId;
  $("metadata-display-name").value = workflow.metadata?.displayName || "";
  $("metadata-archived").checked = Boolean(workflow.metadata?.archived);
  $("metadata-archived").disabled = !workflow.metadata?.archived && !TERMINAL.has(workflow.status);
  $("workflow-metadata-dialog").showModal();
}

function openProjectDialog(projectId = null) {
  const project = projectId ? projects.find((item) => item.projectId === projectId) : null;
  if (projectId && !project) return;
  setDialogMessage("project-dialog-message");
  $("project-form").dataset.projectId = project?.projectId || "";
  $("project-name").value = project?.name || "";
  $("project-name").disabled = Boolean(project && !project.managed);
  $("project-pin-row").classList.toggle("hidden", !project);
  $("project-archive-row").classList.toggle("hidden", !project || project.system);
  $("project-pinned").checked = Boolean(project?.pinned);
  $("project-archived").checked = Boolean(project?.archived);
  $("project-dialog-title").textContent = project ? (language === "zh-CN" ? "Project 设置" : "Project settings") : (language === "zh-CN" ? "新建 Project" : "New Project");
  $("project-dialog-description").textContent = project ? (project.managed ? (language === "zh-CN" ? "重命名会同步变更 workspace 下的受管目录；Project ID 保持不变。" : "Renaming also moves the managed workspace directory; the Project ID stays stable.") : (language === "zh-CN" ? "系统 Project 的目录和名称不可修改。" : "A system Project path and name cannot be changed.")) : (language === "zh-CN" ? "目录仅会创建在 workspace 根目录下。" : "The directory is created only under the workspace root.");
  $("project-managed-note").textContent = project?.workspacePath || (language === "zh-CN" ? "不会扫描或导入未注册目录。" : "Unregistered directories are never scanned or imported.");
  $("project-dialog").showModal();
  if (!$("project-name").disabled) $("project-name").focus();
}

$("language-switch").addEventListener("change", () => { language = $("language-switch").value; localStorage.setItem("supervisor.language", language); renderStaticTranslations(); renderPreflight(latestPreflight); renderOverview(); renderProjects(); if ($("settings-dialog").open && settingsSnapshot) renderSettings(settingsSnapshot); if (selectedWorkflowId) { renderedWorkflowId = null; renderSelectedWorkflow().catch(showError); } else if (selectedProjectContinuity) renderProjectOverviewContent(); });
$("theme-switch").addEventListener("change", () => { theme = $("theme-switch").value; if (theme === "system") localStorage.removeItem("supervisor.theme"); else localStorage.setItem("supervisor.theme", theme); applyTheme(); });
document.querySelectorAll("[data-project-view]").forEach((node) => node.addEventListener("click", () => { projectView = node.dataset.projectView; renderProjectOverviewContent(); }));
document.querySelectorAll("[data-hero-view]").forEach((node) => node.addEventListener("click", () => { heroView = node.dataset.heroView; applyHeroView(); }));
$("entry-project-select").addEventListener("change", (event) => { if (event.currentTarget.value) selectProjectScope("project", event.currentTarget.value); });
$("new-task-form").addEventListener("submit", async (event) => { event.preventDefault(); if (actionPending) return; const userRequest = $("user-request").value.trim(); const project = projects.find((item) => item.projectId === selectedProjectId && !item.archived); if (!userRequest || projectScope !== "project" || !project) { setMessage(language === "zh-CN" ? "请先选择一个活动 Project。" : "Select an active Project first.", "error"); return; } actionPending = true; $("create-task").disabled = true; setMessage(t("message.creating")); try { const payload = await postJson("/api/supervisor/workflows", { userRequest, projectId: project.projectId }); selectedWorkflowId = payload.workflow.workflowId; selectedStageView = null; $("user-request").value = ""; setMessage(t("message.created"), "success"); await refresh(); } catch (error) { setMessage(error.message, "error"); } finally { actionPending = false; renderProjects(); } });
$("approval-form").addEventListener("submit", async (event) => { event.preventDefault(); if (actionPending || !selectedWorkflowId) return; const approvedBy = $("reviewer-name").value.trim(); const approvalReason = $("decision-reason").value.trim(); if (!approvedBy || !approvalReason) return; actionPending = true; renderApproval(selectedWorkflow); setMessage(t("message.approving")); try { await postJson(`/api/supervisor/workflows/${encodeURIComponent(selectedWorkflowId)}/approve`, { approvedBy, approvalReason }); $("decision-reason").value = ""; setMessage(t("message.approved"), "success"); selectedStageView = "implementation"; await refresh(); } catch (error) { setMessage(error.message, "error"); } finally { actionPending = false; if (selectedWorkflow) renderApproval(selectedWorkflow); } });
$("reject-workflow").addEventListener("click", async () => { if (actionPending || !selectedWorkflowId) return; const rejectedBy = $("reviewer-name").value.trim(); const rejectionReason = $("decision-reason").value.trim(); if (!rejectedBy || !rejectionReason) { setMessage(t("message.rejectMissing"), "error"); return; } if (!window.confirm(t("message.rejectConfirm"))) return; actionPending = true; renderApproval(selectedWorkflow); try { await postJson(`/api/supervisor/workflows/${encodeURIComponent(selectedWorkflowId)}/reject`, { rejectedBy, rejectionReason }); $("decision-reason").value = ""; setMessage(t("message.rejected"), "success"); await refresh(); } catch (error) { setMessage(error.message, "error"); } finally { actionPending = false; if (selectedWorkflow) renderApproval(selectedWorkflow); } });
$("run-preflight").addEventListener("click", async () => { if (preflightPending) return; preflightPending = true; renderPreflight(null); setMessage(t("message.probing")); try { const payload = await postJson("/api/supervisor/provider-preflight", { timeoutSeconds: 60 }, { timeoutMs: 70000 }); renderPreflight(payload.result); setMessage(t("message.probeOk"), "success"); } catch (error) { renderPreflight(error.payload?.result || { status: "failed", classification: "preflight_error", message: error.message, checkedAt: new Date().toISOString() }); setMessage(error.payload?.result?.message || error.message, "error"); } finally { preflightPending = false; renderPreflight(latestPreflight); } });
$("recovery-form").addEventListener("submit", async (event) => { event.preventDefault(); if (actionPending || !selectedWorkflowId) return; const requestedBy = $("recovery-operator").value.trim(); const recoveryReason = $("recovery-reason").value.trim(); if (!requestedBy || !recoveryReason) return; actionPending = true; $("retry-workflow").disabled = true; setMessage(t("message.recovering")); try { const payload = await postJson(`/api/supervisor/workflows/${encodeURIComponent(selectedWorkflowId)}/retry`, { requestedBy, recoveryReason }); selectedWorkflowId = payload.workflow.workflowId; selectedStageView = null; $("recovery-reason").value = ""; setMessage(t("message.recovered"), "success"); await refresh(); } catch (error) { setMessage(error.message, "error"); } finally { actionPending = false; $("retry-workflow").disabled = false; } });
$("workflow-metadata-form").addEventListener("submit", async (event) => { event.preventDefault(); const form = event.currentTarget; const workflowId = form.dataset.workflowId; const archiveRequested = $("metadata-archived").checked; const payload = await runDialogMutation({ form, messageId: "workflow-metadata-message", operation: () => sendJson("PATCH", `/api/supervisor/workflows/${encodeURIComponent(workflowId)}/metadata`, { displayName: $("metadata-display-name").value.trim() || null, archived: archiveRequested }) }); if (!payload) return; const projectId = workflowProjectId(workflows.find((workflow) => workflow.workflowId === workflowId)); if (archiveRequested && projectId) openWorkflowArchiveProjectIds.add(projectId); $("workflow-metadata-dialog").close(); setMessage(t("message.metadataSaved"), "success"); await refresh(); });
$("project-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const projectId = form.dataset.projectId;
  const name = $("project-name").value.trim();
  if (!name) return;
  let update = null;
  if (projectId) {
    const project = projects.find((item) => item.projectId === projectId);
    if (!project) { setDialogMessage("project-dialog-message", language === "zh-CN" ? "Project 已刷新，请关闭后重试。" : "The Project changed. Close this dialog and try again.", "error"); return; }
    update = {};
    if (project.pinned !== $("project-pinned").checked) update.pinned = $("project-pinned").checked;
    if (!project.system && project.archived !== $("project-archived").checked) update.archived = $("project-archived").checked;
    if (project.managed && project.name !== name) update.name = name;
    if (!Object.keys(update).length) { $("project-dialog").close(); return; }
  }
  const payload = await runDialogMutation({ form, messageId: "project-dialog-message", operation: () => projectId ? sendJson("PATCH", `/api/supervisor/projects/${encodeURIComponent(projectId)}`, update) : postJson("/api/supervisor/projects", { name }) });
  if (!payload) return;
  selectedProjectId = payload.project.projectId;
  projectScope = "project";
  expandedProjectIds.add(selectedProjectId);
  projectContinuityLoadedAt = 0;
  localStorage.setItem("supervisor.selectedProjectId", selectedProjectId);
  localStorage.setItem("supervisor.projectScope", projectScope);
  localStorage.setItem("supervisor.expandedProjects", JSON.stringify([...expandedProjectIds]));
  if (payload.project.archived) setArchivedProjectsOpen(true);
  $("project-dialog").close();
  const message = payload.project.archived
    ? (language === "zh-CN" ? `Project“${payload.project.name}”已归档，仍保留在“归档 Project”中，可随时恢复。` : `Project “${payload.project.name}” was archived. It remains under Archived Projects and can be restored.`)
    : projectId
      ? (language === "zh-CN" ? `Project“${payload.project.name}”已更新。` : `Project “${payload.project.name}” was updated.`)
      : (language === "zh-CN" ? `Project“${payload.project.name}”已创建。` : `Project “${payload.project.name}” was created.`);
  setMessage(message, "success");
  await refresh();
  document.querySelector(`[data-project-node="${CSS.escape(payload.project.projectId)}"]`)?.scrollIntoView({ block: "nearest" });
});
$("create-project").addEventListener("click", () => openProjectDialog());
$("archived-projects").addEventListener("toggle", () => { archivedProjectsOpen = $("archived-projects").open; localStorage.setItem("supervisor.archivedProjectsOpen", String(archivedProjectsOpen)); });
for (const [id, scope, storageKey] of [["global-archived-workflows", "global_archive", "supervisor.globalArchiveOpen"]]) {
  const group = $(id);
  group.open = localStorage.getItem(storageKey) === "true";
  group.addEventListener("toggle", () => {
    localStorage.setItem(storageKey, String(group.open));
    if (group.open && projectScope !== scope) selectProjectScope(scope);
  });
}
$("metadata-close").addEventListener("click", () => $("workflow-metadata-dialog").close()); $("metadata-cancel").addEventListener("click", () => $("workflow-metadata-dialog").close());
$("project-dialog-close").addEventListener("click", () => $("project-dialog").close()); $("project-dialog-cancel").addEventListener("click", () => $("project-dialog").close()); $("refresh").addEventListener("click", refresh);
$("open-settings").addEventListener("click", openSettingsDialog);
$("settings-close").addEventListener("click", () => $("settings-dialog").close());
$("settings-cancel").addEventListener("click", () => $("settings-dialog").close());
$("settings-form").addEventListener("input", (event) => {
  const input = event.target.closest('[data-resource-owner="hardLimits"]');
  if (!input) return;
  const field = input.dataset.resourceField;
  const maximum = Number(input.value);
  $("settings-form").querySelectorAll(`[data-resource-field="${field}"][data-resource-owner^="profile:"]`).forEach((profileInput) => {
    profileInput.max = String(maximum);
    profileInput.setCustomValidity(Number(profileInput.value) > maximum ? (language === "zh-CN" ? "档位值不能超过安全锁。" : "Profile value cannot exceed the safety lock.") : "");
  });
});
$("settings-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.reportValidity()) return;
  const payload = await runDialogMutation({ form, messageId: "settings-message", operation: () => sendJson("PUT", "/api/supervisor/settings/resources", collectResourceSettings()) });
  if (!payload) return;
  settingsSnapshot = payload.settings;
  $("settings-dialog").close();
  setMessage(language === "zh-CN" ? "资源设置已保存，将用于之后新建的 Task。" : "Resource settings saved for future Tasks.", "success");
});
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

renderStaticTranslations(); applyTheme(); renderPreflight(null); applyHeroView(); refresh();
