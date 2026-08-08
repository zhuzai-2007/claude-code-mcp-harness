import assert from "node:assert/strict";
import { resolveTaskProjectContext } from "./task-project-binding.mjs";

const selectedProject = { id: "markdown-todo-demo", name: "dogfood-v19-demo", workspacePath: "D:/repo/workspace/dogfood-v19-demo", path: "workspace/dogfood-v19-demo" };
const selectedRegistry = {
  resolve(prompt) {
    assert.match(prompt, /markdown-todo-demo/);
    return { status: "selected", method: "request_match", project: selectedProject };
  },
  getProjectContext(projectId) {
    assert.equal(projectId, selectedProject.id);
    return { project: selectedProject };
  }
};

assert.deepEqual(resolveTaskProjectContext(selectedRegistry, "Plan registered Project markdown-todo-demo"), {
  projectId: "markdown-todo-demo",
  name: "dogfood-v19-demo",
  workspacePath: "D:/repo/workspace/dogfood-v19-demo",
  workspaceRelativePath: "workspace/dogfood-v19-demo"
});

const ambiguousRegistry = {
  resolve() { return { status: "confirmation_required", method: "ambiguous_match", project: null }; },
  getProjectContext() { throw new Error("Ambiguous Project must not be bound"); }
};
assert.equal(resolveTaskProjectContext(ambiguousRegistry, "Plan the project"), null);

console.log(JSON.stringify({ ok: true, projectId: selectedProject.id, ambiguousBound: false }, null, 2));
