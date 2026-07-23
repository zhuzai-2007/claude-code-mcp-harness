import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkflowMetadataStore } from "./workflow-metadata-store.mjs";

const root = await mkdtemp(path.join(os.tmpdir(), "workflow-metadata-v2-"));
try {
  const store = new WorkflowMetadataStore(root);
  await store.init();
  const legacyId = "workflow_legacy_fixture";
  await writeFile(store.metadataPath(legacyId), `${JSON.stringify({ schemaVersion: 1, workflowId: legacyId, displayName: "Legacy", archived: false, folderId: "default", updatedAt: null })}\n`, "utf8");
  const legacy = await store.read(legacyId);
  assert.equal(legacy.schemaVersion, 1, "legacy metadata remains readable without eager rewriting");
  assert.equal(legacy.archivedAt, null);

  const archived = await store.update(legacyId, { archived: true }, "2026-07-18T12:00:00.000Z");
  assert.equal(archived.schemaVersion, 2);
  assert.equal(archived.archived, true);
  assert.equal(archived.archivedAt, "2026-07-18T12:00:00.000Z");
  const restored = await store.update(legacyId, { archived: false }, "2026-07-18T13:00:00.000Z");
  assert.equal(restored.archived, false);
  assert.equal(restored.archivedAt, null);
  assert.equal(restored.folderId, "default", "legacy folder metadata is preserved for compatibility");
  assert.equal(JSON.parse(await readFile(store.metadataPath(legacyId), "utf8")).schemaVersion, 2);

  console.log(JSON.stringify({ ok: true, legacySchemaReadable: true, archiveRestore: true, historicalFolderPreserved: true }, null, 2));
} finally {
  await rm(root, { recursive: true, force: true });
}
