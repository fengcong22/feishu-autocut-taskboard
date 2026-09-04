import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type {
  CSSProperties,
  DragEvent,
  PointerEvent as ReactPointerEvent,
  Ref,
} from "react";
import type {
  ActorIdentity,
  ArtifactUpload,
  ArtifactUploadListItem,
  StageDisplayOverride,
  Task,
  TaskArtifactSummary,
  TaskDraft,
  TaskStatus,
} from "../types";
import {
  EMPTY_TASK_FILTERS,
  matchesTaskFilters,
  matchesTaskSearch,
  type TaskFilters,
} from "../taskFilters";
import type {
  TaskCardPresentation,
  TaskConversationItem,
} from "../taskConversations";
import { useTaskboardI18n } from "../i18n";
import { LinearIcon, type LinearIconName } from "./LinearIcon";
import { TaskCard } from "./TaskCard";
// The drop helpers are runtime-independent so they can be shared with focused node tests.
// @ts-expect-error The helper's structural contract is covered by node tests.
import { canDropUnifiedWorkflowTask, hasUnifiedWorkflowDragType } from "../unifiedWorkflowDropGuard.mjs";
// The classifier is intentionally kept in ESM JavaScript so node:test can use it directly.
// @ts-expect-error The helper has no runtime-dependent TypeScript surface.
import { groupUnifiedWorkflowItems, matchesUnifiedWorkflowMetadataSearch, projectUnifiedWorkflowGroups, summarizeHiddenUnifiedWorkflow, summarizeUnifiedWorkflowArtifacts, unifiedWorkflowZipEntries } from "../unifiedWorkflow.mjs";
// Layout state is deliberately browser-only and kept in a runtime-independent module.
// @ts-expect-error The helper's structural contract is covered by node tests.
import { columnWidthPx, normalizeUnifiedWorkflowLayout, readUnifiedWorkflowLayout, resetUnifiedWorkflowLayout, unifiedWorkflowLayoutStorageKey, unifiedWorkflowZipExpansionKey, writeUnifiedWorkflowLayout } from "../unifiedWorkflowLayout.mjs";

export type UnifiedWorkflowStage =
  | "todo"
  | "queued"
  | "in_progress"
  | "in_review"
  | "completed_editing"
  | "upload_queue"
  | "uploading"
  | "uploaded"
  | "blocked";

interface UnifiedWorkflowItem {
  task: Task;
  uploads: ArtifactUpload[];
  artifacts: TaskArtifactSummary[];
  stage: UnifiedWorkflowStage;
}

interface UnifiedWorkflowZipEntry {
  identity: string;
  artifact: TaskArtifactSummary | null;
  upload: ArtifactUpload | null;
}

interface UnifiedWorkflowColumnDefinition {
  id: UnifiedWorkflowStage;
  label: string;
  englishLabel: string;
  icon: LinearIconName;
  taskStatus?: TaskStatus;
  upload: boolean;
  displayLabel?: string;
  displayDescription?: string;
  description: string;
  englishDescription: string;
}

const COLUMN_DEFINITIONS: readonly UnifiedWorkflowColumnDefinition[] = [
  { id: "todo", label: "待处理", englishLabel: "Ready", description: "任务已进入 Taskboard，等待开始处理。", englishDescription: "The task is ready to start.", icon: "statusTodo", taskStatus: "todo", upload: false },
  { id: "queued", label: "排队中", englishLabel: "Queued", description: "任务正在等待可用的 Auto-Cut 执行名额。", englishDescription: "The task is waiting for an available Auto-Cut slot.", icon: "statusStarted", taskStatus: "queued", upload: false },
  { id: "in_progress", label: "处理中", englishLabel: "Processing", description: "Auto-Cut/Codex 正在执行剪辑。", englishDescription: "Auto-Cut/Codex is editing the task.", icon: "statusStarted", taskStatus: "in_progress", upload: false },
  { id: "blocked", label: "阻塞", englishLabel: "Blocked", description: "任务需要处理错误或补充信息后才能继续。", englishDescription: "The task needs an error resolved or more information before it can continue.", icon: "alert", taskStatus: "blocked", upload: false },
  { id: "in_review", label: "待验收", englishLabel: "Review", description: "手动模式的剪辑结果正在等待确认。", englishDescription: "A manual editing result is waiting for confirmation.", icon: "statusStarted", taskStatus: "in_review", upload: false },
  { id: "completed_editing", label: "已完成剪辑", englishLabel: "Editing complete", description: "剪辑已完成，剪映草稿 ZIP 可以加入上传队列。", englishDescription: "Editing is complete and the draft ZIP can be queued for upload.", icon: "statusDone", upload: true },
  { id: "upload_queue", label: "上传队列", englishLabel: "Upload queue", description: "剪映草稿 ZIP 正在等待上传。", englishDescription: "The draft ZIP is waiting to upload.", icon: "file", upload: true },
  { id: "uploading", label: "上传中", englishLabel: "Uploading", description: "正在把剪映草稿 ZIP 复制到目标位置。", englishDescription: "The draft ZIP is being copied to its destination.", icon: "play", upload: true },
  { id: "uploaded", label: "已上传", englishLabel: "Uploaded", description: "剪映草稿 ZIP 已成功复制到目标位置。", englishDescription: "The draft ZIP was copied to its destination.", icon: "check", upload: true },
];

const REAL_TASK_STAGES = new Set<UnifiedWorkflowStage>([
  "todo",
  "queued",
  "in_progress",
  "in_review",
  "blocked",
]);

const EMPTY_PRESENTATION: TaskCardPresentation = {
  conversations: [],
  processing: {
    running: false,
    completed: null,
    total: null,
    startedAt: null,
  },
  unread: false,
};

const EMPTY_RETRYING_UPLOAD_IDS: ReadonlySet<string> = new Set();
const PAN_THRESHOLD_PX = 6;
const EDGE_AUTO_SCROLL_ZONE_PX = 48;
const EDGE_AUTO_SCROLL_STEP_PX = 20;
const LAYOUT_WRITE_DELAY_MS = 120;

const UPLOAD_ERROR_MESSAGES: Record<string, readonly [string, string]> = {
  TARGET_FILE_CONFLICT: ["目标位置已有不同文件，请检查文件名", "A different file already exists at the destination"],
  ARTIFACT_HASH_MISMATCH: ["ZIP 校验值已变化，请重新选择文件", "The ZIP checksum changed; select the file again"],
  INVALID_ARTIFACT_FILENAME: ["ZIP 文件名无效，请重新选择文件", "The ZIP filename is invalid; select the file again"],
  TARGET_PATH_INVALID: ["上传目标不可用，请检查上传配置", "The upload destination is invalid; check the upload configuration"],
  TARGET_DIRECTORY_UNAVAILABLE: ["上传目标目录不可用，请检查路径或连接", "The upload destination is unavailable; check the path or connection"],
  ARTIFACT_CONTENT_MISSING: ["已找不到 ZIP 文件，请重新选择并上传", "The ZIP is no longer available; select and upload it again"],
  UPLOAD_COPY_FAILED: ["复制 ZIP 失败，请稍后重试", "The ZIP could not be copied; try again later"],
  TASK_PROVENANCE_CHANGED: ["任务配置已变化，请重新确认后再上传", "The task configuration changed; confirm it before uploading again"],
};

