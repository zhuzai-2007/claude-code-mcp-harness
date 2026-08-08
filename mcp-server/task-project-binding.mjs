export function resolveTaskProjectContext(projectRegistry, prompt) {
  const resolution = projectRegistry.resolve(prompt);
  if (resolution.status !== "selected") return null;
  const project = projectRegistry.getProjectContext(resolution.project.id).project;
  return {
    projectId: project.id,
    name: project.name,
    workspacePath: project.workspacePath,
    workspaceRelativePath: project.path
  };
}
