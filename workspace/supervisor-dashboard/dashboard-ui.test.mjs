import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defaultStageView, groupProjects, groupProjectWorkflows, groupWorkflowsByFolder, isStageViewable, sortEventsNewestFirst, stageViewForRole, workflowsForProjectScope } from "./dashboard-model.mjs";
import { detectLanguage, translate, translations } from "./i18n.mjs";
import { fetchDashboardJson } from "./dashboard-request.mjs";

const directory = path.dirname(fileURLToPath(import.meta.url));
assert.equal(detectLanguage({ languages: ["zh-Hans-CN"] }), "zh-CN");
assert.equal(detectLanguage({ languages: ["en-US"] }), "en");
assert.equal(detectLanguage({ stored: "en", languages: ["zh-CN"] }), "en", "manual selection must override browser language");
assert.equal(translate("zh-CN", "approval.approve"), "批准并运行");
assert.equal(translate("en", "timeline.progress", { done: 2, total: 4 }), "2 of 4 complete");
for (const key of Object.keys(translations.en)) assert(Object.hasOwn(translations["zh-CN"], key), `Missing zh-CN translation: ${key}`);

assert.equal(stageViewForRole("planner"), "plan");
assert.equal(stageViewForRole("coder"), "implementation");
assert.equal(stageViewForRole("reviewer"), "review");
assert.equal(isStageViewable("succeeded"), true);
assert.equal(isStageViewable("running"), true);
assert.equal(isStageViewable("pending"), false, "future stages must not be clickable");
assert.equal(defaultStageView({ status: "waiting_approval" }), "approval");
assert.equal(defaultStageView({ status: "running" }), "implementation");
assert.equal(defaultStageView({ status: "reviewing" }), "review");

const folderGroups = groupWorkflowsByFolder([
  { workflowId: "default_old", updatedAt: "2026-07-15T10:00:00.000Z", metadata: { folderId: "default" } },
  { workflowId: "default_new", updatedAt: "2026-07-16T10:00:00.000Z", metadata: { folderId: "default" } },
  { workflowId: "pinned_session", updatedAt: "2026-07-14T10:00:00.000Z", metadata: { folderId: "folder_pinned" } },
  { workflowId: "unknown_returns_default", updatedAt: "2026-07-17T10:00:00.000Z", metadata: { folderId: "folder_removed" } }
], [
  { folderId: "default", name: "Default", pinned: true, system: true },
  { folderId: "folder_normal", name: "Normal", pinned: false },
  { folderId: "folder_pinned", name: "Pinned", pinned: true }
]);
assert.deepEqual(folderGroups.map((group) => group.folder.folderId), ["folder_pinned", "folder_normal", "default"]);
assert.deepEqual(folderGroups[2].workflows.map((workflow) => workflow.workflowId), ["unknown_returns_default", "default_new", "default_old"], "sessions inside each folder must be newest first");
const projects = groupProjects([
  { projectId: "archived", name: "Archived", archived: true, updatedAt: "2026-07-18T09:00:00.000Z" },
  { projectId: "recent", name: "Recent", updatedAt: "2026-07-18T10:00:00.000Z" },
  { projectId: "pinned", name: "Pinned", pinned: true, updatedAt: "2026-07-17T10:00:00.000Z" }
]);
assert.deepEqual(projects.active.map((project) => project.projectId), ["pinned", "recent"], "pinned active Projects must appear first");
assert.deepEqual(projects.archived.map((project) => project.projectId), ["archived"]);
const scoped = [
  { workflowId: "project_new", projectId: "recent", createdAt: "2026-07-18T10:00:00.000Z", metadata: { archived: false } },
  { workflowId: "project_archived", projectId: "recent", createdAt: "2026-07-18T11:00:00.000Z", metadata: { archived: true } }
];
assert.deepEqual(workflowsForProjectScope(scoped, { projectId: "recent" }).map((workflow) => workflow.workflowId), ["project_archived", "project_new"]);
assert.deepEqual(groupProjectWorkflows(workflowsForProjectScope(scoped, { projectId: "recent" })).archived.map((workflow) => workflow.workflowId), ["project_archived"]);
assert.deepEqual(groupProjectWorkflows([
  { workflowId: "restored_new", createdAt: "2026-07-18T12:00:00.000Z", metadata: { archived: false } },
  { workflowId: "active_old", createdAt: "2026-07-17T12:00:00.000Z", metadata: { archived: false } }
]).active.map((workflow) => workflow.workflowId), ["restored_new", "active_old"], "restored Workflows must return by creation time, newest first");
assert.deepEqual(sortEventsNewestFirst([{ sequence: 1, type: "old" }, { sequence: 3, type: "new" }, { sequence: 2, type: "middle" }]).map((event) => event.type), ["new", "middle", "old"]);
const timeoutFetch = (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => { const error = new Error("aborted"); error.name = "AbortError"; reject(error); }, { once: true }));
await assert.rejects(() => fetchDashboardJson("/slow", { timeoutMs: 5, language: "zh-CN", fetchImpl: timeoutFetch }), (error) => error.code === "request_timeout" && /请求超时/.test(error.message));
await assert.rejects(() => fetchDashboardJson("/conflict", { fetchImpl: async () => ({ ok: false, status: 409, statusText: "Conflict", json: async () => ({ error: "Project is busy" }) }) }), (error) => error.status === 409 && error.message === "Project is busy");