export interface UnifiedWorkflowBoardProps {
  projectId: string;
  subjectKey: string;
  viewId: string;
  tasks: Task[];
  uploadItems: ArtifactUploadListItem[];
  artifactSummaries: TaskArtifactSummary[];
  presentations: Record<string, TaskCardPresentation>;
  now: number;
  loading: boolean;
  uploadLoading: boolean;
  uploadError: string | null;
  hasActiveFilters: boolean;
  filters?: TaskFilters;
  availableLabels: string[];
  currentUser: ActorIdentity;
  draggedTaskId: string | null;
  draggedTaskHeight: number;
  movingTaskId: string | null;
  settlingTaskId: string | null;
  contextMenuTaskId: string | null;
  dropTarget: TaskStatus | null;
  search?: string;
  stageIds?: UnifiedWorkflowStage[];
  stageDisplays?: StageDisplayOverride[];
  searchScope?: "activeView" | "allStages";
  onOpenTask: (task: Task, stage: UnifiedWorkflowStage) => void;
  onUpdate: (task: Task, changes: Partial<TaskDraft>) => Promise<Task>;
  onComplete: (task: Task) => void;
  onContextMenu: (task: Task, position: { x: number; y: number }) => void;
  onDragStart: (task: Task, height: number) => void;
  onDragEnd: () => void;
  onDragEnter: (status: TaskStatus) => void;
  onDrop: (status: TaskStatus, taskId: string, beforeTaskId: string | null, sourceSurface?: "board" | "other-tasks-panel" | "unified-board") => void;
  onOpenConversation: (conversation: TaskConversationItem) => void;
  onRetryUpload: (item: ArtifactUploadListItem) => void;
  retryingUploadIds?: ReadonlySet<string>;
  onColumnScrollRef?: (stage: UnifiedWorkflowStage, element: HTMLDivElement | null) => void;
  onBoardScrollRef?: Ref<HTMLDivElement>;
}

function uploadErrorLabel(
  errorCode: string | null | undefined,
  text: (chinese: string, english: string) => string,
) {
  const [chinese, english] = UPLOAD_ERROR_MESSAGES[errorCode ?? ""] ?? [
    "上传失败，请检查配置后重试",
    "Upload failed; check the configuration and try again",
  ];
  return text(chinese, english);
}

function statusColor(stage: UnifiedWorkflowStage) {
  if (stage === "in_progress" || stage === "uploading") return "progress";
  if (stage === "in_review" || stage === "uploaded") return "review";
  if (stage === "blocked") return "blocked";
  if (stage === "completed_editing") return "done";
  return "todo";
}

function formatUploadStatus(
  status: ArtifactUpload["status"],
  text: (chinese: string, english: string) => string,
) {
  return {
    queued: text("排队中", "Queued"),
    uploading: text("上传中", "Uploading"),
    uploaded: text("已上传", "Uploaded"),
    failed: text("失败", "Failed"),
  }[status];
}

function uploadTimestamp(upload: ArtifactUpload) {
  if (upload.status === "uploaded") return upload.completedAt ?? upload.updatedAt;
  if (upload.status === "uploading") return upload.startedAt ?? upload.updatedAt;
  return upload.updatedAt || upload.createdAt;
}

function formatTimestamp(value: string, locale: string) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) return value;
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(parsed);
}

function TaskExecutionSummary({ task }: { task: Task }) {
  const { locale, text } = useTaskboardI18n();
  const packageAlias = task.feishuOrigin?.packageAlias?.trim() ?? "";
  const executionMode = task.feishuOrigin?.executionMode ?? task.feishuOrigin?.mode;
  const modeLabel = executionMode === "automatic"
    ? text("自动执行", "Automatic")
    : executionMode === "manual"
      ? text("手动执行", "Manual")
      : null;
  return (
    <div
      className="unified-workflow-card-summary"
      aria-label={text("Auto-Cut 执行摘要", "Auto-Cut execution summary")}
    >
      {packageAlias && (
        <span className="unified-workflow-summary-label" title={packageAlias}>
          {text("Auto-Cut 包", "Auto-Cut package")}: {packageAlias}
        </span>
      )}
      {modeLabel && (
        <span className="unified-workflow-summary-label">{modeLabel}</span>
      )}
      <time
        className="unified-workflow-summary-label"
        dateTime={task.updatedAt}
        title={new Date(task.updatedAt).toLocaleString(locale)}
      >
        {text("更新", "Updated")}: {formatTimestamp(task.updatedAt, locale)}
      </time>
    </div>
  );
}

function matchesBoardSearch(
  item: UnifiedWorkflowItem,
  search: string,
  language: "zh" | "en",
) {
  const needle = search.trim().toLocaleLowerCase();
  if (!needle) return true;
  if (matchesTaskSearch(item.task, search, language)) return true;
  return matchesUnifiedWorkflowMetadataSearch(item, needle);
}

function findDropBefore(container: HTMLElement, clientY: number, draggedTaskId: string | null) {
  const cards = Array.from(container.querySelectorAll<HTMLElement>("[data-task-id]"))
    .filter((card) => card.dataset.taskId !== draggedTaskId);
  return cards.find((card) => (
    clientY < card.getBoundingClientRect().top + card.offsetHeight / 2
  ))?.dataset.taskId ?? null;
}

type PanState = {
  pointerId: number;
  startX: number;
  startY: number;
  startScrollLeft: number;
  startScrollTop: number;
  captured: boolean;
};

function isInteractivePanTarget(target: EventTarget | null) {
  return target instanceof Element
    && Boolean(target.closest("button,a,input,select,textarea,[draggable='true']"));
}

function canPanBoardBlankArea(target: EventTarget | null) {
  if (!(target instanceof Element) || isInteractivePanTarget(target)) return false;
  // A column owns its own vertical scroll surface. The board gesture is only
  // for the grid background/gaps, so a card or empty column cannot steal it.
  return !target.closest(".unified-workflow-column");
}

function assignRef<T>(ref: Ref<T> | undefined, value: T | null) {
  if (typeof ref === "function") {
    ref(value);
  } else if (ref) {
    (ref as { current: T | null }).current = value;
  }
}

