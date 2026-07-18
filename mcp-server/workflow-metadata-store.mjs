import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const WORKFLOW_ID_PATTERN = /^workflow_[a-zA-Z0-9_-]+$/;
const FOLDER_ID_PATTERN = /^folder_[a-zA-Z0-9_-]+$/;
export const DEFAULT_FOLDER_ID = "default";

async function writeJsonAtomic(filePath, value) {
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

export class WorkflowMetadataStore {
  constructor(dataRoot) {
    this.root = path.join(path.resolve(dataRoot), "supervisor-workflow-metadata");
    this.foldersPath = path.join(this.root, "folders.json");
  }

  async init() { await mkdir(this.root, { recursive: true }); }

  metadataPath(workflowId) {
    if (!WORKFLOW_ID_PATTERN.test(String(workflowId || ""))) throw new Error(`Invalid workflowId: ${workflowId}`);
    return path.join(this.root, `${workflowId}.json`);
  }

  defaultMetadata(workflowId) {
    return { schemaVersion: 1, workflowId, displayName: null, archived: false, folderId: DEFAULT_FOLDER_ID, updatedAt: null };
  }

  defaultFolder() {
    return { folderId: DEFAULT_FOLDER_ID, name: "Default", pinned: true, system: true, createdAt: null, updatedAt: null };
  }

  async readFolderRegistry() {
    try {
      const stored = JSON.parse(await readFile(this.foldersPath, "utf8"));
      return {
        schemaVersion: 1,
        folders: Array.isArray(stored.folders) ? stored.folders.filter((folder) => FOLDER_ID_PATTERN.test(folder?.folderId)) : []
      };
    } catch (error) {
      if (error?.code === "ENOENT") return { schemaVersion: 1, folders: [] };
      throw error;
    }
  }

  async listFolders() {
    const registry = await this.readFolderRegistry();
    const custom = [...registry.folders].sort((left, right) => Number(right.pinned) - Number(left.pinned) || String(right.updatedAt || right.createdAt).localeCompare(String(left.updatedAt || left.createdAt)));
    return [this.defaultFolder(), ...custom.map((folder) => ({ ...folder, system: false }))];
  }

  async createFolder(name, timestamp = new Date().toISOString()) {
    await this.init();
    const normalizedName = this.normalizeFolderName(name);
    const registry = await this.readFolderRegistry();
    const folder = { folderId: `folder_${randomUUID().replaceAll("-", "")}`, name: normalizedName, pinned: false, system: false, createdAt: timestamp, updatedAt: timestamp };
    registry.folders.push(folder);
    await writeJsonAtomic(this.foldersPath, registry);
    return folder;
  }

  async updateFolder(folderId, patch, timestamp = new Date().toISOString()) {
    if (folderId === DEFAULT_FOLDER_ID) throw new Error("The default folder cannot be renamed or pinned.");
    if (!FOLDER_ID_PATTERN.test(String(folderId || ""))) throw new Error(`Invalid folderId: ${folderId}`);
    const registry = await this.readFolderRegistry();
    const index = registry.folders.findIndex((folder) => folder.folderId === folderId);
    if (index < 0) throw new Error(`Unknown folderId: ${folderId}`);
    const current = registry.folders[index];
    registry.folders[index] = {
      ...current,
      ...(Object.hasOwn(patch, "name") ? { name: this.normalizeFolderName(patch.name) } : {}),
      ...(Object.hasOwn(patch, "pinned") ? { pinned: Boolean(patch.pinned) } : {}),
      updatedAt: timestamp
    };
    await writeJsonAtomic(this.foldersPath, registry);
    return { ...registry.folders[index], system: false };
  }

  async deleteFolder(folderId, timestamp = new Date().toISOString()) {
    if (folderId === DEFAULT_FOLDER_ID) throw new Error("The default folder cannot be deleted.");
    if (!FOLDER_ID_PATTERN.test(String(folderId || ""))) throw new Error(`Invalid folderId: ${folderId}`);
    const registry = await this.readFolderRegistry();
    const folder = registry.folders.find((item) => item.folderId === folderId);
    if (!folder) throw new Error(`Unknown folderId: ${folderId}`);
    let movedWorkflows = 0;
    for (const entry of await readdir(this.root, { withFileTypes: true })) {
      if (!entry.isFile() || !/^workflow_[a-zA-Z0-9_-]+\.json$/.test(entry.name)) continue;
      const workflowId = entry.name.slice(0, -5);
      const metadata = await this.read(workflowId);
      if (metadata.folderId !== folderId) continue;
      await this.update(workflowId, { folderId: DEFAULT_FOLDER_ID }, timestamp);
      movedWorkflows += 1;
    }
    registry.folders = registry.folders.filter((item) => item.folderId !== folderId);
    await writeJsonAtomic(this.foldersPath, registry);
    return { folderId, movedWorkflows };
  }

  normalizeFolderName(value) {
    const name = String(value || "").trim();
    if (name.length < 1 || name.length > 60) throw new Error("Folder name must contain 1-60 characters.");
    return name;
  }

  async read(workflowId) {
    try {
      const stored = JSON.parse(await readFile(this.metadataPath(workflowId), "utf8"));
      return { ...this.defaultMetadata(workflowId), ...stored, workflowId };
    } catch (error) {
      if (error?.code === "ENOENT") return this.defaultMetadata(workflowId);
      throw error;
    }
  }

  async update(workflowId, patch, timestamp = new Date().toISOString()) {
    await this.init();
    const current = await this.read(workflowId);
    if (Object.hasOwn(patch, "folderId")) {
      const folderId = String(patch.folderId || "");
      const folders = await this.listFolders();
      if (!folders.some((folder) => folder.folderId === folderId)) throw new Error(`Unknown folderId: ${folderId}`);
    }
    const updated = {
      ...current,
      ...(Object.hasOwn(patch, "displayName") ? { displayName: patch.displayName } : {}),
      ...(Object.hasOwn(patch, "archived") ? { archived: patch.archived } : {}),
      ...(Object.hasOwn(patch, "folderId") ? { folderId: patch.folderId } : {}),
      schemaVersion: 1,
      workflowId,
      updatedAt: timestamp
    };
    await writeJsonAtomic(this.metadataPath(workflowId), updated);
    return updated;
  }
}
