import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

const SUPERVISOR_CONTEXT_FILE = "AI_SUPERVISOR.md";
const PROJECT_MEMORY_FILE = "PROJECT_MEMORY.md";
const MAX_SUPERVISOR_CONTEXT_BYTES = 64 * 1024;
const MAX_PROJECT_MEMORY_BYTES = 64 * 1024;

function normalized(value) {
  return String(value || "").trim().toLocaleLowerCase("en-US").replaceAll("\\", "/");
}

function projectIdFor(entry) {
  return String(entry?.projectId || entry?.id || entry?.name || "").trim();
}

function hasStandaloneProjectDefinition(entry) {
  return Boolean(projectIdFor(entry) && String(entry?.name || "").trim() && String(entry?.workspacePath || entry?.path || "").trim());
}

async function readRegistry(registryPath, { optional = false } = {}) {
  try {
    const registry = JSON.parse((await readFile(registryPath, "utf8")).replace(/^\uFEFF/, ""));
    if (!Array.isArray(registry.projects)) throw new Error(`Project registry must contain a projects array: ${registryPath}`);
    return registry;
  } catch (error) {
    if (optional && error?.code === "ENOENT") return { schemaVersion: 1, projects: [] };
    throw error;
  }
}

function publicProject(project, lastUsed = null) {
  return {
    projectId: project.id,
    id: project.id,
    name: project.name,
    workspacePath: project.workspacePath,
    path: project.path,
    description: project.description,
    language: project.language,
    techStack: [...project.techStack],
    stack: [...project.techStack],
    aliases: [...project.aliases],
    defaultConstraints: [...project.defaultConstraints],
    constraints: [...project.defaultConstraints],
    supervisorContext: { ...project.supervisorContext },
    memory: { ...project.memory },
    lastUsed: lastUsed || project.lastUsed || null,
    managed: project.managed === true,
    system: project.system === true,
    pinned: project.pinned === true,
    archived: project.archived === true,
    source: project.source || "base",
    createdAt: project.createdAt || null,
    updatedAt: project.updatedAt || null
  };
}

export class ProjectContextRegistry {
  constructor({ projectRoot, registryPath, localRegistryPath = null, usageProvider = null, metadataStore = null, workspaceRoot = "workspace" }) {
    this.projectRoot = path.resolve(projectRoot);
    this.registryPath = path.resolve(registryPath);
    this.localRegistryPath = localRegistryPath ? path.resolve(localRegistryPath) : path.join(path.dirname(this.registryPath), "projects.local.json");
    this.usageProvider = usageProvider || (async () => ({}));
    this.metadataStore = metadataStore;
    this.workspaceRoot = path.resolve(this.projectRoot, workspaceRoot);
    this.projects = [];
    this.diagnostics = [];
  }

