import assert from "node:assert/strict";
import { SupervisorService } from "./supervisor-service.mjs";

let listCalls = 0;
let renameCalls = 0;
let metadataCalls = 0;
let activeWorkflows = [{ workflowId: "workflow_active", projectId: "board", status: "running" }];

const project = { projectId: "board", id: "board", name: "Board", workspacePath: "D:/workspace/board", managed: true, archived: false, pinned: false };
const service = new SupervisorService({
  decisionLayer: { projectRegistry: { getProjectContext: () => ({ project: { ...project } }) } },
  store: {},
  workflowRuntime: {
    async listWorkflows() { listCalls += 1; return activeWorkflows; }
  },
  projectWorkspaceService: {
    async renameProject(projectId, input) { renameCalls += 1; return { ...project, projectId, name: input.name }; },
    async updateProjectMetadata(projectId, patch) { metadataCalls += 1; return { ...project, projectId, ...patch }; }
  }
});

const pinned = await service.updateProject("board", { pinned: true });
assert.equal(pinned.pinned, true);
assert.equal(listCalls, 0, "pinning must not scan all Workflows");

const restored = await service.updateProject("board", { archived: false });
assert.equal(restored.archived, false);
assert.equal(listCalls, 0, "restoring a Project must not scan all Workflows");

await assert.rejects(() => service.updateProject("board", { name: "Renamed Board" }), /active Workflow/i);
assert.equal(listCalls, 1);
assert.equal(renameCalls, 0, "active Project rename must remain blocked");

await assert.rejects(() => service.updateProject("board", { archived: true }), /active Workflow/i);
assert.equal(listCalls, 2);

activeWorkflows = [];
const renamed = await service.updateProject("board", { name: "Renamed Board" });
assert.equal(renamed.name, "Renamed Board");
assert.equal(renameCalls, 1);
assert.equal(metadataCalls, 2);

console.log(JSON.stringify({ ok: true, pinWithoutWorkflowScan: true, restoreWithoutWorkflowScan: true, activeRenameArchiveBlocked: true }, null, 2));
