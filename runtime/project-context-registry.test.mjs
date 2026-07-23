import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ProjectContextRegistry } from "./project-context.mjs";

async function createFixture({ releaseProjects, localProjects = null, overlay = [] }) {
  const root = await mkdtemp(path.join(os.tmpdir(), "supervisor-project-registry-"));
  await mkdir(path.join(root, ".agents"), { recursive: true });
  await mkdir(path.join(root, "workspace"), { recursive: true });
  for (const project of [...releaseProjects, ...(localProjects || [])]) {
    const configuredPath = String(project.workspacePath || project.path || "");
    if (!path.isAbsolute(configuredPath)) await mkdir(path.resolve(root, configuredPath), { recursive: true });
  }
  const releasePath = path.join(root, ".agents", "projects.json");
  const localPath = path.join(root, ".agents", "projects.local.json");
  await writeFile(releasePath, JSON.stringify({ schemaVersion: 1, projects: releaseProjects }), "utf8");
  if (localProjects) await writeFile(localPath, JSON.stringify({ schemaVersion: 1, projects: localProjects }), "utf8");
  const registry = new ProjectContextRegistry({
    projectRoot: root,
    registryPath: releasePath,
    localRegistryPath: localPath,
    workspaceRoot: "workspace",
    metadataStore: { listRecords: async () => overlay }
  });
  return { root, registry };
}

const project = (projectId, workspacePath) => ({
  projectId,
  name: projectId,
  workspacePath,
  description: `${projectId} description`,
  stack: ["JavaScript"],
  aliases: [projectId],
  constraints: ["Stay inside the project workspace."]
});

test("loads release registry when the optional local registry is missing", async () => {
  const fixture = await createFixture({ releaseProjects: [project("release-project", "workspace/release-project")] });
  try {
    await fixture.registry.init();
    const projects = await fixture.registry.listProjects();
    assert.equal(projects.length, 1);
    assert.equal(projects[0].projectId, "release-project");
    assert.equal(projects[0].source, "base");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("merges release, local, and runtime metadata in that order", async () => {
  const fixture = await createFixture({
    releaseProjects: [project("release-project", "workspace/release-project")],
    localProjects: [project("local-project", "workspace/local-project")],
    overlay: [{ projectId: "local-project", pinned: true }]
  });
  try {
    await fixture.registry.init();
    const projects = await fixture.registry.listProjects();
    assert.deepEqual(projects.map((entry) => entry.projectId).sort(), ["local-project", "release-project"]);
    const local = projects.find((entry) => entry.projectId === "local-project");
    assert.equal(local.source, "local");
    assert.equal(local.pinned, true);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("rejects projectId conflicts between release and local registries", async () => {
  const fixture = await createFixture({
    releaseProjects: [project("conflict", "workspace/release-project")],
    localProjects: [project("conflict", "workspace/local-project")]
  });
  try {
    await assert.rejects(() => fixture.registry.init(), /Duplicate projectId across release and local registries: conflict/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("rejects absolute and workspace-external local paths", async (t) => {
  await t.test("absolute", async () => {
    const fixture = await createFixture({
      releaseProjects: [project("release-project", "workspace/release-project")],
      localProjects: [project("local-project", path.join(os.tmpdir(), "outside-project"))]
    });
    try {
      await assert.rejects(() => fixture.registry.init(), /Local project path must be relative/);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  await t.test("outside workspace", async () => {
    const fixture = await createFixture({
      releaseProjects: [project("release-project", "workspace/release-project")],
      localProjects: [project("local-project", "docs/local-project")]
    });
    try {
      await assert.rejects(() => fixture.registry.init(), /Local project must be inside the workspace root/);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});

test("ignores and diagnoses orphaned runtime-only metadata without rewriting it", async () => {
  const fixture = await createFixture({
    releaseProjects: [project("release-project", "workspace/release-project")],
    overlay: [{ projectId: "retired-local-project", archived: true }]
  });
  try {
    await fixture.registry.init();
    assert.equal((await fixture.registry.listProjects()).length, 1);
    assert.deepEqual(fixture.registry.getDiagnostics().map((entry) => entry.code), ["orphaned_runtime_project_metadata"]);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
