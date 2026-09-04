export function resolveProjectIdAfterRefresh(projects, {
  requestedProjectId,
  currentProjectId,
  globalProjectId,
}) {
  const rows = Array.isArray(projects) ? projects : [];
  const requested = rows.find((project) => project?.id === requestedProjectId);
  if (requested) return requested.id;

  const current = rows.find((project) => project?.id === currentProjectId);
  if (current) return current.id;

  const activeGlobal = rows.find((project) => (
    project?.id === globalProjectId && project.archivedAt == null
  ));
  if (activeGlobal) return activeGlobal.id;

  return rows.find((project) => project?.archivedAt == null)?.id ?? globalProjectId;
}

export function findFeishuSubjectKeyForProject(
  projectId,
  activeSubjectKey,
  activeTasks = [],
  archivedTasks = [],
  retainedSubjectKey = null,
) {
  if (typeof activeSubjectKey === "string" && activeSubjectKey.length > 0) {
    return activeSubjectKey;
  }
  if (typeof retainedSubjectKey === "string" && retainedSubjectKey.length > 0) {
    return retainedSubjectKey;
  }
  const tasks = [
    ...(Array.isArray(activeTasks) ? activeTasks : []),
    ...(Array.isArray(archivedTasks) ? archivedTasks : []),
  ];
  const matchingTask = tasks.find((task) => (
    task?.projectId === projectId
    && task?.feishuOrigin?.source === "feishu-base"
    && typeof task.feishuOrigin.subjectKey === "string"
    && task.feishuOrigin.subjectKey.length > 0
  ));
  return matchingTask?.feishuOrigin?.subjectKey ?? null;
}
