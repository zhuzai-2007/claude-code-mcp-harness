import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defaultStageView, groupWorkflowsByFolder, isStageViewable, sortEventsNewestFirst, stageViewForRole } from "./dashboard-model.mjs";
import { detectLanguage, translate, translations } from "./i18n.mjs";

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
assert.deepEqual(sortEventsNewestFirst([{ sequence: 1, type: "old" }, { sequence: 3, type: "new" }, { sequence: 2, type: "middle" }]).map((event) => event.type), ["new", "middle", "old"]);

const html = await readFile(path.join(directory, "index.html"), "utf8");
const source = await readFile(path.join(directory, "app.js"), "utf8");
const styles = await readFile(path.join(directory, "style.css"), "utf8");
assert.match(html, /id="language-switch"/);
assert.match(html, /<details id="local-entry"/);
assert.doesNotMatch(html, /<details id="local-entry"[^>]*\sopen(?:\s|>)/);
assert.match(html, /<details id="overview-disclosure"/);
assert.doesNotMatch(html, /<details id="overview-disclosure"[^>]*\sopen(?:\s|>)/, "Overall status must be collapsed by default");
assert.match(html, /id="hide-recent"/);
assert.match(html, /id="show-recent"/);
assert.match(html, /id="create-folder"/);
assert.match(html, /id="project-browser"/);
assert.match(html, /id="project-list"/);
assert.match(html, /id="project-summary"/);
assert.match(html, /id="project-overview"/);
assert.match(html, /id="project-overview-content"/);
assert.match(html, /id="artifact-center"/);
assert.match(html, /id="metadata-folder"/);
assert.match(html, /id="folder-dialog"/);
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
assert.match(source, /data-stage-view/);
assert.match(source, /:not\(:disabled\)/);
assert.match(source, /function stageIcon/);
assert.match(source, /<svg viewBox=/);
assert.match(source, /applyRecentVisibility/);
assert.match(source, /applyHeroView/);
assert.match(source, /groupWorkflowsByFolder/);
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
assert.match(source, /session\.sessionId/);
assert.match(source, /sortEventsNewestFirst/);
assert.match(source, /\/review-package/);
assert.match(source, /function renderSupervisorCollaboration/);
assert.match(source, /function renderProjectIntelligence/);
assert.match(source, /\/project-intelligence/);
assert.match(source, /\/memory-proposal\/apply/);
assert.match(source, /confirmed: true/, "Memory apply must submit explicit confirmation");
assert.match(source, /navigator\.clipboard\.writeText/);
assert.match(source, /TERMINAL\.has\(workflow\.status\)/, "Only terminal Workflows should fetch a Supervisor Review Package");
assert.match(source, /openArchiveFolderIds/);
assert.match(source, /data-toggle-archives/);
assert.match(source, /activeWorkflows = folderWorkflows\.filter/);
assert.match(source, /archivedWorkflows = folderWorkflows\.filter/);
assert.match(source, /const content = `\$\{activeContent\}\$\{archivedContent\}`/, "Archived sessions must render after active sessions inside a folder");
assert.match(source, /let openArchiveFolderIds = new Set\(\)/, "Archived sections must start collapsed on every Dashboard load");
assert.doesNotMatch(source, /supervisor\.openArchiveFolders/, "Stale browser preferences must not auto-expand archived sessions");
assert.match(source, /\/api\/supervisor\/folders/);
assert.match(source, /folderId: \$\("metadata-folder"\)\.value/);
assert.match(source, /method, headers/);
assert.match(source, /"PATCH"/);
assert.match(source, /\/approve/);
assert.match(styles, /@media \(min-width:821px\)[\s\S]*?\.console-grid \{[^}]*overflow:hidden/, "Desktop console must own a bounded viewport instead of scrolling the whole page");
assert.match(styles, /@media \(min-width:821px\)[\s\S]*?\.recent-panel \{[^}]*position:relative; top:auto;[^}]*height:100%/, "Recent Work must remain fixed inside the console viewport");
assert.match(styles, /@media \(min-width:821px\)[\s\S]*?\.detail-column \{[^}]*overflow-y:auto/, "Only the Workflow detail column should scroll on desktop");
assert.match(styles, /@media \(min-width:821px\)[\s\S]*?\.workflow-navigation \{ top:0;[^}]*background:#07090d/, "Sticky Workflow navigation needs an opaque top-zero shield inside the detail scroller");
assert.match(styles, /\.stage-icon svg \{[^}]*width:14px; height:14px/, "Timeline symbols must use centered SVG geometry");
assert.match(styles, /\.console-grid\.recent-collapsed/, "Recent Work must have a collapsed layout");
assert.match(styles, /\.workflow-folder\.open \.folder-chevron/, "Folders must expose an expandable session list");
assert.match(styles, /\.metadata-dialog \{[^}]*border-radius:20px/, "Session and folder dialogs must use the polished modal surface");
assert.match(styles, /\.switch-control::after/, "Archive control must render as a switch instead of a raw checkbox");
assert.match(styles, /\.folder-archive \{[^}]*border-top/, "Archived sessions must have a nested section at the end of each folder");
assert.match(styles, /\.project-browser \{[^}]*border-bottom/, "Dashboard must expose a Project-level browser above Workflow sessions");
assert.match(styles, /\.project-sessions/, "Project view must expose Runtime Sessions");
assert.match(styles, /\.project-view-tabs/, "Project overview must use page-like continuity navigation");
assert.match(styles, /\.project-health-summary/, "Project Overview must expose compact deterministic health status");
assert.match(styles, /\.continuity-grid\.health-grid/, "Project Health facts must use a bounded card grid");
assert.match(styles, /\.artifact-center-content/, "Artifact Center must expose a compact read-only projection");
assert.match(styles, /\.archive-toggle\[aria-expanded="true"\]/, "Archived sessions must be collapsed and independently expandable");
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

console.log(JSON.stringify({ ok: true, languageCoverage: Object.keys(translations.en).length, stageNavigation: true, folderOrder: folderGroups.map((group) => group.folder.folderId), technicalEvents: "newest-first" }, null, 2));