const html = await readFile(path.join(directory, "index.html"), "utf8");
const source = await readFile(path.join(directory, "app.js"), "utf8");
const requestSource = await readFile(path.join(directory, "dashboard-request.mjs"), "utf8");
const styles = await readFile(path.join(directory, "style.css"), "utf8");
assert.match(html, /id="language-switch"/);
assert.match(html, /<details id="local-entry"/);
assert.doesNotMatch(html, /<details id="local-entry"[^>]*\sopen(?:\s|>)/);
assert.match(html, /id="entry-project-select"/, "Local fallback entry must select an existing registered Project directly");
assert.match(html, /class="local-entry-intro"><h1 class="local-entry-title"/, "Local fallback must keep only a compact request heading");
assert.doesNotMatch(html, /data-i18n="entry\.eyebrow"|data-i18n="entry\.description"/, "Expanded fallback entry must not repeat large descriptive copy");
assert.match(html, /<details id="overview-disclosure"/);
assert.doesNotMatch(html, /<details id="overview-disclosure"[^>]*\sopen(?:\s|>)/, "Overall status must be collapsed by default");
assert.doesNotMatch(html, /id="hide-recent"|id="show-recent"/, "Project and Workflow navigation must not be split into separate rails");
assert.match(html, /id="theme-switch"/);
assert.match(html, /id="open-settings"/, "Dashboard must expose Supervisor settings from the fixed top bar");
assert.match(html, /id="settings-dialog"/, "Resource settings must use a bounded modal instead of extending the workflow page");
assert.match(html, /id="settings-hard-limits"/);
assert.match(html, /id="settings-profiles"/);
assert.match(html, /class="workspace-panel project-panel panel"/);
assert.match(html, /id="create-project"/);
assert.match(html, /id="active-project-list"/);
assert.match(html, /id="archived-project-list"/);
assert.match(html, /<details id="global-archived-workflows"/, "Global Archived Workflows must be independently collapsible");
assert.doesNotMatch(html, /legacy-workflows|Legacy \/ Unassigned|旧版 \/ 未分配/, "Deleted pre-Project test history must not retain a Legacy navigation group");
assert.match(source, /projectScope === "legacy"[\s\S]*?projectScope = "project"/, "Browsers persisted on the removed legacy scope must migrate back to Project navigation");
assert.match(html, /id="project-summary"/);
assert.match(html, /id="project-overview"/);
assert.match(html, /id="project-overview-content"/);
assert.match(html, /id="artifact-center"/);
assert.doesNotMatch(html, /id="metadata-folder"/);
assert.match(html, /id="project-dialog"/);
assert.match(html, /id="workflow-metadata-message"/);
assert.match(html, /id="project-dialog-message"/);
assert.match(html, /id="workflow-metadata-save"/);
assert.match(html, /id="project-save"/);
assert.match(html, /id="supervisor-collaboration"/);
assert.match(html, /id="review-in-chatgpt"/);
assert.match(html, /id="chatgpt-review-dialog"/);
assert.match(html, /id="chatgpt-review-prompt"/);
assert.match(html, /id="project-intelligence-details"/);
assert.match(html, /id="project-intelligence-content"/);
assert.match(html, /id="memory-apply-dialog"/);
assert.match(html, /id="memory-confirmed"/);
assert.match(html, /data-hero-view="summary"/);
assert.match(html, /id="workflow-timeline-tab" class="active"[^>]*data-hero-view="timeline"/, "Timeline must be the default header view");
assert.match(html, /id="workflow-summary-pane" class="hero-pane hidden"/);
assert.match(html, /id="workflow-timeline-pane" class="hero-pane"/);
for (const stage of ["stage-plan", "stage-approval", "stage-implementation", "stage-review"]) assert.match(html, new RegExp(`id="${stage}"`));
assert.match(
  html,
  /<div id="stage-review"[^>]*>\s*<section id="review-result-grid"[^>]*><\/section>\s*<\/div>\s*<article id="recovery-panel"/,
  "Failure recovery must render outside the Review stage so Planner and Coder failures expose recovery controls"
);
assert.match(source, /data-stage-view/);
assert.match(source, /:not\(:disabled\)/);
assert.match(source, /function stageIcon/);
assert.match(source, /<svg viewBox=/);
assert.match(source, /applyHeroView/);
assert.match(source, /groupProjects/);
assert.match(source, /groupProjectWorkflows/);
assert.match(source, /workflowsForProjectScope/);
assert.match(source, /function renderProjects/);
assert.match(source, /function renderProjectOverview/);
assert.match(source, /context\.health/);
assert.match(source, /project-health-summary/);
assert.match(source, /health\.release\.readiness/);
assert.match(source, /function renderArtifactCenter/);
assert.match(source, /\/continuity/);
assert.match(source, /\/artifacts/);
assert.match(source, /clarification-form/);
assert.match(source, /workflowProjectId/);
assert.match(source, /workflow\?\.projectId/, "An empty Runtime must render Projects without dereferencing a missing Workflow");
assert.match(source, /selectedProjectId/);
assert.match(source, /workspacePath/);
assert.match(source, /sortEventsNewestFirst/);
assert.match(source, /\/review-package/);
assert.match(source, /function renderSupervisorCollaboration/);
assert.match(source, /function renderProjectIntelligence/);
assert.match(source, /\/project-intelligence/);
assert.match(source, /\/memory-proposal\/apply/);
assert.match(source, /confirmed: true/, "Memory apply must submit explicit confirmation");
assert.match(source, /navigator\.clipboard\.writeText/);
assert.match(source, /TERMINAL\.has\(workflow\.status\)/, "Only terminal Workflows should fetch a Supervisor Review Package");
assert.match(source, /workflow-archive-group/, "Archived Workflows must render after active Workflows inside a Project");
assert.match(source, /data-toggle-project/, "Each Project must expand vertically into its Workflow list");
assert.match(source, /expandedProjectIds/, "Expanded Project state must survive refreshes");
const refreshSource = source.slice(source.indexOf("async function refresh()"), source.indexOf("function showError"));
assert.doesNotMatch(refreshSource, /expandedProjectIds\.add/, "Polling must not reopen a Project the user just collapsed");
assert.match(source, /supervisor\.archivedProjectsOpen/, "Archived Project visibility must survive refreshes and reloads");
assert.match(source, /data-restore-project/, "Archived Projects must expose a direct restore action");
assert.match(source, /setArchivedProjectsOpen\(true\)/, "Archiving a Project must reveal the Archived Projects section");
assert.match(source, /\/api\/supervisor\/projects/);
assert.match(source, /\/api\/supervisor\/projects\?compact=1/, "Polling must use the compact Project projection");
assert.match(source, /projectId: project\.projectId/, "Local Workflow creation must bind the selected Project explicitly");
assert.match(source, /function renderEntryProjectSelector/, "The local Project selector must stay synchronized with the Project tree");
assert.match(source, /entry-project-select[^\n]*selectProjectScope/, "Changing the local Project selector must update the shared Project scope");
assert.doesNotMatch(source, /\/api\/supervisor\/folders/);
assert.match(source, /method, headers/);
assert.match(source, /"PATCH"/);
assert.match(source, /\/approve/);
assert.match(source, /fetchDashboardJson/, "Dashboard API calls must use the bounded request helper");
assert.match(requestSource, /AbortController/, "Dashboard requests must have a bounded timeout");
assert.match(requestSource, /request_timeout/, "Timeouts must produce an actionable error");
assert.match(source, /runDialogMutation/, "Project and Workflow settings must share guarded mutation handling");
assert.match(source, /\/api\/supervisor\/settings/);
assert.match(source, /"PUT", "\/api\/supervisor\/settings\/resources"/);
assert.match(html, /Changes apply to new Tasks only|更改只影响新建 Task/, "Settings must explain frozen running Attempt resources");
assert.match(source, /setFormBusy/, "Mutation forms must prevent duplicate submission and always restore controls");
assert.match(source, /refreshGeneration/, "Stale polling responses must not overwrite mutation refreshes");
assert.match(styles, /@media \(min-width:821px\)[\s\S]*?\.console-grid \{[^}]*overflow:hidden/, "Desktop console must own a bounded viewport instead of scrolling the whole page");
assert.match(styles, /@media \(min-width:821px\)[\s\S]*?\.detail-column \{[^}]*overflow-y:auto/, "Only the Workflow detail column should scroll on desktop");
assert.match(styles, /\.stage-icon svg \{[^}]*width:14px; height:14px/, "Timeline symbols must use centered SVG geometry");
assert.match(styles, /\.metadata-dialog \{[^}]*border-radius:20px/, "Session and folder dialogs must use the polished modal surface");
assert.match(styles, /\.switch-control::after/, "Archive control must render as a switch instead of a raw checkbox");
assert.match(styles, /\.project-panel \{[^}]*flex-direction:column/, "Projects must have a dedicated first column");
assert.match(styles, /\.project-workflows \{[^}]*padding-left:28px/, "Workflows must be nested directly under their Project");
assert.match(styles, /\.project-node\.open \.project-expand span/, "Project nodes must visibly expand and collapse");
assert.match(styles, /\.project-tree > details\[open\] > summary::before/, "Global archive and legacy groups must show an explicit expand/collapse chevron");
assert.match(styles, /\.project-restore-button/, "Archived Projects must have a visible restore control");
assert.match(styles, /\.workflow-archive-group \{[^}]*border-top/, "Archived Workflows must have a collapsed section after active work");
assert.match(styles, /\.project-view-tabs/, "Project overview must use page-like continuity navigation");
assert.match(styles, /\.entry-project-control select/, "The local fallback Project selector must use the Dashboard control styling");
assert.match(styles, /\.local-entry-content \.new-task-form textarea \{[^}]*min-height:62px;[^}]*max-height:120px/, "Expanded fallback input must use a compact bounded default height");
assert.match(styles, /\.local-entry-content \{[^}]*grid-template-columns:minmax\(150px,220px\)[^}]*padding:11px 13px/, "Expanded fallback layout must not consume the Workflow detail viewport");
assert.match(styles, /\.project-health-summary/, "Project Overview must expose compact deterministic health status");
assert.match(styles, /\.continuity-grid\.health-grid/, "Project Health facts must use a bounded card grid");
assert.match(styles, /\.artifact-center-content/, "Artifact Center must expose a compact read-only projection");
assert.match(styles, /@media \(min-width:821px\)[\s\S]*?\.local-entry > summary,\.overview-disclosure > summary \{[^}]*min-height:40px/, "Collapsed console controls must use compact desktop chrome");
assert.match(styles, /\.page-shell \{ display:grid; grid-template-columns:minmax\(0,1fr\) minmax\(0,1fr\)/, "Local fallback and Overall status must share one compact desktop row");
assert.match(styles, /\.stage-icon svg \{[^}]*position:absolute;[^}]*top:50%; left:50%;[^}]*transform:translate\(-50%,-50%\)/, "Timeline symbols must be geometrically centered independent of line-height");
assert.match(styles, /\.collaboration-status \{[^}]*grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/, "Terminal collaboration status must remain compact");
assert.match(styles, /\.review-dialog \{[^}]*width:min\(680px/, "ChatGPT handoff must use a dialog rather than expand the stage page");
assert.match(styles, /\.project-intelligence-details \{[^}]*border-top/, "Project Intelligence must remain a compact collapsed area");
assert.match(styles, /\.project-intelligence-content \{[^}]*grid-template-columns:repeat\(3/, "Project Intelligence must use a compact three-column desktop layout");
assert.match(styles, /--stage-icon-size:28px/, "Timeline icon, circle, and track must share one geometry token");
assert.match(styles, /\.stage-icon svg \{[^}]*inset:0;[^}]*margin:auto;[^}]*transform:none/, "Timeline glyphs must be centered without fractional translate offsets");
assert.match(styles, /@media \(max-width:560px\)[\s\S]*?\.stage-track \{[^}]*top:var\(--stage-icon-size\);[^}]*left:calc\(var\(--stage-icon-size\) \/ 2\)/, "Mobile timeline track must start below the circle on the same center axis");
assert.match(styles, /@media \(min-width:821px\)[\s\S]*?\.page-shell \{[^}]*grid-template-rows:32px minmax\(0,1fr\)/, "Desktop utility controls must leave more height for stage details");
assert.match(styles, /\.detail-column,\.detail-column > #workflow-detail \{ align-content:start; \}/, "Workflow header and stage details must not be stretched apart by the bounded grid viewport");
assert.match(styles, /@media \(min-width:1200px\)[\s\S]*?\.console-grid \{[^}]*grid-template-columns:minmax\(290px,370px\) minmax\(0,1fr\)/, "Desktop console must use one Project/Workflow tree and one detail column");
assert.match(styles, /\.dialog-message\[data-tone="error"\]/, "Mutation errors must be visible inside the active dialog");
assert.match(styles, /form\[aria-busy="true"\]/, "Saving state must be visually explicit");
assert.match(styles, /\.settings-dialog \{[^}]*width:min\(980px/, "Settings must use a wide but bounded management surface");
assert.match(styles, /\.settings-body \{[^}]*overflow-y:auto/, "Settings content must scroll inside the modal");
assert.match(styles, /:root\[data-theme="light"\]/, "Dashboard must expose an explicit light theme");
assert.match(styles, /html,body \{[^}]*overflow-x:hidden/, "Dashboard must prevent horizontal page overflow after responsive reflow");

console.log(JSON.stringify({ ok: true, languageCoverage: Object.keys(translations.en).length, stageNavigation: true, folderOrder: folderGroups.map((group) => group.folder.folderId), technicalEvents: "newest-first" }, null, 2));
