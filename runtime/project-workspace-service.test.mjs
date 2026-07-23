import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ProjectContextRegistry } from "./project-context.mjs";
import { ProjectRegistryStore } from "./project-registry-store.mjs";
import { ProjectWorkspaceService } from "./project-workspace-service.mjs";

const root = await mkdtemp(path.join(os.tmpdir(), "supervisor-project-workspace-"));
try {
  await mkdir(path.join(root, ".agents"), { recursive: true });
  await mkdir(path.join(root, "workspace", "existing"), { recursive: true });
  await mkdir(path.join(root, "workspace", "unregistered-do-not-import"), { recursive: true });
  await writeFile(path.join(root, ".agents", "projects.json"), JSON.stringify({
    schemaVersion: 3,
    projects: [
      { projectId: "system-root", name: "System Root", workspacePath: ".", description: "Root", stack: ["Node.js"], aliases: ["root"], constraints: ["Keep boundaries"] },
      { projectId: "existing", name: "Existing", workspacePath: "workspace/existing", description: "Existing", stack: ["HTML"], aliases: ["existing"], constraints: ["Keep boundaries"] }
    ]
  }, null, 2));

  const registryStore = new ProjectRegistryStore(path.join(root, "runtime-data"));
  const registry = new ProjectContextRegistry({ projectRoot: root, registryPath: path.join(root, ".agents", "projects.json"), metadataStore: registryStore });
  await registryStore.init();
  await registry.init();
  const service = new ProjectWorkspaceService({ projectRoot: root, workspaceRoot: path.join(root, "workspace"), projectRegistry: registry, registryStore });
  await service.init();

  const initial = await registry.listProjects();
  assert.equal(initial.length, 2, "unregistered workspace directories must never be auto-imported");
  assert.equal(initial.find((project) => project.projectId === "system-root").managed, false);
  assert.equal(initial.find((project) => project.projectId === "existing").managed, true);

  await assert.rejects(() => service.createProject({ name: "Unsafe Demo", workspacePath: "D:/must-be-rejected" }), /cannot be provided/i);
  const created = await service.createProject({ name: "CSV Demo" });
  assert.equal(created.projectId, "csv-demo");
  assert.equal(created.path, "workspace/csv-demo");
  assert.equal(created.managed, true);
  await access(path.join(root, "workspace", "csv-demo"));
  await assert.rejects(() => service.createProject({ name: "csv demo" }), /already exists/i);

  const renamed = await service.renameProject(created.projectId, { name: "Export Demo" });
  assert.equal(renamed.projectId, created.projectId, "projectId must remain stable after rename");
  assert.equal(renamed.name, "Export Demo");
  assert.equal(renamed.path, "workspace/export-demo");
  await access(path.join(root, "workspace", "export-demo"));
  await assert.rejects(() => access(path.join(root, "workspace", "csv-demo")));
  await assert.rejects(() => service.renameProject("system-root", { name: "Moved Root" }), /Only managed/);

  const archived = await service.updateProjectMetadata(created.projectId, { archived: true, pinned: true });
  assert.equal(archived.archived, true);
  assert.equal(archived.pinned, true);

  const reloadedStore = new ProjectRegistryStore(path.join(root, "runtime-data"));
  const reloaded = new ProjectContextRegistry({ projectRoot: root, registryPath: path.join(root, ".agents", "projects.json"), metadataStore: reloadedStore });
  await reloaded.init();
  const persisted = reloaded.getProjectContext(created.projectId).project;
  assert.equal(persisted.name, "Export Demo");
  assert.equal(persisted.path, "workspace/export-demo");
  assert.equal(persisted.archived, true);
  assert.throws(() => reloaded.resolve("create work", { selector: created.projectId }), /archived/i, "archived Projects must reject Workflow creation");
  assert.equal((await reloaded.listProjects()).length, 3);
  const stored = JSON.parse(await readFile(path.join(root, "runtime-data", "supervisor-project-registry", "projects.json"), "utf8"));
  assert.equal(stored.schemaVersion, 1);
  assert.equal(stored.projects.length, 1, "base projects remain in the immutable base registry until overridden");

  const unsafeStore = new ProjectRegistryStore(path.join(root, "unsafe-runtime-data"));
  await unsafeStore.upsert({ projectId: "unsafe", name: "Unsafe", workspacePath: "outside-workspace", managed: true });
  const unsafeRegistry = new ProjectContextRegistry({ projectRoot: root, registryPath: path.join(root, ".agents", "projects.json"), metadataStore: unsafeStore });
  await assert.rejects(() => unsafeRegistry.init(), /direct child of the workspace root/i, "a persisted managed Project cannot point outside workspace root");

  console.log(JSON.stringify({ ok: true, projectIdStable: true, managedWorkspaceOnly: true, unregisteredNotImported: true, overlayCompatible: true }, null, 2));
} finally {
  await rm(root, { recursive: true, force: true });
}
