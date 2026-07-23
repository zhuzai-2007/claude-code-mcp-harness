import fs from "node:fs";
import path from "node:path";

export const PROJECT_CONTEXT_SNAPSHOT_FILE = "project-context-snapshot.json";

function isInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function resolveWorkspace(projectRoot, workspacePath) {
  const root = path.resolve(projectRoot);
  const workspace = path.resolve(root, String(workspacePath || ""));
  if (!workspacePath || !isInside(root, workspace)) {
    throw new Error("Project Context Snapshot workspace must stay inside the Runtime project root.");
  }
  const stat = fs.statSync(workspace);
  if (!stat.isDirectory()) throw new Error(`Project Context Snapshot workspace is not a directory: ${workspace}`);
  const realRoot = fs.realpathSync(root);
  const realWorkspace = fs.realpathSync(workspace);
  if (!isInside(realRoot, realWorkspace)) {
    throw new Error("Project Context Snapshot workspace resolves outside the Runtime project root.");
  }
  return { root, workspace };
}

function collectEntries(workspace, maxEntries) {
  const entries = [];
  const pending = [""];
  let truncated = false;
  while (pending.length > 0 && !truncated) {
    const relativeDirectory = pending.shift();
    const directory = path.join(workspace, relativeDirectory);
    const children = fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      if (entries.length >= maxEntries) {
        truncated = true;
        break;
      }
      const relativePath = path.join(relativeDirectory, child.name).replaceAll("\\", "/");
      const type = child.isSymbolicLink() ? "symlink" : child.isDirectory() ? "directory" : child.isFile() ? "file" : "other";
      entries.push({ path: relativePath, type });
      if (type === "directory") pending.push(path.join(relativeDirectory, child.name));
    }
  }
  return { entries, truncated };
}

export function createProjectContextSnapshot({ projectRoot, workspacePath, generatedAt = new Date().toISOString(), maxEntries = 2000 }) {
  const { workspace } = resolveWorkspace(projectRoot, workspacePath);
  const limit = Math.max(1, Number(maxEntries) || 2000);
  const { entries, truncated } = collectEntries(workspace, limit);
  return {
    schemaVersion: 1,
    projectRoot: workspace.replaceAll("\\", "/"),
    entries,
    empty: entries.length === 0,
    generatedAt,
    truncated
  };
}

export function writeAttemptProjectContextSnapshot({ projectRoot, workspacePath, attemptId, generatedAt, maxEntries }) {
  if (!/^\d{8}-\d{6}-\d{3}$/.test(String(attemptId || ""))) throw new Error("Invalid Attempt id for Project Context Snapshot.");
  const root = path.resolve(projectRoot);
  const snapshot = createProjectContextSnapshot({ projectRoot: root, workspacePath, generatedAt, maxEntries });
  const snapshotRoot = path.join(root, ".agent-runs", "context-snapshots");
  fs.mkdirSync(snapshotRoot, { recursive: true });
  const filePath = path.join(snapshotRoot, `${attemptId}.json`);
  fs.writeFileSync(filePath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  return { filePath, snapshot };
}
