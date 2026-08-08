import { createHash } from "node:crypto";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";

function normalizeName(value) {
  const name = String(value || "").trim().replace(/\s+/g, " ");
  if (name.length < 1 || name.length > 80) throw new Error("Project name must contain 1-80 characters.");
  return name;
}

function slugFor(name) {
  const slug = name.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  return slug || `project-${createHash("sha256").update(name).digest("hex").slice(0, 10)}`;
}

function isInside(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function isDirectChild(parent, candidate) {
  if (!isInside(parent, candidate)) return false;
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return !relative.includes(path.sep);
}

async function exists(filePath) {
  try { await stat(filePath); return true; }
  catch (error) { if (error?.code === "ENOENT") return false; throw error; }
}

export class ProjectWorkspaceService {
  constructor({ projectRoot, workspaceRoot, projectRegistry, registryStore }) {
    this.projectRoot = path.resolve(projectRoot);
    this.workspaceRoot = path.resolve(workspaceRoot);
    this.projectRegistry = projectRegistry;
    this.registryStore = registryStore;
    if (!isInside(this.projectRoot, this.workspaceRoot)) throw new Error("Managed workspace root must be inside projectRoot.");
  }

  async init() {
    await this.registryStore.init();
    return this;
  }

  async createProject(input, timestamp = new Date().toISOString()) {
    if (Object.hasOwn(input || {}, "path") || Object.hasOwn(input || {}, "workspacePath")) throw new Error("Project paths are assigned by the managed workspace service and cannot be provided.");
    const { name } = input || {};
    const normalizedName = normalizeName(name);
    const projects = await this.projectRegistry.listProjects();
    this._assertUniqueName(projects, normalizedName);
    const baseSlug = slugFor(normalizedName);
    let projectId = baseSlug;
    if (projects.some((project) => project.projectId.toLowerCase() === projectId.toLowerCase())) {
      projectId = `${baseSlug}-${createHash("sha256").update(normalizedName).digest("hex").slice(0, 8)}`;
    }
    if (projects.some((project) => project.projectId.toLowerCase() === projectId.toLowerCase())) throw new Error(`Project id conflict: ${projectId}`);
    const targetPath = path.join(this.workspaceRoot, baseSlug);
    this._assertManagedTarget(targetPath);
    await mkdir(this.workspaceRoot, { recursive: true });
    if (await exists(targetPath)) throw new Error(`Workspace folder already exists: workspace/${baseSlug}`);
    await mkdir(targetPath);
    const relativePath = path.relative(this.projectRoot, targetPath).replaceAll("\\", "/");
    const record = {
      projectId,
      name: normalizedName,
      workspacePath: relativePath,
      description: "Local project created from the Supervisor Dashboard.",
      language: "unknown",
      stack: ["unknown"],
      aliases: [normalizedName, projectId, relativePath],
      constraints: ["Keep all inspection and changes inside this registered project workspace."],
      managed: true,
      system: false,
      pinned: false,
      archived: false,
      source: "dashboard",
      createdAt: timestamp,
      updatedAt: timestamp
    };
    try { await this.registryStore.upsert(record); }
    catch (error) { await rm(targetPath, { recursive: true, force: true }); throw error; }
    await this.projectRegistry.init();
    return this.projectRegistry.getProjectContext(projectId).project;
  }

  async renameProject(projectId, input, timestamp = new Date().toISOString()) {
    if (Object.hasOwn(input || {}, "path") || Object.hasOwn(input || {}, "workspacePath")) throw new Error("Project paths cannot be changed directly.");
    const { name } = input || {};
    const project = this.projectRegistry.getProjectContext(projectId).project;
    if (!project.managed || project.system) throw new Error("Only managed workspace projects can be renamed.");
    const normalizedName = normalizeName(name);
    const projects = await this.projectRegistry.listProjects();
    this._assertUniqueName(projects, normalizedName, project.projectId);
    const currentPath = path.resolve(project.workspacePath);
    this._assertManagedTarget(currentPath);
    const targetPath = path.join(this.workspaceRoot, slugFor(normalizedName));
    this._assertManagedTarget(targetPath);
    const pathChanged = path.resolve(currentPath).toLowerCase() !== path.resolve(targetPath).toLowerCase();
    if (pathChanged && await exists(targetPath)) throw new Error(`Workspace folder already exists: ${path.basename(targetPath)}`);
    if (pathChanged) await rename(currentPath, targetPath);
    const relativePath = path.relative(this.projectRoot, targetPath).replaceAll("\\", "/");
    try {
      await this.registryStore.upsert({
        projectId: project.projectId,
        name: normalizedName,
        workspacePath: relativePath,
        aliases: [...new Set([...(project.aliases || []), normalizedName.toLowerCase(), relativePath.toLowerCase()])],
        managed: true,
        system: false,
        updatedAt: timestamp
      });
    } catch (error) {
      if (pathChanged) await rename(targetPath, currentPath);
      throw error;
    }
    await this.projectRegistry.init();
    return this.projectRegistry.getProjectContext(project.projectId).project;
  }

  async updateProjectMetadata(projectId, patch, timestamp = new Date().toISOString()) {
    const project = this.projectRegistry.getProjectContext(projectId).project;
    const record = { projectId: project.projectId, updatedAt: timestamp };
    if (Object.hasOwn(patch, "archived")) record.archived = Boolean(patch.archived);
    if (Object.hasOwn(patch, "pinned")) record.pinned = Boolean(patch.pinned);
    await this.registryStore.upsert(record);
    await this.projectRegistry.init();
    return this.projectRegistry.getProjectContext(project.projectId).project;
  }

  _assertManagedTarget(candidate) {
    if (!isDirectChild(this.workspaceRoot, candidate)) throw new Error("Managed Project paths must be direct children of the workspace root.");
  }

  _assertUniqueName(projects, name, exceptProjectId = null) {
    const match = projects.find((project) => project.projectId !== exceptProjectId && project.name.localeCompare(name, undefined, { sensitivity: "accent" }) === 0);
    if (match) throw new Error(`Project name already exists: ${name}`);
  }
}
