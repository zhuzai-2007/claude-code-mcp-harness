import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const PROJECT_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;

async function writeJsonAtomic(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  let lastError;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try { await rename(temporaryPath, filePath); return; }
    catch (error) {
      lastError = error;
      if (!new Set(["EPERM", "EACCES", "EBUSY"]).has(error?.code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10 * 2 ** attempt));
    }
  }
  throw lastError;
}

function cleanRecord(record) {
  const projectId = String(record?.projectId || "").trim();
  if (!PROJECT_ID_PATTERN.test(projectId)) throw new Error(`Invalid projectId: ${projectId}`);
  const cleaned = { ...record, projectId };
  delete cleaned.id;
  return cleaned;
}

export class ProjectRegistryStore {
  constructor(dataRoot) {
    this.root = path.join(path.resolve(dataRoot), "supervisor-project-registry");
    this.registryPath = path.join(this.root, "projects.json");
    this.lock = Promise.resolve();
  }

  async init() { await mkdir(this.root, { recursive: true }); }

  async readRegistry() {
    try {
      const stored = JSON.parse(await readFile(this.registryPath, "utf8"));
      return {
        schemaVersion: 1,
        projects: Array.isArray(stored.projects) ? stored.projects.map(cleanRecord) : []
      };
    } catch (error) {
      if (error?.code === "ENOENT") return { schemaVersion: 1, projects: [] };
      throw error;
    }
  }

  async listRecords() { return (await this.readRegistry()).projects.map((record) => ({ ...record })); }

  async upsert(record) {
    return this._withLock(async () => {
      await this.init();
      const cleaned = cleanRecord(record);
      const registry = await this.readRegistry();
      const index = registry.projects.findIndex((entry) => entry.projectId === cleaned.projectId);
      if (index >= 0) registry.projects[index] = { ...registry.projects[index], ...cleaned };
      else registry.projects.push(cleaned);
      await writeJsonAtomic(this.registryPath, registry);
      return { ...registry.projects[index >= 0 ? index : registry.projects.length - 1] };
    });
  }

  async _withLock(operation) {
    const previous = this.lock;
    let release;
    this.lock = new Promise((resolve) => { release = resolve; });
    await previous;
    try { return await operation(); }
    finally { release(); }
  }
}
