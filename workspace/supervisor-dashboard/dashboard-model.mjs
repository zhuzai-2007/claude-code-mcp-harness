const CURRENT_STATUSES = new Set(["created", "queued", "planning", "planned", "waiting_approval", "running", "reviewing"]);

export function stageViewForRole(role) {
  if (["decision", "planner", "planning"].includes(role)) return "plan";
  if (role === "approval") return "approval";
  if (["coder", "implementation"].includes(role)) return "implementation";
  return "review";
}

export function isStageViewable(status) {
  return status === "succeeded" || status === "failed" || CURRENT_STATUSES.has(status);
}

export function defaultStageView(workflow) {
  if (workflow.status === "waiting_approval") return "approval";
  if (["reviewing", "completed", "succeeded"].includes(workflow.status)) return "review";
  if (workflow.status === "failed") {
    return stageViewForRole(workflow.product?.failure?.role || workflow.failure?.role || workflow.failure?.failedStage || workflow.currentStage);
  }
  if (["running"].includes(workflow.status)) return "implementation";
  return "plan";
}

function localDayKey(value, now) {
  const date = new Date(value);
  return Math.floor((new Date(now.getFullYear(), now.getMonth(), now.getDate()) - new Date(date.getFullYear(), date.getMonth(), date.getDate())) / 86400000);
}

export function groupWorkflows(workflows, now = new Date()) {
  const groups = { today: [], yesterday: [], week: [], earlier: [], archived: [] };
  for (const workflow of workflows) {
    if (workflow.metadata?.archived) { groups.archived.push(workflow); continue; }
    const age = localDayKey(workflow.updatedAt || workflow.createdAt, now);
    if (age <= 0) groups.today.push(workflow);
    else if (age === 1) groups.yesterday.push(workflow);
    else if (age <= 7) groups.week.push(workflow);
    else groups.earlier.push(workflow);
  }
  return groups;
}

function newestFirst(left, right) {
  return new Date(right.updatedAt || right.createdAt || 0) - new Date(left.updatedAt || left.createdAt || 0);
}

export function groupWorkflowsByFolder(workflows, folders) {
  const sourceFolders = Array.isArray(folders) ? folders : [];
  const defaultFolder = sourceFolders.find((folder) => folder.folderId === "default") || { folderId: "default", name: "Default", pinned: true, system: true };
  const customFolders = sourceFolders.filter((folder) => folder.folderId !== "default").sort((left, right) => Number(right.pinned) - Number(left.pinned) || String(right.updatedAt || right.createdAt || "").localeCompare(String(left.updatedAt || left.createdAt || "")));
  const orderedFolders = [...customFolders, defaultFolder];
  const grouped = new Map(orderedFolders.map((folder) => [folder.folderId, { folder, workflows: [] }]));
  for (const workflow of workflows || []) {
    const requestedFolderId = workflow.metadata?.folderId || "default";
    const target = grouped.get(requestedFolderId) || grouped.get("default");
    target.workflows.push(workflow);
  }
  for (const group of grouped.values()) group.workflows.sort(newestFirst);
  return [...grouped.values()];
}

export function sortEventsNewestFirst(events) {
  return [...(events || [])].sort((left, right) => Number(right.sequence || 0) - Number(left.sequence || 0) || new Date(right.timestamp || 0) - new Date(left.timestamp || 0));
}