function UploadSummary({
  item,
  stage,
  locale,
  search,
  zipExpansion,
  onToggleZip,
  onRetryUpload,
  retryingUploadIds,
}: {
  item: UnifiedWorkflowItem;
  stage: UnifiedWorkflowStage;
  locale: string;
  search: string;
  zipExpansion: Record<string, boolean>;
  onToggleZip: (key: string, expanded: boolean) => void;
  onRetryUpload: (item: ArtifactUploadListItem) => void;
  retryingUploadIds: ReadonlySet<string>;
}) {
  const { text } = useTaskboardI18n();
  const zipEntries = unifiedWorkflowZipEntries(item) as UnifiedWorkflowZipEntry[];
  const zipCount = zipEntries.length;
  if (zipCount === 0 && stage === "completed_editing") {
    return (
      <div className="unified-workflow-card-summary">
        <span className="unified-workflow-summary-label">
          {text("剪辑已完成，等待上传", "Editing complete; waiting for upload")}
        </span>
      </div>
    );
  }
  if (zipCount === 0) return null;

  return (
    <div className="unified-workflow-card-summary" aria-label={text("ZIP 与上传摘要", "ZIP and upload summary")}>
      {zipEntries.map((entry) => {
        const artifact = entry.artifact;
        const upload = entry.upload;
        const filename = artifact?.filename ?? upload?.filename ?? text("ZIP 文件", "ZIP file");
        let expansionKey = "";
        try {
          expansionKey = unifiedWorkflowZipExpansionKey(item.task.id, entry.identity);
        } catch {
          // The identities come from local records; a malformed one remains
          // visible but does not persist an expansion preference.
        }
        const autoExpand = Boolean(upload && (
          upload.status === "uploading" || upload.status === "failed"
        ));
        const expanded = search.trim().length > 0
          || (expansionKey ? zipExpansion[expansionKey] ?? autoExpand : autoExpand);
        const detailsId = [
          "unified-workflow-zip-details",
          encodeURIComponent(item.task.id),
          encodeURIComponent(entry.identity),
        ].join("-");

        return (
          <div className="unified-workflow-zip-entry" key={entry.identity}>
            <button
              type="button"
              className="unified-workflow-zip-disclosure"
              aria-expanded={expanded}
              aria-controls={detailsId}
              onClick={() => {
                if (expansionKey) onToggleZip(expansionKey, !expanded);
              }}
            >
              <LinearIcon name={expanded ? "chevronDown" : "chevronRight"} />
              <span className="unified-workflow-summary-label" title={filename}>{filename}</span>
            </button>
            {expanded && (
              <div id={detailsId} className="unified-workflow-zip-details" role="region">
                {artifact && !upload && (
                  <div className="unified-workflow-upload-row unified-workflow-artifact-row status-verified">
                    <LinearIcon name="check" />
                    <span className="unified-workflow-upload-filename" title={artifact.filename}>{artifact.filename}</span>
                    <span className="unified-workflow-upload-status">
                      {artifact.validationStatus === "verified" ? text("已验证 ZIP", "Verified ZIP") : artifact.validationStatus}
                    </span>
                    <time dateTime={artifact.updatedAt} title={new Date(artifact.updatedAt).toLocaleString(locale)}>
                      {formatTimestamp(artifact.updatedAt, locale)}
                    </time>
                  </div>
                )}
                {upload && (() => {
            const retryable = upload.status === "failed";
            const retrying = retryingUploadIds.has(upload.id);
            const status = formatUploadStatus(upload.status, text);
            const errorLabel = uploadErrorLabel(upload.errorCode, text);
            return (
              <div className={"unified-workflow-upload-row status-" + upload.status}>
                <LinearIcon name={upload.status === "failed" ? "alert" : upload.status === "uploaded" ? "check" : "file"} />
                <span className="unified-workflow-upload-filename" title={upload.filename}>{upload.filename}</span>
                <span className="unified-workflow-upload-status">{status}</span>
                {upload.status === "failed" && (
                  <span className="unified-workflow-upload-error" title={errorLabel}>{errorLabel}</span>
                )}
                {upload.status === "uploaded" && upload.targetId && (
                  <span className="unified-workflow-upload-target" title={upload.targetId}>
                    {text("上传目标", "Upload target")}: {upload.targetId}
                  </span>
                )}
                <time dateTime={uploadTimestamp(upload)} title={new Date(uploadTimestamp(upload)).toLocaleString(locale)}>
                  {formatTimestamp(uploadTimestamp(upload), locale)}
                </time>
                {retryable && (
                  <button
                    type="button"
                    className="unified-workflow-upload-retry"
                    disabled={retryingUploadIds.has(upload.id)}
                    aria-busy={retrying || undefined}
                    title={retrying ? text("正在重新上传", "Retrying upload") : text("重新上传", "Retry upload")}
                    aria-label={text("重新上传 " + upload.filename, "Retry upload " + upload.filename)}
                    onClick={(event) => {
                      event.stopPropagation();
                      if (retrying) return;
                      onRetryUpload({ upload, task: item.task });
                    }}
                  >
                    <LinearIcon name="recurrence" />
                  </button>
                )}
              </div>
            );
                })()}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function UnifiedWorkflowColumn({
  definition,
  items,
  taskById,
  subjectKey,
  projectId,
  viewId,
  visibleStageIds,
  presentations,
  now,
  loading,
  uploadLoading,
  uploadError,
  hasActiveFilters,
  availableLabels,
  currentUser,
  draggedTaskId,
  draggedTaskHeight,
  movingTaskId,
  settlingTaskId,
  contextMenuTaskId,
  dropTarget,
  onOpenTask,
  onUpdate,
  onComplete,
  onContextMenu,
  onDragStart,
  onDragEnd,
  onDragEnter,
  onDrop,
  onOpenConversation,
  onRetryUpload,
  retryingUploadIds,
  search,
  zipExpansion,
  onToggleZip,
  onColumnScrollRef,
  onColumnScroll,
  onColumnPointerDown,
  onColumnPointerMove,
  onColumnPointerUp,
  onColumnPointerCancel,
}: {
  definition: UnifiedWorkflowColumnDefinition;
  items: UnifiedWorkflowItem[];
  taskById: ReadonlyMap<string, Task>;
  subjectKey: string;
  projectId: string;
  viewId: string;
  visibleStageIds: readonly UnifiedWorkflowStage[];
  presentations: Record<string, TaskCardPresentation>;
  now: number;
  loading: boolean;
  uploadLoading: boolean;
  uploadError: string | null;
  hasActiveFilters: boolean;
  availableLabels: string[];
  currentUser: ActorIdentity;
  draggedTaskId: string | null;
  draggedTaskHeight: number;
  movingTaskId: string | null;
  settlingTaskId: string | null;
  contextMenuTaskId: string | null;
  dropTarget: TaskStatus | null;
  onOpenTask: (task: Task, stage: UnifiedWorkflowStage) => void;
  onUpdate: (task: Task, changes: Partial<TaskDraft>) => Promise<Task>;
  onComplete: (task: Task) => void;
  onContextMenu: (task: Task, position: { x: number; y: number }) => void;
  onDragStart: (task: Task, height: number) => void;
  onDragEnd: () => void;
  onDragEnter: (status: TaskStatus) => void;
  onDrop: (status: TaskStatus, taskId: string, beforeTaskId: string | null, sourceSurface?: "board" | "other-tasks-panel" | "unified-board") => void;
  onOpenConversation: (conversation: TaskConversationItem) => void;
  onRetryUpload: (item: ArtifactUploadListItem) => void;
  retryingUploadIds: ReadonlySet<string>;
  search: string;
  zipExpansion: Record<string, boolean>;
  onToggleZip: (key: string, expanded: boolean) => void;
  onColumnScrollRef?: (stage: UnifiedWorkflowStage, element: HTMLDivElement | null) => void;
  onColumnScroll?: (stage: UnifiedWorkflowStage, scrollTop: number) => void;
  onColumnPointerDown?: (stage: UnifiedWorkflowStage, event: ReactPointerEvent<HTMLDivElement>) => void;
  onColumnPointerMove?: (stage: UnifiedWorkflowStage, event: ReactPointerEvent<HTMLDivElement>) => void;
  onColumnPointerUp?: (stage: UnifiedWorkflowStage, event: ReactPointerEvent<HTMLDivElement>) => void;
  onColumnPointerCancel?: (stage: UnifiedWorkflowStage, event: ReactPointerEvent<HTMLDivElement>) => void;
}) {
  const { locale, text } = useTaskboardI18n();
  const zipCount = items.reduce((total, item) => (
    total + summarizeUnifiedWorkflowArtifacts(item).zipCount
  ), 0);
  const taskCountLabel = loading
    ? "..."
    : text(`${items.length} 个任务`, `${items.length} task${items.length === 1 ? "" : "s"}`);
  const zipCountLabel = loading || uploadLoading
    ? text("ZIP 同步中", "ZIP syncing")
    : uploadError
      ? text("ZIP 未同步", "ZIP unavailable")
      : text(`${zipCount} 个 ZIP`, `${zipCount} ZIP file${zipCount === 1 ? "" : "s"}`);
  const [dropBeforeTaskId, setDropBeforeTaskId] = useState<string | null | undefined>();
  const readOnly = definition.upload || !REAL_TASK_STAGES.has(definition.id);
  const isDropTarget = !readOnly && definition.taskStatus !== undefined && dropTarget === definition.taskStatus;
  const taskIndexes = new Map(items.map((item, index) => [item.task.id, index]));
  const remainingItems = items.filter((item) => item.task.id !== draggedTaskId);
  const remainingIndexes = new Map(remainingItems.map((item, index) => [item.task.id, index]));
  const draggedIndex = draggedTaskId ? taskIndexes.get(draggedTaskId) ?? -1 : -1;
  const beforeIndex = dropBeforeTaskId
    ? remainingIndexes.get(dropBeforeTaskId) ?? remainingItems.length
    : remainingItems.length;
  const previewIndex = isDropTarget && dropBeforeTaskId !== undefined ? beforeIndex : -1;
  const dragDistance = draggedTaskHeight + 8;

  useEffect(() => {
    if (!isDropTarget || !draggedTaskId) setDropBeforeTaskId(undefined);
  }, [draggedTaskId, isDropTarget]);

  function dragShift(item: UnifiedWorkflowItem) {
    if (!draggedTaskId || item.task.id === draggedTaskId || readOnly) return 0;
    const taskIndex = taskIndexes.get(item.task.id) ?? -1;
    const remainingIndex = remainingIndexes.get(item.task.id) ?? -1;
    let shift = 0;
    if (draggedIndex >= 0 && taskIndex > draggedIndex) shift -= dragDistance;
    if (previewIndex >= 0 && remainingIndex >= previewIndex) shift += dragDistance;
    return shift;
  }

  function handleDrop(event: DragEvent<HTMLElement>) {
    if (readOnly || definition.taskStatus === undefined) return;
    event.preventDefault();
    const taskId = event.dataTransfer.getData("application/x-taskboard-task")
      || event.dataTransfer.getData("text/plain");
    const sourceSurface = event.dataTransfer.getData("application/x-taskboard-source-surface");
    if (sourceSurface !== "unified-board") {
      setDropBeforeTaskId(undefined);
      return;
    }
    const task = taskById.get(taskId);
    if (
      taskId
      && canDropUnifiedWorkflowTask({
        projectId,
        subjectKey,
        visibleStageIds,
        task,
        targetStage: definition.id,
        sourceSurface,
      })
    ) {
      onDrop(
        definition.taskStatus,
        taskId,
        findDropBefore(event.currentTarget, event.clientY, draggedTaskId),
        "unified-board",
      );
    }
    setDropBeforeTaskId(undefined);
  }

  return (
    <section
      className={`unified-workflow-column unified-workflow-column-${definition.id}${definition.upload ? " unified-workflow-column--upload" : ""}${readOnly ? " is-read-only" : ""}${isDropTarget ? " is-drop-target" : ""}`}
      data-stage={definition.id}
      data-read-only={readOnly || undefined}
      aria-labelledby={`unified-workflow-column-${definition.id}`}
      onDragEnter={readOnly || definition.taskStatus === undefined ? undefined : (event) => {
        if (!hasUnifiedWorkflowDragType(event.dataTransfer.types)) {
          setDropBeforeTaskId(undefined);
          return;
        }
        onDragEnter(definition.taskStatus!);
      }}
      onDragOver={readOnly || definition.taskStatus === undefined ? undefined : (event) => {
        if (!hasUnifiedWorkflowDragType(event.dataTransfer.types)) {
          setDropBeforeTaskId(undefined);
          return;
        }
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        onDragEnter(definition.taskStatus!);
        setDropBeforeTaskId(findDropBefore(event.currentTarget, event.clientY, draggedTaskId));
      }}
      onDragLeave={readOnly ? undefined : (event) => {
        if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) {
          setDropBeforeTaskId(undefined);
        }
      }}
      onDrop={readOnly ? undefined : handleDrop}
    >
      <header className="unified-workflow-column-header">
        <div className="unified-workflow-column-header-copy">
          <div className="unified-workflow-column-heading">
            <span className={`unified-workflow-column-icon status-icon-${statusColor(definition.id)}`}>
              <LinearIcon name={definition.icon} />
            </span>
            <h2 id={`unified-workflow-column-${definition.id}`}>
              {definition.displayLabel ?? text(definition.label, definition.englishLabel)}
            </h2>
            <div className="unified-workflow-column-counts" aria-label={text("任务和 ZIP 数量", "Task and ZIP counts")}>
              <span className="unified-workflow-column-task-count">{taskCountLabel}</span>
              <span className="unified-workflow-column-zip-count">{zipCountLabel}</span>
            </div>
          </div>
          {definition.displayDescription && (
            <p className="unified-workflow-column-description" title={definition.displayDescription}>
              {definition.displayDescription}
            </p>
          )}
        </div>
        {definition.upload && <span className="unified-workflow-read-only-label">{text("只读", "Read-only")}</span>}
      </header>

      <div
        className="unified-workflow-column-list"
        ref={(element) => {
          onColumnScrollRef?.(definition.id, element);
        }}
        onScroll={(event) => onColumnScroll?.(definition.id, event.currentTarget.scrollTop)}
        onPointerDown={(event) => onColumnPointerDown?.(definition.id, event)}
        onPointerMove={(event) => onColumnPointerMove?.(definition.id, event)}
        onPointerUp={(event) => onColumnPointerUp?.(definition.id, event)}
        onPointerCancel={(event) => onColumnPointerCancel?.(definition.id, event)}
      >
        {loading ? (
          <div className="unified-workflow-column-loading" role="status" aria-busy="true">
            <span /><span /><span />
          </div>
        ) : items.length === 0 ? (
          <div className="unified-workflow-column-empty">
            {hasActiveFilters
              ? text("当前筛选下无匹配任务", "No tasks match the current filters")
              : text("暂无任务", "No tasks")}
          </div>
        ) : items.map((item) => {
          const task = item.task;
          const presentation = presentations[task.id] ?? EMPTY_PRESENTATION;
          return (
            <div className="unified-workflow-item" key={task.id}>
              <TaskCard
                task={task}
                presentation={presentation}
                now={now}
                isDragging={draggedTaskId === task.id}
                dragShift={dragShift(item)}
                isMoving={movingTaskId === task.id}
                isSettling={settlingTaskId === task.id}
                isContextMenuOpen={contextMenuTaskId === task.id}
                dragSourceSurface="unified-board"
                dragEnabled={!readOnly}
                availableLabels={availableLabels}
                currentUser={currentUser}
                onEdit={(task) => onOpenTask(task, definition.id)}
                onUpdate={onUpdate}
                onComplete={!readOnly ? onComplete : undefined}
                onContextMenu={onContextMenu}
                onDragStart={onDragStart}
                onDragEnd={onDragEnd}
                onOpenConversation={onOpenConversation}
              />
              <TaskExecutionSummary task={task} />
              {(definition.upload || item.artifacts.length > 0 || item.uploads.length > 0) && (
                <UploadSummary
                  item={item}
                  stage={definition.id}
                  locale={locale}
                  search={search}
                  zipExpansion={zipExpansion}
                  onToggleZip={onToggleZip}
                  onRetryUpload={onRetryUpload}
                  retryingUploadIds={retryingUploadIds}
                />
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

export function UnifiedWorkflowBoard({
  projectId,
  subjectKey,
  viewId,
  tasks,
  uploadItems,
  artifactSummaries,
  presentations,
  now,
  loading,
  uploadLoading,
  uploadError,
  hasActiveFilters,
  filters,
  availableLabels,
  currentUser,
  draggedTaskId,
  draggedTaskHeight,
  movingTaskId,
  settlingTaskId,
  contextMenuTaskId,
  dropTarget,
  search = "",
  stageIds,
  stageDisplays = [],
  searchScope = "activeView",
  onOpenTask,
  onUpdate,
  onComplete,
  onContextMenu,
  onDragStart,
  onDragEnd,
  onDragEnter,
  onDrop,
  onOpenConversation,
  onRetryUpload,
  retryingUploadIds = EMPTY_RETRYING_UPLOAD_IDS,
  onColumnScrollRef,
  onBoardScrollRef,
}: UnifiedWorkflowBoardProps) {
  const { language, locale, statusLabel, text } = useTaskboardI18n();
  const activeFilters = filters ?? EMPTY_TASK_FILTERS;
  const taskById = useMemo(
    () => new Map(tasks.map((task) => [task.id, task])),
    [tasks],
  );
  const taskIds = useMemo(() => new Set(tasks.map((task) => task.id)), [tasks]);
  const scopedUploadItems = useMemo(() => uploadItems.filter((item) => (
    taskIds.has(item.upload.taskId)
  )), [taskIds, uploadItems]);
  const grouped = useMemo(() => (
    groupUnifiedWorkflowItems(tasks, scopedUploadItems, artifactSummaries) as Record<
      UnifiedWorkflowStage,
      UnifiedWorkflowItem[]
    >
  ), [artifactSummaries, scopedUploadItems, tasks]);
  const filteredGroups = useMemo(() => Object.fromEntries(
    Object.entries(grouped).map(([stage, items]) => [
      stage,
      (items as UnifiedWorkflowItem[]).filter((item) => (
        matchesTaskFilters(item.task, activeFilters)
        && matchesBoardSearch(item, search, language)
      )),
    ]),
  ) as Record<UnifiedWorkflowStage, UnifiedWorkflowItem[]>, [activeFilters, grouped, language, search]);

  // The saved view is the source of truth for the rendered columns. Keep this
  // list stable while filtering/searching so a temporary empty column does not
  // discard its scroll position or other layout preferences.
  const selectedStageIds = useMemo(() => {
    const requested = Array.isArray(stageIds) && stageIds.length > 0
      ? stageIds
      : COLUMN_DEFINITIONS.map((definition) => definition.id);
    const known = new Set(COLUMN_DEFINITIONS.map((definition) => definition.id));
    const seen = new Set<UnifiedWorkflowStage>();
    const result: UnifiedWorkflowStage[] = [];
    for (const candidate of requested) {
      if (!known.has(candidate) || seen.has(candidate)) continue;
      seen.add(candidate);
      result.push(candidate);
    }
    return result.length > 0
      ? result
      : COLUMN_DEFINITIONS.map((definition) => definition.id);
  }, [stageIds]);
  const [revealedStageIds, setRevealedStageIds] = useState<UnifiedWorkflowStage[]>([]);
  const selectedStageKey = selectedStageIds.join(",");
  const revealedStageKey = revealedStageIds.join(",");
  const onDragEndRef = useRef(onDragEnd);
  onDragEndRef.current = onDragEnd;
  const clearTaskDragState = useCallback(() => {
    onDragEndRef.current();
  }, []);
  useEffect(() => {
    setRevealedStageIds([]);
  }, [selectedStageKey, subjectKey, viewId]);
  useEffect(() => {
    clearTaskDragState();
  }, [clearTaskDragState, projectId, revealedStageKey, selectedStageKey, subjectKey, viewId]);
  const renderedStageIds = useMemo(() => {
    const selected = new Set(selectedStageIds);
    return [
      ...selectedStageIds,
      ...revealedStageIds.filter((stageId) => !selected.has(stageId)),
    ];
  }, [revealedStageIds, selectedStageIds]);
  const visibleGroups = useMemo(
    () => projectUnifiedWorkflowGroups(filteredGroups, renderedStageIds) as Record<UnifiedWorkflowStage, UnifiedWorkflowItem[]>,
    [filteredGroups, renderedStageIds],
  );
  const stageDisplayMap = useMemo(() => {
    const map = new Map<UnifiedWorkflowStage, StageDisplayOverride>();
    for (const override of stageDisplays) {
      if (override && override.subjectKey === subjectKey && typeof override.stageId === "string") {
        map.set(override.stageId, override);
      }
    }
    return map;
  }, [stageDisplays, subjectKey]);
  const visibleDefinitions = useMemo(() => renderedStageIds
    .map((stageId) => COLUMN_DEFINITIONS.find((definition) => definition.id === stageId))
    .filter((definition): definition is UnifiedWorkflowColumnDefinition => Boolean(definition))
    .map((definition) => {
      const override = stageDisplayMap.get(definition.id);
      const displayLabel = language === "zh"
        ? override?.zhName?.trim() || null
        : override?.enName?.trim() || null;
      const displayDescription = language === "zh"
        ? override?.zhDescription?.trim() || null
        : override?.enDescription?.trim() || null;
      return {
        ...definition,
        displayLabel: displayLabel
          ?? (definition.taskStatus ? statusLabel(definition.taskStatus) : text(definition.label, definition.englishLabel)),
        displayDescription: displayDescription
          ?? text(definition.description, definition.englishDescription),
      };
    }), [language, renderedStageIds, stageDisplayMap, statusLabel, text]);
  const hasHiddenStages = visibleDefinitions.length < COLUMN_DEFINITIONS.length;
  const hiddenSummary = useMemo(
    () => summarizeHiddenUnifiedWorkflow(filteredGroups, renderedStageIds, {
      loading,
      uploadLoading,
      uploadError,
    }),
    [filteredGroups, loading, renderedStageIds, uploadError, uploadLoading],
  );
  const hiddenMatches = useMemo(() => {
    if (searchScope !== "allStages" || !search.trim()) return [];
    const selected = new Set(renderedStageIds);
    const definitions = new Map(COLUMN_DEFINITIONS.map((definition) => [definition.id, definition]));
    const result: Array<{ stage: UnifiedWorkflowStage; item: UnifiedWorkflowItem }> = [];
    for (const [stage, items] of Object.entries(filteredGroups) as Array<[UnifiedWorkflowStage, UnifiedWorkflowItem[]]>) {
      if (selected.has(stage)) continue;
      for (const item of items) result.push({ stage, item });
    }
    return result.map((entry) => ({
      ...entry,
      definition: definitions.get(entry.stage),
    }));
  }, [filteredGroups, renderedStageIds, search, searchScope]);

  type LayoutState = {
    columnWidthPreset: "narrow" | "standard" | "wide";
    cardDensity: "compact" | "comfortable";
    boardScrollLeft: number;
    columnScrollTop: Record<string, number>;
    zipExpansion: Record<string, boolean>;
  };
  const layoutStageIds = useMemo(
    () => selectedStageIds,
    [selectedStageIds],
  );
  const layoutScopeKey = useMemo(
    () => unifiedWorkflowLayoutStorageKey(projectId, viewId),
    [projectId, viewId],
  );
  const [layout, setLayout] = useState<LayoutState>(() => (
    readUnifiedWorkflowLayout(projectId, viewId, layoutStageIds) as LayoutState
  ));
  const layoutRef = useRef<LayoutState>(layout);
  layoutRef.current = layout;
  const boardElementRef = useRef<HTMLDivElement | null>(null);
  const columnElementRefs = useRef<Partial<Record<UnifiedWorkflowStage, HTMLDivElement | null>>>({});
  const layoutWriteTimerRef = useRef<number | null>(null);
  const boardPanRef = useRef<PanState | null>(null);
  const columnPanRef = useRef<{ stage: UnifiedWorkflowStage; state: PanState } | null>(null);
  const draggedTaskIdRef = useRef(draggedTaskId);
  draggedTaskIdRef.current = draggedTaskId;
  const edgeAutoScrollFrameRef = useRef<number | null>(null);
  const edgeAutoScrollPointerXRef = useRef<number | null>(null);
  const edgeAutoScrollActiveRef = useRef(false);
  const [panSurface, setPanSurface] = useState<"board" | "column" | null>(null);

  const restoreScrollPositions = useCallback(() => {
    const board = boardElementRef.current;
    if (board) board.scrollLeft = layoutRef.current.boardScrollLeft;
    for (const stageId of layoutStageIds) {
      const column = columnElementRefs.current[stageId];
      if (column) column.scrollTop = layoutRef.current.columnScrollTop[stageId] ?? 0;
    }
  }, [layoutStageIds]);

  const stopEdgeAutoScroll = useCallback(() => {
    edgeAutoScrollActiveRef.current = false;
    edgeAutoScrollPointerXRef.current = null;
    if (edgeAutoScrollFrameRef.current !== null && typeof window !== "undefined") {
      window.cancelAnimationFrame(edgeAutoScrollFrameRef.current);
      edgeAutoScrollFrameRef.current = null;
    }
  }, []);

  const clearPanStates = useCallback(() => {
    const boardPan = boardPanRef.current;
    if (boardPan && boardElementRef.current?.hasPointerCapture?.(boardPan.pointerId)) {
      boardElementRef.current.releasePointerCapture(boardPan.pointerId);
    }
    const columnPan = columnPanRef.current;
    if (columnPan) {
      const column = columnElementRefs.current[columnPan.stage];
      if (column?.hasPointerCapture?.(columnPan.state.pointerId)) {
        column.releasePointerCapture(columnPan.state.pointerId);
      }
    }
    boardPanRef.current = null;
    columnPanRef.current = null;
    setPanSurface(null);
    stopEdgeAutoScroll();
  }, [stopEdgeAutoScroll]);

  const queueLayoutWrite = useCallback(() => {
    if (typeof window === "undefined" || layoutWriteTimerRef.current !== null) return;
    layoutWriteTimerRef.current = window.setTimeout(() => {
      layoutWriteTimerRef.current = null;
      writeUnifiedWorkflowLayout(projectId, viewId, layoutRef.current, layoutStageIds);
    }, LAYOUT_WRITE_DELAY_MS);
  }, [layoutStageIds, projectId, viewId]);

  const applyLayoutPatch = useCallback((patch: Partial<LayoutState>) => {
    const current = layoutRef.current;
    const next = normalizeUnifiedWorkflowLayout({
      ...current,
      ...patch,
      columnScrollTop: {
        ...current.columnScrollTop,
        ...(patch.columnScrollTop ?? {}),
      },
      zipExpansion: {
        ...current.zipExpansion,
        ...(patch.zipExpansion ?? {}),
      },
    }, layoutStageIds) as LayoutState;
    layoutRef.current = next;
    setLayout(next);
    queueLayoutWrite();
  }, [layoutStageIds, queueLayoutWrite]);

  const handleToggleZip = useCallback((key: string, expanded: boolean) => {
    applyLayoutPatch({ zipExpansion: { [key]: expanded } });
  }, [applyLayoutPatch]);

  const assignBoardElement = useCallback((element: HTMLDivElement | null) => {
    boardElementRef.current = element;
    assignRef(onBoardScrollRef, element);
  }, [onBoardScrollRef]);

  const assignColumnElement = useCallback((stage: UnifiedWorkflowStage, element: HTMLDivElement | null) => {
    columnElementRefs.current[stage] = element;
    onColumnScrollRef?.(stage, element);
  }, [onColumnScrollRef]);

  useLayoutEffect(() => {
    clearPanStates();
    if (layoutWriteTimerRef.current !== null && typeof window !== "undefined") {
      window.clearTimeout(layoutWriteTimerRef.current);
      layoutWriteTimerRef.current = null;
    }
    const next = readUnifiedWorkflowLayout(projectId, viewId, layoutStageIds) as LayoutState;
    layoutRef.current = next;
    setLayout(next);
    if (!loading) restoreScrollPositions();
  }, [clearPanStates, layoutScopeKey, layoutStageIds, loading, projectId, restoreScrollPositions, subjectKey, viewId]);

  useLayoutEffect(() => {
    if (loading) return;
    restoreScrollPositions();
  }, [loading, restoreScrollPositions, visibleGroups]);

  useEffect(() => () => {
    clearPanStates();
    stopEdgeAutoScroll();
    clearTaskDragState();
    if (layoutWriteTimerRef.current !== null && typeof window !== "undefined") {
      window.clearTimeout(layoutWriteTimerRef.current);
      layoutWriteTimerRef.current = null;
    }
  }, [clearPanStates, clearTaskDragState, stopEdgeAutoScroll]);

  useEffect(() => {
    const onPointerEnd = (event: PointerEvent) => {
      const boardPan = boardPanRef.current;
      const columnPan = columnPanRef.current;
      if (
        boardPan?.pointerId === event.pointerId
        || columnPan?.state.pointerId === event.pointerId
      ) {
        clearPanStates();
      }
    };
    window.addEventListener("pointerup", onPointerEnd, true);
    window.addEventListener("pointercancel", onPointerEnd, true);
    return () => {
      window.removeEventListener("pointerup", onPointerEnd, true);
      window.removeEventListener("pointercancel", onPointerEnd, true);
    };
  }, [clearPanStates]);

  useEffect(() => {
    stopEdgeAutoScroll();
  }, [draggedTaskId, stopEdgeAutoScroll]);

  useEffect(() => {
    const stop = () => stopEdgeAutoScroll();
    window.addEventListener("dragend", stop, true);
    window.addEventListener("drop", stop, true);
    return () => {
      window.removeEventListener("dragend", stop, true);
      window.removeEventListener("drop", stop, true);
    };
  }, [stopEdgeAutoScroll]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        clearPanStates();
        clearTaskDragState();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [clearPanStates, clearTaskDragState]);

  const handleBoardScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
    applyLayoutPatch({ boardScrollLeft: event.currentTarget.scrollLeft });
  }, [applyLayoutPatch]);

  const handleColumnScroll = useCallback((stage: UnifiedWorkflowStage, scrollTop: number) => {
    applyLayoutPatch({ columnScrollTop: { [stage]: scrollTop } });
  }, [applyLayoutPatch]);

  const runEdgeAutoScroll = useCallback(() => {
    edgeAutoScrollFrameRef.current = null;
    if (typeof window === "undefined" || !edgeAutoScrollActiveRef.current || !draggedTaskIdRef.current) {
      stopEdgeAutoScroll();
      return;
    }
    const board = boardElementRef.current;
    const pointerX = edgeAutoScrollPointerXRef.current;
    if (!board || pointerX === null) {
      stopEdgeAutoScroll();
      return;
    }
    const rect = board.getBoundingClientRect();
    const distanceFromLeft = pointerX - rect.left;
    const distanceFromRight = rect.right - pointerX;
    const direction = distanceFromLeft >= 0 && distanceFromLeft <= EDGE_AUTO_SCROLL_ZONE_PX
      ? -1
      : distanceFromRight >= 0 && distanceFromRight <= EDGE_AUTO_SCROLL_ZONE_PX
        ? 1
        : 0;
    const maxScrollLeft = Math.max(0, board.scrollWidth - board.clientWidth);
    if (direction === 0 || maxScrollLeft <= 0) {
      stopEdgeAutoScroll();
      return;
    }
    const nextScrollLeft = Math.max(
      0,
      Math.min(maxScrollLeft, board.scrollLeft + direction * EDGE_AUTO_SCROLL_STEP_PX),
    );
    if (nextScrollLeft === board.scrollLeft) {
      stopEdgeAutoScroll();
      return;
    }
    board.scrollLeft = nextScrollLeft;
    edgeAutoScrollFrameRef.current = window.requestAnimationFrame(runEdgeAutoScroll);
  }, [stopEdgeAutoScroll]);

  const handleBoardDragOver = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (!hasUnifiedWorkflowDragType(event.dataTransfer.types) || !draggedTaskIdRef.current) {
      stopEdgeAutoScroll();
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const board = event.currentTarget;
    const rect = board.getBoundingClientRect();
    const distanceFromLeft = event.clientX - rect.left;
    const distanceFromRight = rect.right - event.clientX;
    const nearEdge = (
      distanceFromLeft >= 0 && distanceFromLeft <= EDGE_AUTO_SCROLL_ZONE_PX
    ) || (
      distanceFromRight >= 0 && distanceFromRight <= EDGE_AUTO_SCROLL_ZONE_PX
    );
    if (!nearEdge || board.scrollWidth <= board.clientWidth) {
      stopEdgeAutoScroll();
      return;
    }
    edgeAutoScrollActiveRef.current = true;
    edgeAutoScrollPointerXRef.current = event.clientX;
    if (edgeAutoScrollFrameRef.current === null) {
      edgeAutoScrollFrameRef.current = window.requestAnimationFrame(runEdgeAutoScroll);
    }
  }, [runEdgeAutoScroll, stopEdgeAutoScroll]);

  const handleBoardDragLeave = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) {
      stopEdgeAutoScroll();
    }
  }, [stopEdgeAutoScroll]);

  const handleBoardDragEnd = useCallback(() => stopEdgeAutoScroll(), [stopEdgeAutoScroll]);

  const handleBoardPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !canPanBoardBlankArea(event.target)) return;
    clearPanStates();
    boardPanRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startScrollLeft: event.currentTarget.scrollLeft,
      startScrollTop: event.currentTarget.scrollTop,
      captured: false,
    };
  }, [clearPanStates]);

  const handleBoardPointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const pan = boardPanRef.current;
    const board = event.currentTarget;
    if (!pan || pan.pointerId !== event.pointerId) return;
    const deltaX = event.clientX - pan.startX;
    if (!pan.captured && Math.abs(deltaX) < PAN_THRESHOLD_PX) return;
    if (!pan.captured) {
      try { board.setPointerCapture(event.pointerId); } catch { /* pointer already ended */ }
      pan.captured = true;
      setPanSurface("board");
    }
    event.preventDefault();
    board.scrollLeft = Math.max(0, pan.startScrollLeft - deltaX);
  }, []);

  const handleColumnPointerDown = useCallback((stage: UnifiedWorkflowStage, event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || isInteractivePanTarget(event.target)) return;
    if (event.target instanceof Element && event.target.closest(".unified-workflow-item")) return;
    clearPanStates();
    columnPanRef.current = {
      stage,
      state: {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        startScrollLeft: event.currentTarget.scrollLeft,
        startScrollTop: event.currentTarget.scrollTop,
        captured: false,
      },
    };
  }, [clearPanStates]);

  const handleColumnPointerMove = useCallback((stage: UnifiedWorkflowStage, event: ReactPointerEvent<HTMLDivElement>) => {
    const pan = columnPanRef.current;
    const column = event.currentTarget;
    if (!pan || pan.stage !== stage || pan.state.pointerId !== event.pointerId) return;
    const deltaY = event.clientY - pan.state.startY;
    if (!pan.state.captured && Math.abs(deltaY) < PAN_THRESHOLD_PX) return;
    if (!pan.state.captured) {
      try { column.setPointerCapture(event.pointerId); } catch { /* pointer already ended */ }
      pan.state.captured = true;
      setPanSurface("column");
    }
    event.preventDefault();
    column.scrollTop = Math.max(0, pan.state.startScrollTop - deltaY);
  }, []);

  const handleBoardPointerUp = useCallback(() => clearPanStates(), [clearPanStates]);
  const handleBoardPointerCancel = useCallback(() => {
    clearPanStates();
    clearTaskDragState();
  }, [clearPanStates, clearTaskDragState]);
  const handleColumnPointerUp = useCallback(() => clearPanStates(), [clearPanStates]);
  const handleColumnPointerCancel = useCallback(() => {
    clearPanStates();
    clearTaskDragState();
  }, [clearPanStates, clearTaskDragState]);

  const resetLayout = useCallback(() => {
    const defaults = resetUnifiedWorkflowLayout(projectId, viewId, layoutStageIds) as LayoutState;
    layoutRef.current = defaults;
    setLayout(defaults);
    clearPanStates();
    restoreScrollPositions();
  }, [clearPanStates, layoutStageIds, projectId, restoreScrollPositions, viewId]);

  const gridStyle = {
    "--unified-stage-count": String(Math.max(1, visibleDefinitions.length)),
    "--unified-column-width": `${columnWidthPx(layout.columnWidthPreset)}px`,
  } as CSSProperties;

  return (
    <section
      className={`unified-workflow-board${panSurface ? " is-panning" : ""}`}
      data-layout-density={layout.cardDensity}
      aria-label={text("统一流程看板", "Unified workflow board")}
    >
      <div className="unified-workflow-layout-controls" aria-label={text("看板布局", "Board layout")}>
        <label>
          <span>{text("列宽", "Column width")}</span>
          <select
            value={layout.columnWidthPreset}
            onChange={(event) => applyLayoutPatch({ columnWidthPreset: event.target.value as LayoutState["columnWidthPreset"] })}
          >
            <option value="narrow">{text("窄", "Narrow")}</option>
            <option value="standard">{text("标准", "Standard")}</option>
            <option value="wide">{text("宽", "Wide")}</option>
          </select>
        </label>
        <label>
          <span>{text("卡片密度", "Card density")}</span>
          <select
            value={layout.cardDensity}
            onChange={(event) => applyLayoutPatch({ cardDensity: event.target.value as LayoutState["cardDensity"] })}
          >
            <option value="compact">{text("紧凑", "Compact")}</option>
            <option value="comfortable">{text("舒适", "Comfortable")}</option>
          </select>
        </label>
        <button
          type="button"
          className="unified-workflow-layout-reset"
          title={text("恢复默认布局", "Reset board layout")}
          aria-label={text("恢复默认布局", "Reset board layout")}
          onClick={resetLayout}
        >
          <LinearIcon name="recurrence" />
        </button>
      </div>
      {(uploadLoading || uploadError) && (
        <div className={`unified-workflow-upload-banner${uploadError ? " is-error" : ""}`} role={uploadError ? "alert" : "status"} aria-busy={uploadLoading}>
          <LinearIcon name={uploadError ? "alert" : "recurrence"} />
          <span>{uploadError
            ? uploadErrorLabel(uploadError, text)
            : text("正在加载上传状态…", "Loading upload status…")}</span>
        </div>
      )}
      {(hiddenSummary.taskCount > 0 || (hasHiddenStages && hiddenSummary.status === "syncing")) && (
        <div className="unified-workflow-hidden-summary" role="status" aria-live="polite">
          <span className="unified-workflow-hidden-summary-title">
            {hiddenSummary.status === "syncing"
              ? text("隐藏流程正在同步…", "Hidden stages are syncing…")
              : text(`${hiddenSummary.taskCount} 个任务在当前视图之外`, `${hiddenSummary.taskCount} task${hiddenSummary.taskCount === 1 ? "" : "s"} outside this view`)}
          </span>
          {hiddenSummary.zipCount > 0 && (
            <span>{text(`${hiddenSummary.zipCount} 个 ZIP`, `${hiddenSummary.zipCount} ZIP file${hiddenSummary.zipCount === 1 ? "" : "s"}`)}</span>
          )}
          {hiddenSummary.failedUploadCount > 0 && (
            <span className="is-error">{text(`${hiddenSummary.failedUploadCount} 个上传失败`, `${hiddenSummary.failedUploadCount} upload failure${hiddenSummary.failedUploadCount === 1 ? "" : "s"}`)}</span>
          )}
        </div>
      )}
      {hiddenMatches.length > 0 && (
        <aside
          className="unified-workflow-hidden-matches"
          aria-label={text("隐藏流程中的搜索结果", "Search results in hidden stages")}
        >
          <div className="unified-workflow-hidden-matches-heading">
            <span>{text("隐藏流程中的匹配任务", "Matching tasks in hidden stages")}</span>
            <span>{hiddenMatches.length}</span>
          </div>
          <ul>
            {hiddenMatches.map(({ stage, item, definition }) => {
              const override = stageDisplayMap.get(stage);
              const stageLabel = language === "zh"
                ? override?.zhName?.trim() || definition?.label
                : override?.enName?.trim() || definition?.englishLabel;
              const stageAlreadyRevealed = renderedStageIds.includes(stage);
              return (
                <li key={`${stage}:${item.task.id}`}>
                  <button
                    type="button"
                    className="unified-workflow-hidden-match-task"
                    onClick={() => onOpenTask(item.task, stage)}
                  >
                    <span title={item.task.title}>{item.task.title}</span>
                    <small>{stageLabel}</small>
                  </button>
                  {!stageAlreadyRevealed && (
                    <button
                      type="button"
                      className="unified-workflow-hidden-match-reveal"
                      title={text("临时显示此流程", "Temporarily show this stage")}
                      aria-label={text(`显示${stageLabel}流程`, `Show ${stageLabel} stage`)}
                      onClick={() => setRevealedStageIds((current) => current.includes(stage) ? current : [...current, stage])}
                    >
                      <LinearIcon name="chevronRight" />
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </aside>
      )}
      <div
        className="unified-workflow-board-scroll"
        ref={assignBoardElement}
        onScroll={handleBoardScroll}
        onDragOver={handleBoardDragOver}
        onDragLeave={handleBoardDragLeave}
        onDragEnd={handleBoardDragEnd}
        onDrop={handleBoardDragEnd}
        onPointerDown={handleBoardPointerDown}
        onPointerMove={handleBoardPointerMove}
        onPointerUp={handleBoardPointerUp}
        onPointerCancel={handleBoardPointerCancel}
      >
        <div className="unified-workflow-board-grid" style={gridStyle}>
          {visibleDefinitions.map((definition) => (
            <UnifiedWorkflowColumn
              key={definition.id}
              definition={definition}
              items={visibleGroups[definition.id] ?? []}
              taskById={taskById}
              subjectKey={subjectKey}
              projectId={projectId}
              viewId={viewId}
              visibleStageIds={selectedStageIds}
              presentations={presentations}
              now={now}
              loading={loading}
              uploadLoading={uploadLoading}
              uploadError={uploadError}
              hasActiveFilters={hasActiveFilters || Boolean(search.trim())}
              availableLabels={availableLabels}
              currentUser={currentUser}
              draggedTaskId={draggedTaskId}
              draggedTaskHeight={draggedTaskHeight}
              movingTaskId={movingTaskId}
              settlingTaskId={settlingTaskId}
              contextMenuTaskId={contextMenuTaskId}
              dropTarget={dropTarget}
              onOpenTask={onOpenTask}
              onUpdate={onUpdate}
              onComplete={onComplete}
              onContextMenu={onContextMenu}
              onDragStart={onDragStart}
              onDragEnd={onDragEnd}
              onDragEnter={onDragEnter}
              onDrop={onDrop}
              onOpenConversation={onOpenConversation}
              onRetryUpload={onRetryUpload}
              retryingUploadIds={retryingUploadIds}
              search={search}
              zipExpansion={layout.zipExpansion}
              onToggleZip={handleToggleZip}
              onColumnScrollRef={assignColumnElement}
              onColumnScroll={handleColumnScroll}
              onColumnPointerDown={handleColumnPointerDown}
              onColumnPointerMove={handleColumnPointerMove}
              onColumnPointerUp={handleColumnPointerUp}
              onColumnPointerCancel={handleColumnPointerCancel}
            />
          ))}
        </div>
      </div>
    </section>
  );
}
