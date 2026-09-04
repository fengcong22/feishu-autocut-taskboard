import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  ARTIFACT_UPLOAD_LEASE_DURATION_MS,
  ARTIFACT_UPLOAD_MAX_FUTURE_MS,
  artifactUploadLeaseNeedsRecovery,
  parseArtifactUploadTimestamp,
} from "./artifact-upload-lease.mjs";
import { UNIFIED_WORKFLOW_STAGES } from "../shared/unified-workflow-stages.mjs";

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function now() {
  return new Date().toISOString();
}

const BOARD_STAGE_STATUS_IDS = [
  "backlog",
  "todo",
  "queued",
  "in_progress",
  "in_review",
  "blocked",
  "done",
  "canceled",
];

const DEFAULT_BOARD_STAGE_LABELS = {
  zh: {
    backlog: "待立项",
    todo: "待处理",
    queued: "排队中",
    in_progress: "处理中",
    in_review: "待验收",
    blocked: "遇到阻碍",
    done: "已完成",
    canceled: "已取消",
  },
  en: {
    backlog: "Backlog",
    todo: "To do",
    queued: "Queued",
    in_progress: "In progress",
    in_review: "In review",
    blocked: "Blocked",
    done: "Done",
    canceled: "Canceled",
  },
};

const SYSTEM_UNIFIED_WORKFLOW_VIEW_ID = "all";
const SYSTEM_UNIFIED_WORKFLOW_VIEW_NAME = "全部流程";
const UNIFIED_WORKFLOW_STAGE_IDS = new Set(UNIFIED_WORKFLOW_STAGES);

function normalizeUnifiedWorkflowSubjectKey(value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ApiError(400, "INVALID_FIELD", "subjectKey must be a non-empty string");
  }
  return value.trim();
}

function normalizeUnifiedWorkflowRevision(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ApiError(400, "INVALID_FIELD", `${name} must be a positive integer`);
  }
  return value;
}

function normalizeUnifiedWorkflowViewName(value) {
  if (typeof value !== "string") {
    throw new ApiError(400, "INVALID_FIELD", "name must be a string");
  }
  const name = value.trim();
  if (name === "" || [...name].length > 64) {
    throw new ApiError(400, "INVALID_FIELD", "name must contain between 1 and 64 characters");
  }
  return name;
}

function normalizeUnifiedWorkflowStageIds(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ApiError(400, "INVALID_FIELD", "stageIds must contain at least one stage");
  }
  const seen = new Set();
  for (const stageId of value) {
    if (typeof stageId !== "string" || !UNIFIED_WORKFLOW_STAGE_IDS.has(stageId)) {
      throw new ApiError(400, "INVALID_FIELD", `Unknown unified workflow stage '${String(stageId)}'`);
    }
    if (seen.has(stageId)) {
      throw new ApiError(400, "INVALID_FIELD", `stageIds contains duplicate stage '${stageId}'`);
    }
    seen.add(stageId);
  }
  return [...value];
}

const UNIFIED_WORKFLOW_STAGE_DISPLAY_FIELDS = Object.freeze([
  "zhName",
  "enName",
  "zhDescription",
  "enDescription",
]);

function normalizeUnifiedWorkflowStageDisplayText(value, fieldName, maxLength) {
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new ApiError(400, "INVALID_FIELD", `${fieldName} must be a string or null`);
  }
  if (/[\u0000-\u001f\u007f-\u009f\p{Cf}<>]/u.test(value)) {
    throw new ApiError(400, "INVALID_FIELD", `${fieldName} must be plain text without markup or control characters`);
  }
  const normalized = value.trim();
  if ([...normalized].length > maxLength) {
    throw new ApiError(400, "INVALID_FIELD", `${fieldName} must contain at most ${maxLength} characters`);
  }
  return normalized;
}

function unifiedWorkflowStageDisplayFromRow(row) {
  if (
    typeof row.subject_key !== "string"
    || typeof row.stage_id !== "string"
    || !UNIFIED_WORKFLOW_STAGE_IDS.has(row.stage_id)
    || !Number.isSafeInteger(row.revision)
    || row.revision < 1
    || typeof row.updated_at !== "string"
  ) {
    throw new TypeError("Invalid persisted unified workflow stage display");
  }
  return {
    subjectKey: row.subject_key,
    stageId: row.stage_id,
    zhName: row.zh_name,
    enName: row.en_name,
    zhDescription: row.zh_description,
    enDescription: row.en_description,
    revision: row.revision,
    updatedAt: row.updated_at,
  };
}

function unifiedWorkflowViewFromRow(row) {
  if (
    typeof row.id !== "string"
    || row.id.trim() === ""
    || row.id !== row.id.trim()
    || typeof row.subject_key !== "string"
    || !Number.isSafeInteger(row.revision)
    || row.revision < 1
    || typeof row.created_at !== "string"
    || typeof row.updated_at !== "string"
  ) {
    throw new TypeError("Invalid persisted unified workflow view");
  }
  return {
    id: row.id,
    subjectKey: row.subject_key,
    name: normalizeUnifiedWorkflowViewName(row.name),
    stageIds: normalizeUnifiedWorkflowStageIds(JSON.parse(row.stage_ids_json)),
    isSystem: Boolean(row.is_system),
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeBoardStageLabels(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, "INVALID_BOARD_STAGE_LABELS", "Board stage labels must be an object");
  }
  const result = {};
  for (const language of ["zh", "en"]) {
    const source = value[language];
    if (!source || typeof source !== "object" || Array.isArray(source)) {
      throw new ApiError(400, "INVALID_BOARD_STAGE_LABELS", `Board stage labels '${language}' must be an object`);
    }
    result[language] = {};
    for (const status of BOARD_STAGE_STATUS_IDS) {
      const label = source[status];
      if (typeof label !== "string" || label.trim() === "" || label.length > 80) {
        throw new ApiError(400, "INVALID_BOARD_STAGE_LABELS", `Board stage label '${language}.${status}' is invalid`);
      }
      result[language][status] = label.trim();
    }
  }
  return result;
}

function boardStageLabelsFromRow(row) {
  return {
    version: row.version,
    labels: normalizeBoardStageLabels(JSON.parse(row.value_json)),
  };
}

function commentConversationTitle(body) {
  const firstLine = String(body ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) return "评论";
  const compact = firstLine.replace(/\s+/g, " ");
  return compact.length > 80 ? `${compact.slice(0, 77)}…` : compact;
}

function attachTaskActivity(task, comments, activities, previewImage = null) {
  const orderedComments = [...comments].sort((left, right) => (
    left.id.localeCompare(right.id)
  ));
  const orderedActivities = [...activities].sort((left, right) => (
    left.id.localeCompare(right.id)
  ));
  const participants = [];
  const participantIds = new Set();
  const addParticipant = (actor) => {
    const key = `${actor.type}:${actor.id}`;
    if (participantIds.has(key)) return;
    participantIds.add(key);
    participants.push(actor);
  };
  addParticipant({
    type: task.creatorType,
    id: task.creatorId,
    name: task.creatorName,
    avatarUrl: task.creatorAvatarUrl,
  });
  addParticipant(task.assignee);
  for (const comment of orderedComments) {
    addParticipant({
      type: comment.author_type,
      id: comment.author_id,
      name: comment.author_name,
      avatarUrl: comment.author_avatar_url,
    });
  }
  for (const activity of orderedActivities) {
    addParticipant({
      type: activity.actor_type,
      id: activity.actor_id,
      name: activity.actor_name,
      avatarUrl: activity.actor_avatar_url,
    });
  }
  const conversationRefs = [];
  if (task.threadId) {
    conversationRefs.push({
      threadId: task.threadId,
      source: "task",
      sourceId: task.id,
      title: task.title,
      updatedAt: task.updatedAt,
    });
  }
  for (const comment of orderedComments) {
    if (!comment.thread_id) continue;
    conversationRefs.push({
      threadId: comment.thread_id,
      source: "comment",
      sourceId: comment.id,
      title: commentConversationTitle(comment.body),
      updatedAt: comment.updated_at,
    });
  }

  task.conversationRefs = conversationRefs;
  task.participants = participants;
  task.previewImage = previewImage;
  task.activityKey = JSON.stringify({
    version: 1,
    task: [task.id, task.version, task.updatedAt],
    comments: orderedComments.map((comment) => [comment.id, comment.version, comment.updated_at]),
    changes: orderedActivities.map((activity) => [activity.id, activity.created_at]),
  });
  task.activityUpdatedAt = [...orderedComments, ...orderedActivities].reduce(
    (latest, activity) => {
      const updatedAt = activity.updated_at ?? activity.created_at;
      return updatedAt > latest ? updatedAt : latest;
    },
    task.updatedAt,
  );
  return task;
}

function taskActivityFromRow(row) {
  return {
    id: row.id,
    taskId: row.task_id,
    actorType: row.actor_type,
    actorId: row.actor_id,
    actorName: row.actor_name,
    actorAvatarUrl: row.actor_avatar_url,
    changes: JSON.parse(row.changes),
    createdAt: row.created_at,
  };
}

function taskFieldChanges(task, changes) {
  return Object.entries(changes).flatMap(([field, after]) => {
    const before = task[field];
    return JSON.stringify(before) === JSON.stringify(after)
      ? []
      : [{ field, before, after }];
  });
}

function attachAiStartClaim(task, claimToken) {
  Object.defineProperty(task, "claimToken", {
    value: claimToken,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return task;
}

function normalizeFeishuTaskOrigin(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, "INVALID_FEISHU_ORIGIN", "Feishu task origin must be an object");
  }
  for (const key of ["source", "eventId", "baseToken", "tableId", "recordId"]) {
    if (typeof value[key] !== "string" || value[key].trim() === "") {
      throw new ApiError(400, "INVALID_FEISHU_ORIGIN", `Feishu task origin '${key}' is required`);
    }
  }
  if (value.source !== "feishu-base") {
    throw new ApiError(400, "INVALID_FEISHU_ORIGIN", "Unsupported Feishu task origin");
  }
  if (value.mode !== undefined && !["manual", "automatic"].includes(value.mode)) {
    throw new ApiError(400, "INVALID_FEISHU_ORIGIN", "Feishu task origin mode is invalid");
  }
  const origin = {
    version: value.version === undefined ? 1 : value.version,
    source: "feishu-base",
    eventId: value.eventId.trim(),
    baseToken: value.baseToken.trim(),
    tableId: value.tableId.trim(),
    recordId: value.recordId.trim(),
    ...(typeof value.triggerField === "string" && value.triggerField.trim()
      ? { triggerField: value.triggerField.trim() } : {}),
    ...(typeof value.triggerFieldId === "string" && value.triggerFieldId.trim()
      ? { triggerFieldId: value.triggerFieldId.trim() } : {}),
    ...(typeof value.triggerValue === "string" && value.triggerValue.trim()
      ? { triggerValue: value.triggerValue.trim() } : {}),
    ...(value.mode ? { mode: value.mode } : {}),
    ...(typeof value.subjectKey === "string" && value.subjectKey.trim()
      ? { subjectKey: value.subjectKey.trim() } : {}),
    ...(Number.isSafeInteger(value.configVersion) && value.configVersion > 0
      ? { configVersion: value.configVersion } : {}),
    ...(typeof value.executionMode === "string" && value.executionMode.trim()
      ? { executionMode: value.executionMode.trim() } : {}),
    ...(typeof value.uploadMode === "string" && value.uploadMode.trim()
      ? { uploadMode: value.uploadMode.trim() } : {}),
    ...(typeof value.packageAlias === "string" && value.packageAlias.trim()
      ? { packageAlias: value.packageAlias.trim() } : {}),
    ...(typeof value.packageSource === "string" && value.packageSource.trim()
      ? { packageSource: value.packageSource.trim() } : {}),
    ...(typeof value.concurrencyGroup === "string" && value.concurrencyGroup.trim()
      ? { concurrencyGroup: value.concurrencyGroup.trim() } : {}),
    ...(Number.isSafeInteger(value.maxConcurrent) && value.maxConcurrent > 0
      ? { maxConcurrent: value.maxConcurrent } : {}),
    ...(Array.isArray(value.resourceGroups)
      ? { resourceGroups: value.resourceGroups.filter((group) => typeof group === "string" && group.trim()) } : {}),
  };
  if (!Number.isSafeInteger(origin.version) || origin.version < 1) {
    throw new ApiError(400, "INVALID_FEISHU_ORIGIN", "Feishu task origin version is invalid");
  }
  if (origin.subjectKey !== undefined && origin.subjectKey !== `${origin.baseToken}:${origin.tableId}`) {
    throw new ApiError(400, "INVALID_FEISHU_ORIGIN", "Feishu task origin subjectKey is invalid");
  }
  if (origin.executionMode !== undefined && !["manual", "automatic"].includes(origin.executionMode)) {
    throw new ApiError(400, "INVALID_FEISHU_ORIGIN", "Feishu task origin executionMode is invalid");
  }
  if (origin.uploadMode !== undefined && !["manual", "automatic"].includes(origin.uploadMode)) {
    throw new ApiError(400, "INVALID_FEISHU_ORIGIN", "Feishu task origin uploadMode is invalid");
  }
  return origin;
}

function normalizeFeishuPackageSnapshot(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, "INVALID_PACKAGE_SNAPSHOT", "Auto-Cut package snapshot must be an object");
  }
  if (typeof value.packageAlias !== "string" || value.packageAlias.trim() === "" || value.packageAlias.includes("\0")) {
    throw new ApiError(400, "INVALID_PACKAGE_SNAPSHOT", "Package snapshot 'packageAlias' is required");
  }
  if (!Number.isSafeInteger(value.packageRevision) || value.packageRevision < 1) {
    throw new ApiError(400, "INVALID_PACKAGE_SNAPSHOT", "Package snapshot revision is invalid");
  }
  const optionalText = ["name", "projectId", "model", "reasoningEffort", "zipSourceDirectory"];
  const snapshot = {
    packageAlias: value.packageAlias.trim(),
    packageRevision: value.packageRevision,
    workspacePath: value.workspacePath === null || value.workspacePath === undefined ? null : typeof value.workspacePath === "string" ? value.workspacePath.trim() : value.workspacePath,
    prompt: value.prompt === null || value.prompt === undefined ? null : typeof value.prompt === "string" ? value.prompt.trim() : value.prompt,
  };
  for (const key of ["workspacePath", "prompt"]) {
    if (snapshot[key] !== null && (typeof value[key] !== "string" || value[key].includes("\0") || snapshot[key] === "")) {
      throw new ApiError(400, "INVALID_PACKAGE_SNAPSHOT", `Package snapshot '${key}' is invalid`);
    }
  }
  for (const key of optionalText) {
    if (value[key] !== undefined && value[key] !== null) {
      if (typeof value[key] !== "string" || value[key].includes("\0")) {
        throw new ApiError(400, "INVALID_PACKAGE_SNAPSHOT", `Package snapshot '${key}' is invalid`);
      }
      snapshot[key] = value[key].trim();
    }
  }
  if (value.maxConcurrent !== undefined
    && (!Number.isSafeInteger(value.maxConcurrent) || value.maxConcurrent < 1)) {
    throw new ApiError(400, "INVALID_PACKAGE_SNAPSHOT", "Package snapshot maxConcurrent is invalid");
  }
  if (value.maxConcurrent !== undefined) snapshot.maxConcurrent = value.maxConcurrent;
  return snapshot;
}

function relationActivityValue(type, task) {
  return {
    type,
    identifier: task.identifier,
    title: task.title,
  };
}

function parseAiChatTodoProgress(row) {
  try {
    const data = row.data === null ? null : JSON.parse(row.data);
    const detail = typeof data?.detail === "string" ? JSON.parse(data.detail) : data?.detail;
    if (!Array.isArray(detail)) return null;
    const items = detail.filter((item) => (
      item && typeof item === "object" && typeof item.text === "string" && item.text.trim()
    ));
    if (items.length === 0) return null;
    return {
      completed: items.filter((item) => item.completed === true).length,
      total: items.length,
      eventId: row.id,
      updatedAt: row.created_at,
    };
  } catch {
    return null;
  }
}