  async init() {
    const [releaseRegistry, localRegistry] = await Promise.all([
      readRegistry(this.registryPath),
      readRegistry(this.localRegistryPath, { optional: true })
    ]);
    const overlay = this.metadataStore ? await this.metadataStore.listRecords() : [];
    const merged = new Map();
    this.diagnostics = [];
    for (const [registryLayer, entries] of [["release", releaseRegistry.projects], ["local", localRegistry.projects]]) {
      for (const entry of entries) {
        const id = projectIdFor(entry);
        if (merged.has(id)) throw new Error(`Duplicate projectId across release and local registries: ${id}`);
        merged.set(id, { ...entry, source: entry.source || (registryLayer === "release" ? "base" : "local"), registryLayer });
      }
    }
    for (const record of overlay) {
      const id = projectIdFor(record);
      if (merged.has(id)) {
        const existing = merged.get(id);
        merged.set(id, { ...existing, ...record, source: record.source || existing.source, registryLayer: existing.registryLayer });
      } else if (hasStandaloneProjectDefinition(record)) {
        merged.set(id, { ...record, source: record.source || "runtime", registryLayer: "runtime" });
      } else {
        this.diagnostics.push({
          code: "orphaned_runtime_project_metadata",
          projectId: id || null,
          message: `Runtime project metadata has no release or local project definition and was ignored: ${id || "(missing projectId)"}`
        });
      }
    }
    const ids = new Set();
    this.projects = [...merged.values()].map((entry) => {
      const id = String(entry.projectId || entry.id || entry.name || "").trim();
      const name = String(entry.name || "").trim();
      const configuredPath = String(entry.workspacePath || entry.path || "").trim();
      const relativePath = configuredPath.replaceAll("\\", "/").replace(/^\.\//, "");
      if (!id || !name || !relativePath) throw new Error("Each registered project requires id, name, and path.");
      if (ids.has(id)) throw new Error(`Duplicate registered project id: ${id}`);
      ids.add(id);
      if (entry.registryLayer === "local" && path.isAbsolute(configuredPath)) throw new Error(`Local project path must be relative: ${configuredPath}`);
      const absolutePath = path.resolve(this.projectRoot, relativePath);
      const relative = path.relative(this.projectRoot, absolutePath);
      if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Registered project escapes projectRoot: ${relativePath}`);
      const workspaceRelative = path.relative(this.workspaceRoot, absolutePath);
      const insideWorkspace = workspaceRelative !== "" && !workspaceRelative.startsWith("..") && !path.isAbsolute(workspaceRelative);
      if (entry.registryLayer === "local" && !insideWorkspace) throw new Error(`Local project must be inside the workspace root: ${relativePath}`);
      const inferredManaged = workspaceRelative !== "" && !workspaceRelative.startsWith("..") && !path.isAbsolute(workspaceRelative) && !workspaceRelative.includes(path.sep);
      if (entry.managed === true && !inferredManaged) throw new Error(`Managed Project must be a direct child of the workspace root: ${relativePath}`);
      return {
        id,
        name,
        path: relativePath || ".",
        workspacePath: absolutePath.replaceAll("\\", "/"),
        description: String(entry.description || "").trim(),
        language: String(entry.language || (entry.stack || entry.techStack || []).join(", ") || "unknown").trim(),
        techStack: [...new Set((entry.stack || entry.techStack || String(entry.language || "unknown").split(",")).map((item) => String(item).trim()).filter(Boolean))],
        defaultConstraints: [...new Set((entry.constraints || entry.defaultConstraints || []).map((item) => String(item).trim()).filter(Boolean))],
        lastUsed: entry.lastUsed || null,
        aliases: [...new Set([...(entry.aliases || []), name, relativePath].map(normalized).filter(Boolean))],
        managed: inferredManaged && entry.managed !== false,
        system: entry.system === true || relativePath === ".",
        pinned: entry.pinned === true,
        archived: entry.archived === true,
        source: String(entry.source || "base"),
        createdAt: entry.createdAt || null,
        updatedAt: entry.updatedAt || null
      };
    });
    if (!this.projects.length) throw new Error("Project registry must contain at least one project.");
    for (const project of this.projects) {
      const absoluteProjectPath = path.resolve(this.projectRoot, project.path);
      const details = await stat(absoluteProjectPath);
      if (!details.isDirectory()) throw new Error(`Registered project is not a directory: ${project.path}`);
      const supervisorContextPath = path.join(absoluteProjectPath, SUPERVISOR_CONTEXT_FILE);
      try {
        const contextDetails = await stat(supervisorContextPath);
        if (!contextDetails.isFile()) throw new Error(`${SUPERVISOR_CONTEXT_FILE} is not a file in registered project: ${project.path}`);
        if (contextDetails.size > MAX_SUPERVISOR_CONTEXT_BYTES) throw new Error(`${SUPERVISOR_CONTEXT_FILE} exceeds ${MAX_SUPERVISOR_CONTEXT_BYTES} bytes in registered project: ${project.path}`);
        const instructions = (await readFile(supervisorContextPath, "utf8")).replace(/^\uFEFF/, "").trim();
        project.supervisorInstructions = instructions;
        project.supervisorContext = { available: true, file: SUPERVISOR_CONTEXT_FILE, digest: createHash("sha256").update(instructions).digest("hex") };
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
        project.supervisorInstructions = "";
        project.supervisorContext = { available: false, file: SUPERVISOR_CONTEXT_FILE, digest: null };
      }
      const projectMemoryPath = path.join(absoluteProjectPath, PROJECT_MEMORY_FILE);
      try {
        const memoryDetails = await stat(projectMemoryPath);
        if (!memoryDetails.isFile()) throw new Error(`${PROJECT_MEMORY_FILE} is not a file in registered project: ${project.path}`);
        if (memoryDetails.size > MAX_PROJECT_MEMORY_BYTES) throw new Error(`${PROJECT_MEMORY_FILE} exceeds ${MAX_PROJECT_MEMORY_BYTES} bytes in registered project: ${project.path}`);
        const memory = (await readFile(projectMemoryPath, "utf8")).replace(/^\uFEFF/, "").trim();
        project.projectMemory = memory;
        project.memory = { available: true, file: PROJECT_MEMORY_FILE, digest: createHash("sha256").update(memory).digest("hex"), lastUpdated: memoryDetails.mtime.toISOString(), size: memoryDetails.size };
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
        project.projectMemory = "";
        project.memory = { available: false, file: PROJECT_MEMORY_FILE, digest: null, lastUpdated: null, size: 0 };
      }
    }
    return this;
  }

  getDiagnostics() {
    return this.diagnostics.map((entry) => ({ ...entry }));
  }

  async listProjects() {
    const usage = await this.usageProvider();
    return this.projects.map((project) => publicProject(project, usage[project.id])).sort((left, right) => String(right.lastUsed || "").localeCompare(String(left.lastUsed || "")) || left.name.localeCompare(right.name));
  }

  async refreshProjectMemory(selector) {
    const resolution = this.resolve("", { selector, allowArchived: true });
    const project = this.projects.find((candidate) => candidate.id === resolution.project.id);
    const projectMemoryPath = path.join(path.resolve(this.projectRoot, project.path), PROJECT_MEMORY_FILE);
    try {
      const memoryDetails = await stat(projectMemoryPath);
      if (!memoryDetails.isFile()) throw new Error(`${PROJECT_MEMORY_FILE} is not a file in registered project: ${project.path}`);
      if (memoryDetails.size > MAX_PROJECT_MEMORY_BYTES) throw new Error(`${PROJECT_MEMORY_FILE} exceeds ${MAX_PROJECT_MEMORY_BYTES} bytes in registered project: ${project.path}`);
      const memory = (await readFile(projectMemoryPath, "utf8")).replace(/^\uFEFF/, "").trim();
      project.projectMemory = memory;
      project.memory = { available: true, file: PROJECT_MEMORY_FILE, digest: createHash("sha256").update(memory).digest("hex"), lastUpdated: memoryDetails.mtime.toISOString(), size: memoryDetails.size };
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      project.projectMemory = "";
      project.memory = { available: false, file: PROJECT_MEMORY_FILE, digest: null, lastUpdated: null, size: 0 };
    }
    return { project: publicProject(project), projectMemory: project.projectMemory, memory: { ...project.memory } };
  }

  getProjectContext(selector) {
    const resolution = this.resolve("", { selector, allowArchived: true });
    const project = this.projects.find((candidate) => candidate.id === resolution.project.id);
    return {
      project: publicProject(project),
      projectDescription: project.description,
      technicalStack: [...project.techStack],
      constraints: [...project.defaultConstraints],
      supervisorInstructions: project.supervisorInstructions || "",
      supervisorContext: { ...project.supervisorContext },
      projectMemory: project.projectMemory || "",
      projectMemorySummary: project.projectMemory || "",
      memory: { ...project.memory }
    };
  }

  resolve(userRequest, { selector = null, allowArchived = false } = {}) {
    if (!this.projects.length) throw new Error("Project registry is not initialized.");
    if (selector) {
      const exact = normalized(selector);
      const project = this.projects.find((candidate) => [candidate.id, candidate.name, candidate.path, ...candidate.aliases].map(normalized).includes(exact));
      if (!project) throw new Error(`Unknown registered project: ${selector}`);
      if (project.archived && !allowArchived) throw new Error(`Project is archived and cannot create Workflows: ${project.id}`);
      return { status: "selected", method: "explicit", project: publicProject(project), candidates: [] };
    }

    const activeProjects = this.projects.filter((project) => !project.archived);
    if (!activeProjects.length) throw new Error("No active registered projects are available.");
    if (activeProjects.length === 1) return { status: "selected", method: "only_candidate", project: publicProject(activeProjects[0]), candidates: [] };

    const text = normalized(userRequest);
    const scored = activeProjects.map((project) => {
      const matches = project.aliases.filter((alias) => alias.length >= 2 && text.includes(alias));
      return { project, score: matches.reduce((total, alias) => total + alias.length, 0), matches };
    }).filter((entry) => entry.score > 0).sort((left, right) => right.score - left.score || left.project.name.localeCompare(right.project.name));
    const winners = scored.filter((entry) => entry.score === scored[0]?.score);
    if (winners.length === 1) return { status: "selected", method: "request_match", project: publicProject(winners[0].project), candidates: [] };

    const candidates = (winners.length ? winners : activeProjects.map((project) => ({ project }))).map(({ project }) => publicProject(project));
    return { status: "confirmation_required", method: winners.length ? "ambiguous_match" : "no_match", project: null, candidates };
  }
}
