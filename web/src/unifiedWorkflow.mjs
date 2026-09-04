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
const UPLOAD_DISPLAY_PRIORITY = new Map([
  ["uploading", 4],
  ["failed", 3],
  ["queued", 2],
  ["uploaded", 1],
]);

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

function uploadUpdatedAt(upload) {
  const timestamp = Date.parse(upload?.updatedAt ?? "");
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function preferDisplayUpload(current, candidate) {
  const currentPriority = UPLOAD_DISPLAY_PRIORITY.get(current.status) ?? 0;
  const candidatePriority = UPLOAD_DISPLAY_PRIORITY.get(candidate.status) ?? 0;
  if (candidatePriority !== currentPriority) return candidatePriority > currentPriority;
  return uploadUpdatedAt(candidate) > uploadUpdatedAt(current);
}

function deduplicateArtifactUploads(uploads) {
  const selected = new Map();
  uploads.forEach((upload, index) => {
    const key = typeof upload.artifactId === "string" && upload.artifactId.length > 0
      ? `artifact:${upload.artifactId}`
      : `upload:${typeof upload.id === "string" ? upload.id : index}`;
    const current = selected.get(key);
    if (!current || preferDisplayUpload(current, upload)) selected.set(key, upload);
  });
  return [...selected.values()];
}

function artifactsByTaskId(artifactSummaries) {
  const artifactsByTask = new Map();
  if (!Array.isArray(artifactSummaries)) return artifactsByTask;
  for (const artifact of artifactSummaries) {
    if (
      !artifact
      || typeof artifact !== "object"
      || typeof artifact.taskId !== "string"
      || artifact.validationStatus !== "verified"
    ) {
      continue;
    }
    const list = artifactsByTask.get(artifact.taskId) ?? [];
    list.push(artifact);
    artifactsByTask.set(artifact.taskId, list);
  }
  return artifactsByTask;
}

function normalizedText(value) {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Return a stable, non-sensitive identity for an artifact or upload row.
 * Artifact IDs are preferred because filenames can be reused across runs.
 */
export function artifactIdentity(record) {
  if (!record || typeof record !== "object") return "file::";
  const artifactId = normalizedText(record.artifactId);
  if (artifactId) return `artifact:${artifactId}`;
  const uploadId = normalizedText(record.id);
  if (uploadId) return `upload:${uploadId}`;
  const filename = normalizedText(record.filename).toLocaleLowerCase();
  const createdAt = normalizedText(record.createdAt);
  return `file:${filename}:${createdAt}`;
}

export function filterVerifiedUnifiedArtifacts(artifacts) {
  if (!Array.isArray(artifacts)) return [];
  return artifacts.filter((artifact) => (
    artifact
    && typeof artifact === "object"
    && artifact.validationStatus === "verified"
    && normalizedText(artifact.id)
  ));
}

/**
 * Return one display entry for each independently addressable ZIP. A verified
 * artifact and its upload share the artifact identity, while upload rows with
 * no matching verified artifact remain visible as their own state entry.
 */
export function unifiedWorkflowZipEntries(item) {
  const entriesByIdentity = new Map();
  const addEntry = (identity, artifact = null, upload = null) => {
    const current = entriesByIdentity.get(identity);
    if (!current) {
      entriesByIdentity.set(identity, { identity, artifact, upload });
      return;
    }
    if (artifact && !current.artifact) current.artifact = artifact;
    if (upload && (!current.upload || preferDisplayUpload(current.upload, upload))) {
      current.upload = upload;
    }
  };

  for (const artifact of filterVerifiedUnifiedArtifacts(item?.artifacts)) {
    const identity = artifactIdentity({ artifactId: artifact.id });
    addEntry(identity, artifact);
  }

  for (const upload of Array.isArray(item?.uploads) ? item.uploads : []) {
    if (!upload || typeof upload !== "object") continue;
    const artifactId = normalizedText(upload.artifactId);
    const identity = artifactId
      ? artifactIdentity({ artifactId })
      : artifactIdentity(upload);
    addEntry(identity, null, upload);
  }

  return [...entriesByIdentity.values()];
}

function verifiedArtifactIdentities(item) {
  return new Set(unifiedWorkflowZipEntries(item)
    .filter((entry) => entry.artifact)
    .map((entry) => entry.identity));
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
export function groupUnifiedWorkflowItems(tasks, uploadItems = [], artifactSummaries = []) {
  const uploadsByTask = new Map();
  const artifactsByTask = artifactsByTaskId(artifactSummaries);

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
    const uploads = deduplicateArtifactUploads(uploadsByTask.get(task.id) ?? []);
    const stage = classifyUnifiedStage(task, uploads);
    if (stage) {
      groups[stage].push({
        task,
        uploads,
        artifacts: artifactsByTask.get(task.id) ?? [],
        stage,
      });
    }
  }

  return groups;
}

/**
 * Project grouped task data into an explicitly ordered set of visible stages.
 * Unknown or duplicated stage IDs are ignored so damaged local view data cannot
 * create an unregistered column.
 */
export function projectUnifiedWorkflowGroups(groups, stageIds) {
  const knownStages = new Set(UNIFIED_WORKFLOW_STAGES);
  const projected = {};
  const seen = new Set();
  if (!Array.isArray(stageIds)) return projected;
  for (const stageId of stageIds) {
    if (typeof stageId !== "string" || !knownStages.has(stageId) || seen.has(stageId)) continue;
    seen.add(stageId);
    projected[stageId] = Array.isArray(groups?.[stageId]) ? groups[stageId] : [];
  }
  return projected;
}

function summaryState(searchState) {
  if (!searchState || typeof searchState !== "object") return "ready";
  if (
    searchState.loading === true
    || searchState.uploadLoading === true
    || searchState.status === "syncing"
  ) return "syncing";
  if (searchState.error || searchState.uploadError) return "syncing";
  return "ready";
}

/**
 * Summarize stages hidden by a saved view after the caller has applied its
 * normal task/search filters. ZIP identities are counted once per task.
 */
export function summarizeHiddenUnifiedWorkflow(groups, visibleStageIds, searchState = null) {
  const visible = new Set(Array.isArray(visibleStageIds) ? visibleStageIds : []);
  let taskCount = 0;
  let failedUploadCount = 0;
  const zipIdentities = new Set();
  for (const stageId of UNIFIED_WORKFLOW_STAGES) {
    if (visible.has(stageId)) continue;
    const items = Array.isArray(groups?.[stageId]) ? groups[stageId] : [];
    taskCount += items.length;
    for (const item of items) {
      if (Array.isArray(item?.uploads) && item.uploads.some((upload) => upload?.status === "failed")) {
        failedUploadCount += 1;
      }
      for (const identity of verifiedArtifactIdentities(item)) zipIdentities.add(identity);
    }
  }
  return {
    taskCount,
    zipCount: zipIdentities.size,
    failedUploadCount,
    status: summaryState(searchState),
  };
}

export function matchesUnifiedWorkflowMetadataSearch(item, search) {
  const needle = typeof search === "string" ? search.trim().toLocaleLowerCase() : "";
  if (!needle) return true;
  if (!item || typeof item !== "object") return false;
  const searchable = [
    item.task?.feishuOrigin?.packageAlias,
    ...(Array.isArray(item.uploads) ? item.uploads.map((upload) => upload?.filename) : []),
    ...filterVerifiedUnifiedArtifacts(item.artifacts).map((artifact) => artifact?.filename),
  ];
  return searchable.some((value) => (
    typeof value === "string" && value.toLocaleLowerCase().includes(needle)
  ));
}

export function summarizeUnifiedWorkflowArtifacts(item) {
  const entries = unifiedWorkflowZipEntries(item);
  return {
    zipCount: entries.length,
    unqueuedArtifacts: entries
      .filter((entry) => entry.artifact && !entry.upload)
      .map((entry) => entry.artifact),
  };
}