function taskFromRow(row) {
  const developmentContext = row.worktree_path
    ? { type: "worktree", path: row.worktree_path, branch: row.worktree_branch }
    : row.git_branch
      ? { type: "branch", branch: row.git_branch }
      : null;
  return {
    id: row.id,
    identifier: row.identifier,
    projectId: row.project_id,
    title: row.title,
    description: row.description,
    status: row.status,
    priority: row.priority,
    labels: JSON.parse(row.labels),
    sortOrder: row.sort_order,
    threadId: row.thread_id,
    creatorType: row.creator_type,
    creatorId: row.creator_id,
    creatorName: row.creator_name,
    creatorAvatarUrl: row.creator_avatar_url,
    assignee: {
      type: row.assignee_type,
      id: row.assignee_id,
      name: row.assignee_name,
      avatarUrl: row.assignee_avatar_url,
    },
    workflowId: row.workflow_id,
    developmentContext,
    startDate: row.start_date,
    dueDate: row.due_date,
    recurrence: row.recurrence_interval && row.recurrence_unit
      ? { interval: row.recurrence_interval, unit: row.recurrence_unit }
      : null,
    archivedAt: row.archived_at,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function taskRelationSummaryFromRow(row) {
  return {
    id: row.id,
    identifier: row.identifier,
    projectId: row.project_id,
    title: row.title,
    status: row.status,
    priority: row.priority,
    assignee: {
      type: row.assignee_type,
      id: row.assignee_id,
      name: row.assignee_name,
      avatarUrl: row.assignee_avatar_url,
    },
    archivedAt: row.archived_at,
  };
}

function commentFromRow(row) {
  return {
    id: row.id,
    taskId: row.task_id,
    body: row.body,
    threadId: row.thread_id,
    authorType: row.author_type,
    authorId: row.author_id,
    authorName: row.author_name,
    authorAvatarUrl: row.author_avatar_url,
    attachments: [],
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function attachmentFromRow(row) {
  return {
    id: row.id,
    taskId: row.task_id,
    commentId: row.comment_id,
    filename: row.filename,
    contentType: row.content_type,
    size: row.size,
    createdAt: row.created_at,
  };
}

function taskArtifactFromRow(row) {
  return {
    id: row.id,
    taskId: row.task_id,
    filename: row.filename,
    contentType: row.content_type,
    size: row.size,
    sha256: row.sha256,
    sourceMode: row.source_mode,
    validationStatus: row.validation_status,
    entryCount: row.entry_count,
    draftRoot: row.draft_root,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function taskArtifactWorkFromRow(row) {
  return {
    ...taskArtifactFromRow(row),
    storageKey: row.storage_key,
  };
}

function taskArtifactSummaryFromRow(row) {
  return {
    id: row.id,
    taskId: row.task_id,
    filename: row.filename,
    validationStatus: row.validation_status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function artifactUploadFromRow(row) {
  return {
    id: row.id,
    taskId: row.task_id,
    artifactId: row.artifact_id,
    subjectKey: row.subject_key,
    targetId: row.target_id,
    filename: row.filename,
    sha256: row.sha256,
    status: row.status,
    attemptCount: row.attempt_count,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    updatedAt: row.updated_at,
  };
}

function artifactUploadWorkFromRow(row) {
  return {
    ...artifactUploadFromRow(row),
    storageKey: row.storage_key,
    targetPath: row.target_path,
    uploadConcurrency: row.upload_concurrency,
    claimToken: row.claim_token,
  };
}

function projectFromRow(row) {
  return {
    id: row.id,
    name: row.name,
    workspacePath: row.workspace_path,
    issueCount: Number(row.issue_count ?? 0),
    archivedIssueCount: Number(row.archived_issue_count ?? 0),
    archivedAt: row.archived_at ?? null,
    source: row.source ?? "local",
    subjectKey: row.subject_key ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function projectSummaryFromRow(row) {
  return {
    projectId: row.project_id,
    summary: row.summary,
    generatedAt: row.generated_at,
    attemptedAt: row.attempted_at,
    error: row.error,
  };
}

function workflowWorkspaceFromRow(row) {
  return {
    projectId: row.project_id,
    workspace: JSON.parse(row.workspace),
    version: row.version,
    updatedAt: row.updated_at,
  };
}

function aiChatRunFromRow(row) {
  return {
    id: row.id,
    threadId: row.thread_id,
    status: row.status,
    exitCode: row.exit_code,
    error: row.error,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

function aiChatThreadFromRow(row) {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    origin: {
      projectId: row.origin_project_id,
      projectName: row.origin_project_name,
      workspacePath: row.origin_workspace_path,
      ...(row.origin_issue_id ? { issueId: row.origin_issue_id } : {}),
      ...(row.origin_issue_identifier ? { issueIdentifier: row.origin_issue_identifier } : {}),
    },
    codexThreadId: row.codex_thread_id,
    model: row.model,
    reasoningEffort: row.reasoning_effort,
    sandbox: row.sandbox,
    currentRun: null,
    latestTodo: null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function aiChatEventFromRow(row) {
  return {
    id: row.id,
    threadId: row.thread_id,
    runId: row.run_id,
    type: row.type,
    role: row.role,
    content: row.content,
    data: row.data === null ? null : JSON.parse(row.data),
    createdAt: row.created_at,
  };
}

function projectPrefix(projectId) {
  const prefix = projectId.toUpperCase().replace(/[^A-Z0-9]+/g, "");
  return (prefix || "TASK").slice(0, 12);
}

function feishuSubjectProjectId(subjectKey) {
  return `feishu-${createHash("sha256").update(String(subjectKey), "utf8").digest("hex").slice(0, 16)}`;
}

export class TaskboardDatabase {
  constructor(filename) {
    mkdirSync(path.dirname(filename), { recursive: true });
    this.database = new DatabaseSync(filename);
    this.database.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.#migrate();
    this.interruptAbandonedAiChatRuns();
  }

  #migrate() {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        workspace_path TEXT,
        next_task_number INTEGER NOT NULL DEFAULT 1 CHECK (next_task_number > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        identifier TEXT NOT NULL UNIQUE,
        project_id TEXT NOT NULL REFERENCES projects(id),
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL CHECK (status IN (
          'backlog', 'todo', 'queued', 'in_progress', 'in_review', 'blocked', 'done', 'canceled'
        )),
        priority TEXT NOT NULL CHECK (priority IN ('none', 'urgent', 'high', 'medium', 'low')),
        labels TEXT NOT NULL DEFAULT '[]',
        sort_order REAL NOT NULL,
        thread_id TEXT,
        creator_type TEXT NOT NULL DEFAULT 'user',
        creator_id TEXT NOT NULL DEFAULT 'local-user',
        creator_name TEXT NOT NULL DEFAULT '本地用户',
        creator_avatar_url TEXT,
        assignee_type TEXT NOT NULL DEFAULT 'user' CHECK (assignee_type IN ('user', 'agent')),
        assignee_id TEXT NOT NULL DEFAULT 'local-user',
        assignee_name TEXT NOT NULL DEFAULT '本地用户',
        assignee_avatar_url TEXT,
        workflow_id TEXT,
        git_branch TEXT,
        worktree_path TEXT,
        worktree_branch TEXT,
        start_date TEXT,
        due_date TEXT,
        recurrence_interval INTEGER,
        recurrence_unit TEXT,
        archived_at TEXT,
        version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS tasks_project_status_sort
        ON tasks(project_id, archived_at, status, sort_order, created_at);

      CREATE TABLE IF NOT EXISTS taskboard_settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        version INTEGER NOT NULL CHECK (version > 0),
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS comments (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        body TEXT NOT NULL,
        thread_id TEXT,
        author_type TEXT NOT NULL DEFAULT 'user',
        author_id TEXT NOT NULL,
        author_name TEXT NOT NULL,
        author_avatar_url TEXT,
        version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS comments_task_created
        ON comments(task_id, created_at, id);

      CREATE TABLE IF NOT EXISTS task_activities (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'agent')),
        actor_id TEXT NOT NULL,
        actor_name TEXT NOT NULL,
        actor_avatar_url TEXT,
        changes TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS task_activities_task_created
        ON task_activities(task_id, created_at, id);

      CREATE TABLE IF NOT EXISTS attachments (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        comment_id TEXT REFERENCES comments(id) ON DELETE CASCADE,
        filename TEXT NOT NULL,
        content_type TEXT NOT NULL,
        size INTEGER NOT NULL CHECK (size >= 0),
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS attachments_task_created
        ON attachments(task_id, created_at, id);

      CREATE TABLE IF NOT EXISTS task_artifacts (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        storage_key TEXT NOT NULL UNIQUE,
        filename TEXT NOT NULL,
        content_type TEXT NOT NULL,
        size INTEGER NOT NULL CHECK (size >= 0),
        sha256 TEXT NOT NULL,
        source_mode TEXT NOT NULL CHECK (source_mode = 'manual_select'),
        validation_status TEXT NOT NULL CHECK (validation_status = 'verified'),
        entry_count INTEGER NOT NULL CHECK (entry_count > 0),
        draft_root TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS task_artifacts_task_created
        ON task_artifacts(task_id, created_at, id);

      CREATE TABLE IF NOT EXISTS feishu_task_origins (
        task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS feishu_task_package_snapshots (
        task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
        package_alias TEXT NOT NULL,
        package_revision INTEGER NOT NULL CHECK (package_revision > 0),
        snapshot_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS feishu_task_package_snapshots_alias
        ON feishu_task_package_snapshots(package_alias, package_revision);

      CREATE TABLE IF NOT EXISTS feishu_task_executions (
        task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
        state TEXT NOT NULL CHECK (state IN ('delayed', 'queued', 'running')),
        mode TEXT NOT NULL CHECK (mode IN ('manual', 'automatic')),
        ready_at INTEGER NOT NULL,
        package_alias TEXT NOT NULL,
        package_revision INTEGER NOT NULL CHECK (package_revision > 0),
        trigger TEXT NOT NULL CHECK (trigger IN ('manual', 'move', 'automatic')),
        lease_id TEXT,
        version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_error TEXT
      );

      CREATE INDEX IF NOT EXISTS feishu_task_executions_pending
        ON feishu_task_executions(state, ready_at, created_at, task_id);

      CREATE TABLE IF NOT EXISTS workflow_workspaces (
        project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
        workspace TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS project_summaries (
        project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
        summary TEXT,
        generated_at TEXT,
        attempted_at TEXT NOT NULL,
        error TEXT
      );

      CREATE TABLE IF NOT EXISTS ai_chat_threads (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('idle', 'running', 'failed')),
        origin_project_id TEXT NOT NULL,
        origin_project_name TEXT NOT NULL,
        origin_workspace_path TEXT NOT NULL,
        origin_issue_id TEXT,
        origin_issue_identifier TEXT,
        codex_thread_id TEXT,
        model TEXT NOT NULL,
        reasoning_effort TEXT NOT NULL,
        sandbox TEXT NOT NULL CHECK (sandbox IN (
          'read-only', 'workspace-write', 'danger-full-access'
        )),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS ai_chat_threads_updated
        ON ai_chat_threads(updated_at DESC, id);

      CREATE TABLE IF NOT EXISTS ai_chat_runs (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES ai_chat_threads(id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK (status IN (
          'running', 'completed', 'failed', 'interrupted'
        )),
        exit_code INTEGER,
        error TEXT,
        started_at TEXT NOT NULL,
        finished_at TEXT
      );

      CREATE INDEX IF NOT EXISTS ai_chat_runs_thread_started
        ON ai_chat_runs(thread_id, started_at, id);

      CREATE UNIQUE INDEX IF NOT EXISTS ai_chat_runs_one_active
        ON ai_chat_runs(thread_id)
        WHERE status = 'running';

      CREATE TABLE IF NOT EXISTS ai_chat_events (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES ai_chat_threads(id) ON DELETE CASCADE,
        run_id TEXT REFERENCES ai_chat_runs(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'activity', 'error')),
        content TEXT NOT NULL,
        data TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS ai_chat_events_thread_created
        ON ai_chat_events(thread_id, created_at, id);

      CREATE TABLE IF NOT EXISTS feishu_bases (
        base_token TEXT PRIMARY KEY,
        base_name TEXT NOT NULL,
        source_url_label TEXT,
        metadata_refreshed_at INTEGER,
        removed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS feishu_subjects (
        subject_key TEXT PRIMARY KEY,
        base_token TEXT NOT NULL REFERENCES feishu_bases(base_token) ON DELETE CASCADE,
        table_id TEXT NOT NULL,
        table_name TEXT NOT NULL,
        project_id TEXT NOT NULL UNIQUE,
        display_enabled INTEGER NOT NULL DEFAULT 1 CHECK (display_enabled IN (0, 1)),
        lifecycle TEXT NOT NULL CHECK (lifecycle IN ('draft', 'enabled', 'disabled')),
        config_version INTEGER NOT NULL CHECK (config_version > 0),
        config_json TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        removed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(base_token, table_id)
      );

      CREATE TABLE IF NOT EXISTS artifact_uploads (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        artifact_id TEXT NOT NULL REFERENCES task_artifacts(id) ON DELETE CASCADE,
        subject_key TEXT NOT NULL REFERENCES feishu_subjects(subject_key) ON DELETE CASCADE,
        storage_key TEXT NOT NULL,
        target_id TEXT,
        target_path TEXT NOT NULL,
        filename TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('queued', 'uploading', 'uploaded', 'failed')),
        attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
        error_code TEXT,
        error_message TEXT,
        upload_concurrency INTEGER NOT NULL DEFAULT 1 CHECK (upload_concurrency > 0),
        created_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        updated_at TEXT NOT NULL,
        claim_token TEXT,
        lease_until TEXT,
        UNIQUE(artifact_id, target_path)
      );

      CREATE INDEX IF NOT EXISTS artifact_uploads_task_created
        ON artifact_uploads(task_id, created_at DESC, id DESC);

      CREATE INDEX IF NOT EXISTS artifact_uploads_queue
        ON artifact_uploads(status, created_at, id);

      CREATE TABLE IF NOT EXISTS feishu_subject_versions (
        subject_key TEXT NOT NULL REFERENCES feishu_subjects(subject_key) ON DELETE CASCADE,
        version INTEGER NOT NULL CHECK (version > 0),
        snapshot_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(subject_key, version)
      );

      CREATE TABLE IF NOT EXISTS feishu_unified_view_sets (
        subject_key TEXT PRIMARY KEY REFERENCES feishu_subjects(subject_key) ON DELETE CASCADE,
        schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version = 1),
        default_view_id TEXT NOT NULL DEFAULT 'all',
        active_view_id TEXT NOT NULL DEFAULT 'all',
        frozen_active_view_id TEXT,
        revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
        read_only INTEGER NOT NULL DEFAULT 0 CHECK (read_only IN (0, 1)),
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS feishu_unified_views (
        id TEXT NOT NULL,
        subject_key TEXT NOT NULL REFERENCES feishu_subjects(subject_key) ON DELETE CASCADE,
        name TEXT NOT NULL DEFAULT '',
        stage_ids_json TEXT NOT NULL DEFAULT '[]',
        is_system INTEGER NOT NULL DEFAULT 0 CHECK (is_system IN (0, 1)),
        revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
        created_at TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL DEFAULT '',
        PRIMARY KEY(subject_key, id),
        UNIQUE(subject_key, name)
      );

      CREATE INDEX IF NOT EXISTS feishu_unified_views_subject_created
        ON feishu_unified_views(subject_key, is_system DESC, created_at, id);

      CREATE TABLE IF NOT EXISTS feishu_unified_view_quarantine (
        subject_key TEXT NOT NULL REFERENCES feishu_subjects(subject_key) ON DELETE CASCADE,
        view_id TEXT NOT NULL,
        name TEXT NOT NULL,
        stage_ids_json TEXT NOT NULL,
        is_system INTEGER NOT NULL,
        revision INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        reason TEXT NOT NULL,
        quarantined_at TEXT NOT NULL,
        PRIMARY KEY(subject_key, view_id)
      );

      CREATE TABLE IF NOT EXISTS feishu_unified_stage_display_overrides (
        subject_key TEXT NOT NULL REFERENCES feishu_subjects(subject_key) ON DELETE CASCADE,
        stage_id TEXT NOT NULL,
        zh_name TEXT,
        en_name TEXT,
        zh_description TEXT,
        en_description TEXT,
        revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
        updated_at TEXT NOT NULL,
        PRIMARY KEY(subject_key, stage_id)
      );

    `);

    const feishuBaseColumns = this.database.prepare("PRAGMA table_info(feishu_bases)").all();
    if (!feishuBaseColumns.some((column) => column.name === "removed_at")) {
      this.database.exec("ALTER TABLE feishu_bases ADD COLUMN removed_at TEXT");
    }
    const feishuSubjectColumns = this.database.prepare("PRAGMA table_info(feishu_subjects)").all();
    if (!feishuSubjectColumns.some((column) => column.name === "removed_at")) {
      this.database.exec("ALTER TABLE feishu_subjects ADD COLUMN removed_at TEXT");
    }
    const feishuUnifiedViewSetColumns = this.database.prepare("PRAGMA table_info(feishu_unified_view_sets)").all();
    if (!feishuUnifiedViewSetColumns.some((column) => column.name === "frozen_active_view_id")) {
      this.database.exec("ALTER TABLE feishu_unified_view_sets ADD COLUMN frozen_active_view_id TEXT");
    }

    const artifactUploadColumns = this.database.prepare("PRAGMA table_info(artifact_uploads)").all();
    if (!artifactUploadColumns.some((column) => column.name === "claim_token")) {
      this.database.exec("ALTER TABLE artifact_uploads ADD COLUMN claim_token TEXT");
    }
    if (!artifactUploadColumns.some((column) => column.name === "lease_until")) {
      this.database.exec("ALTER TABLE artifact_uploads ADD COLUMN lease_until TEXT");
    }
    if (!artifactUploadColumns.some((column) => column.name === "upload_concurrency")) {
      this.database.exec("ALTER TABLE artifact_uploads ADD COLUMN upload_concurrency INTEGER NOT NULL DEFAULT 1 CHECK (upload_concurrency > 0)");
    }

    const projectColumns = this.database.prepare("PRAGMA table_info(projects)").all();
    if (!projectColumns.some((column) => column.name === "workspace_path")) {
      this.database.exec("ALTER TABLE projects ADD COLUMN workspace_path TEXT");
    }
    if (!projectColumns.some((column) => column.name === "archived_at")) {
      this.database.exec("ALTER TABLE projects ADD COLUMN archived_at TEXT");
    }
    if (!projectColumns.some((column) => column.name === "source")) {
      this.database.exec("ALTER TABLE projects ADD COLUMN source TEXT NOT NULL DEFAULT 'local' CHECK (source IN ('global', 'local', 'feishu'))");
    }

    const taskColumns = this.database.prepare("PRAGMA table_info(tasks)").all();
    const hasThreadId = taskColumns.some((column) => column.name === "thread_id");
    const hasLinkedThreadId = taskColumns.some((column) => column.name === "linked_thread_id");
    if (!hasThreadId) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN thread_id TEXT");
    }
    if (hasLinkedThreadId) {
      this.database.exec(`
        UPDATE tasks
        SET thread_id = COALESCE(thread_id, linked_thread_id)
      `);
      this.database.exec("ALTER TABLE tasks DROP COLUMN linked_thread_id");
    }
    if (!taskColumns.some((column) => column.name === "git_branch")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN git_branch TEXT");
    }
    if (!taskColumns.some((column) => column.name === "worktree_path")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN worktree_path TEXT");
    }
    if (!taskColumns.some((column) => column.name === "worktree_branch")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN worktree_branch TEXT");
    }
    if (!taskColumns.some((column) => column.name === "due_date")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN due_date TEXT");
    }
    if (!taskColumns.some((column) => column.name === "start_date")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN start_date TEXT");
    }
    if (!taskColumns.some((column) => column.name === "recurrence_interval")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN recurrence_interval INTEGER");
    }
    if (!taskColumns.some((column) => column.name === "recurrence_unit")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN recurrence_unit TEXT");
    }
    this.#migrateTaskStatuses();
    const migratedTaskColumns = this.database.prepare("PRAGMA table_info(tasks)").all();
    if (!migratedTaskColumns.some((column) => column.name === "creator_type")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN creator_type TEXT NOT NULL DEFAULT 'user'");
    }
    if (!migratedTaskColumns.some((column) => column.name === "creator_id")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN creator_id TEXT NOT NULL DEFAULT 'local-user'");
    }
    if (!migratedTaskColumns.some((column) => column.name === "creator_name")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN creator_name TEXT NOT NULL DEFAULT '本地用户'");
    }
    if (!migratedTaskColumns.some((column) => column.name === "creator_avatar_url")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN creator_avatar_url TEXT");
    }
    if (!migratedTaskColumns.some((column) => column.name === "workflow_id")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN workflow_id TEXT");
    }
    this.database.exec(`
      UPDATE tasks
      SET creator_type = 'agent', creator_id = 'codex-agent', creator_name = 'Codex Agent'
      WHERE thread_id IS NOT NULL AND version = 1 AND creator_id = 'local-user'
    `);
    const identityTaskColumns = this.database.prepare("PRAGMA table_info(tasks)").all();
    const assigneeColumns = [
      ["assignee_type", "TEXT CHECK (assignee_type IN ('user', 'agent'))", "creator_type"],
      ["assignee_id", "TEXT", "creator_id"],
      ["assignee_name", "TEXT", "creator_name"],
      ["assignee_avatar_url", "TEXT", "creator_avatar_url"],
    ];
    const assigneeMigrations = assigneeColumns
      .filter(([column]) => !identityTaskColumns.some((current) => current.name === column));
    const assigneeBackfills = assigneeColumns
      .filter(([column]) => !taskColumns.some((current) => current.name === column));
    if (assigneeMigrations.length > 0 || assigneeBackfills.length > 0) {
      this.database.exec("BEGIN IMMEDIATE");
      try {
        for (const [column, definition] of assigneeMigrations) {
          this.database.exec(`ALTER TABLE tasks ADD COLUMN ${column} ${definition}`);
        }
        for (const [column, , source] of assigneeBackfills) {
          this.database.exec(`UPDATE tasks SET ${column} = ${source}`);
        }
        this.database.exec("COMMIT");
      } catch (error) {
        this.database.exec("ROLLBACK");
        throw error;
      }
    }
    this.database.exec(`
      CREATE INDEX IF NOT EXISTS tasks_project_status_sort
        ON tasks(project_id, archived_at, status, sort_order, created_at)
    `);
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS task_ai_starts (
        task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
        claim_token TEXT NOT NULL UNIQUE,
        thread_id TEXT UNIQUE,
        run_id TEXT UNIQUE REFERENCES ai_chat_runs(id) ON DELETE SET NULL,
        claimed_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        claimed_activity_rowid INTEGER
      )
    `);
    const taskAiStartColumns = this.database.prepare("PRAGMA table_info(task_ai_starts)").all();
    const hadTaskAiStartRunId = taskAiStartColumns.some((column) => column.name === "run_id");
    const hadTaskAiStartActivityRowid = taskAiStartColumns.some(
      (column) => column.name === "claimed_activity_rowid",
    );
    if (!hadTaskAiStartRunId) {
      this.database.exec("ALTER TABLE task_ai_starts ADD COLUMN run_id TEXT REFERENCES ai_chat_runs(id) ON DELETE SET NULL");
    }
    if (!hadTaskAiStartActivityRowid) {
      this.database.exec("ALTER TABLE task_ai_starts ADD COLUMN claimed_activity_rowid INTEGER");
    }
    if (!hadTaskAiStartRunId || !hadTaskAiStartActivityRowid) {
      const legacyClaims = this.database.prepare(`
        SELECT task_id, claim_token, thread_id, run_id, claimed_at, claimed_activity_rowid
        FROM task_ai_starts
      `).all();
      const activitiesForClaim = this.database.prepare(`
        SELECT rowid, changes
        FROM task_activities
        WHERE task_id = ? AND created_at <= ?
        ORDER BY created_at DESC, rowid DESC
      `);
      const runsForClaim = this.database.prepare(`
        SELECT ai_chat_runs.id
        FROM ai_chat_runs
        JOIN ai_chat_threads ON ai_chat_threads.id = ai_chat_runs.thread_id
        JOIN tasks ON tasks.id = ai_chat_threads.origin_issue_id
        WHERE ai_chat_runs.thread_id = ?
          AND ai_chat_threads.origin_issue_id = ?
          AND tasks.thread_id = ai_chat_runs.thread_id
          AND ai_chat_runs.started_at >= ?
        ORDER BY ai_chat_runs.started_at, ai_chat_runs.id
        LIMIT 2
      `);
      const updateLegacyClaim = this.database.prepare(`
        UPDATE task_ai_starts
        SET claimed_activity_rowid = COALESCE(claimed_activity_rowid, ?),
            run_id = COALESCE(run_id, ?)
        WHERE task_id = ? AND claim_token = ?
      `);
      this.database.exec("BEGIN IMMEDIATE");
      try {
        for (const claim of legacyClaims) {
          let claimedActivityRowid = claim.claimed_activity_rowid;
          if (claimedActivityRowid === null) {
            const activity = activitiesForClaim.all(claim.task_id, claim.claimed_at).find((entry) => {
              try {
                return JSON.parse(entry.changes).some((change) => (
                  change?.field === "status" && change.after === "in_progress"
                ));
              } catch {
                return false;
              }
            });
            claimedActivityRowid = activity?.rowid ?? null;
          }
          let runId = claim.run_id;
          if (runId === null && claim.thread_id && claimedActivityRowid !== null) {
            const candidates = runsForClaim.all(
              claim.thread_id,
              claim.task_id,
              claim.claimed_at,
            );
            if (candidates.length === 1) runId = candidates[0].id;
          }
          updateLegacyClaim.run(
            claimedActivityRowid,
            runId,
            claim.task_id,
            claim.claim_token,
          );
        }
        this.database.exec("COMMIT");
      } catch (error) {
        this.database.exec("ROLLBACK");
        throw error;
      }
    }
    this.database.exec("CREATE UNIQUE INDEX IF NOT EXISTS task_ai_starts_run ON task_ai_starts(run_id) WHERE run_id IS NOT NULL");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS task_relations (
        relation_type TEXT NOT NULL CHECK (relation_type IN ('parent', 'blocks', 'related')),
        source_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        target_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        CHECK (source_task_id <> target_task_id),
        CHECK (relation_type <> 'related' OR source_task_id < target_task_id),
        PRIMARY KEY (relation_type, source_task_id, target_task_id)
      );

      CREATE INDEX IF NOT EXISTS task_relations_target
        ON task_relations(relation_type, target_task_id);

      CREATE UNIQUE INDEX IF NOT EXISTS task_relations_one_parent
        ON task_relations(target_task_id)
        WHERE relation_type = 'parent';
    `);

    const commentColumns = this.database.prepare("PRAGMA table_info(comments)").all();
    if (!commentColumns.some((column) => column.name === "thread_id")) {
      this.database.exec("ALTER TABLE comments ADD COLUMN thread_id TEXT");
    }
    if (!commentColumns.some((column) => column.name === "author_type")) {
      this.database.exec("ALTER TABLE comments ADD COLUMN author_type TEXT NOT NULL DEFAULT 'user'");
    }
    if (!commentColumns.some((column) => column.name === "author_avatar_url")) {
      this.database.exec("ALTER TABLE comments ADD COLUMN author_avatar_url TEXT");
    }
    this.database.exec(`
      UPDATE comments
      SET author_type = 'agent', author_id = 'codex-agent', author_name = 'Codex Agent'
      WHERE thread_id IS NOT NULL AND author_id = 'local'
    `);
    this.database.exec(`
      UPDATE comments
      SET author_id = 'local-user'
      WHERE author_id = 'local'
    `);

    const hasTaskThreads = this.database.prepare(`
      SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'task_threads'
    `).get();
    if (hasTaskThreads) {
      this.database.exec(`
        UPDATE tasks AS migrated_task
        SET thread_id = COALESCE(thread_id, (
          SELECT task_threads.thread_id
          FROM task_threads
          LEFT JOIN comments
            ON comments.task_id = task_threads.task_id
            AND comments.thread_id = task_threads.thread_id
          WHERE task_threads.task_id = migrated_task.id
          ORDER BY
            CASE WHEN comments.id IS NOT NULL THEN 1 ELSE 0 END,
            task_threads.created_at DESC,
            task_threads.thread_id DESC
          LIMIT 1
        ))
        WHERE thread_id IS NULL
      `);
      this.database.exec("DROP TABLE task_threads");
    }

    const attachmentColumns = this.database.prepare("PRAGMA table_info(attachments)").all();
    if (!attachmentColumns.some((column) => column.name === "comment_id")) {
      this.database.exec("ALTER TABLE attachments ADD COLUMN comment_id TEXT REFERENCES comments(id) ON DELETE CASCADE");
    }
    this.database.exec("CREATE INDEX IF NOT EXISTS attachments_comment_created ON attachments(comment_id, created_at, id)");

    const timestamp = now();
    this.database.prepare(`
      INSERT INTO projects (id, name, workspace_path, next_task_number, created_at, updated_at)
      VALUES ('local', '全局', NULL, 1, ?, ?)
      ON CONFLICT(id) DO NOTHING
    `).run(timestamp, timestamp);
    this.database.prepare(`
      UPDATE projects
      SET name = '全局', workspace_path = NULL, updated_at = ?
      WHERE id = 'local' AND (name != '全局' OR workspace_path IS NOT NULL)
    `).run(timestamp);
    this.database.prepare("UPDATE projects SET source = 'global' WHERE id = 'local'").run();
    this.database.prepare(`
      UPDATE projects
      SET source = 'feishu'
      WHERE id IN (SELECT project_id FROM feishu_subjects WHERE project_id IS NOT NULL)
    `).run();
    this.database.prepare(`
      INSERT INTO taskboard_settings (key, value_json, version, updated_at)
      VALUES (?, ?, 1, ?)
      ON CONFLICT(key) DO NOTHING
    `).run("board-stage-labels", JSON.stringify(DEFAULT_BOARD_STAGE_LABELS), timestamp);
  }

  close() {
    this.database.close();
  }

  #migrateTaskStatuses() {
    const tasksSql = this.database.prepare(`
      SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'tasks'
    `).get()?.sql ?? "";
    if (
      tasksSql.includes("'in_review'")
      && tasksSql.includes("'blocked'")
      && tasksSql.includes("'canceled'")
      && tasksSql.includes("'queued'")
    ) {
      return;
    }

    const taskColumns = new Set(
      this.database.prepare("PRAGMA table_info(tasks)").all().map((column) => column.name),
    );
    const sourceColumn = (name, fallback) => taskColumns.has(name) ? name : fallback;
    const creatorType = sourceColumn("creator_type", "'user'");
    const creatorId = sourceColumn("creator_id", "'local-user'");
    const creatorName = sourceColumn("creator_name", "'本地用户'");
    const creatorAvatarUrl = sourceColumn("creator_avatar_url", "NULL");
    const assigneeType = sourceColumn("assignee_type", creatorType);
    const assigneeId = sourceColumn("assignee_id", creatorId);
    const assigneeName = sourceColumn("assignee_name", creatorName);
    const assigneeAvatarUrl = sourceColumn("assignee_avatar_url", creatorAvatarUrl);
    const workflowId = sourceColumn("workflow_id", "NULL");

    this.database.exec("PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE");
    try {
      this.database.exec(`
        CREATE TABLE tasks_status_migration (
          id TEXT PRIMARY KEY,
          identifier TEXT NOT NULL UNIQUE,
          project_id TEXT NOT NULL REFERENCES projects(id),
          title TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL CHECK (status IN (
            'backlog', 'todo', 'queued', 'in_progress', 'in_review', 'blocked', 'done', 'canceled'
          )),
          priority TEXT NOT NULL CHECK (priority IN ('none', 'urgent', 'high', 'medium', 'low')),
          labels TEXT NOT NULL DEFAULT '[]',
          sort_order REAL NOT NULL,
          thread_id TEXT,
          creator_type TEXT NOT NULL DEFAULT 'user',
          creator_id TEXT NOT NULL DEFAULT 'local-user',
          creator_name TEXT NOT NULL DEFAULT '本地用户',
          creator_avatar_url TEXT,
          assignee_type TEXT NOT NULL DEFAULT 'user' CHECK (assignee_type IN ('user', 'agent')),
          assignee_id TEXT NOT NULL DEFAULT 'local-user',
          assignee_name TEXT NOT NULL DEFAULT '本地用户',
          assignee_avatar_url TEXT,
          workflow_id TEXT,
          git_branch TEXT,
          worktree_path TEXT,
          worktree_branch TEXT,
          start_date TEXT,
          due_date TEXT,
          recurrence_interval INTEGER,
          recurrence_unit TEXT,
          archived_at TEXT,
          version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        INSERT INTO tasks_status_migration (
          id, identifier, project_id, title, description, status, priority, labels,
          sort_order, thread_id, creator_type, creator_id, creator_name, creator_avatar_url,
          assignee_type, assignee_id, assignee_name, assignee_avatar_url, workflow_id,
          git_branch, worktree_path, worktree_branch,
          start_date, due_date, recurrence_interval, recurrence_unit,
          archived_at, version, created_at, updated_at
        )
        SELECT
          id, identifier, project_id, title, description, status, priority, labels,
          sort_order, thread_id, ${creatorType}, ${creatorId}, ${creatorName}, ${creatorAvatarUrl},
          ${assigneeType}, ${assigneeId}, ${assigneeName}, ${assigneeAvatarUrl}, ${workflowId},
          git_branch, worktree_path, worktree_branch,
          start_date, due_date, recurrence_interval, recurrence_unit,
          archived_at, version, created_at, updated_at
        FROM tasks;

        DROP TABLE tasks;
        ALTER TABLE tasks_status_migration RENAME TO tasks;
      `);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    } finally {
      this.database.exec("PRAGMA foreign_keys = ON");
    }

    const violation = this.database.prepare("PRAGMA foreign_key_check").get();
    if (violation) {
      throw new Error(`Task status migration produced a foreign key violation in '${violation.table}'`);
    }
  }

  listProjects(options = {}) {
    const includeArchived = options?.includeArchived === true;
    return this.database.prepare(`
      SELECT
        projects.id,
        projects.name,
        projects.workspace_path,
        projects.created_at,
        projects.updated_at,
        projects.archived_at,
        projects.source,
        (
          SELECT feishu_subjects.subject_key
          FROM feishu_subjects
          WHERE feishu_subjects.project_id = projects.id
          ORDER BY
            CASE WHEN feishu_subjects.removed_at IS NULL THEN 0 ELSE 1 END,
            feishu_subjects.updated_at DESC,
            feishu_subjects.subject_key
          LIMIT 1
        ) AS subject_key,
        COUNT(tasks.id) FILTER (WHERE tasks.archived_at IS NULL) AS issue_count,
        COUNT(tasks.id) FILTER (WHERE tasks.archived_at IS NOT NULL) AS archived_issue_count
      FROM projects
      LEFT JOIN tasks ON tasks.project_id = projects.id
      ${includeArchived ? "" : "WHERE projects.archived_at IS NULL"}
      GROUP BY
        projects.id,
        projects.name,
        projects.workspace_path,
        projects.archived_at,
        projects.source,
        projects.created_at,
        projects.updated_at
      ORDER BY CASE WHEN projects.archived_at IS NULL THEN 0 ELSE 1 END, projects.created_at, projects.id
    `).all().map(projectFromRow);
  }

  createProject(input) {
    const timestamp = now();
    try {
      this.database.prepare(`
        INSERT INTO projects (id, name, workspace_path, source, next_task_number, created_at, updated_at)
        VALUES (?, ?, ?, 'local', 1, ?, ?)
      `).run(input.id, input.name, input.workspacePath, timestamp, timestamp);
    } catch (error) {
      if (String(error.message).includes("UNIQUE constraint failed")) {
        throw new ApiError(409, "PROJECT_EXISTS", `Project '${input.id}' already exists`);
      }
      throw error;
    }
    return this.getProject(input.id);
  }

  setProjectArchived(id, archived) {
    if (typeof archived !== "boolean") throw new ApiError(400, "INVALID_FIELD", "'archived' must be a boolean");
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.database.prepare("SELECT id, source FROM projects WHERE id = ?").get(id);
      if (!row) throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${id}' does not exist`);
      if (row.source !== "local") {
        throw new ApiError(409, "PROJECT_ARCHIVE_FORBIDDEN", "Source-managed projects cannot be archived manually");
      }
      this.database.prepare("UPDATE projects SET archived_at = ?, updated_at = ? WHERE id = ?")
        .run(archived ? now() : null, now(), id);
      this.database.exec("COMMIT");
    } catch (error) {
      try { this.database.exec("ROLLBACK"); } catch {}
      throw error;
    }
    return this.getProject(id);
  }

  syncSourceProjectArchived(id, archived, source = "feishu", transaction = null) {
    if (source !== "feishu") throw new ApiError(400, "INVALID_PROJECT_SOURCE", "Only Feishu source projects may be synchronized");
    const execute = () => {
      const row = this.database.prepare("SELECT id, source FROM projects WHERE id = ?").get(id);
      if (!row) throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${id}' does not exist`);
      if (row.source !== "feishu") throw new ApiError(409, "PROJECT_SOURCE_MISMATCH", "Project source does not match Feishu");
      const subject = this.database.prepare("SELECT subject_key, project_id FROM feishu_subjects WHERE project_id = ?").get(id);
      if (!subject || subject.project_id !== id || id !== feishuSubjectProjectId(subject.subject_key)) {
        throw new ApiError(409, "PROJECT_SOURCE_MISMATCH", "Feishu subject project identity is invalid");
      }
      const timestamp = now();
      this.database.prepare("UPDATE projects SET archived_at = ?, updated_at = ? WHERE id = ?")
        .run(archived ? timestamp : null, timestamp, id);
      return this.getProject(id);
    };
    if (transaction && typeof transaction.prepare === "function") return execute();
    if (typeof transaction === "function") return transaction(execute);
    this.database.exec("BEGIN IMMEDIATE");
    try { const result = execute(); this.database.exec("COMMIT"); return result; } catch (error) { try { this.database.exec("ROLLBACK"); } catch {} throw error; }
  }

  freezeSourceWorkflowState(subjectKey, transaction = null) {
    const execute = () => {
      const hasViewSets = this.database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'feishu_unified_view_sets'").get();
      if (!hasViewSets) return null;
      const subject = this.database.prepare(`
        SELECT feishu_subjects.subject_key, feishu_subjects.project_id, projects.source
        FROM feishu_subjects
        LEFT JOIN projects ON projects.id = feishu_subjects.project_id
        WHERE feishu_subjects.subject_key = ?
      `).get(subjectKey);
      if (!subject) {
        throw new ApiError(404, "FEISHU_SUBJECT_NOT_FOUND", `Feishu subject '${subjectKey}' does not exist`);
      }
      if (subject.source !== "feishu" || subject.project_id !== feishuSubjectProjectId(subject.subject_key)) {
        throw new ApiError(409, "PROJECT_SOURCE_MISMATCH", "Feishu subject project identity is invalid");
      }
      const viewSetColumns = this.database.prepare("PRAGMA table_info(feishu_unified_view_sets)").all();
      if (!viewSetColumns.some((column) => column.name === "frozen_active_view_id")) {
        this.database.exec("ALTER TABLE feishu_unified_view_sets ADD COLUMN frozen_active_view_id TEXT");
      }
      const result = this.database.prepare(`
        UPDATE feishu_unified_view_sets
        SET frozen_active_view_id = CASE WHEN read_only = 0 THEN active_view_id ELSE frozen_active_view_id END,
            active_view_id = 'all', read_only = 1,
            revision = revision + 1, updated_at = ?
        WHERE subject_key = ? AND (read_only = 0 OR active_view_id <> 'all')
      `).run(now(), subjectKey);
      return result.changes === 0 ? null : this.database.prepare(`
        SELECT subject_key, active_view_id, read_only, revision, updated_at
        FROM feishu_unified_view_sets WHERE subject_key = ?
      `).get(subjectKey);
    };
    if (transaction && typeof transaction.prepare === "function") return execute();
    if (typeof transaction === "function") return transaction(execute);
    this.database.exec("BEGIN IMMEDIATE");
    try { const result = execute(); this.database.exec("COMMIT"); return result; } catch (error) { try { this.database.exec("ROLLBACK"); } catch {} throw error; }
  }

  restoreSourceWorkflowState(subjectKey, transaction = null) {
    const execute = () => {
      const hasViewSets = this.database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'feishu_unified_view_sets'").get();
      if (!hasViewSets) return null;
      const subject = this.database.prepare(`
        SELECT feishu_subjects.subject_key, feishu_subjects.project_id, projects.source
        FROM feishu_subjects
        LEFT JOIN projects ON projects.id = feishu_subjects.project_id
        WHERE feishu_subjects.subject_key = ?
      `).get(subjectKey);
      if (!subject) {
        throw new ApiError(404, "FEISHU_SUBJECT_NOT_FOUND", `Feishu subject '${subjectKey}' does not exist`);
      }
      if (subject.source !== "feishu" || subject.project_id !== feishuSubjectProjectId(subject.subject_key)) {
        throw new ApiError(409, "PROJECT_SOURCE_MISMATCH", "Feishu subject project identity is invalid");
      }
      const viewSetColumns = this.database.prepare("PRAGMA table_info(feishu_unified_view_sets)").all();
      const hasFrozenActiveViewId = viewSetColumns.some((column) => column.name === "frozen_active_view_id");
      const viewSet = this.database.prepare(`
        SELECT active_view_id, read_only${hasFrozenActiveViewId ? ", frozen_active_view_id" : ""}
        FROM feishu_unified_view_sets WHERE subject_key = ?
      `).get(subjectKey);
      if (!viewSet || !Boolean(viewSet.read_only)) return null;
      this.#ensureUnifiedWorkflowViewsLocked(subjectKey);
      const repairedViewSet = this.#getUnifiedWorkflowViewSet(subjectKey);
      const validViewIds = new Set(
        this.#getUnifiedWorkflowViewsLocked(subjectKey).views.map((view) => view.id),
      );
      const frozenActiveViewId = hasFrozenActiveViewId
        ? repairedViewSet?.frozen_active_view_id
        : null;
      const restoredActiveViewId = validViewIds.has(frozenActiveViewId)
        ? frozenActiveViewId
        : SYSTEM_UNIFIED_WORKFLOW_VIEW_ID;
      const result = this.database.prepare(`
        UPDATE feishu_unified_view_sets
        SET active_view_id = ?, read_only = 0,
            ${hasFrozenActiveViewId ? "frozen_active_view_id = NULL," : ""}
            revision = revision + 1, updated_at = ?
        WHERE subject_key = ? AND read_only = 1
      `).run(restoredActiveViewId, now(), subjectKey);
      return result.changes === 0 ? null : this.database.prepare(`
        SELECT subject_key, active_view_id, read_only, revision, updated_at
        FROM feishu_unified_view_sets WHERE subject_key = ?
      `).get(subjectKey);
    };
    if (transaction && typeof transaction.prepare === "function") return execute();
    if (typeof transaction === "function") return transaction(execute);
    this.database.exec("BEGIN IMMEDIATE");
    try { const result = execute(); this.database.exec("COMMIT"); return result; } catch (error) { try { this.database.exec("ROLLBACK"); } catch {} throw error; }
  }

  #getUnifiedWorkflowSubject(subjectKey) {
    const key = normalizeUnifiedWorkflowSubjectKey(subjectKey);
    const subject = this.database.prepare(`
      SELECT subject_key, removed_at
      FROM feishu_subjects
      WHERE subject_key = ?
    `).get(key);
    if (!subject) {
      throw new ApiError(404, "FEISHU_SUBJECT_NOT_FOUND", `Feishu subject '${key}' does not exist`);
    }
    return subject;
  }

  #quarantineUnifiedWorkflowViewLocked(row, reason, timestamp) {
    this.database.prepare(`
      INSERT INTO feishu_unified_view_quarantine (
        subject_key, view_id, name, stage_ids_json, is_system,
        revision, created_at, updated_at, reason, quarantined_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(subject_key, view_id) DO UPDATE SET
        name = excluded.name,
        stage_ids_json = excluded.stage_ids_json,
        is_system = excluded.is_system,
        revision = excluded.revision,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        reason = excluded.reason,
        quarantined_at = excluded.quarantined_at
    `).run(
      row.subject_key,
      row.id,
      row.name,
      row.stage_ids_json,
      row.is_system,
      row.revision,
      row.created_at,
      row.updated_at,
      reason,
      timestamp,
    );
    return this.database.prepare(`
      DELETE FROM feishu_unified_views
      WHERE subject_key = ? AND id = ? AND id <> ?
    `).run(row.subject_key, row.id, SYSTEM_UNIFIED_WORKFLOW_VIEW_ID).changes === 1;
  }

  #ensureUnifiedWorkflowViewsLocked(subjectKey, { bumpSystemRepairRevision = false } = {}) {
    const subject = this.#getUnifiedWorkflowSubject(subjectKey);
    const timestamp = now();
    const readOnly = subject.removed_at === null ? 0 : 1;
    const insertedViewSet = this.database.prepare(`
      INSERT INTO feishu_unified_view_sets (
        subject_key, schema_version, default_view_id, active_view_id,
        frozen_active_view_id, revision, read_only, updated_at
      ) VALUES (?, 1, 'all', 'all', NULL, 1, ?, ?)
      ON CONFLICT(subject_key) DO NOTHING
    `).run(subject.subject_key, readOnly, timestamp);
    let repaired = false;
    if (readOnly) {
      const frozen = this.database.prepare(`
        UPDATE feishu_unified_view_sets
        SET frozen_active_view_id = CASE
              WHEN read_only = 0 THEN active_view_id
              ELSE frozen_active_view_id
            END,
            active_view_id = 'all',
            read_only = 1,
            updated_at = ?
        WHERE subject_key = ? AND (read_only = 0 OR active_view_id <> 'all')
      `).run(timestamp, subject.subject_key);
      repaired ||= frozen.changes === 1;
    }
    const customRows = this.database.prepare(`
      SELECT id, subject_key, name, stage_ids_json, is_system,
             revision, created_at, updated_at
      FROM feishu_unified_views
      WHERE subject_key = ? AND id <> ?
      ORDER BY created_at, id
    `).all(subject.subject_key, SYSTEM_UNIFIED_WORKFLOW_VIEW_ID);
    const names = new Set([SYSTEM_UNIFIED_WORKFLOW_VIEW_NAME]);
    const acceptedRows = [];
    const rejectedRows = [];
    for (const row of customRows) {
      let view = null;
      let reason = null;
      try {
        view = unifiedWorkflowViewFromRow(row);
      } catch {
        reason = "invalid_definition";
      }
      if (!reason && view.isSystem) reason = "unexpected_system_flag";
      if (!reason && view.name === SYSTEM_UNIFIED_WORKFLOW_VIEW_NAME) reason = "reserved_name";
      if (!reason && names.has(view.name)) reason = "duplicate_name";
      if (reason) {
        rejectedRows.push({ row, reason });
      } else {
        names.add(view.name);
        acceptedRows.push({ row, view });
      }
    }
    for (const { row, reason } of rejectedRows) {
      const quarantined = this.#quarantineUnifiedWorkflowViewLocked(row, reason, timestamp);
      repaired = quarantined || repaired;
    }
    const systemStageIdsJson = JSON.stringify(UNIFIED_WORKFLOW_STAGES);
    const writtenSystemView = this.database.prepare(`
      INSERT INTO feishu_unified_views (
        id, subject_key, name, stage_ids_json, is_system,
        revision, created_at, updated_at
      ) VALUES ('all', ?, ?, ?, 1, 1, ?, ?)
      ON CONFLICT(subject_key, id) DO UPDATE SET
        name = excluded.name,
        stage_ids_json = excluded.stage_ids_json,
        is_system = 1,
        revision = feishu_unified_views.revision + 1,
        updated_at = excluded.updated_at
      WHERE feishu_unified_views.name <> excluded.name
         OR feishu_unified_views.stage_ids_json <> excluded.stage_ids_json
         OR feishu_unified_views.is_system <> 1
    `).run(
      subject.subject_key,
      SYSTEM_UNIFIED_WORKFLOW_VIEW_NAME,
      systemStageIdsJson,
      timestamp,
      timestamp,
    );
    repaired ||= writtenSystemView.changes === 1;
    for (const { row, view } of acceptedRows) {
      if (row.name === view.name) continue;
      const canonicalized = this.database.prepare(`
        UPDATE feishu_unified_views
        SET name = ?, revision = revision + 1, updated_at = ?
        WHERE subject_key = ? AND id = ? AND revision = ?
      `).run(view.name, timestamp, row.subject_key, row.id, row.revision);
      repaired ||= canonicalized.changes === 1;
    }
    const normalized = this.#getUnifiedWorkflowViewsLocked(subject.subject_key);
    const validViewIds = new Set(normalized.views.map((view) => view.id));
    const viewSet = this.#getUnifiedWorkflowViewSet(subject.subject_key);
    const nextDefaultViewId = validViewIds.has(viewSet.default_view_id)
      ? viewSet.default_view_id
      : SYSTEM_UNIFIED_WORKFLOW_VIEW_ID;
    const nextActiveViewId = Boolean(viewSet.read_only)
      ? SYSTEM_UNIFIED_WORKFLOW_VIEW_ID
      : validViewIds.has(viewSet.active_view_id)
        ? viewSet.active_view_id
        : SYSTEM_UNIFIED_WORKFLOW_VIEW_ID;
    const nextFrozenActiveViewId = Boolean(viewSet.read_only)
      && validViewIds.has(viewSet.frozen_active_view_id)
      ? viewSet.frozen_active_view_id
      : null;
    if (
      viewSet.default_view_id !== nextDefaultViewId
      || viewSet.active_view_id !== nextActiveViewId
      || viewSet.frozen_active_view_id !== nextFrozenActiveViewId
    ) {
      this.database.prepare(`
        UPDATE feishu_unified_view_sets
        SET default_view_id = ?, active_view_id = ?, frozen_active_view_id = ?, updated_at = ?
        WHERE subject_key = ?
      `).run(
        nextDefaultViewId,
        nextActiveViewId,
        nextFrozenActiveViewId,
        timestamp,
        subject.subject_key,
      );
      repaired = true;
    }
    if (
      bumpSystemRepairRevision
      && insertedViewSet.changes === 0
      && repaired
    ) {
      this.database.prepare(`
        UPDATE feishu_unified_view_sets
        SET revision = revision + 1, updated_at = ?
        WHERE subject_key = ?
      `).run(timestamp, subject.subject_key);
    }
    return subject;
  }

  #getUnifiedWorkflowViewsLocked(subjectKey) {
    const key = normalizeUnifiedWorkflowSubjectKey(subjectKey);
    const viewSet = this.database.prepare(`
      SELECT subject_key, schema_version, default_view_id, active_view_id,
             revision, read_only
      FROM feishu_unified_view_sets
      WHERE subject_key = ?
    `).get(key);
    if (!viewSet) {
      throw new ApiError(500, "UNIFIED_VIEW_STATE_MISSING", "Unified workflow view state was not initialized");
    }
    const rows = this.database.prepare(`
      SELECT id, subject_key, name, stage_ids_json, is_system,
             revision, created_at, updated_at
      FROM feishu_unified_views
      WHERE subject_key = ?
      ORDER BY is_system DESC, created_at, id
    `).all(key);
    let systemView = null;
    const customViews = [];
    const names = new Set([SYSTEM_UNIFIED_WORKFLOW_VIEW_NAME]);
    for (const row of rows) {
      let view;
      try {
        view = unifiedWorkflowViewFromRow(row);
      } catch {
        continue;
      }
      if (view.id === SYSTEM_UNIFIED_WORKFLOW_VIEW_ID) {
        if (view.isSystem) systemView = view;
        continue;
      }
      if (view.isSystem || names.has(view.name)) continue;
      names.add(view.name);
      customViews.push(view);
    }
    const views = systemView ? [systemView, ...customViews] : [];
    const viewIds = new Set(views.map((view) => view.id));
    return {
      schemaVersion: viewSet.schema_version,
      subjectKey: viewSet.subject_key,
      revision: viewSet.revision,
      defaultViewId: viewIds.has(viewSet.default_view_id)
        ? viewSet.default_view_id
        : SYSTEM_UNIFIED_WORKFLOW_VIEW_ID,
      activeViewId: viewIds.has(viewSet.active_view_id)
        ? viewSet.active_view_id
        : SYSTEM_UNIFIED_WORKFLOW_VIEW_ID,
      views,
      readOnly: Boolean(viewSet.read_only),
    };
  }

  #assertUnifiedWorkflowWritable(subject, viewSet) {
    if (subject.removed_at !== null || Boolean(viewSet.read_only)) {
      throw new ApiError(409, "SUBJECT_REMOVED", "Removed Feishu subjects are read-only");
    }
  }

  #assertUnifiedWorkflowRevision(expectedVersion, actualVersion) {
    if (expectedVersion !== actualVersion) {
      throw new ApiError(409, "VERSION_CONFLICT", "Workflow views were changed by another client", {
        expectedVersion,
        actualVersion,
      });
    }
  }

  #getUnifiedWorkflowViewSet(subjectKey) {
    return this.database.prepare(`
      SELECT subject_key, default_view_id, active_view_id, frozen_active_view_id,
             revision, read_only
      FROM feishu_unified_view_sets
      WHERE subject_key = ?
    `).get(subjectKey);
  }

  #getUnifiedWorkflowView(subjectKey, viewId) {
    if (typeof viewId !== "string" || viewId.trim() === "") {
      throw new ApiError(400, "INVALID_FIELD", "viewId must be a non-empty string");
    }
    const view = this.database.prepare(`
      SELECT id, subject_key, name, stage_ids_json, is_system,
             revision, created_at, updated_at
      FROM feishu_unified_views
      WHERE subject_key = ? AND id = ?
    `).get(subjectKey, viewId.trim());
    if (!view) {
      throw new ApiError(404, "VIEW_NOT_FOUND", `Workflow view '${viewId.trim()}' does not exist`);
    }
    return view;
  }

  #assertUnifiedWorkflowViewNameAvailable(subjectKey, name, excludedViewId = null) {
    const duplicate = this.database.prepare(`
      SELECT id FROM feishu_unified_views
      WHERE subject_key = ? AND name = ? AND (? IS NULL OR id <> ?)
    `).get(subjectKey, name, excludedViewId, excludedViewId);
    if (duplicate) {
      throw new ApiError(409, "VIEW_NAME_EXISTS", `Workflow view name '${name}' already exists`);
    }
  }

  #assertUnifiedWorkflowPointer(subjectKey, viewId, fieldName) {
    if (typeof viewId !== "string" || viewId.trim() === "") {
      throw new ApiError(400, "INVALID_FIELD", `${fieldName} must be a non-empty string`);
    }
    const normalized = viewId.trim();
    const exists = this.database.prepare(`
      SELECT 1 FROM feishu_unified_views WHERE subject_key = ? AND id = ?
    `).get(subjectKey, normalized);
    if (!exists) {
      throw new ApiError(400, "INVALID_FIELD", `${fieldName} must identify a view in the same subject`);
    }
    return normalized;
  }

  ensureUnifiedWorkflowViews(subjectKey) {
    const key = normalizeUnifiedWorkflowSubjectKey(subjectKey);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.#ensureUnifiedWorkflowViewsLocked(key, { bumpSystemRepairRevision: true });
      const state = this.#getUnifiedWorkflowViewsLocked(key);
      this.database.exec("COMMIT");
      return state;
    } catch (error) {
      try { this.database.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }

  getUnifiedWorkflowViews(subjectKey) {
    return this.ensureUnifiedWorkflowViews(subjectKey);
  }

  createUnifiedWorkflowView(input) {
    const subjectKey = normalizeUnifiedWorkflowSubjectKey(input?.subjectKey);
    const stateRevision = normalizeUnifiedWorkflowRevision(input?.stateRevision, "stateRevision");
    const name = normalizeUnifiedWorkflowViewName(input?.name);
    const stageIds = normalizeUnifiedWorkflowStageIds(input?.stageIds);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const subject = this.#ensureUnifiedWorkflowViewsLocked(subjectKey);
      const viewSet = this.#getUnifiedWorkflowViewSet(subjectKey);
      this.#assertUnifiedWorkflowWritable(subject, viewSet);
      this.#assertUnifiedWorkflowRevision(stateRevision, viewSet.revision);
      this.#assertUnifiedWorkflowViewNameAvailable(subjectKey, name);
      const timestamp = now();
      const viewId = randomUUID();
      this.database.prepare(`
        INSERT INTO feishu_unified_views (
          id, subject_key, name, stage_ids_json, is_system,
          revision, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 0, 1, ?, ?)
      `).run(viewId, subjectKey, name, JSON.stringify(stageIds), timestamp, timestamp);
      const updated = this.database.prepare(`
        UPDATE feishu_unified_view_sets
        SET revision = revision + 1, updated_at = ?
        WHERE subject_key = ? AND revision = ?
      `).run(timestamp, subjectKey, stateRevision);
      if (updated.changes !== 1) {
        const actualVersion = this.#getUnifiedWorkflowViewSet(subjectKey)?.revision ?? 0;
        this.#assertUnifiedWorkflowRevision(stateRevision, actualVersion);
      }
      const state = this.#getUnifiedWorkflowViewsLocked(subjectKey);
      this.database.exec("COMMIT");
      return state;
    } catch (error) {
      try { this.database.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }

  updateUnifiedWorkflowView(viewId, input) {
    const subjectKey = normalizeUnifiedWorkflowSubjectKey(input?.subjectKey);
    const stateRevision = normalizeUnifiedWorkflowRevision(input?.stateRevision, "stateRevision");
    const hasName = Object.hasOwn(input ?? {}, "name");
    const hasStageIds = Object.hasOwn(input ?? {}, "stageIds");
    const hasDefaultViewId = Object.hasOwn(input ?? {}, "defaultViewId");
    const hasActiveViewId = Object.hasOwn(input ?? {}, "activeViewId");
    if (!hasName && !hasStageIds && !hasDefaultViewId && !hasActiveViewId) {
      throw new ApiError(400, "INVALID_FIELD", "At least one workflow view field must be updated");
    }
    const name = hasName ? normalizeUnifiedWorkflowViewName(input.name) : null;
    const stageIds = hasStageIds ? normalizeUnifiedWorkflowStageIds(input.stageIds) : null;
    const updatesView = hasName || hasStageIds;
    const viewRevision = updatesView
      ? normalizeUnifiedWorkflowRevision(input?.viewRevision, "viewRevision")
      : null;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const subject = this.#ensureUnifiedWorkflowViewsLocked(subjectKey);
      const viewSet = this.#getUnifiedWorkflowViewSet(subjectKey);
      this.#assertUnifiedWorkflowWritable(subject, viewSet);
      this.#assertUnifiedWorkflowRevision(stateRevision, viewSet.revision);
      const view = this.#getUnifiedWorkflowView(subjectKey, viewId);
      if (updatesView && Boolean(view.is_system)) {
        throw new ApiError(409, "SYSTEM_VIEW_PROTECTED", "The all-stages system view cannot be changed");
      }
      if (updatesView) {
        this.#assertUnifiedWorkflowRevision(viewRevision, view.revision);
        const nextName = hasName ? name : view.name;
        const nextStageIds = hasStageIds ? stageIds : JSON.parse(view.stage_ids_json);
        this.#assertUnifiedWorkflowViewNameAvailable(subjectKey, nextName, view.id);
        const timestamp = now();
        const updatedView = this.database.prepare(`
          UPDATE feishu_unified_views
          SET name = ?, stage_ids_json = ?, revision = revision + 1, updated_at = ?
          WHERE subject_key = ? AND id = ? AND revision = ? AND is_system = 0
        `).run(
          nextName,
          JSON.stringify(nextStageIds),
          timestamp,
          subjectKey,
          view.id,
          viewRevision,
        );
        if (updatedView.changes !== 1) {
          const actualVersion = this.#getUnifiedWorkflowView(subjectKey, view.id).revision;
          this.#assertUnifiedWorkflowRevision(viewRevision, actualVersion);
        }
      }
      const defaultViewId = hasDefaultViewId
        ? this.#assertUnifiedWorkflowPointer(subjectKey, input.defaultViewId, "defaultViewId")
        : viewSet.default_view_id;
      const activeViewId = hasActiveViewId
        ? this.#assertUnifiedWorkflowPointer(subjectKey, input.activeViewId, "activeViewId")
        : viewSet.active_view_id;
      const timestamp = now();
      const updatedSet = this.database.prepare(`
        UPDATE feishu_unified_view_sets
        SET default_view_id = ?, active_view_id = ?,
            revision = revision + 1, updated_at = ?
        WHERE subject_key = ? AND revision = ? AND read_only = 0
      `).run(defaultViewId, activeViewId, timestamp, subjectKey, stateRevision);
      if (updatedSet.changes !== 1) {
        const actualVersion = this.#getUnifiedWorkflowViewSet(subjectKey)?.revision ?? 0;
        this.#assertUnifiedWorkflowRevision(stateRevision, actualVersion);
        throw new ApiError(409, "SUBJECT_REMOVED", "Removed Feishu subjects are read-only");
      }
      const state = this.#getUnifiedWorkflowViewsLocked(subjectKey);
      this.database.exec("COMMIT");
      return state;
    } catch (error) {
      try { this.database.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }

  deleteUnifiedWorkflowView(viewId, input) {
    const subjectKey = normalizeUnifiedWorkflowSubjectKey(input?.subjectKey);
    const stateRevision = normalizeUnifiedWorkflowRevision(input?.stateRevision, "stateRevision");
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const subject = this.#ensureUnifiedWorkflowViewsLocked(subjectKey);
      const viewSet = this.#getUnifiedWorkflowViewSet(subjectKey);
      this.#assertUnifiedWorkflowWritable(subject, viewSet);
      this.#assertUnifiedWorkflowRevision(stateRevision, viewSet.revision);
      const view = this.#getUnifiedWorkflowView(subjectKey, viewId);
      if (Boolean(view.is_system)) {
        throw new ApiError(409, "SYSTEM_VIEW_PROTECTED", "The all-stages system view cannot be deleted");
      }
      const removed = this.database.prepare(`
        DELETE FROM feishu_unified_views
        WHERE subject_key = ? AND id = ? AND is_system = 0
      `).run(subjectKey, view.id);
      if (removed.changes !== 1) {
        throw new ApiError(404, "VIEW_NOT_FOUND", `Workflow view '${view.id}' does not exist`);
      }
      const timestamp = now();
      const updatedSet = this.database.prepare(`
        UPDATE feishu_unified_view_sets
        SET default_view_id = CASE WHEN default_view_id = ? THEN 'all' ELSE default_view_id END,
            active_view_id = CASE WHEN active_view_id = ? THEN 'all' ELSE active_view_id END,
            frozen_active_view_id = CASE WHEN frozen_active_view_id = ? THEN NULL ELSE frozen_active_view_id END,
            revision = revision + 1,
            updated_at = ?
        WHERE subject_key = ? AND revision = ? AND read_only = 0
      `).run(view.id, view.id, view.id, timestamp, subjectKey, stateRevision);
      if (updatedSet.changes !== 1) {
        const actualVersion = this.#getUnifiedWorkflowViewSet(subjectKey)?.revision ?? 0;
        this.#assertUnifiedWorkflowRevision(stateRevision, actualVersion);
        throw new ApiError(409, "SUBJECT_REMOVED", "Removed Feishu subjects are read-only");
      }
      const state = this.#getUnifiedWorkflowViewsLocked(subjectKey);
      this.database.exec("COMMIT");
      return state;
    } catch (error) {
      try { this.database.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }

  setUnifiedWorkflowViewState(subjectKeyValue, input) {
    const subjectKey = normalizeUnifiedWorkflowSubjectKey(subjectKeyValue);
    const stateRevision = normalizeUnifiedWorkflowRevision(input?.stateRevision, "stateRevision");
    const hasDefaultViewId = Object.hasOwn(input ?? {}, "defaultViewId");
    const hasActiveViewId = Object.hasOwn(input ?? {}, "activeViewId");
    if (!hasDefaultViewId && !hasActiveViewId) {
      throw new ApiError(400, "INVALID_FIELD", "defaultViewId or activeViewId is required");
    }
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const subject = this.#ensureUnifiedWorkflowViewsLocked(subjectKey);
      const viewSet = this.#getUnifiedWorkflowViewSet(subjectKey);
      this.#assertUnifiedWorkflowWritable(subject, viewSet);
      this.#assertUnifiedWorkflowRevision(stateRevision, viewSet.revision);
      const defaultViewId = hasDefaultViewId
        ? this.#assertUnifiedWorkflowPointer(subjectKey, input.defaultViewId, "defaultViewId")
        : viewSet.default_view_id;
      const activeViewId = hasActiveViewId
        ? this.#assertUnifiedWorkflowPointer(subjectKey, input.activeViewId, "activeViewId")
        : viewSet.active_view_id;
      const timestamp = now();
      const updated = this.database.prepare(`
        UPDATE feishu_unified_view_sets
        SET default_view_id = ?, active_view_id = ?,
            revision = revision + 1, updated_at = ?
        WHERE subject_key = ? AND revision = ? AND read_only = 0
      `).run(defaultViewId, activeViewId, timestamp, subjectKey, stateRevision);
      if (updated.changes !== 1) {
        const actualVersion = this.#getUnifiedWorkflowViewSet(subjectKey)?.revision ?? 0;
        this.#assertUnifiedWorkflowRevision(stateRevision, actualVersion);
        throw new ApiError(409, "SUBJECT_REMOVED", "Removed Feishu subjects are read-only");
      }
      const state = this.#getUnifiedWorkflowViewsLocked(subjectKey);
      this.database.exec("COMMIT");
      return state;
    } catch (error) {
      try { this.database.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }

  #ensureUnifiedWorkflowStageDisplayRowsLocked(subjectKey) {
    const subject = this.#getUnifiedWorkflowSubject(subjectKey);
    const timestamp = now();
    const insert = this.database.prepare(`
      INSERT INTO feishu_unified_stage_display_overrides (
        subject_key, stage_id, zh_name, en_name,
        zh_description, en_description, revision, updated_at
      ) VALUES (?, ?, NULL, NULL, NULL, NULL, 1, ?)
      ON CONFLICT(subject_key, stage_id) DO NOTHING
    `);
    for (const stageId of UNIFIED_WORKFLOW_STAGES) {
      insert.run(subject.subject_key, stageId, timestamp);
    }
    return subject;
  }

  #getUnifiedWorkflowStageDisplayOverridesLocked(subjectKey) {
    const rows = this.database.prepare(`
      SELECT subject_key, stage_id, zh_name, en_name,
             zh_description, en_description, revision, updated_at
      FROM feishu_unified_stage_display_overrides
      WHERE subject_key = ?
    `).all(subjectKey);
    const byStage = new Map(rows.map((row) => [row.stage_id, row]));
    return UNIFIED_WORKFLOW_STAGES.map((stageId) => {
      const row = byStage.get(stageId);
      if (!row) throw new Error(`Missing unified workflow stage display '${stageId}'`);
      return unifiedWorkflowStageDisplayFromRow(row);
    });
  }

  getStageDisplayOverrides(subjectKeyValue) {
    const subjectKey = normalizeUnifiedWorkflowSubjectKey(subjectKeyValue);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.#ensureUnifiedWorkflowStageDisplayRowsLocked(subjectKey);
      const overrides = this.#getUnifiedWorkflowStageDisplayOverridesLocked(subjectKey);
      this.database.exec("COMMIT");
      return overrides;
    } catch (error) {
      try { this.database.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }

  saveStageDisplayOverride(subjectKeyValue, stageId, expectedRevision, patch) {
    const subjectKey = normalizeUnifiedWorkflowSubjectKey(subjectKeyValue);
    if (typeof stageId !== "string" || !UNIFIED_WORKFLOW_STAGE_IDS.has(stageId)) {
      throw new ApiError(400, "INVALID_FIELD", `Unknown unified workflow stage '${String(stageId)}'`);
    }
    const revision = normalizeUnifiedWorkflowRevision(expectedRevision, "revision");
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
      throw new ApiError(400, "INVALID_BODY", "Stage display patch body must be an object");
    }
    const unknown = Object.keys(patch).find((key) => !UNIFIED_WORKFLOW_STAGE_DISPLAY_FIELDS.includes(key));
    if (unknown) throw new ApiError(400, "UNKNOWN_FIELD", `Unknown stage display field '${unknown}'`);
    const normalized = {};
    for (const field of UNIFIED_WORKFLOW_STAGE_DISPLAY_FIELDS) {
      if (!Object.hasOwn(patch, field)) continue;
      const maxLength = field.endsWith("Description") ? 120 : 32;
      normalized[field] = normalizeUnifiedWorkflowStageDisplayText(patch[field], field, maxLength);
    }

    this.database.exec("BEGIN IMMEDIATE");
    try {
      const subject = this.#ensureUnifiedWorkflowStageDisplayRowsLocked(subjectKey);
      if (subject.removed_at !== null) {
        throw new ApiError(409, "SUBJECT_REMOVED", "Removed Feishu subjects are read-only");
      }
      const current = this.database.prepare(`
        SELECT subject_key, stage_id, zh_name, en_name,
               zh_description, en_description, revision, updated_at
        FROM feishu_unified_stage_display_overrides
        WHERE subject_key = ? AND stage_id = ?
      `).get(subject.subject_key, stageId);
      if (!current) {
        throw new ApiError(404, "FEISHU_STAGE_DISPLAY_NOT_FOUND", `Stage display '${stageId}' does not exist`);
      }
      if (current.revision !== revision) {
        throw new ApiError(409, "VERSION_CONFLICT", "Stage display was changed by another client", {
          expectedVersion: revision,
          actualVersion: current.revision,
        });
      }
      const next = {
        zhName: Object.hasOwn(normalized, "zhName") ? normalized.zhName : current.zh_name,
        enName: Object.hasOwn(normalized, "enName") ? normalized.enName : current.en_name,
        zhDescription: Object.hasOwn(normalized, "zhDescription")
          ? normalized.zhDescription : current.zh_description,
        enDescription: Object.hasOwn(normalized, "enDescription")
          ? normalized.enDescription : current.en_description,
      };
      const timestamp = now();
      const updated = this.database.prepare(`
        UPDATE feishu_unified_stage_display_overrides
        SET zh_name = ?, en_name = ?, zh_description = ?, en_description = ?,
            revision = revision + 1, updated_at = ?
        WHERE subject_key = ? AND stage_id = ? AND revision = ?
      `).run(
        next.zhName,
        next.enName,
        next.zhDescription,
        next.enDescription,
        timestamp,
        subject.subject_key,
        stageId,
        revision,
      );
      if (updated.changes !== 1) {
        const actual = this.database.prepare(`
          SELECT revision FROM feishu_unified_stage_display_overrides
          WHERE subject_key = ? AND stage_id = ?
        `).get(subject.subject_key, stageId)?.revision ?? 0;
        throw new ApiError(409, "VERSION_CONFLICT", "Stage display was changed by another client", {
          expectedVersion: revision,
          actualVersion: actual,
        });
      }
      const overrides = this.#getUnifiedWorkflowStageDisplayOverridesLocked(subject.subject_key);
      this.database.exec("COMMIT");
      return overrides;
    } catch (error) {
      try { this.database.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }

  getProjectAssociationCounts(id) {
    const tableExists = (name) => Boolean(this.database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
    const count = (sql, ...values) => Number(this.database.prepare(sql).get(...values)?.count ?? 0);
    const result = {
      tasks: count("SELECT COUNT(*) AS count FROM tasks WHERE project_id = ?", id),
      comments: 0, taskActivities: 0, attachments: 0, taskArtifacts: 0, artifactUploads: 0,
      feishuOrigins: 0, packageSnapshots: 0, executions: 0, relations: 0, workflowWorkspaces: 0,
      projectSummaries: 0, aiChatThreads: 0, feishuSubjects: 0, views: 0, displayOverrides: 0,
    };
    const taskCount = (table, condition = "") => tableExists(table) ? count(`SELECT COUNT(*) AS count FROM ${table} JOIN tasks ON tasks.id = ${table}.task_id WHERE tasks.project_id = ? ${condition}`, id) : 0;
    result.comments = taskCount("comments");
    result.taskActivities = taskCount("task_activities");
    result.attachments = taskCount("attachments");
    result.taskArtifacts = taskCount("task_artifacts");
    result.artifactUploads = taskCount("artifact_uploads");
    result.feishuOrigins = taskCount("feishu_task_origins");
    result.packageSnapshots = taskCount("feishu_task_package_snapshots");
    result.executions = taskCount("feishu_task_executions");
    if (tableExists("task_relations")) result.relations = count(`
      SELECT COUNT(*) AS count
      FROM task_relations
      WHERE EXISTS (SELECT 1 FROM tasks WHERE tasks.id = task_relations.source_task_id AND tasks.project_id = ?)
         OR EXISTS (SELECT 1 FROM tasks WHERE tasks.id = task_relations.target_task_id AND tasks.project_id = ?)
    `, id, id);
    if (tableExists("workflow_workspaces")) result.workflowWorkspaces = count("SELECT COUNT(*) AS count FROM workflow_workspaces WHERE project_id = ?", id);
    if (tableExists("project_summaries")) result.projectSummaries = count("SELECT COUNT(*) AS count FROM project_summaries WHERE project_id = ?", id);
    if (tableExists("ai_chat_threads")) result.aiChatThreads = count("SELECT COUNT(*) AS count FROM ai_chat_threads WHERE origin_project_id = ?", id);
    if (tableExists("feishu_subjects")) result.feishuSubjects = count("SELECT COUNT(*) AS count FROM feishu_subjects WHERE project_id = ?", id);
    result.total = Object.values(result).reduce((sum, value) => sum + value, 0);
    return result;
  }

  deleteProject(id) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.database.prepare("SELECT id, source FROM projects WHERE id = ?").get(id);
      if (!row) throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${id}' does not exist`);
      if (row.source !== "local" || !id.startsWith("temp-")) throw new ApiError(403, "PROJECT_DELETE_FORBIDDEN", "Only manually created projects can be deleted");
      const associations = this.getProjectAssociationCounts(id);
      if (associations.total > 0) throw new ApiError(409, "PROJECT_NOT_EMPTY", "Project still contains associations", { associations });
      const result = this.database.prepare("DELETE FROM projects WHERE id = ?").run(id);
      if (result.changes !== 1) throw new ApiError(409, "PROJECT_NOT_EMPTY", "Project still contains associations", { associations });
      this.database.exec("COMMIT");
      return projectFromRow({ ...row, name: "", workspace_path: null, created_at: null, updated_at: null });
    } catch (error) { try { this.database.exec("ROLLBACK"); } catch {} throw error; }
  }

  getProject(id) {
    const row = this.database.prepare(`
      SELECT
        projects.id,
        projects.name,
        projects.workspace_path,
        projects.created_at,
        projects.updated_at,
        projects.archived_at,
        projects.source,
        (
          SELECT feishu_subjects.subject_key
          FROM feishu_subjects
          WHERE feishu_subjects.project_id = projects.id
          ORDER BY
            CASE WHEN feishu_subjects.removed_at IS NULL THEN 0 ELSE 1 END,
            feishu_subjects.updated_at DESC,
            feishu_subjects.subject_key
          LIMIT 1
        ) AS subject_key,
        COUNT(tasks.id) FILTER (WHERE tasks.archived_at IS NULL) AS issue_count,
        COUNT(tasks.id) FILTER (WHERE tasks.archived_at IS NOT NULL) AS archived_issue_count
      FROM projects
      LEFT JOIN tasks ON tasks.project_id = projects.id
      WHERE projects.id = ?
      GROUP BY
        projects.id,
        projects.name,
        projects.workspace_path,
        projects.archived_at,
        projects.source,
        projects.created_at,
        projects.updated_at
    `).get(id);
    return row ? projectFromRow(row) : null;
  }

  getProjectSummary(projectId) {
    const row = this.database.prepare(`
      SELECT project_id, summary, generated_at, attempted_at, error
      FROM project_summaries
      WHERE project_id = ?
    `).get(projectId);
    return row ? projectSummaryFromRow(row) : {
      projectId,
      summary: null,
      generatedAt: null,
      attemptedAt: null,
      error: null,
    };
  }

  listProjectSummaries() {
    return this.database.prepare(`
      SELECT project_id, summary, generated_at, attempted_at, error
      FROM project_summaries
      ORDER BY project_id
    `).all().map(projectSummaryFromRow);
  }

  saveProjectSummary(projectId, summary) {
    const timestamp = now();
    this.database.prepare(`
      INSERT INTO project_summaries (
        project_id, summary, generated_at, attempted_at, error
      ) VALUES (?, ?, ?, ?, NULL)
      ON CONFLICT(project_id) DO UPDATE SET
        summary = excluded.summary,
        generated_at = excluded.generated_at,
        attempted_at = excluded.attempted_at,
        error = NULL
    `).run(projectId, summary, timestamp, timestamp);
    return this.getProjectSummary(projectId);
  }

  saveProjectSummaryError(projectId, error) {
    const timestamp = now();
    this.database.prepare(`
      INSERT INTO project_summaries (
        project_id, summary, generated_at, attempted_at, error
      ) VALUES (?, NULL, NULL, ?, ?)
      ON CONFLICT(project_id) DO UPDATE SET
        attempted_at = excluded.attempted_at,
        error = excluded.error
    `).run(projectId, timestamp, error);
    return this.getProjectSummary(projectId);
  }

  getBoardStageLabels() {
    const row = this.database.prepare(`
      SELECT value_json, version
      FROM taskboard_settings
      WHERE key = ?
    `).get("board-stage-labels");
    if (!row) return { version: 1, labels: structuredClone(DEFAULT_BOARD_STAGE_LABELS) };
    return boardStageLabelsFromRow(row);
  }

  saveBoardStageLabels(expectedVersion, labels) {
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
      throw new ApiError(400, "INVALID_FIELD", "expectedVersion must be a positive integer");
    }
    const normalized = normalizeBoardStageLabels(labels);
    const timestamp = now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const currentRow = this.database.prepare(`
        SELECT value_json, version
        FROM taskboard_settings
        WHERE key = ?
      `).get("board-stage-labels");
      const current = currentRow ? boardStageLabelsFromRow(currentRow) : {
        version: 1,
        labels: structuredClone(DEFAULT_BOARD_STAGE_LABELS),
      };
      if (current.version !== expectedVersion) {
        this.database.exec("COMMIT");
        throw new ApiError(409, "BOARD_STAGE_LABELS_CONFLICT", "Board stage labels were changed by another client", { current });
      }
      const next = {
        version: current.version + 1,
        labels: normalized,
      };
      this.database.prepare(`
        INSERT INTO taskboard_settings (key, value_json, version, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value_json = excluded.value_json,
          version = excluded.version,
          updated_at = excluded.updated_at
      `).run("board-stage-labels", JSON.stringify(next.labels), next.version, timestamp);
      this.database.exec("COMMIT");
      return next;
    } catch (error) {
      try { this.database.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }

  getWorkflowWorkspace(projectId) {
    if (!this.database.prepare("SELECT 1 FROM projects WHERE id = ?").get(projectId)) {
      throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${projectId}' does not exist`);
    }
    const row = this.database.prepare(`
      SELECT project_id, workspace, version, updated_at
      FROM workflow_workspaces
      WHERE project_id = ?
    `).get(projectId);
    return row
      ? workflowWorkspaceFromRow(row)
      : { projectId, workspace: null, version: 0, updatedAt: null };
  }

  saveWorkflowWorkspace(projectId, expectedVersion, workspace) {
    const timestamp = now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      if (!this.database.prepare("SELECT 1 FROM projects WHERE id = ?").get(projectId)) {
        throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${projectId}' does not exist`);
      }
      if (this.database.prepare("SELECT 1 FROM projects WHERE id = ? AND archived_at IS NOT NULL").get(projectId)) {
        throw new ApiError(409, "PROJECT_ARCHIVED", `Project '${projectId}' is archived`);
      }
      const current = this.database.prepare(`
        SELECT version FROM workflow_workspaces WHERE project_id = ?
      `).get(projectId);
      const actualVersion = current?.version ?? 0;
      if (actualVersion !== expectedVersion) {
        throw new ApiError(409, "VERSION_CONFLICT", "Workflow was changed by another client", {
          expectedVersion,
          actualVersion,
        });
      }
      if (current) {
        this.database.prepare(`
          UPDATE workflow_workspaces
          SET workspace = ?, version = version + 1, updated_at = ?
          WHERE project_id = ? AND version = ?
        `).run(JSON.stringify(workspace), timestamp, projectId, expectedVersion);
      } else {
        this.database.prepare(`
          INSERT INTO workflow_workspaces (project_id, workspace, version, updated_at)
          VALUES (?, ?, 1, ?)
        `).run(projectId, JSON.stringify(workspace), timestamp);
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.getWorkflowWorkspace(projectId);
  }

  listAiChatThreads() {
    const rows = this.database.prepare(`
      SELECT * FROM ai_chat_threads
      ORDER BY updated_at DESC, id
    `).all();
    if (rows.length === 0) return [];

    const currentRuns = new Map();
    for (const row of this.database.prepare(`
      SELECT * FROM ai_chat_runs
      WHERE status = 'running'
      ORDER BY thread_id, started_at DESC, id DESC
    `).all()) {
      if (!currentRuns.has(row.thread_id)) currentRuns.set(row.thread_id, aiChatRunFromRow(row));
    }

    const latestTodos = new Map();
    for (const row of this.database.prepare(`
      SELECT id, thread_id, run_id, data, created_at
      FROM ai_chat_events
      WHERE type = 'todo_list'
      ORDER BY thread_id, created_at DESC, rowid DESC
    `).all()) {
      if (latestTodos.has(row.thread_id)) continue;
      const currentRun = currentRuns.get(row.thread_id);
      if (currentRun && row.run_id !== currentRun.id) continue;
      const progress = parseAiChatTodoProgress(row);
      if (progress) latestTodos.set(row.thread_id, progress);
    }

    return rows.map((row) => {
      const thread = aiChatThreadFromRow(row);
      thread.currentRun = currentRuns.get(thread.id) ?? null;
      thread.latestTodo = latestTodos.get(thread.id) ?? null;
      return thread;
    });
  }

  getAiChatThread(id) {
    const row = this.database.prepare("SELECT * FROM ai_chat_threads WHERE id = ?").get(id);
    return row ? this.#aiChatThreadWithCurrentRun(row) : null;
  }

  hasAiChatThreadProjectConflict(issueRef, projectId) {
    return Boolean(this.database.prepare(`
      SELECT 1
      FROM ai_chat_threads
      WHERE (origin_issue_id = ? OR origin_issue_identifier = ?)
        AND origin_project_id != ?
      LIMIT 1
    `).get(issueRef, issueRef, projectId));
  }

  createAiChatThread(input) {
    const id = input.id ?? randomUUID();
    const timestamp = input.createdAt ?? now();
    if (this.database.prepare("SELECT 1 FROM projects WHERE id = ? AND archived_at IS NOT NULL").get(input.origin.projectId)) {
      throw new ApiError(409, "PROJECT_ARCHIVED", `Project '${input.origin.projectId}' is archived`);
    }
    this.database.prepare(`
      INSERT INTO ai_chat_threads (
        id, title, status,
        origin_project_id, origin_project_name, origin_workspace_path,
        origin_issue_id, origin_issue_identifier,
        codex_thread_id, model, reasoning_effort, sandbox,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.title,
      input.status ?? "idle",
      input.origin.projectId,
      input.origin.projectName,
      input.origin.workspacePath,
      input.origin.issueId ?? null,
      input.origin.issueIdentifier ?? null,
      input.codexThreadId ?? null,
      input.model,
      input.reasoningEffort,
      input.sandbox,
      timestamp,
      input.updatedAt ?? timestamp,
    );
    return this.getAiChatThread(id);
  }

  updateAiChatThread(id, changes) {
    const current = this.getAiChatThread(id);
    if (!current) {
      throw new ApiError(404, "AI_CHAT_THREAD_NOT_FOUND", `AI chat thread '${id}' does not exist`);
    }
    const columns = {
      title: "title",
      status: "status",
      codexThreadId: "codex_thread_id",
      model: "model",
      reasoningEffort: "reasoning_effort",
      sandbox: "sandbox",
    };
    const assignments = [];
    const values = [];
    for (const [key, column] of Object.entries(columns)) {
      if (!Object.hasOwn(changes, key)) continue;
      assignments.push(`${column} = ?`);
      values.push(changes[key]);
    }
    if (assignments.length === 0) return current;
    assignments.push("updated_at = ?");
    values.push(changes.updatedAt ?? now(), id);
    this.database.prepare(`
      UPDATE ai_chat_threads SET ${assignments.join(", ")} WHERE id = ?
    `).run(...values);
    return this.getAiChatThread(id);
  }

  deleteAiChatThread(id) {
    const current = this.getAiChatThread(id);
    if (!current) {
      throw new ApiError(404, "AI_CHAT_THREAD_NOT_FOUND", `AI chat thread '${id}' does not exist`);
    }
    this.database.prepare("DELETE FROM ai_chat_threads WHERE id = ?").run(id);
    return current;
  }

  listAiChatRuns(threadId) {
    return this.database.prepare(`
      SELECT * FROM ai_chat_runs
      WHERE thread_id = ?
      ORDER BY started_at, id
    `).all(threadId).map(aiChatRunFromRow);
  }

  getAiChatRun(id) {
    const row = this.database.prepare("SELECT * FROM ai_chat_runs WHERE id = ?").get(id);
    return row ? aiChatRunFromRow(row) : null;
  }

  createAiChatRun(input) {
    const id = input.id ?? randomUUID();
    const timestamp = input.startedAt ?? now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(`
        INSERT INTO ai_chat_runs (
          id, thread_id, status, exit_code, error, started_at, finished_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        input.threadId,
        input.status ?? "running",
        input.exitCode ?? null,
        input.error ?? null,
        timestamp,
        input.finishedAt ?? null,
      );
      if ((input.status ?? "running") === "running") {
        this.database.prepare(`
          UPDATE ai_chat_threads
          SET status = 'running', updated_at = ?
          WHERE id = ?
        `).run(timestamp, input.threadId);
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.getAiChatRun(id);
  }

  updateAiChatRun(id, changes) {
    const current = this.getAiChatRun(id);
    if (!current) {
      throw new ApiError(404, "AI_CHAT_RUN_NOT_FOUND", `AI chat run '${id}' does not exist`);
    }
    const columns = {
      status: "status",
      exitCode: "exit_code",
      error: "error",
      finishedAt: "finished_at",
    };
    const assignments = [];
    const values = [];
    for (const [key, column] of Object.entries(columns)) {
      if (!Object.hasOwn(changes, key)) continue;
      assignments.push(`${column} = ?`);
      values.push(changes[key]);
    }
    if (assignments.length === 0) return current;

    this.database.exec("BEGIN IMMEDIATE");
    try {
      values.push(id);
      this.database.prepare(`
        UPDATE ai_chat_runs SET ${assignments.join(", ")} WHERE id = ?
      `).run(...values);
      const status = changes.status ?? current.status;
      if (status !== "running") {
        const threadStatus = status === "failed" ? "failed" : "idle";
        this.database.prepare(`
          UPDATE ai_chat_threads
          SET status = ?, updated_at = ?
          WHERE id = ?
            AND NOT EXISTS (
              SELECT 1 FROM ai_chat_runs
              WHERE thread_id = ? AND status = 'running'
            )
        `).run(threadStatus, changes.finishedAt ?? now(), current.threadId, current.threadId);
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.getAiChatRun(id);
  }

  insertAiChatEvent(input) {
    const id = input.id ?? randomUUID();
    const timestamp = input.createdAt ?? now();
    this.database.prepare(`
      INSERT INTO ai_chat_events (
        id, thread_id, run_id, type, role, content, data, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.threadId,
      input.runId ?? null,
      input.type,
      input.role,
      input.content,
      input.data === undefined || input.data === null ? null : JSON.stringify(input.data),
      timestamp,
    );
    const row = this.database.prepare("SELECT * FROM ai_chat_events WHERE id = ?").get(id);
    return aiChatEventFromRow(row);
  }

  listAiChatEvents(threadId) {
    return this.database.prepare(`
      SELECT * FROM ai_chat_events
      WHERE thread_id = ?
      ORDER BY created_at, rowid
    `).all(threadId).map(aiChatEventFromRow);
  }

  interruptAbandonedAiChatRuns() {
    const timestamp = now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = this.database.prepare(`
        UPDATE ai_chat_runs
        SET
          status = 'interrupted',
          error = COALESCE(error, 'Taskboard service restarted'),
          finished_at = COALESCE(finished_at, ?)
        WHERE status = 'running'
      `).run(timestamp);
      if (result.changes > 0) {
        this.database.prepare(`
          UPDATE ai_chat_threads
          SET status = 'idle', updated_at = ?
          WHERE status = 'running'
            AND NOT EXISTS (
              SELECT 1 FROM ai_chat_runs
              WHERE ai_chat_runs.thread_id = ai_chat_threads.id
                AND ai_chat_runs.status = 'running'
            )
        `).run(timestamp);
      }
      this.database.exec("COMMIT");
      return Number(result.changes);
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  listTasks(filters) {
    const where = [];
    const values = [];
    if (filters.projectId) {
      where.push("project_id = ?");
      values.push(filters.projectId);
    }
    if (filters.status) {
      where.push("status = ?");
      values.push(filters.status);
    }
    if (filters.archived === "false") {
      where.push("archived_at IS NULL");
    } else if (filters.archived === "true") {
      where.push("archived_at IS NOT NULL");
    }

    const sql = `
      SELECT * FROM tasks
      ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY
        CASE status
          WHEN 'backlog' THEN 1
          WHEN 'todo' THEN 2
          WHEN 'queued' THEN 3
          WHEN 'in_progress' THEN 4
          WHEN 'in_review' THEN 5
          WHEN 'blocked' THEN 6
          WHEN 'done' THEN 7
          WHEN 'canceled' THEN 8
        END,
        sort_order,
        created_at,
        id
    `;
    const rows = this.database.prepare(sql).all(...values);
    const commentsByTask = this.#commentsForTaskActivity(rows.map((row) => row.id));
    const activitiesByTask = this.#activitiesForTasks(rows.map((row) => row.id));
    const previewImagesByTask = this.#taskPreviewImages(rows.map((row) => row.id));
    return rows.map((row) => {
      const task = attachTaskActivity(
        this.#taskWithRelations(row),
        commentsByTask.get(row.id) ?? [],
        activitiesByTask.get(row.id) ?? [],
        previewImagesByTask.get(row.id) ?? null,
      );
      const feishuOrigin = this.getFeishuTaskOrigin(task.id);
      if (feishuOrigin) task.feishuOrigin = feishuOrigin;
      const packageSnapshot = this.getFeishuTaskPackageSnapshot(task.id);
      if (packageSnapshot) {
        task.feishuPackageSnapshot = {
          zipSourceDirectory: packageSnapshot.zipSourceDirectory ?? null,
        };
      }
      return task;
    });
  }

  getTask(id) {
    const row = this.database.prepare("SELECT * FROM tasks WHERE id = ? OR identifier = ?").get(id, id);
    if (!row) return null;
    const task = this.#taskWithRelations(row);
    const comments = this.#commentsForTaskActivity([task.id]).get(task.id) ?? [];
    const activities = this.#activitiesForTasks([task.id]).get(task.id) ?? [];
    const previewImage = this.#taskPreviewImages([task.id]).get(task.id) ?? null;
    const enriched = attachTaskActivity(task, comments, activities, previewImage);
    const feishuOrigin = this.getFeishuTaskOrigin(task.id);
    if (feishuOrigin) enriched.feishuOrigin = feishuOrigin;
    const packageSnapshot = this.getFeishuTaskPackageSnapshot(task.id);
    if (packageSnapshot) {
      enriched.feishuPackageSnapshot = {
        zipSourceDirectory: packageSnapshot.zipSourceDirectory ?? null,
      };
    }
    return enriched;
  }

  createTask(input) {
    if (input.status === "queued" && !input.feishuOrigin) {
      throw new ApiError(409, "QUEUED_STATUS_RESERVED", "Queued status is reserved for server-managed executions");
    }
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const project = this.database.prepare(`
        SELECT
          projects.id,
          projects.next_task_number,
          projects.archived_at,
          (
            SELECT tasks.identifier
            FROM tasks
            WHERE tasks.project_id = projects.id
            ORDER BY tasks.created_at, tasks.id
            LIMIT 1
          ) AS first_identifier
        FROM projects
        WHERE projects.id = ?
      `).get(input.projectId);
      if (!project) {
        throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${input.projectId}' does not exist`);
      }
      if (project.archived_at !== null) {
        throw new ApiError(409, "PROJECT_ARCHIVED", `Project '${input.projectId}' is archived`);
      }

      const prefix = project.first_identifier
        ? project.first_identifier.replace(/-\d+$/, "")
        : projectPrefix(project.id);
      const maximum = this.database.prepare(`
        SELECT MAX(CAST(substr(identifier, ?) AS INTEGER)) AS number
        FROM tasks
        WHERE identifier GLOB ?
      `).get(prefix.length + 2, `${prefix}-[0-9]*`).number;
      const number = Math.max(project.next_task_number, maximum === null ? 1 : maximum + 1);
      const identifier = `${prefix}-${number}`;
      const id = randomUUID();
      const timestamp = now();
      let sortOrder = input.sortOrder;
      if (sortOrder === undefined) {
        const row = this.database.prepare(`
          SELECT MIN(sort_order) AS minimum
          FROM tasks
          WHERE project_id = ? AND status = ? AND archived_at IS NULL
        `).get(input.projectId, input.status);
        sortOrder = row.minimum === null ? 1000 : row.minimum - 1000;
      }

      this.database.prepare(`
        UPDATE projects SET next_task_number = ?, updated_at = ? WHERE id = ?
      `).run(number + 1, timestamp, input.projectId);
      this.database.prepare(`
        INSERT INTO tasks (
          id, identifier, project_id, title, description, status, priority, labels,
          sort_order, thread_id, creator_type, creator_id, creator_name, creator_avatar_url,
          assignee_type, assignee_id, assignee_name, assignee_avatar_url,
          workflow_id, git_branch, worktree_path, worktree_branch,
          start_date, due_date, recurrence_interval, recurrence_unit,
          archived_at, version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1, ?, ?)
      `).run(
        id,
        identifier,
        input.projectId,
        input.title,
        input.description,
        input.status,
        input.priority,
        JSON.stringify(input.labels),
        sortOrder,
        input.threadId ?? null,
        input.actor.type,
        input.actor.id,
        input.actor.name,
        input.actor.avatarUrl,
        input.assignee.type,
        input.assignee.id,
        input.assignee.name,
        input.assignee.avatarUrl,
        input.workflowId,
        input.developmentContext?.type === "branch" ? input.developmentContext.branch : null,
        input.developmentContext?.type === "worktree" ? input.developmentContext.path : null,
        input.developmentContext?.type === "worktree" ? input.developmentContext.branch : null,
        input.startDate,
        input.dueDate,
        input.recurrence?.interval ?? null,
        input.recurrence?.unit ?? null,
        timestamp,
        timestamp,
      );
      if (input.feishuOrigin !== undefined) {
        const origin = normalizeFeishuTaskOrigin(input.feishuOrigin);
        this.database.prepare(`
          INSERT INTO feishu_task_origins (task_id, metadata_json, created_at, updated_at)
          VALUES (?, ?, ?, ?)
        `).run(id, JSON.stringify(origin), timestamp, timestamp);
      }
      if (input.packageSnapshot !== undefined) {
        const snapshot = normalizeFeishuPackageSnapshot(input.packageSnapshot);
        this.database.prepare(`
          INSERT INTO feishu_task_package_snapshots
            (task_id, package_alias, package_revision, snapshot_json, created_at)
          VALUES (?, ?, ?, ?, ?)
        `).run(id, snapshot.packageAlias, snapshot.packageRevision, JSON.stringify(snapshot), timestamp);
      }
      this.database.exec("COMMIT");
      return this.getTask(id);
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  updateTask(id, version, changes, threadId, actor) {
    const current = this.#requireTask(id);
    this.#requireVersion(current, version);
    if (current.status === "queued" && changes.status === "in_progress") {
      throw new ApiError(
        409,
        "TASK_EXECUTION_PENDING",
        "Queued executions start automatically when their package slot is available",
      );
    }
    if (changes.status === "queued" && !this.getFeishuTaskOrigin(id)) {
      throw new ApiError(409, "QUEUED_STATUS_RESERVED", "Queued status is reserved for server-managed executions");
    }
    const activityChanges = taskFieldChanges(current, changes);
    const targetProject = Object.hasOwn(changes, "projectId")
      ? this.database.prepare("SELECT id, name, workspace_path FROM projects WHERE id = ?").get(changes.projectId)
      : null;
    if (Object.hasOwn(changes, "projectId") && !targetProject) {
      throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${changes.projectId}' does not exist`);
    }
    const projectChanged = Boolean(targetProject && targetProject.id !== current.projectId);
    if (projectChanged) {
      if (this.getFeishuTaskOrigin(current.id)) {
        throw new ApiError(
          409,
          "FEISHU_PROJECT_MOVE_BLOCKED",
          "Server-registered Feishu workflow tasks cannot be moved to another project",
        );
      }
      const relation = this.database.prepare(`
        SELECT 1
        FROM task_relations
        WHERE source_task_id = ? OR target_task_id = ?
        LIMIT 1
      `).get(current.id, current.id);
      if (relation) {
        throw new ApiError(
          409,
          "CROSS_PROJECT_RELATION",
          "Remove issue relations before moving the issue to another project",
        );
      }
      if (this.hasAiChatThreadProjectConflict(current.id, targetProject.id)) {
        throw new ApiError(
          409,
          "AI_CHAT_PROJECT_MOVE_BLOCKED",
          "Delete issue-linked AI conversations before moving the issue to another project",
        );
      }
    }
    const dueDate = Object.hasOwn(changes, "dueDate") ? changes.dueDate : current.dueDate;
    const recurrence = Object.hasOwn(changes, "recurrence") ? changes.recurrence : current.recurrence;
    if (recurrence && !dueDate) {
      throw new ApiError(400, "INVALID_FIELD", "A recurring issue requires a due date");
    }

    const columns = {
      projectId: "project_id",
      title: "title",
      description: "description",
      status: "status",
      priority: "priority",
      labels: "labels",
      workflowId: "workflow_id",
      startDate: "start_date",
      dueDate: "due_date",
    };
    const assignments = [];
    const values = [];
    for (const [key, value] of Object.entries(changes)) {
      if (key === "developmentContext") {
        assignments.push("git_branch = ?", "worktree_path = ?", "worktree_branch = ?");
        values.push(
          value?.type === "branch" ? value.branch : null,
          value?.type === "worktree" ? value.path : null,
          value?.type === "worktree" ? value.branch : null,
        );
        continue;
      }
      if (key === "recurrence") {
        assignments.push("recurrence_interval = ?", "recurrence_unit = ?");
        values.push(value?.interval ?? null, value?.unit ?? null);
        continue;
      }
      if (key === "assignee") {
        assignments.push(
          "assignee_type = ?",
          "assignee_id = ?",
          "assignee_name = ?",
          "assignee_avatar_url = ?",
        );
        values.push(value.type, value.id, value.name, value.avatarUrl);
        continue;
      }
      assignments.push(`${columns[key]} = ?`);
      values.push(key === "labels" ? JSON.stringify(value) : value);
    }
    if (Object.hasOwn(changes, "status") && changes.status !== current.status) {
      const placementProjectId = projectChanged ? targetProject.id : current.projectId;
      const row = this.database.prepare(`
        SELECT MIN(sort_order) AS minimum
        FROM tasks
        WHERE project_id = ? AND status = ? AND archived_at IS NULL AND id != ?
      `).get(placementProjectId, changes.status, current.id);
      assignments.push("sort_order = ?");
      values.push(row.minimum === null ? 1000 : row.minimum - 1000);
    }
    if (threadId !== undefined && !Object.hasOwn(changes, "projectId")) {
      assignments.push("thread_id = ?");
      values.push(threadId);
    }
    assignments.push("version = version + 1", "updated_at = ?");
    const timestamp = now();
    values.push(timestamp, current.id, version);

    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = this.database.prepare(`
        UPDATE tasks SET ${assignments.join(", ")} WHERE id = ? AND version = ?
      `).run(...values);
      if (result.changes !== 1) {
        this.#throwMissingOrConflict(id, version);
      }
      if (projectChanged) {
        this.database.prepare(`
          UPDATE projects SET updated_at = ? WHERE id IN (?, ?)
        `).run(timestamp, current.projectId, targetProject.id);
      }
      this.#recordTaskActivity(current.id, actor, activityChanges, timestamp);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.getTask(current.id);
  }

  createFeishuTask(input, packageSnapshot = undefined) {
    if (!input || typeof input !== "object" || !input.feishuOrigin) {
      throw new ApiError(400, "INVALID_FEISHU_ORIGIN", "Feishu task origin is required");
    }
    if (packageSnapshot === undefined && input.feishuOrigin.packageAlias) {
      throw new ApiError(409, "PACKAGE_SNAPSHOT_REQUIRED", "A trusted Auto-Cut package snapshot is required");
    }
    return this.createTask({ ...input, packageSnapshot });
  }

  getFeishuTaskOrigin(taskId) {
    const row = this.database.prepare(`
      SELECT task_id, metadata_json, created_at, updated_at
      FROM feishu_task_origins WHERE task_id = ?
    `).get(taskId);
    if (!row) return null;
    try {
      return {
        taskId: row.task_id,
        ...normalizeFeishuTaskOrigin(JSON.parse(row.metadata_json)),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    } catch {
      return null;
    }
  }

  getFeishuTaskPackageSnapshot(taskId) {
    const row = this.database.prepare(`
      SELECT snapshot_json FROM feishu_task_package_snapshots WHERE task_id = ?
    `).get(taskId);
    if (!row) return null;
    try {
      return structuredClone(normalizeFeishuPackageSnapshot(JSON.parse(row.snapshot_json)));
    } catch {
      return null;
    }
  }

  createFeishuExecution(input) {
    if (!input || typeof input !== "object") throw new ApiError(400, "INVALID_FIELD", "Execution input is required");
    const taskId = String(input.taskId ?? "").trim();
    const packageAlias = String(input.packageAlias ?? "").trim();
    if (!taskId || !packageAlias) throw new ApiError(400, "INVALID_FIELD", "taskId and packageAlias are required");
    if (!Number.isSafeInteger(input.readyAt) || input.readyAt < 0) {
      throw new ApiError(400, "INVALID_FIELD", "readyAt must be a non-negative timestamp");
    }
    if (!Number.isSafeInteger(input.packageRevision) || input.packageRevision < 1) {
      throw new ApiError(400, "INVALID_FIELD", "packageRevision must be a positive integer");
    }
    if (!['manual', 'automatic'].includes(input.mode) || !['manual', 'move', 'automatic'].includes(input.trigger)) {
      throw new ApiError(400, "INVALID_FIELD", "Invalid execution mode or trigger");
    }
    const timestamp = now();
    try {
      this.database.prepare(`
        INSERT INTO feishu_task_executions
          (task_id, state, mode, ready_at, package_alias, package_revision, trigger,
           lease_id, version, created_at, updated_at, last_error)
        VALUES (?, 'delayed', ?, ?, ?, ?, ?, NULL, 1, ?, ?, NULL)
      `).run(taskId, input.mode, input.readyAt, packageAlias, input.packageRevision, input.trigger, timestamp, timestamp);
    } catch (error) {
      if (String(error.message).includes("UNIQUE constraint failed")) {
        throw new ApiError(409, "EXECUTION_EXISTS", "An execution is already scheduled for this task");
      }
      throw error;
    }
    return this.getFeishuExecution(taskId);
  }

  getFeishuExecution(taskId) {
    const row = this.database.prepare(`SELECT * FROM feishu_task_executions WHERE task_id = ?`).get(taskId);
    return row ? {
      taskId: row.task_id,
      state: row.state,
      mode: row.mode,
      readyAt: row.ready_at,
      packageAlias: row.package_alias,
      packageRevision: row.package_revision,
      trigger: row.trigger,
      leaseId: row.lease_id,
      version: row.version,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastError: row.last_error,
    } : null;
  }

  listPendingFeishuExecutions() {
    return this.database.prepare(`
      SELECT * FROM feishu_task_executions
      WHERE state IN ('delayed', 'queued')
      ORDER BY ready_at, created_at, task_id
    `).all().map((row) => ({
      taskId: row.task_id,
      state: row.state,
      mode: row.mode,
      readyAt: row.ready_at,
      packageAlias: row.package_alias,
      packageRevision: row.package_revision,
      trigger: row.trigger,
      leaseId: row.lease_id,
      version: row.version,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastError: row.last_error,
    }));
  }

  setFeishuExecutionState(taskId, expectedVersion, state, patch = {}) {
    if (!['delayed', 'queued', 'running'].includes(state)) {
      throw new ApiError(400, "INVALID_FIELD", "Invalid Feishu execution state");
    }
    const allowed = new Set(['readyAt', 'leaseId', 'lastError']);
    const unknown = Object.keys(patch).find((key) => !allowed.has(key));
    if (unknown) throw new ApiError(400, "INVALID_FIELD", `Unsupported execution field '${unknown}'`);
    const current = this.getFeishuExecution(taskId);
    if (!current) throw new ApiError(404, "EXECUTION_NOT_FOUND", "Execution does not exist");
    if (current.version !== expectedVersion) throw new ApiError(409, "EXECUTION_VERSION_CONFLICT", "Execution state changed");
    const timestamp = now();
    const result = this.database.prepare(`
      UPDATE feishu_task_executions
      SET state = ?, ready_at = COALESCE(?, ready_at), lease_id = COALESCE(?, lease_id),
          last_error = CASE WHEN ? THEN ? ELSE last_error END,
          version = version + 1, updated_at = ?
      WHERE task_id = ? AND version = ?
    `).run(
      state,
      patch.readyAt ?? null,
      patch.leaseId ?? null,
      Object.hasOwn(patch, 'lastError') ? 1 : 0,
      patch.lastError ?? null,
      timestamp,
      taskId,
      expectedVersion,
    );
    if (result.changes !== 1) throw new ApiError(409, "EXECUTION_VERSION_CONFLICT", "Execution state changed");
    return this.getFeishuExecution(taskId);
  }

  clearFeishuExecution(taskId) {
    this.database.prepare("DELETE FROM feishu_task_executions WHERE task_id = ?").run(taskId);
  }

  transitionFeishuTaskExecution(taskId, expectedVersion, status, actor = {
    type: "agent", id: "codex-agent", name: "Codex Agent", avatarUrl: null,
  }) {
    if (!['todo', 'queued', 'in_progress'].includes(status)) {
      throw new ApiError(400, "INVALID_FIELD", "Invalid Feishu execution task status");
    }
    const current = this.#requireTask(taskId);
    this.#requireVersion(current, expectedVersion);
    if (current.archivedAt !== null) throw new ApiError(409, "TASK_ARCHIVED", "Archived tasks cannot change execution state");
    if (current.status === status) return current;
    const row = this.database.prepare(`
      SELECT MIN(sort_order) AS minimum FROM tasks
      WHERE project_id = ? AND status = ? AND archived_at IS NULL AND id != ?
    `).get(current.projectId, status, current.id);
    const sortOrder = row.minimum === null ? 1000 : row.minimum - 1000;
    const timestamp = now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = this.database.prepare(`
        UPDATE tasks SET status = ?, sort_order = ?, version = version + 1, updated_at = ?
        WHERE id = ? AND version = ?
      `).run(status, sortOrder, timestamp, taskId, expectedVersion);
      if (result.changes !== 1) this.#throwMissingOrConflict(taskId, expectedVersion);
      this.#recordTaskActivity(taskId, actor, taskFieldChanges(current, { status }), timestamp);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.getTask(taskId);
  }

  refreshFeishuTaskPackageSnapshot(taskId, expectedVersion, packageSnapshot, actor) {
    const current = this.#requireTask(taskId);
    this.#requireVersion(current, expectedVersion);
    if (current.archivedAt !== null) {
      throw new ApiError(409, "TASK_PACKAGE_REFRESH_BLOCKED", "Archived tasks cannot refresh package configuration");
    }
    if (!this.getFeishuTaskOrigin(taskId)) {
      throw new ApiError(409, "TASK_NOT_STARTABLE", "This task is not a server-registered Feishu workflow task");
    }
    if (!["todo", "queued"].includes(current.status)) {
      throw new ApiError(409, "TASK_PACKAGE_REFRESH_BLOCKED", "Only waiting or queued tasks can refresh their package configuration");
    }
    const snapshot = normalizeFeishuPackageSnapshot(packageSnapshot);
    const timestamp = now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const locked = this.#requireTask(taskId);
      this.#requireVersion(locked, expectedVersion);
      this.database.prepare(`
        UPDATE tasks SET version = version + 1, updated_at = ? WHERE id = ? AND version = ?
      `).run(timestamp, taskId, expectedVersion);
      this.database.prepare(`
        INSERT INTO feishu_task_package_snapshots
          (task_id, package_alias, package_revision, snapshot_json, created_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(task_id) DO UPDATE SET package_alias=excluded.package_alias,
          package_revision=excluded.package_revision, snapshot_json=excluded.snapshot_json,
          created_at=excluded.created_at
      `).run(taskId, snapshot.packageAlias, snapshot.packageRevision, JSON.stringify(snapshot), timestamp);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.getTask(taskId);
  }

  findFeishuTaskByEventId(eventId, projectId = null) {
    const rows = this.database.prepare(`
      SELECT feishu_task_origins.task_id, feishu_task_origins.metadata_json
      FROM feishu_task_origins JOIN tasks ON tasks.id = feishu_task_origins.task_id
      WHERE (? IS NULL OR tasks.project_id = ?)
      ORDER BY tasks.created_at, tasks.id
    `).all(projectId, projectId);
    for (const row of rows) {
      try {
        if (normalizeFeishuTaskOrigin(JSON.parse(row.metadata_json)).eventId === eventId) {
          return this.getTask(row.task_id);
        }
      } catch {}
    }
    return null;
  }

  listFeishuTasks(scope = {}) {
    const rows = this.database.prepare(`
      SELECT feishu_task_origins.task_id, feishu_task_origins.metadata_json
      FROM feishu_task_origins JOIN tasks ON tasks.id = feishu_task_origins.task_id
      WHERE (? IS NULL OR tasks.project_id = ?)
        AND (? IS NULL OR tasks.status = ?)
        AND (? IS NULL OR tasks.archived_at IS NULL)
      ORDER BY tasks.created_at, tasks.id
    `).all(
      scope.projectId ?? null, scope.projectId ?? null,
      scope.status ?? null, scope.status ?? null,
      scope.archived === false ? 1 : null,
    );
    return rows.flatMap((row) => {
      try {
        const metadata = normalizeFeishuTaskOrigin(JSON.parse(row.metadata_json));
        for (const key of ["baseToken", "tableId", "recordId", "triggerFieldId", "triggerField", "triggerValue"]) {
          if (scope[key] !== undefined && metadata[key] !== scope[key]) return [];
        }
        const task = this.getTask(row.task_id);
        return task ? [task] : [];
      } catch { return []; }
    });
  }

  listPackageReferences(alias) {
    if (typeof alias !== "string" || alias.trim() === "") return [];
    const packageAlias = alias.trim();
    const references = [];
    const subjects = this.database.prepare(`
      SELECT
        feishu_subjects.subject_key,
        feishu_subjects.base_token,
        feishu_subjects.table_id,
        feishu_subjects.table_name,
        feishu_subjects.lifecycle,
        feishu_subjects.config_json,
        feishu_bases.base_name
      FROM feishu_subjects
      JOIN feishu_bases ON feishu_bases.base_token = feishu_subjects.base_token
      WHERE feishu_subjects.lifecycle = 'enabled'
        AND feishu_subjects.removed_at IS NULL
        AND feishu_bases.removed_at IS NULL
      ORDER BY feishu_bases.base_name, feishu_subjects.table_name, feishu_subjects.subject_key
    `).all();
    for (const row of subjects) {
      try {
        const route = JSON.parse(row.config_json)?.packageRoute;
        const aliases = new Set([
          route?.packageAlias,
          ...Object.values(route?.branchMap ?? {}),
        ].filter((value) => typeof value === "string" && value.trim() !== ""));
        if (!aliases.has(packageAlias)) continue;
        references.push({
          type: "subject",
          subjectKey: row.subject_key,
          baseToken: row.base_token,
          baseName: row.base_name,
          tableId: row.table_id,
          tableName: row.table_name,
          lifecycle: row.lifecycle,
        });
      } catch {}
    }

    const tasks = this.database.prepare(`
      SELECT
        tasks.id,
        tasks.identifier,
        tasks.title,
        tasks.status,
        feishu_task_origins.metadata_json
      FROM feishu_task_origins
      JOIN tasks ON tasks.id = feishu_task_origins.task_id
      WHERE tasks.status NOT IN ('done', 'canceled')
      ORDER BY tasks.created_at, tasks.id
    `).all();
    for (const row of tasks) {
      try {
        const origin = normalizeFeishuTaskOrigin(JSON.parse(row.metadata_json));
        if (origin.packageAlias !== packageAlias) continue;
        references.push({
          type: "task",
          taskId: row.id,
          identifier: row.identifier,
          title: row.title,
          status: row.status,
          ...(origin.subjectKey ? { subjectKey: origin.subjectKey } : {}),
        });
      } catch {}
    }
    return references;
  }

  archiveFeishuTask(taskId, version, actor) {
    this.#requireTask(taskId);
    if (!this.getFeishuTaskOrigin(taskId)) {
      throw new ApiError(409, "TASK_NOT_STARTABLE", "This task is not a server-registered Feishu workflow task");
    }
    const task = this.#requireTask(taskId);
    if (task.archivedAt !== null || task.status !== "todo") {
      throw new ApiError(409, "TASK_NOT_WAITING", "Only unarchived todo Feishu tasks can be archived");
    }
    return this.archiveTask(taskId, version, null, actor);
  }

  deleteAiChatRun(id) {
    const run = this.getAiChatRun(id);
    if (!run) return;
    const timestamp = now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare("DELETE FROM ai_chat_runs WHERE id = ?").run(id);
      this.database.prepare(`
        UPDATE ai_chat_threads
        SET status = 'idle', updated_at = ?
        WHERE id = ?
          AND NOT EXISTS (
            SELECT 1 FROM ai_chat_runs
            WHERE thread_id = ? AND status = 'running'
          )
      `).run(timestamp, run.threadId, run.threadId);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  detachFailedPreStartThreadForRetry(id, expectedVersion, actor) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const current = this.getTask(id);
      if (!current) {
        throw new ApiError(404, "TASK_NOT_FOUND", `Task '${id}' does not exist`);
      }
      this.#requireVersion(current, expectedVersion);
      if (
        !(current.status === "todo" || current.status === "queued")
        || current.archivedAt !== null
        || current.threadId === null
      ) {
        throw new ApiError(409, "TASK_NOT_STARTABLE", "Only ready tasks can be started with Codex");
      }
      const failedPreStartThread = this.database.prepare(`
        SELECT ai_chat_threads.id
        FROM ai_chat_threads
        WHERE ai_chat_threads.id = ?
          AND ai_chat_threads.origin_issue_id = ?
          AND ai_chat_threads.origin_project_id = ?
          AND ai_chat_threads.status = 'failed'
          AND ai_chat_threads.codex_thread_id IS NULL
          AND EXISTS (
            SELECT 1 FROM ai_chat_runs
            WHERE ai_chat_runs.thread_id = ai_chat_threads.id
              AND ai_chat_runs.status = 'failed'
          )
          AND NOT EXISTS (
            SELECT 1 FROM ai_chat_runs
            WHERE ai_chat_runs.thread_id = ai_chat_threads.id
              AND ai_chat_runs.status = 'running'
          )
      `).get(current.threadId, current.id, current.projectId);
      if (!failedPreStartThread) {
        throw new ApiError(409, "TASK_NOT_STARTABLE", "Only ready tasks can be started with Codex");
      }
      const timestamp = now();
      const result = this.database.prepare(`
        UPDATE tasks
        SET thread_id = NULL, version = version + 1, updated_at = ?
        WHERE id = ? AND version = ? AND thread_id = ?
      `).run(timestamp, current.id, expectedVersion, current.threadId);
      if (result.changes !== 1) this.#throwMissingOrConflict(id, expectedVersion);
      this.#recordTaskActivity(
        current.id,
        actor,
        taskFieldChanges(current, { threadId: null }),
        timestamp,
      );
      this.database.exec("COMMIT");
      return this.getTask(current.id);
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  claimTaskForAiStart(id, expectedVersion, actor) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const current = this.getTask(id);
      if (!current) {
        throw new ApiError(404, "TASK_NOT_FOUND", `Task '${id}' does not exist`);
      }
      this.#requireVersion(current, expectedVersion);
      if (!(current.status === "todo" || current.status === "queued") || current.archivedAt !== null || current.threadId !== null) {
        throw new ApiError(409, "TASK_NOT_STARTABLE", "Only ready tasks can be started with Codex");
      }
      const row = this.database.prepare(`
        SELECT MIN(sort_order) AS minimum
        FROM tasks
        WHERE project_id = ? AND status = 'in_progress' AND archived_at IS NULL AND id != ?
      `).get(current.projectId, current.id);
      const sortOrder = row.minimum === null ? 1000 : row.minimum - 1000;
      const timestamp = now();
      const result = this.database.prepare(`
        UPDATE tasks
        SET status = 'in_progress', sort_order = ?, version = version + 1, updated_at = ?
        WHERE id = ? AND version = ? AND status IN ('todo', 'queued') AND archived_at IS NULL
      `).run(sortOrder, timestamp, current.id, expectedVersion);
      if (result.changes !== 1) {
        throw new ApiError(409, "TASK_NOT_STARTABLE", "Only ready tasks can be started with Codex");
      }
      const claimToken = randomUUID();
      const activity = this.database.prepare(`
        INSERT INTO task_activities (
          id, task_id, actor_type, actor_id, actor_name, actor_avatar_url, changes, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        randomUUID(),
        current.id,
        actor.type,
        actor.id,
        actor.name,
        actor.avatarUrl,
        JSON.stringify(taskFieldChanges(current, { status: "in_progress" })),
        timestamp,
      );
      this.database.prepare(`
        INSERT INTO task_ai_starts (task_id, claim_token, thread_id, claimed_at, updated_at)
        VALUES (?, ?, NULL, ?, ?)
      `).run(current.id, claimToken, timestamp, timestamp);
      this.database.prepare("UPDATE task_ai_starts SET claimed_activity_rowid = ? WHERE task_id = ? AND claim_token = ?")
        .run(Number(activity.lastInsertRowid), current.id, claimToken);
      this.database.exec("COMMIT");
      return attachAiStartClaim(this.getTask(current.id), claimToken);
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  releaseTaskFromAiStart(id, claimToken, actor) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const current = this.getTask(id);
      if (!current) {
        throw new ApiError(404, "TASK_NOT_FOUND", `Task '${id}' does not exist`);
      }
      const claim = this.database.prepare(`
        SELECT thread_id FROM task_ai_starts
        WHERE task_id = ? AND claim_token = ?
      `).get(id, claimToken);
      if (!claim) {
        throw new ApiError(409, "TASK_START_STATE_CHANGED", "Task start state changed before Codex finished starting");
      }
      if (current.status !== "in_progress" || current.threadId !== claim.thread_id) {
        this.database.prepare("DELETE FROM task_ai_starts WHERE task_id = ? AND claim_token = ?")
          .run(id, claimToken);
        this.database.exec("COMMIT");
        return current;
      }
      const timestamp = now();
      const result = this.database.prepare(`
        UPDATE tasks
        SET status = 'todo', thread_id = NULL, version = version + 1, updated_at = ?
        WHERE id = ? AND status = 'in_progress' AND thread_id IS ?
      `).run(timestamp, current.id, claim.thread_id);
      if (result.changes !== 1) {
        throw new ApiError(
          409,
          "TASK_START_STATE_CHANGED",
          "Task start state changed before Codex finished starting",
        );
      }
      this.#recordTaskActivity(current.id, actor, taskFieldChanges(current, {
        status: "todo",
        threadId: null,
      }), timestamp);
      this.database.prepare("DELETE FROM task_ai_starts WHERE task_id = ? AND claim_token = ?")
        .run(id, claimToken);
      this.database.exec("COMMIT");
      return this.getTask(current.id);
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  listTaskAiStarts() {
    return this.database.prepare(`
      SELECT task_id, claim_token, thread_id, run_id, claimed_at, updated_at, claimed_activity_rowid
      FROM task_ai_starts
      ORDER BY claimed_at, task_id
    `).all().map((row) => ({
      taskId: row.task_id,
      claimToken: row.claim_token,
      threadId: row.thread_id,
      runId: row.run_id,
      claimedAt: row.claimed_at,
      updatedAt: row.updated_at,
      claimedActivityRowid: row.claimed_activity_rowid,
    }));
  }

  deleteTaskAiStartClaim(id, claimToken) {
    this.database.prepare("DELETE FROM task_ai_starts WHERE task_id = ? AND claim_token = ?")
      .run(id, claimToken);
  }

  bindTaskAiStart(id, claimToken, expectedVersion, threadId, actor) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const current = this.getTask(id);
      if (!current) {
        throw new ApiError(404, "TASK_NOT_FOUND", `Task '${id}' does not exist`);
      }
      this.#requireVersion(current, expectedVersion);
      const claim = this.database.prepare(`
        SELECT thread_id FROM task_ai_starts
        WHERE task_id = ? AND claim_token = ?
      `).get(id, claimToken);
      if (!claim || claim.thread_id !== null || current.status !== "in_progress" || current.threadId !== null) {
        throw new ApiError(409, "TASK_START_STATE_CHANGED", "Task start state changed before Codex finished starting");
      }
      const timestamp = now();
      const result = this.database.prepare(`
        UPDATE tasks
        SET thread_id = ?, version = version + 1, updated_at = ?
        WHERE id = ? AND version = ? AND status = 'in_progress' AND thread_id IS NULL
      `).run(threadId, timestamp, id, expectedVersion);
      if (result.changes !== 1) {
        throw new ApiError(409, "TASK_START_STATE_CHANGED", "Task start state changed before Codex finished starting");
      }
      const claimResult = this.database.prepare(`
        UPDATE task_ai_starts SET thread_id = ?, updated_at = ?
        WHERE task_id = ? AND claim_token = ? AND thread_id IS NULL
      `).run(threadId, timestamp, id, claimToken);
      if (claimResult.changes !== 1) {
        throw new ApiError(409, "TASK_START_STATE_CHANGED", "Task start state changed before Codex finished starting");
      }
      this.#recordTaskActivity(current.id, actor, taskFieldChanges(current, { threadId }), timestamp);
      this.database.exec("COMMIT");
      return attachAiStartClaim(this.getTask(id), claimToken);
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  bindTaskAiStartRun(id, claimToken, threadId, runId) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const claim = this.database.prepare(`
        SELECT thread_id, run_id FROM task_ai_starts
        WHERE task_id = ? AND claim_token = ?
      `).get(id, claimToken);
      const run = this.database.prepare(`
        SELECT id, thread_id FROM ai_chat_runs WHERE id = ?
      `).get(runId);
      if (!claim || claim.thread_id !== threadId || claim.run_id !== null || !run || run.thread_id !== threadId) {
        throw new ApiError(409, "TASK_START_STATE_CHANGED", "Task start state changed before Codex run was bound");
      }
      this.database.prepare(`
        UPDATE task_ai_starts SET run_id = ?, updated_at = ?
        WHERE task_id = ? AND claim_token = ? AND thread_id = ? AND run_id IS NULL
      `).run(runId, now(), id, claimToken, threadId);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  verifyTaskAiStart(id, claimToken, expectedVersion, threadId) {
    const current = this.getTask(id);
    const claim = this.database.prepare(`
      SELECT thread_id FROM task_ai_starts
      WHERE task_id = ? AND claim_token = ?
    `).get(id, claimToken);
    if (
      !current
      || current.version !== expectedVersion
      || current.status !== "in_progress"
      || current.threadId !== threadId
      || claim?.thread_id !== threadId
    ) {
      throw new ApiError(409, "TASK_START_STATE_CHANGED", "Task start state changed before Codex finished starting");
    }
    return current;
  }

  settleTaskAiStart(id, claimToken, runId, status, actor) {
    if (!["in_progress", "in_review", "done", "blocked"].includes(status)) {
      throw new ApiError(400, "INVALID_FIELD", "Invalid AI start terminal status");
    }
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const current = this.getTask(id);
      if (!current) {
        throw new ApiError(404, "TASK_NOT_FOUND", `Task '${id}' does not exist`);
      }
      const claim = this.database.prepare(`
        SELECT thread_id, run_id, claimed_at, claimed_activity_rowid FROM task_ai_starts
        WHERE task_id = ? AND claim_token = ?
      `).get(id, claimToken);
      if (!claim) {
        throw new ApiError(409, "TASK_START_STATE_CHANGED", "Task start state changed before Codex finished");
      }
      if (!claim.run_id || claim.run_id !== runId) {
        throw new ApiError(409, "TASK_START_STATE_CHANGED", "Codex run does not own this task start claim");
      }
      if (current.status !== "in_progress" || current.threadId !== claim.thread_id) {
        this.database.prepare("DELETE FROM task_ai_starts WHERE task_id = ? AND claim_token = ?")
          .run(id, claimToken);
        this.database.exec("COMMIT");
        return current;
      }
      const latestStatusChange = this.latestTaskStatusChange(id, claim.claimed_activity_rowid);
      if (latestStatusChange) {
        this.database.prepare("DELETE FROM task_ai_starts WHERE task_id = ? AND claim_token = ?")
          .run(id, claimToken);
        this.database.exec("COMMIT");
        return current;
      }
      if (status === "in_progress") {
        this.database.prepare("DELETE FROM task_ai_starts WHERE task_id = ? AND claim_token = ?")
          .run(id, claimToken);
        this.database.exec("COMMIT");
        return current;
      }
      const timestamp = now();
      const result = this.database.prepare(`
        UPDATE tasks SET status = ?, version = version + 1, updated_at = ?
        WHERE id = ? AND status = 'in_progress' AND thread_id IS ?
      `).run(status, timestamp, id, claim.thread_id);
      if (result.changes !== 1) {
        throw new ApiError(409, "TASK_START_STATE_CHANGED", "Task start state changed before Codex finished");
      }
      this.#recordTaskActivity(current.id, actor, taskFieldChanges(current, { status }), timestamp);
      this.database.prepare("DELETE FROM task_ai_starts WHERE task_id = ? AND claim_token = ?")
        .run(id, claimToken);
      this.database.exec("COMMIT");
      return this.getTask(id);
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  latestTaskStatusChange(taskId, afterRowid = 0) {
    const task = this.#requireTask(taskId);
    const activities = this.database.prepare(`
      SELECT changes, created_at FROM task_activities
      WHERE task_id = ? AND rowid > ?
      ORDER BY rowid DESC
    `).all(task.id, afterRowid ?? 0);
    for (const activity of activities) {
      const change = JSON.parse(activity.changes).find((entry) => entry?.field === "status");
      if (change) return { createdAt: activity.created_at, ...change };
    }
    return null;
  }

  moveTask(id, version, status, sortOrder, threadId, actor) {
    const current = this.#requireTask(id);
    this.#requireVersion(current, version);
    if (current.status === "queued" && status === "in_progress") {
      throw new ApiError(
        409,
        "TASK_EXECUTION_PENDING",
        "Queued executions start automatically when their package slot is available",
      );
    }
    if (status === "queued" && !this.getFeishuTaskOrigin(id)) {
      throw new ApiError(409, "QUEUED_STATUS_RESERVED", "Queued status is reserved for server-managed executions");
    }
    if (current.archivedAt !== null) {
      throw new ApiError(409, "TASK_ARCHIVED", "Archived tasks cannot be moved");
    }
    if (status !== current.status && sortOrder === undefined) {
      const row = this.database.prepare(`
        SELECT MIN(sort_order) AS minimum
        FROM tasks
        WHERE project_id = ? AND status = ? AND archived_at IS NULL AND id != ?
      `).get(current.projectId, status, current.id);
      sortOrder = row.minimum === null ? 1000 : row.minimum - 1000;
    } else if (sortOrder === undefined) {
      const row = this.database.prepare(`
        SELECT COALESCE(MAX(sort_order), 0) AS maximum
        FROM tasks
        WHERE project_id = ? AND status = ? AND archived_at IS NULL AND id != ?
      `).get(current.projectId, status, current.id);
      sortOrder = row.maximum + 1000;
    }

    const timestamp = now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = this.database.prepare(`
        UPDATE tasks
        SET status = ?, sort_order = ?, thread_id = COALESCE(?, thread_id), version = version + 1, updated_at = ?
        WHERE id = ? AND version = ?
      `).run(status, sortOrder, threadId ?? null, timestamp, current.id, version);
      if (result.changes !== 1) {
        this.#throwMissingOrConflict(id, version);
      }
      this.#recordTaskActivity(
        current.id,
        actor,
        taskFieldChanges(current, { status }),
        timestamp,
      );
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.getTask(current.id);
  }

  archiveTask(id, version, threadId, actor) {
    const current = this.#requireTask(id);
    this.#requireVersion(current, version);
    const timestamp = now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = this.database.prepare(`
        UPDATE tasks
        SET archived_at = ?, thread_id = COALESCE(?, thread_id), version = version + 1, updated_at = ?
        WHERE id = ? AND version = ?
      `).run(timestamp, threadId ?? null, timestamp, current.id, version);
      if (result.changes !== 1) {
        this.#throwMissingOrConflict(id, version);
      }
      this.#recordTaskActivity(
        current.id,
        actor,
        [{ field: "archivedAt", before: current.archivedAt, after: timestamp }],
        timestamp,
      );
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.getTask(current.id);
  }

  restoreTask(id, version, threadId, actor) {
    const current = this.#requireTask(id);
    this.#requireVersion(current, version);
    if (current.archivedAt === null) {
      throw new ApiError(409, "TASK_NOT_ARCHIVED", "Only archived tasks can be restored");
    }
    const timestamp = now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = this.database.prepare(`
        UPDATE tasks
        SET archived_at = NULL, thread_id = COALESCE(?, thread_id), version = version + 1, updated_at = ?
        WHERE id = ? AND version = ?
      `).run(threadId ?? null, timestamp, current.id, version);
      if (result.changes !== 1) {
        this.#throwMissingOrConflict(id, version);
      }
      this.#recordTaskActivity(
        current.id,
        actor,
        [{ field: "archivedAt", before: current.archivedAt, after: null }],
        timestamp,
      );
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.getTask(current.id);
  }

  deleteArchivedTask(id, version) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const current = this.#requireTask(id);
      this.#requireVersion(current, version);
      if (current.archivedAt === null) {
        throw new ApiError(409, "TASK_NOT_ARCHIVED", "Only archived tasks can be deleted");
      }
      const activeUpload = this.database.prepare(`
        SELECT 1 FROM artifact_uploads
        WHERE task_id = ? AND status IN ('queued', 'uploading')
        LIMIT 1
      `).get(current.id);
      if (activeUpload) {
        throw new ApiError(
          409,
          "ARTIFACT_UPLOAD_ACTIVE",
          "The task cannot be deleted while a ZIP upload is queued or uploading",
        );
      }
      const attachmentIds = this.database.prepare(
        "SELECT id FROM attachments WHERE task_id = ? ORDER BY created_at, id",
      ).all(current.id).map((attachment) => attachment.id);
      const artifactStorageKeys = this.database.prepare(
        "SELECT storage_key FROM task_artifacts WHERE task_id = ? ORDER BY created_at, id",
      ).all(current.id).map((artifact) => artifact.storage_key);
      const result = this.database.prepare(
        "DELETE FROM tasks WHERE id = ? AND version = ? AND archived_at IS NOT NULL",
      ).run(current.id, version);
      if (result.changes !== 1) this.#throwMissingOrConflict(id, version);
      this.database.exec("COMMIT");
      return { task: current, attachmentIds, artifactStorageKeys };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  addTaskRelation(id, version, type, relatedId, threadId, actor) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const task = this.#requireTask(id);
      const relatedTask = this.#requireTask(relatedId);
      this.#requireVersion(task, version);
      this.#validateRelationTasks(task, relatedTask);

      const { relationType, sourceTaskId, targetTaskId } = this.#relationEndpoints(
        type,
        task.id,
        relatedTask.id,
      );
      if (relationType === "parent") {
        this.#assertNoParentCycle(task.id, relatedTask.id);
        const existing = this.database.prepare(`
          SELECT source_task_id
          FROM task_relations
          WHERE relation_type = 'parent' AND target_task_id = ?
        `).get(task.id);
        if (existing?.source_task_id === relatedTask.id) {
          throw new ApiError(409, "RELATION_EXISTS", "This parent relation already exists");
        }
        if (existing) {
          this.database.prepare(`
            DELETE FROM task_relations
            WHERE relation_type = 'parent' AND target_task_id = ?
          `).run(task.id);
        }
      } else {
        const existing = this.database.prepare(`
          SELECT 1
          FROM task_relations
          WHERE relation_type = ? AND source_task_id = ? AND target_task_id = ?
        `).get(relationType, sourceTaskId, targetTaskId);
        if (existing) {
          throw new ApiError(409, "RELATION_EXISTS", "This issue relation already exists");
        }
      }

      const timestamp = now();
      const previousRelation = type === "parent" && task.relations.parent
        ? relationActivityValue(type, task.relations.parent)
        : null;
      this.database.prepare(`
        INSERT INTO task_relations (
          relation_type, source_task_id, target_task_id, created_at
        ) VALUES (?, ?, ?, ?)
      `).run(relationType, sourceTaskId, targetTaskId, timestamp);
      this.#touchTask(task.id, version, threadId, timestamp);
      this.#recordTaskActivity(task.id, actor, [{
        field: "relation",
        before: previousRelation,
        after: relationActivityValue(type, relatedTask),
      }], timestamp);
      this.database.exec("COMMIT");
      return {
        task: this.getTask(task.id),
        relatedTask: this.getTask(relatedTask.id),
      };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  removeTaskRelation(id, version, type, relatedId, threadId, actor) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const task = this.#requireTask(id);
      const relatedTask = this.#requireTask(relatedId);
      this.#requireVersion(task, version);
      this.#validateRelationTasks(task, relatedTask);
      const { relationType, sourceTaskId, targetTaskId } = this.#relationEndpoints(
        type,
        task.id,
        relatedTask.id,
      );
      const removed = this.database.prepare(`
        DELETE FROM task_relations
        WHERE relation_type = ? AND source_task_id = ? AND target_task_id = ?
      `).run(relationType, sourceTaskId, targetTaskId);
      if (removed.changes !== 1) {
        throw new ApiError(404, "RELATION_NOT_FOUND", "This issue relation does not exist");
      }
      const timestamp = now();
      this.#touchTask(task.id, version, threadId, timestamp);
      this.#recordTaskActivity(task.id, actor, [{
        field: "relation",
        before: relationActivityValue(type, relatedTask),
        after: null,
      }], timestamp);
      this.database.exec("COMMIT");
      return {
        task: this.getTask(task.id),
        relatedTask: this.getTask(relatedTask.id),
      };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  listTaskActivities(taskId) {
    const task = this.#requireTask(taskId);
    return this.database.prepare(`
      SELECT * FROM task_activities
      WHERE task_id = ?
      ORDER BY rowid
    `).all(task.id).map(taskActivityFromRow);
  }

  listComments(taskId) {
    const task = this.#requireTask(taskId);
    return this.database.prepare(`
      SELECT * FROM comments
      WHERE task_id = ?
      ORDER BY created_at, id
    `).all(task.id).map((row) => this.#commentWithAttachments(row));
  }

  createComment(taskId, input) {
    const task = this.#requireTask(taskId);
    const id = randomUUID();
    const timestamp = now();
    this.database.prepare(`
      INSERT INTO comments (
        id, task_id, body, thread_id, author_type, author_id, author_name, author_avatar_url,
        version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    `).run(
      id,
      task.id,
      input.body,
      input.threadId ?? null,
      input.actor.type,
      input.actor.id,
      input.actor.name,
      input.actor.avatarUrl,
      timestamp,
      timestamp,
    );
    return this.getComment(id);
  }

  getComment(id) {
    const row = this.database.prepare("SELECT * FROM comments WHERE id = ?").get(id);
    return row ? this.#commentWithAttachments(row) : null;
  }

  updateComment(id, version, body, threadId) {
    const current = this.#requireComment(id);
    this.#requireCommentVersion(current, version);
    const result = this.database.prepare(`
      UPDATE comments
      SET body = ?, thread_id = COALESCE(?, thread_id), version = version + 1, updated_at = ?
      WHERE id = ? AND version = ?
    `).run(body, threadId ?? null, now(), id, version);
    if (result.changes !== 1) {
      this.#throwMissingCommentOrConflict(id, version);
    }
    return this.getComment(id);
  }

  deleteComment(id, version) {
    const current = this.#requireComment(id);
    this.#requireCommentVersion(current, version);
    const result = this.database.prepare(`
      DELETE FROM comments WHERE id = ? AND version = ?
    `).run(id, version);
    if (result.changes !== 1) {
      this.#throwMissingCommentOrConflict(id, version);
    }
    return current;
  }

  listAttachments(taskId) {
    const task = this.#requireTask(taskId);
    return this.database.prepare(`
      SELECT * FROM attachments
      WHERE task_id = ? AND comment_id IS NULL
      ORDER BY created_at, id
    `).all(task.id).map(attachmentFromRow);
  }

  createAttachment(taskId, input) {
    const task = this.#requireTask(taskId);
    this.database.prepare(`
      INSERT INTO attachments (id, task_id, comment_id, filename, content_type, size, created_at)
      VALUES (?, ?, NULL, ?, ?, ?, ?)
    `).run(input.id, task.id, input.filename, input.contentType, input.size, now());
    return this.getAttachment(input.id);
  }

  listCommentAttachments(commentId) {
    const comment = this.database.prepare("SELECT id FROM comments WHERE id = ?").get(commentId);
    if (!comment) {
      throw new ApiError(404, "COMMENT_NOT_FOUND", `Comment '${commentId}' does not exist`);
    }
    return this.#attachmentsForComment(commentId);
  }

  createCommentAttachment(commentId, input) {
    const comment = this.#requireComment(commentId);
    this.database.prepare(`
      INSERT INTO attachments (id, task_id, comment_id, filename, content_type, size, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(input.id, comment.taskId, comment.id, input.filename, input.contentType, input.size, now());
    return this.getAttachment(input.id);
  }

  getAttachment(id) {
    const row = this.database.prepare("SELECT * FROM attachments WHERE id = ?").get(id);
    return row ? attachmentFromRow(row) : null;
  }

  deleteAttachment(id) {
    const attachment = this.getAttachment(id);
    if (!attachment) {
      throw new ApiError(404, "ATTACHMENT_NOT_FOUND", `Attachment '${id}' does not exist`);
    }
    this.database.prepare("DELETE FROM attachments WHERE id = ?").run(id);
    return attachment;
  }

  listTaskArtifacts(taskId) {
    const task = this.#requireTask(taskId);
    return this.database.prepare(`
      SELECT * FROM task_artifacts
      WHERE task_id = ?
      ORDER BY created_at DESC, id DESC
    `).all(task.id).map(taskArtifactFromRow);
  }

  listTaskArtifactSummaryItems(projectId) {
    const rows = this.database.prepare(`
      SELECT
        task_artifacts.id,
        task_artifacts.task_id,
        task_artifacts.filename,
        task_artifacts.validation_status,
        task_artifacts.created_at,
        task_artifacts.updated_at,
        tasks.description AS task_description,
        tasks.labels AS task_labels,
        feishu_task_origins.metadata_json AS origin_metadata_json
      FROM task_artifacts
      JOIN tasks ON tasks.id = task_artifacts.task_id
      LEFT JOIN feishu_task_origins ON feishu_task_origins.task_id = tasks.id
      WHERE tasks.project_id = ?
      ORDER BY task_artifacts.updated_at DESC, task_artifacts.id DESC
    `).all(projectId);
    return rows.flatMap((row) => {
      let origin = null;
      try {
        if (row.origin_metadata_json) {
          origin = {
            taskId: row.task_id,
            ...normalizeFeishuTaskOrigin(JSON.parse(row.origin_metadata_json)),
          };
        }
      } catch {}
      return [{
        summary: taskArtifactSummaryFromRow(row),
        task: {
          id: row.task_id,
          description: row.task_description,
          labels: JSON.parse(row.task_labels),
        },
        origin,
      }];
    });
  }

  getTaskArtifact(id) {
    const row = this.database.prepare("SELECT * FROM task_artifacts WHERE id = ?").get(id);
    return row ? taskArtifactFromRow(row) : null;
  }

  getTaskArtifactForWork(id) {
    const row = this.database.prepare("SELECT * FROM task_artifacts WHERE id = ?").get(id);
    return row ? taskArtifactWorkFromRow(row) : null;
  }

  createTaskArtifact(taskId, input) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const task = this.#requireTask(taskId);
      const acceptedStatuses = [input.requiredTaskStatus, input.completedTaskStatus].filter(Boolean);
      if (acceptedStatuses.length > 0 && !acceptedStatuses.includes(task.status)) {
        throw new ApiError(
          409,
          "TASK_NOT_ARTIFACT_READY",
          `This task accepts artifacts only while it is ${acceptedStatuses.join(" or ")}`,
        );
      }
      const existing = this.database.prepare(`
        SELECT * FROM task_artifacts
        WHERE task_id = ? AND filename = ? AND sha256 = ?
        ORDER BY created_at, id
        LIMIT 1
      `).get(task.id, input.filename, input.sha256);
      if (!existing) {
        this.database.prepare(`
          INSERT INTO task_artifacts (
            id, task_id, storage_key, filename, content_type, size, sha256, source_mode,
            validation_status, entry_count, draft_root, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          input.id,
          task.id,
          input.storageKey,
          input.filename,
          input.contentType,
          input.size,
          input.sha256,
          input.sourceMode,
          input.validationStatus,
          input.entryCount,
          input.draftRoot,
          input.createdAt,
          input.updatedAt,
        );
      }
      if (
        input.completedTaskStatus
        && input.requiredTaskStatus
        && task.status === input.requiredTaskStatus
        && task.status !== input.completedTaskStatus
      ) {
        const timestamp = now();
        const result = this.database.prepare(`
          UPDATE tasks SET status = ?, version = version + 1, updated_at = ?
          WHERE id = ? AND status = ?
        `).run(input.completedTaskStatus, timestamp, task.id, input.requiredTaskStatus);
        if (result.changes !== 1) {
          throw new ApiError(409, "TASK_NOT_ARTIFACT_READY", "Task status changed while storing the ZIP artifact");
        }
        this.#recordTaskActivity(
          task.id,
          input.actor,
          taskFieldChanges(task, { status: input.completedTaskStatus }),
          timestamp,
        );
      }
      this.database.exec("COMMIT");
      return this.getTaskArtifact(existing?.id ?? input.id);
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  deleteTaskArtifact(id) {
    const artifact = this.getTaskArtifact(id);
    if (!artifact) {
      throw new ApiError(404, "ARTIFACT_NOT_FOUND", `Artifact '${id}' does not exist`);
    }
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const activeUpload = this.database.prepare(`
        SELECT 1 FROM artifact_uploads
        WHERE artifact_id = ? AND status IN ('queued', 'uploading')
        LIMIT 1
      `).get(artifact.id);
      if (activeUpload) {
        throw new ApiError(
          409,
          "ARTIFACT_UPLOAD_ACTIVE",
          "The ZIP cannot be deleted while it is queued or uploading",
        );
      }
      this.database.prepare("DELETE FROM task_artifacts WHERE id = ?").run(artifact.id);
      this.database.exec("COMMIT");
      return artifact;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  getFeishuSubjectUploadTarget(projectId) {
    const row = this.database.prepare(`
      SELECT subject_key, config_json
      FROM feishu_subjects
      WHERE project_id = ?
    `).get(projectId);
    return this.#subjectUploadTargetFromRow(row);
  }

  getFeishuSubjectUploadTargetByOrigin(baseToken, tableId) {
    const row = this.database.prepare(`
      SELECT subject_key, config_json
      FROM feishu_subjects
      WHERE base_token = ? AND table_id = ?
    `).get(baseToken, tableId);
    return this.#subjectUploadTargetFromRow(row);
  }

  getFeishuSubjectUploadTargetByVersion(subjectKey, configVersion) {
    const row = this.database.prepare(`
      SELECT subject_key, snapshot_json AS config_json
      FROM feishu_subject_versions
      WHERE subject_key = ? AND version = ?
    `).get(subjectKey, configVersion);
    return this.#subjectUploadTargetFromRow(row);
  }

  #subjectUploadTargetFromRow(row) {
    if (!row) return null;
    let config;
    try {
      config = JSON.parse(row.config_json);
    } catch {
      throw new ApiError(409, "TASK_UPLOAD_NOT_CONFIGURED", "The subject upload configuration is invalid");
    }
    const upload = config?.upload;
    const targetPath = typeof upload?.targetPath === "string" ? upload.targetPath.trim() : "";
    return {
      subjectKey: row.subject_key,
      enqueueMode: upload?.enqueueMode === "automatic" ? "automatic" : "manual",
      targetId: typeof upload?.targetId === "string" && upload.targetId.trim()
        ? upload.targetId.trim()
        : null,
      targetPath: targetPath || null,
      uploadConcurrency: Number.isSafeInteger(upload?.uploadConcurrency)
        ? upload.uploadConcurrency
        : null,
    };
  }

  listTaskArtifactUploads(taskId) {
    const task = this.#requireTask(taskId);
    return this.database.prepare(`
      SELECT * FROM artifact_uploads
      WHERE task_id = ?
      ORDER BY created_at DESC, id DESC
    `).all(task.id).map(artifactUploadFromRow);
  }

  listArtifactUploadItems(projectId) {
    const rows = this.database.prepare(`
      SELECT artifact_uploads.*
      FROM artifact_uploads
      JOIN tasks ON tasks.id = artifact_uploads.task_id
      WHERE tasks.project_id = ?
      ORDER BY artifact_uploads.updated_at DESC, artifact_uploads.id DESC
    `).all(projectId);
    return rows.flatMap((row) => {
      const task = this.getTask(row.task_id);
      return task ? [{ upload: artifactUploadFromRow(row), task }] : [];
    });
  }

  getArtifactUpload(id) {
    const row = this.database.prepare("SELECT * FROM artifact_uploads WHERE id = ?").get(id);
    return row ? artifactUploadFromRow(row) : null;
  }

  createArtifactUpload(input) {
    const timestamp = now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.database.prepare(`
        SELECT * FROM artifact_uploads
        WHERE artifact_id = ? AND target_path = ?
      `).get(input.artifactId, input.targetPath);
      if (existing) {
        this.database.exec("COMMIT");
        return artifactUploadFromRow(existing);
      }
      const uploadConcurrency = input.uploadConcurrency;
      if (!Number.isSafeInteger(uploadConcurrency) || uploadConcurrency < 1) {
        throw new ApiError(409, "TASK_UPLOAD_NOT_CONFIGURED", "The subject upload concurrency is invalid");
      }
      const id = randomUUID();
      this.database.prepare(`
        INSERT INTO artifact_uploads (
          id, task_id, artifact_id, subject_key, storage_key, target_id, target_path,
          filename, sha256, status, attempt_count, error_code, error_message, upload_concurrency,
          created_at, started_at, completed_at, updated_at, claim_token, lease_until
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, NULL, NULL, ?, ?, NULL, NULL, ?, NULL, NULL)
      `).run(
        id,
        input.taskId,
        input.artifactId,
        input.subjectKey,
        input.storageKey,
        input.targetId,
        input.targetPath,
        input.filename,
        input.sha256,
        uploadConcurrency,
        timestamp,
        timestamp,
      );
      const row = this.database.prepare("SELECT * FROM artifact_uploads WHERE id = ?").get(id);
      this.database.exec("COMMIT");
      return artifactUploadFromRow(row);
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  claimNextArtifactUpload(leaseMs = ARTIFACT_UPLOAD_LEASE_DURATION_MS) {
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > ARTIFACT_UPLOAD_MAX_FUTURE_MS) {
      throw new TypeError("artifact upload lease duration is invalid");
    }
    const timestamp = now();
    const leaseUntil = new Date(Date.now() + leaseMs).toISOString();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.database.prepare(`
        SELECT queued.* FROM artifact_uploads AS queued
        WHERE queued.status = 'queued'
          AND (
            SELECT COUNT(*) FROM artifact_uploads AS active
            WHERE active.subject_key = queued.subject_key
              AND active.status = 'uploading'
          ) < queued.upload_concurrency
        ORDER BY queued.created_at, queued.id
        LIMIT 1
      `).get();
      if (!row) {
        this.database.exec("COMMIT");
        return null;
      }
      const claimToken = randomUUID();
      const result = this.database.prepare(`
        UPDATE artifact_uploads
        SET status = 'uploading', attempt_count = attempt_count + 1,
            error_code = NULL, error_message = NULL, started_at = ?, completed_at = NULL,
            updated_at = ?, claim_token = ?, lease_until = ?
        WHERE id = ? AND status = 'queued'
      `).run(timestamp, timestamp, claimToken, leaseUntil, row.id);
      if (result.changes !== 1) {
        this.database.exec("COMMIT");
        return null;
      }
      const claimed = this.database.prepare("SELECT * FROM artifact_uploads WHERE id = ?").get(row.id);
      this.database.exec("COMMIT");
      return artifactUploadWorkFromRow(claimed);
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  renewArtifactUploadLease(id, claimToken, leaseMs = ARTIFACT_UPLOAD_LEASE_DURATION_MS) {
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > ARTIFACT_UPLOAD_MAX_FUTURE_MS) {
      throw new TypeError("artifact upload lease duration is invalid");
    }
    const timestamp = now();
    const leaseUntil = new Date(Date.now() + leaseMs).toISOString();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = this.database.prepare(`
        UPDATE artifact_uploads
        SET lease_until = ?, updated_at = ?
        WHERE id = ? AND status = 'uploading' AND claim_token = ?
      `).run(leaseUntil, timestamp, id, claimToken);
      if (result.changes !== 1) {
        this.database.exec("COMMIT");
        return null;
      }
      const renewed = this.database.prepare("SELECT * FROM artifact_uploads WHERE id = ?").get(id);
      this.database.exec("COMMIT");
      return artifactUploadWorkFromRow(renewed);
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  markArtifactUploadUploaded(id, claimToken, validateTask = null) {
    const timestamp = now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const current = this.database.prepare(`
        SELECT * FROM artifact_uploads
        WHERE id = ? AND status = 'uploading' AND claim_token = ?
      `).get(id, claimToken);
      if (!current) {
        this.database.exec("COMMIT");
        return null;
      }
      if (typeof validateTask === "function") {
        const task = this.getTask(current.task_id);
        const origin = this.getFeishuTaskOrigin(current.task_id);
        if (!validateTask(task, origin)) {
          this.database.prepare(`
            UPDATE artifact_uploads
            SET status = 'failed', error_code = 'TASK_PROVENANCE_CHANGED',
                error_message = 'The task is no longer an eligible Feishu Auto-Cut task',
                completed_at = ?, updated_at = ?, claim_token = NULL, lease_until = NULL
            WHERE id = ? AND status = 'uploading' AND claim_token = ?
          `).run(timestamp, timestamp, id, claimToken);
          const failed = this.database.prepare("SELECT * FROM artifact_uploads WHERE id = ?").get(id);
          this.database.exec("COMMIT");
          return artifactUploadFromRow(failed);
        }
      }
      const result = this.database.prepare(`
        UPDATE artifact_uploads
        SET status = 'uploaded', error_code = NULL, error_message = NULL,
            completed_at = ?, updated_at = ?, claim_token = NULL, lease_until = NULL
        WHERE id = ? AND status = 'uploading' AND claim_token = ?
      `).run(timestamp, timestamp, id, claimToken);
      const uploaded = result.changes === 1
        ? this.database.prepare("SELECT * FROM artifact_uploads WHERE id = ?").get(id)
        : null;
      this.database.exec("COMMIT");
      return uploaded ? artifactUploadFromRow(uploaded) : null;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  markArtifactUploadFailed(id, claimToken, { code, message }) {
    const timestamp = now();
    const result = this.database.prepare(`
      UPDATE artifact_uploads
      SET status = 'failed', error_code = ?, error_message = ?, completed_at = ?, updated_at = ?,
          claim_token = NULL, lease_until = NULL
      WHERE id = ? AND status = 'uploading' AND claim_token = ?
    `).run(code, message, timestamp, timestamp, id, claimToken);
    if (result.changes !== 1) return null;
    return this.getArtifactUpload(id);
  }

  retryArtifactUpload(id) {
    const timestamp = now();
    const result = this.database.prepare(`
      UPDATE artifact_uploads
      SET status = 'queued', error_code = NULL, error_message = NULL,
          started_at = NULL, completed_at = NULL, updated_at = ?, claim_token = NULL, lease_until = NULL
      WHERE id = ? AND status = 'failed'
    `).run(timestamp, id);
    if (result.changes !== 1) return null;
    return this.getArtifactUpload(id);
  }

  getNextArtifactUploadLeaseExpiry(excludedIds = []) {
    const ids = [...new Set(excludedIds)];
    const exclusion = ids.length > 0
      ? `AND id NOT IN (${ids.map(() => "?").join(", ")})`
      : "";
    const rows = this.database.prepare(`
      SELECT lease_until FROM artifact_uploads
      WHERE status = 'uploading' AND lease_until IS NOT NULL
        ${exclusion}
    `).all(...ids);
    let earliest = null;
    let earliestMs = Number.POSITIVE_INFINITY;
    for (const row of rows) {
      const leaseUntilMs = parseArtifactUploadTimestamp(row.lease_until);
      if (leaseUntilMs !== null && leaseUntilMs < earliestMs) {
        earliest = row.lease_until;
        earliestMs = leaseUntilMs;
      }
    }
    return earliest;
  }

  recoverUploadingArtifactUploads(excludedIds = []) {
    const timestampMs = Date.now();
    const timestamp = new Date(timestampMs).toISOString();
    const ids = [...new Set(excludedIds)];
    const exclusion = ids.length > 0
      ? `AND id NOT IN (${ids.map(() => "?").join(", ")})`
      : "";
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const rows = this.database.prepare(`
        SELECT id, started_at, claim_token, lease_until
        FROM artifact_uploads
        WHERE status = 'uploading' ${exclusion}
      `).all(...ids);
      const recoverableIds = rows
        .filter((row) => artifactUploadLeaseNeedsRecovery({
          startedAt: row.started_at,
          claimToken: row.claim_token,
          leaseUntil: row.lease_until,
        }, timestampMs))
        .map((row) => row.id);
      let changes = 0;
      if (recoverableIds.length > 0) {
        changes = this.database.prepare(`
          UPDATE artifact_uploads
          SET status = 'queued', error_code = NULL, error_message = NULL,
              started_at = NULL, completed_at = NULL, updated_at = ?, claim_token = NULL, lease_until = NULL
          WHERE status = 'uploading'
            AND id IN (${recoverableIds.map(() => "?").join(", ")})
        `).run(timestamp, ...recoverableIds).changes;
      }
      this.database.exec("COMMIT");
      return changes;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  #commentWithAttachments(row) {
    const comment = commentFromRow(row);
    comment.attachments = this.#attachmentsForComment(comment.id);
    return comment;
  }

  #aiChatThreadWithCurrentRun(row) {
    const thread = aiChatThreadFromRow(row);
    const currentRun = this.database.prepare(`
      SELECT * FROM ai_chat_runs
      WHERE thread_id = ? AND status = 'running'
      ORDER BY started_at DESC, id DESC
      LIMIT 1
    `).get(thread.id);
    thread.currentRun = currentRun ? aiChatRunFromRow(currentRun) : null;
    const todoRows = this.database.prepare(`
      SELECT id, thread_id, run_id, data, created_at
      FROM ai_chat_events
      WHERE thread_id = ? AND type = 'todo_list'
      ORDER BY created_at DESC, rowid DESC
    `).all(thread.id);
    thread.latestTodo = todoRows
      .filter((row) => !thread.currentRun || row.run_id === thread.currentRun.id)
      .map(parseAiChatTodoProgress)
      .find(Boolean) ?? null;
    return thread;
  }

  #commentsForTaskActivity(taskIds) {
    const commentsByTask = new Map(taskIds.map((taskId) => [taskId, []]));
    for (let offset = 0; offset < taskIds.length; offset += 400) {
      const chunk = taskIds.slice(offset, offset + 400);
      if (chunk.length === 0) continue;
      const placeholders = chunk.map(() => "?").join(", ");
      const rows = this.database.prepare(`
        SELECT
          id, task_id,
          CASE WHEN thread_id IS NULL THEN NULL ELSE substr(body, 1, 512) END AS body,
          thread_id, author_type, author_id, author_name,
          author_avatar_url, version, updated_at
        FROM comments
        WHERE task_id IN (${placeholders})
        ORDER BY task_id, id
      `).all(...chunk);
      for (const row of rows) commentsByTask.get(row.task_id)?.push(row);
    }
    return commentsByTask;
  }

  #activitiesForTasks(taskIds) {
    const activitiesByTask = new Map(taskIds.map((taskId) => [taskId, []]));
    for (let offset = 0; offset < taskIds.length; offset += 400) {
      const chunk = taskIds.slice(offset, offset + 400);
      if (chunk.length === 0) continue;
      const placeholders = chunk.map(() => "?").join(", ");
      const rows = this.database.prepare(`
        SELECT
          id, task_id, actor_type, actor_id, actor_name, actor_avatar_url, created_at
        FROM task_activities
        WHERE task_id IN (${placeholders})
        ORDER BY task_id, created_at, id
      `).all(...chunk);
      for (const row of rows) activitiesByTask.get(row.task_id)?.push(row);
    }
    return activitiesByTask;
  }

  #taskPreviewImages(taskIds) {
    const imagesByTask = new Map();
    for (let offset = 0; offset < taskIds.length; offset += 400) {
      const chunk = taskIds.slice(offset, offset + 400);
      if (chunk.length === 0) continue;
      const placeholders = chunk.map(() => "?").join(", ");
      const rows = this.database.prepare(`
        SELECT * FROM attachments
        WHERE task_id IN (${placeholders})
          AND comment_id IS NULL
          AND content_type LIKE 'image/%'
        ORDER BY task_id, created_at, id
      `).all(...chunk);
      for (const row of rows) {
        if (!imagesByTask.has(row.task_id)) imagesByTask.set(row.task_id, attachmentFromRow(row));
      }
    }
    return imagesByTask;
  }

  #attachmentsForComment(commentId) {
    return this.database.prepare(`
      SELECT * FROM attachments
      WHERE comment_id = ?
      ORDER BY created_at, id
    `).all(commentId).map(attachmentFromRow);
  }

  #taskWithRelations(row) {
    const task = taskFromRow(row);
    const parent = this.database.prepare(`
      SELECT tasks.*
      FROM task_relations
      JOIN tasks ON tasks.id = task_relations.source_task_id
      WHERE task_relations.relation_type = 'parent'
        AND task_relations.target_task_id = ?
    `).get(task.id);
    const subIssues = this.database.prepare(`
      SELECT tasks.*
      FROM task_relations
      JOIN tasks ON tasks.id = task_relations.target_task_id
      WHERE task_relations.relation_type = 'parent'
        AND task_relations.source_task_id = ?
      ORDER BY tasks.sort_order, tasks.created_at, tasks.id
    `).all(task.id);
    const blockedBy = this.database.prepare(`
      SELECT tasks.*
      FROM task_relations
      JOIN tasks ON tasks.id = task_relations.source_task_id
      WHERE task_relations.relation_type = 'blocks'
        AND task_relations.target_task_id = ?
      ORDER BY tasks.sort_order, tasks.created_at, tasks.id
    `).all(task.id);
    const blocks = this.database.prepare(`
      SELECT tasks.*
      FROM task_relations
      JOIN tasks ON tasks.id = task_relations.target_task_id
      WHERE task_relations.relation_type = 'blocks'
        AND task_relations.source_task_id = ?
      ORDER BY tasks.sort_order, tasks.created_at, tasks.id
    `).all(task.id);
    const related = this.database.prepare(`
      SELECT tasks.*
      FROM task_relations
      JOIN tasks ON tasks.id = CASE
        WHEN task_relations.source_task_id = ? THEN task_relations.target_task_id
        ELSE task_relations.source_task_id
      END
      WHERE task_relations.relation_type = 'related'
        AND (
          task_relations.source_task_id = ?
          OR task_relations.target_task_id = ?
        )
      ORDER BY tasks.sort_order, tasks.created_at, tasks.id
    `).all(task.id, task.id, task.id);
    task.relations = {
      parent: parent ? taskRelationSummaryFromRow(parent) : null,
      subIssues: subIssues.map(taskRelationSummaryFromRow),
      blockedBy: blockedBy.map(taskRelationSummaryFromRow),
      blocks: blocks.map(taskRelationSummaryFromRow),
      related: related.map(taskRelationSummaryFromRow),
    };
    return task;
  }

  #validateRelationTasks(task, relatedTask) {
    if (task.id === relatedTask.id) {
      throw new ApiError(400, "SELF_RELATION", "An issue cannot be related to itself");
    }
    if (task.projectId !== relatedTask.projectId) {
      throw new ApiError(400, "CROSS_PROJECT_RELATION", "Issue relations must stay within one project");
    }
  }

  #relationEndpoints(type, taskId, relatedTaskId) {
    if (type === "parent") {
      return {
        relationType: "parent",
        sourceTaskId: relatedTaskId,
        targetTaskId: taskId,
      };
    }
    if (type === "blocks") {
      return {
        relationType: "blocks",
        sourceTaskId: taskId,
        targetTaskId: relatedTaskId,
      };
    }
    if (type === "blocked_by") {
      return {
        relationType: "blocks",
        sourceTaskId: relatedTaskId,
        targetTaskId: taskId,
      };
    }
    const [sourceTaskId, targetTaskId] = [taskId, relatedTaskId].sort();
    return { relationType: "related", sourceTaskId, targetTaskId };
  }

  #assertNoParentCycle(childId, parentId) {
    const cycle = this.database.prepare(`
      WITH RECURSIVE ancestors(id) AS (
        SELECT source_task_id
        FROM task_relations
        WHERE relation_type = 'parent' AND target_task_id = ?
        UNION
        SELECT task_relations.source_task_id
        FROM task_relations
        JOIN ancestors ON task_relations.target_task_id = ancestors.id
        WHERE task_relations.relation_type = 'parent'
      )
      SELECT 1 FROM ancestors WHERE id = ?
    `).get(parentId, childId);
    if (cycle) {
      throw new ApiError(409, "RELATION_CYCLE", "This parent would create a cycle");
    }
  }

  #recordTaskActivity(taskId, actor, changes, timestamp) {
    if (changes.length === 0) return;
    this.database.prepare(`
      INSERT INTO task_activities (
        id, task_id, actor_type, actor_id, actor_name, actor_avatar_url, changes, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(),
      taskId,
      actor.type,
      actor.id,
      actor.name,
      actor.avatarUrl,
      JSON.stringify(changes),
      timestamp,
    );
  }

  #touchTask(id, version, threadId, timestamp) {
    const result = this.database.prepare(`
      UPDATE tasks
      SET thread_id = COALESCE(?, thread_id), version = version + 1, updated_at = ?
      WHERE id = ? AND version = ?
    `).run(threadId ?? null, timestamp, id, version);
    if (result.changes !== 1) {
      this.#throwMissingOrConflict(id, version);
    }
  }

  #requireTask(id) {
    const task = this.getTask(id);
    if (!task) {
      throw new ApiError(404, "TASK_NOT_FOUND", `Task '${id}' does not exist`);
    }
    return task;
  }

  #requireComment(id) {
    const comment = this.getComment(id);
    if (!comment) {
      throw new ApiError(404, "COMMENT_NOT_FOUND", `Comment '${id}' does not exist`);
    }
    return comment;
  }

  #requireVersion(task, expectedVersion) {
    if (task.version !== expectedVersion) {
      throw new ApiError(409, "VERSION_CONFLICT", "Task was changed by another client", {
        expectedVersion,
        actualVersion: task.version,
      });
    }
  }

  #requireCommentVersion(comment, expectedVersion) {
    if (comment.version !== expectedVersion) {
      throw new ApiError(409, "VERSION_CONFLICT", "Comment was changed by another client", {
        expectedVersion,
        actualVersion: comment.version,
      });
    }
  }

  #throwMissingOrConflict(id, expectedVersion) {
    const task = this.getTask(id);
    if (!task) {
      throw new ApiError(404, "TASK_NOT_FOUND", `Task '${id}' does not exist`);
    }
    throw new ApiError(409, "VERSION_CONFLICT", "Task was changed by another client", {
      expectedVersion,
      actualVersion: task.version,
    });
  }

  #throwMissingCommentOrConflict(id, expectedVersion) {
    const comment = this.getComment(id);
    if (!comment) {
      throw new ApiError(404, "COMMENT_NOT_FOUND", `Comment '${id}' does not exist`);
    }
    throw new ApiError(409, "VERSION_CONFLICT", "Comment was changed by another client", {
      expectedVersion,
      actualVersion: comment.version,
    });
  }
}
