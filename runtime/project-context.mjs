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
    lastUsed: lastUsed || project.lastUsed || null
  };
}

export class ProjectContextRegistry {
  constructor({ projectRoot, registryPath, usageProvider = null }) {
    this.projectRoot = path.resolve(projectRoot);
    this.registryPath = path.resolve(registryPath);
    this.usageProvider = usageProvider || (async () => ({}));
    this.projects = [];
  }

  async init() {
    const config = JSON.parse((await readFile(this.registryPath, "utf8")).replace(/^\uFEFF/, ""));
    const ids = new Set();
    this.projects = (config.projects || []).map((entry) => {
      const id = String(entry.projectId || entry.id || entry.name || "").trim();
      const name = String(entry.name || "").trim();
      const relativePath = String(entry.workspacePath || entry.path || "").trim().replaceAll("\\", "/").replace(/^\.\//, "");
      if (!id || !name || !relativePath) throw new Error("Each registered project requires id, name, and path.");
      if (ids.has(id)) throw new Error(`Duplicate registered project id: ${id}`);
      ids.add(id);
      const absolutePath = path.resolve(this.projectRoot, relativePath);
      const relative = path.relative(this.projectRoot, absolutePath);
      if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Registered project escapes projectRoot: ${relativePath}`);
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
        aliases: [...new Set([...(entry.aliases || []), name, relativePath].map(normalized).filter(Boolean))]
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

  async listProjects() {
    const usage = await this.usageProvider();
    return this.projects.map((project) => publicProject(project, usage[project.id])).sort((left, right) => String(right.lastUsed || "").localeCompare(String(left.lastUsed || "")) || left.name.localeCompare(right.name));
  }

  async refreshProjectMemory(selector) {
    const resolution = this.resolve("", { selector });
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
    const resolution = this.resolve("", { selector });
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

  resolve(userRequest, { selector = null } = {}) {
    if (!this.projects.length) throw new Error("Project registry is not initialized.");
    if (selector) {
      const exact = normalized(selector);
      const project = this.projects.find((candidate) => [candidate.id, candidate.name, candidate.path, ...candidate.aliases].map(normalized).includes(exact));
      if (!project) throw new Error(`Unknown registered project: ${selector}`);
      return { status: "selected", method: "explicit", project: publicProject(project), candidates: [] };
    }

    if (this.projects.length === 1) return { status: "selected", method: "only_candidate", project: publicProject(this.projects[0]), candidates: [] };

    const text = normalized(userRequest);
    const scored = this.projects.map((project) => {
      const matches = project.aliases.filter((alias) => alias.length >= 2 && text.includes(alias));
      return { project, score: matches.reduce((total, alias) => total + alias.length, 0), matches };
    }).filter((entry) => entry.score > 0).sort((left, right) => right.score - left.score || left.project.name.localeCompare(right.project.name));
    const winners = scored.filter((entry) => entry.score === scored[0]?.score);
    if (winners.length === 1) return { status: "selected", method: "request_match", project: publicProject(winners[0].project), candidates: [] };

    const candidates = (winners.length ? winners : this.projects.map((project) => ({ project }))).map(({ project }) => publicProject(project));
    return { status: "confirmation_required", method: winners.length ? "ambiguous_match" : "no_match", project: null, candidates };
  }
}
