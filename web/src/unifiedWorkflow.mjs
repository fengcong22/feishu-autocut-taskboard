import { UNIFIED_WORKFLOW_STAGES } from "../../shared/unified-workflow-stages.mjs";

export { UNIFIED_WORKFLOW_STAGES };

const ACTIVE_TASK_STAGES = new Set([
  "todo",
  "queued",
  "in_progress",
  "in_review",
  "blocked",
]);

const UPLOAD_STAGES = new Set(["queued", "uploading", "uploaded", "failed"]);

function uploadRecord(candidate) {
  // `classifyUnifiedStage` receives ArtifactUpload records while the project
  // list API returns ArtifactUploadListItem rows. Accepting either shape keeps
  // the classifier independent from the view's data-loading boundary.
  if (!candidate || typeof candidate !== "object") return null;
  const record = candidate.upload && typeof candidate.upload === "object"
    ? candidate.upload
    : candidate;
  return typeof record.taskId === "string" && UPLOAD_STAGES.has(record.status)
    ? record
    : null;
}

function uploadsForTask(task, uploads) {
  if (!Array.isArray(uploads) || !task || typeof task.id !== "string") return [];
  return uploads
    .map(uploadRecord)
    .filter((candidate) => candidate?.taskId === task.id);
}

/**
 * Return the single unified stage to which a Feishu task belongs.
 * Upload activity deliberately wins over the task's own editing status.
 */
export function classifyUnifiedStage(task, uploads = []) {
  if (!task || typeof task !== "object") return null;
  if (task.feishuOrigin?.source !== "feishu-base") return null;
  if (task.archivedAt != null || task.status === "backlog" || task.status === "canceled") {
    return null;
  }

  const taskUploads = uploadsForTask(task, uploads);
  if (taskUploads.some((candidate) => candidate.status === "uploading")) {
    return "uploading";
  }
  if (taskUploads.some((candidate) => candidate.status === "queued" || candidate.status === "failed")) {
    return "upload_queue";
  }
  if (taskUploads.some((candidate) => candidate.status === "uploaded")) {
    return "uploaded";
  }
  if (task.status === "done") return "completed_editing";
  return ACTIVE_TASK_STAGES.has(task.status) ? task.status : null;
}

/**
 * Group task/upload rows into one, and only one, unified stage per task.
 */
export function groupUnifiedWorkflowItems(tasks, uploadItems = []) {
  const uploadsByTask = new Map();

  if (Array.isArray(uploadItems)) {
    for (const item of uploadItems) {
      const upload = uploadRecord(item);
      if (!upload) continue;
      const list = uploadsByTask.get(upload.taskId) ?? [];
      list.push(upload);
      uploadsByTask.set(upload.taskId, list);
    }
  }

  const groups = Object.fromEntries(
    UNIFIED_WORKFLOW_STAGES.map((stage) => [stage, []]),
  );

  if (!Array.isArray(tasks)) return groups;
  for (const task of tasks) {
    if (!task || typeof task.id !== "string") continue;
    const uploads = uploadsByTask.get(task.id) ?? [];
    const stage = classifyUnifiedStage(task, uploads);
    if (stage) groups[stage].push({ task, uploads, stage });
  }

  return groups;
}
