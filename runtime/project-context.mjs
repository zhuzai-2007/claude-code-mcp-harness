import { readFile, stat } from "node:fs/promises";
import path from "node:path";

function normalized(value) {
  return String(value || "").trim().toLocaleLowerCase("en-US").replaceAll("\\", "/");
}

function publicProject(project, lastUsed = null) {
  return {
    id: project.id,
    name: project.name,
    path: project.path,
    description: project.description,
    language: project.language,
    techStack: [...project.techStack],
    aliases: [...project.aliases],
    defaultConstraints: [...project.defaultConstraints],
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
      const id = String(entry.id || entry.name || "").trim();
      const name = String(entry.name || "").trim();
      const relativePath = String(entry.path || "").trim().replaceAll("\\", "/").replace(/^\.\//, "");
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
        description: String(entry.description || "").trim(),
        language: String(entry.language || (entry.techStack || []).join(", ") || "unknown").trim(),
        techStack: [...new Set((entry.techStack || String(entry.language || "unknown").split(",")).map((item) => String(item).trim()).filter(Boolean))],
        defaultConstraints: [...new Set((entry.defaultConstraints || []).map((item) => String(item).trim()).filter(Boolean))],
        lastUsed: entry.lastUsed || null,
        aliases: [...new Set([...(entry.aliases || []), name, relativePath].map(normalized).filter(Boolean))]
      };
    });
    if (!this.projects.length) throw new Error("Project registry must contain at least one project.");
    for (const project of this.projects) {
      const details = await stat(path.resolve(this.projectRoot, project.path));
      if (!details.isDirectory()) throw new Error(`Registered project is not a directory: ${project.path}`);
    }
    return this;
  }

  async listProjects() {
    const usage = await this.usageProvider();
    return this.projects.map((project) => publicProject(project, usage[project.id])).sort((left, right) => String(right.lastUsed || "").localeCompare(String(left.lastUsed || "")) || left.name.localeCompare(right.name));
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
