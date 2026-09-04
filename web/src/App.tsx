import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type Dispatch,
  type SetStateAction,
} from "react";
import {
  isAutomationModel,
  isAutomationReasoningEffort,
  isSupportedModelEffort,
  type AutomationModel,
  type AutomationReasoningEffort,
} from "../../shared/taskboard-automation-options.mjs";
import {
  ApiError,
  addTaskRelation,
  archiveTask as archiveTaskRequest,
  createProject as createProjectRequest,
  createTask as createTaskRequest,
  deleteArchivedTask as deleteArchivedTaskRequest,
  deleteProject as deleteProjectRequest,
  executeTaskWithCodex,
  getBoardStageLabels,
  getCodexThreadProgress,
  getHostRuntime,
  getTaskboardRevision,
  getUnifiedWorkflowStageDisplays,
  getUnifiedWorkflowViews,
  getWorkflowWorkspace,
  getTaskboardMetadata,
  listArtifactUploads,
  listArchivedTasks,
  listDevelopmentContexts,
  listDeviceWorkspaces,
  listFeishuWorkflowCatalog,
  listProjects,
  listTaskArtifactSummaries,
  listTasks,
  moveTask as moveTaskRequest,
  publishHostRuntime,
  removeTaskRelation,
  resolveTaskboardUrl,
  restoreTask as restoreTaskRequest,
  retryTaskArtifactUpload,
  setApiText,
  setCurrentUserActor,
  setProjectArchived,
  startTaskWithCodex,
  uploadAttachment,
  updateTask as updateTaskRequest,
} from "./api";
import {
  actorKey,
  actorForAssigneeTarget,
  assigneeTargetForActor,
} from "./actors";
import { BoardColumn } from "./components/BoardColumn";
import { AiChat, type AiChatOpenThreadRequest } from "./components/AiChat";
import { DashboardView } from "./components/DashboardView";
import { ArtifactUploadView } from "./components/ArtifactUploadView";
import {
  UnifiedWorkflowBoard,
  type UnifiedWorkflowStage,
} from "./components/UnifiedWorkflowBoard";
import { IssueListView } from "./components/IssueListView";
import { OtherTasksPanel } from "./components/OtherTasksPanel";
import {
  resolveInlineMediaMarkdown,
  type PendingInlineImage,
} from "./components/InlineMediaComposer";
import { LinearIcon } from "./components/LinearIcon";
import { ProjectAutomationMenu } from "./components/ProjectAutomationMenu";
import { TaskboardIcon } from "./components/TaskboardIcon";
import { TaskContextMenu } from "./components/TaskContextMenu";
import { TaskDetail } from "./components/TaskDetail";
import { FeishuBaseNavigator } from "./components/FeishuBaseNavigator";
import { FeishuWorkflowPanel } from "./components/FeishuWorkflowPanel";
import { FeishuPackageManager } from "./components/FeishuPackageManager";
import { BoardStageSettings } from "./components/BoardStageSettings";
import { UnifiedWorkflowStageSettings } from "./components/UnifiedWorkflowStageSettings";
import { UnifiedWorkflowViewControls } from "./components/UnifiedWorkflowViewControls";
import {
  addFeishuBaseFromUrl,
  removeFeishuBase,
  removeFeishuSubject,
  setFeishuSubjectDisabled,
  setFeishuSubjectDisplay,
} from "./feishuWorkflow";
import { TaskEditor, type NewTaskEditorDraft } from "./components/TaskEditor";
import { TaskFilterMenu } from "./components/TaskFilterMenu";
import { taskboardStorage } from "./storage";
import {
  installEmbeddedExternalLinkHandler,
  postEmbeddedHostMessage,
  setEmbeddedFrameChallenge,
} from "./embeddedHost.mjs";
import { buildIssueUrl, readIssueIdentifier } from "./issueRoute";
import {
  getTaskboardI18n,
  resolveTaskboardLanguage,
  TaskboardLanguageProvider,
} from "./i18n";
import {
  MAIN_STATUSES,
  type OtherTasksPanelTab,
} from "./issueBoardStatuses";
import { DEFAULT_LABELS } from "./labels";
import {
  normalizeCodexThreadId,
  taskCardPresentation,
  type TaskCardPresentation,
  type TaskConversationItem,
} from "./taskConversations";
import {
  EMPTY_TASK_FILTERS,
  matchesTaskFilters,
  matchesTaskSearch,
  readTaskFilters,
  taskFilterCount,
  writeTaskFilters,
} from "./taskFilters";
import {
  TASK_STATUSES,
  type ActorIdentity,
  type AiChatThread,
  type ArtifactUploadListItem,
  type DevelopmentScan,
  type HostContext,
  type IssueRelationType,
  type Project,
  type StageDisplayOverride,
  type Task,
  type TaskArtifactSummary,
  type TaskboardMetadata,
  type TaskDraft,
  type TaskStatus,
  type UnifiedWorkflowViewsState,
  type WorkflowOption,
} from "./types";
import {
  DEFAULT_WORKFLOW_OPTIONS,
  readLegacyWorkflowWorkspace,
  workflowOptionsFromWorkspace,
} from "./workflowStore";
// The poller stays in ESM JavaScript so its lifecycle can be tested directly with node:test.
// @ts-expect-error The module's option contract is enforced by its focused node tests.
import { createRevisionPoller, getRevisionPollingInterval } from "./revisionPolling.mjs";
// These selection rules stay runtime-independent so history navigation can be regression-tested.
// @ts-expect-error The helper's structural inputs are enforced at its call sites.
import { findFeishuSubjectKeyForProject, resolveProjectIdAfterRefresh } from "./projectSelection.mjs";
// The classifier is intentionally kept in ESM JavaScript so node:test can use it directly.
// @ts-expect-error The helper has no runtime-dependent TypeScript surface.
import { classifyUnifiedStage } from "./unifiedWorkflow.mjs";
// Browser-only board preferences are removed with the owning project.
// @ts-expect-error The helper's storage contract is covered by focused node tests.
import { clearUnifiedWorkflowLayoutsForProject } from "./unifiedWorkflowLayout.mjs";
// The drop predicate stays runtime-independent so it can be shared with focused node tests.
// @ts-expect-error The helper's structural contract is covered by node tests.
import { canDropUnifiedWorkflowTask } from "./unifiedWorkflowDropGuard.mjs";

type ConnectionState = "connecting" | "live" | "reconnecting";
type Theme = "light" | "dark";
type BoardView = "dashboard" | "issues" | "list" | "gantt" | "workflow" | "completed_editing"
  | "upload_queue" | "uploading" | "uploaded" | "autocut_packages";
type BoardColumnScrollKey = TaskStatus | UnifiedWorkflowStage;
type DetailSourceScroll =
  | {
    projectId: string;
    view: "issues";
    columnKey: BoardColumnScrollKey;
    scrollTop: number;
    scrollLeft: number;
  }
  | { projectId: string; view: "list" | "completed_editing"; scrollTop: number };
type GanttZoom = "day" | "week" | "month";
type ActionError = string | readonly [string, string];
const SHOW_WORKFLOW_BOARD_ENTRY = true;
const GANTT_ZOOM_OPTIONS: GanttZoom[] = ["day", "week", "month"];

function isFeishuWorkflowTask(task: Task): boolean {
  return task.feishuOrigin?.source === "feishu-base";
}

const WorkflowBoard = lazy(() => import("./components/WorkflowBoard").then((module) => ({
  default: module.WorkflowBoard,
})));
const GanttView = lazy(() => import("./components/GanttView").then((module) => ({
  default: module.GanttView,
})));

interface EditorState {
  task: Task | null;
  status: TaskStatus;
}

interface ContextMenuState {
  taskId: string;
  x: number;
  y: number;
}

interface ProjectChoice {
  id: string;
  name: string;
  issueCount: number;
  archivedIssueCount: number;
  archivedAt: string | null;
  source: Project["source"];
  inCodex: boolean;
  persisted: boolean;
}

interface ProjectContextMenuState {
  project: ProjectChoice;
  x: number;
  y: number;
}

interface ProjectDeleteAssociations {
  total: number;
  tasks: number;
}

interface UndoOperation {
  id: number;
  message: string;
  undo: () => Promise<void>;
}

interface UndoNotice {
  id: number;
  message: string;
}

type ProjectAutomationStatus = "ACTIVE" | "PAUSED";
type AutomationQuotaState = "available" | "blocked" | "unknown" | "unavailable";
type AutomationIntervalMinutes = 5 | 10 | 15 | 30 | 60;

interface AutomationQuotaStatus {
  state: AutomationQuotaState;
  checkedAt: number;
  resetsAt?: number;
  reason?: "api-key";
}

interface ProjectAutomationRecord {
  automationId?: string;
  codexProjectId: string;
  status: ProjectAutomationStatus;
  enabledByUser: boolean;
  quotaAware: boolean;
  quota?: AutomationQuotaStatus;
  intervalMinutes: AutomationIntervalMinutes;
  model: AutomationModel;
  reasoningEffort: AutomationReasoningEffort;
}

type ProjectAutomationOptions = Pick<
  ProjectAutomationRecord,
  "enabledByUser" | "quotaAware" | "intervalMinutes" | "model" | "reasoningEffort"
>;

interface AutomationRequestContext {
  taskboardProjectId: string;
  codexProjectId: string;
  projectName: string;
  workspacePath: string;
  skillPath: string;
}

interface QueuedProjectAutomationSave {
  projectId: string;
  context: AutomationRequestContext;
  options: ProjectAutomationOptions;
}

type ProjectAutomations = Record<string, ProjectAutomationRecord>;

interface AutomationHostItem {
  id: string;
  status: ProjectAutomationStatus;
  model: AutomationModel;
  reasoningEffort: AutomationReasoningEffort;
  rrule: string;
}

interface AutomationHostResponse {
  requestId: string;
  ok: boolean;
  item?: AutomationHostItem;
  items?: AutomationHostItem[];
  quota?: AutomationQuotaStatus;
  policy?: {
    automationId?: string;
    enabledByUser: boolean;
    quotaAware: boolean;
    intervalMinutes: AutomationIntervalMinutes;
    model: AutomationModel;
    reasoningEffort: AutomationReasoningEffort;
  };
  error?: string;
}

interface PendingAutomationRequest {
  resolve: (response: AutomationHostResponse) => void;
  reject: (error: Error) => void;
  timeoutId: number;
}

const DEFAULT_USER_ACTOR: ActorIdentity = {
  type: "user",
  id: "local-user",
  name: "本地用户",
  avatarUrl: null,
};

const GLOBAL_PROJECT_ID = "local";
const RECENT_PROJECT_IDS_KEY = "taskboard.recentProjectIds.v1";
const PROJECT_VIEW_KEY_PREFIX = "taskboard.project-view.v1.";
const DEVICE_WORKSPACE_PATHS_KEY = "taskboard.deviceWorkspacePaths.v1";
const PROJECT_AUTOMATIONS_KEY = "taskboard.projectAutomations.v1";
const ISSUE_READ_KEY_PREFIX = "taskboard.issue-read.v1";
const FIRST_USE_COMPLETE_KEY = "taskboard.first-use-complete.v1";
const DEFAULT_AUTOMATION_OPTIONS = {
  enabledByUser: false,
  quotaAware: false,
  intervalMinutes: 5,
  model: "gpt-5.5",
  reasoningEffort: "high",
} as const;

function readIssueActivityKeys(storageKey: string): Record<string, string> {
  try {
    const value = JSON.parse(taskboardStorage.getItem(storageKey) ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => (
      typeof entry[0] === "string" && typeof entry[1] === "string"
    )));
  } catch {
    return {};
  }
}

function readProjectBoardView(projectId: string): BoardView {
  const view = taskboardStorage.getItem(`${PROJECT_VIEW_KEY_PREFIX}${projectId}`);
  if (view === "completed_editing" || view === "upload_queue" || view === "uploading" || view === "uploaded") {
    // These views predate the single Feishu workflow board. Keep the stored
    // value readable for older clients, but open the project in the unified view.
    taskboardStorage.setItem(`${PROJECT_VIEW_KEY_PREFIX}${projectId}`, "issues");
    return "issues";
  }
  return view === "dashboard" || view === "list" || view === "gantt" || view === "issues" || view === "completed_editing"
    || view === "upload_queue" || view === "uploading" || view === "uploaded" || view === "workflow" || view === "autocut_packages"
    ? view
    : "issues";
}

function readRecentProjectIds(): string[] {
  try {
    const value = JSON.parse(taskboardStorage.getItem(RECENT_PROJECT_IDS_KEY) ?? "[]");
    return Array.isArray(value)
      ? value.filter((projectId): projectId is string => typeof projectId === "string" && projectId.length > 0)
      : [];
  } catch {
    return [];
  }
}

const EVENT_NAMES = [
  "task.created",
  "task.updated",
  "task.moved",
  "task.archived",
  "task.restored",
  "task.deleted",
  "task.relation.updated",
  "comment.created",
  "comment.updated",
  "comment.deleted",
  "attachment.created",
  "attachment.deleted",
  "artifact.created",
  "artifact.deleted",
  "artifact.upload.updated",
  "autocut.package.updated",
  "board-stage-labels.updated",
  "project.created",
  "project.updated",
  "workflow.updated",
] as const;

function isTheme(value: unknown): value is Theme {
  return value === "light" || value === "dark";
}

function getInitialTheme(): Theme {
  const fromQuery = new URLSearchParams(window.location.search).get("theme");
  if (isTheme(fromQuery)) return fromQuery;
  const stored = taskboardStorage.getItem("taskboard.theme");
  if (isTheme(stored)) return stored;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function readDeviceWorkspacePaths(): Record<string, string> {
  try {
    const value = JSON.parse(taskboardStorage.getItem(DEVICE_WORKSPACE_PATHS_KEY) ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => (
      typeof entry[1] === "string" && entry[1].trim().length > 0
    )));
  } catch {
    return {};
  }
}

function readProjectAutomations(): ProjectAutomations {
  try {
    const value = JSON.parse(taskboardStorage.getItem(PROJECT_AUTOMATIONS_KEY) ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const result: ProjectAutomations = {};
    for (const [projectId, record] of Object.entries(value)) {
      if (!record || typeof record !== "object" || Array.isArray(record)) continue;
      const candidate = record as Partial<ProjectAutomationRecord>;
      const model = candidate.model ?? "gpt-5.5";
      const reasoningEffort = candidate.reasoningEffort ?? "high";
      const enabledByUser = candidate.enabledByUser ?? candidate.status === "ACTIVE";
      const quotaAware = candidate.quotaAware ?? false;
      if (
        (candidate.automationId !== undefined && typeof candidate.automationId !== "string")
        || typeof candidate.codexProjectId !== "string"
        || (candidate.status !== "ACTIVE" && candidate.status !== "PAUSED")
        || !isAutomationIntervalMinutes(candidate.intervalMinutes ?? 5)
        || !isAutomationModel(model)
        || !isAutomationReasoningEffort(reasoningEffort)
        || !isSupportedModelEffort(model, reasoningEffort)
        || (candidate.status === "ACTIVE" && !candidate.automationId)
        || typeof enabledByUser !== "boolean"
        || typeof quotaAware !== "boolean"
      ) continue;
      const quota = isAutomationQuotaStatus(candidate.quota) ? candidate.quota : undefined;
      result[projectId] = {
        automationId: candidate.automationId,
        codexProjectId: candidate.codexProjectId,
        status: candidate.status,
        enabledByUser,
        quotaAware,
        ...(quota ? { quota } : {}),
        intervalMinutes: candidate.intervalMinutes ?? 5,
        model,
        reasoningEffort,
      };
    }
    return result;
  } catch {
    return {};
  }
}

function isAutomationQuotaStatus(value: unknown): value is AutomationQuotaStatus {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<AutomationQuotaStatus>;
  return (
    (candidate.state === "available"
      || candidate.state === "blocked"
      || candidate.state === "unknown"
      || candidate.state === "unavailable")
    && Number.isFinite(candidate.checkedAt)
    && (candidate.resetsAt === undefined || Number.isFinite(candidate.resetsAt))
    && (candidate.reason === undefined || candidate.reason === "api-key")
  );
}

function isAutomationHostPolicy(
  value: AutomationHostResponse["policy"] | undefined,
): value is NonNullable<AutomationHostResponse["policy"]> {
  return Boolean(
    value
    && (value.automationId === undefined || typeof value.automationId === "string")
    && typeof value.enabledByUser === "boolean"
    && typeof value.quotaAware === "boolean"
    && isAutomationIntervalMinutes(value.intervalMinutes)
    && isAutomationModel(value.model)
    && isAutomationReasoningEffort(value.reasoningEffort)
    && isSupportedModelEffort(value.model, value.reasoningEffort),
  );
}

function isAutomationIntervalMinutes(value: unknown): value is AutomationIntervalMinutes {
  return value === 5 || value === 10 || value === 15 || value === 30 || value === 60;
}

function intervalMinutesFromRrule(value: string): AutomationIntervalMinutes | null {
  const match = /^RRULE:FREQ=MINUTELY;INTERVAL=(5|10|15|30|60)$/.exec(value);
  return match ? Number(match[1]) as AutomationIntervalMinutes : null;
}

function workspaceName(path?: string): string | null {
  if (!path) return null;
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? path;
}

function isAutomationHostItem(value: unknown): value is AutomationHostItem {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Partial<AutomationHostItem>;
  return (
    typeof item.id === "string"
    && (item.status === "ACTIVE" || item.status === "PAUSED")
    && isAutomationModel(item.model)
    && isAutomationReasoningEffort(item.reasoningEffort)
    && isSupportedModelEffort(item.model, item.reasoningEffort)
    && typeof item.rrule === "string"
    && intervalMinutesFromRrule(item.rrule) !== null
  );
}

function isLocalTaskboardOrigin(origin: string): boolean {
  try {
    const { protocol, hostname } = new URL(origin);
    return (protocol === "http:" || protocol === "https:")
      && (hostname === "127.0.0.1" || hostname === "localhost");
  } catch {
    return false;
  }
}

function sortTasks(tasks: Task[]): Task[] {
  return [...tasks].sort(
    (left, right) => left.sortOrder - right.sortOrder || left.createdAt.localeCompare(right.createdAt),
  );
}

function taskToDraft(task: Task): TaskDraft {
  return {
    title: task.title,
    description: task.description,
    status: task.status,
    priority: task.priority,
    labels: task.labels,
    developmentContext: task.developmentContext,
    startDate: task.startDate,
    dueDate: task.dueDate,
    recurrence: task.recurrence,
  };
}

interface LocalRealtimeSyncProps {
  selectedProjectId: string;
  detailTaskId: string | null;
  refreshProjectList: () => Promise<void>;
  refreshTasks: (
    projectId: string,
    options?: { quiet?: boolean; signal?: AbortSignal },
  ) => Promise<void>;
  refreshArtifactUploads: (
    projectId: string,
    options?: { quiet?: boolean; signal?: AbortSignal },
  ) => Promise<void>;
  refreshWorkflowOptions: (projectId: string, signal?: AbortSignal) => Promise<void>;
  setConnection: Dispatch<SetStateAction<ConnectionState>>;
  setCommentsRevision: Dispatch<SetStateAction<number>>;
  setAttachmentsRevision: Dispatch<SetStateAction<number>>;
  setAutoCutPackagesRevision: Dispatch<SetStateAction<number>>;
  setBoardStageLabels: Dispatch<SetStateAction<import("./types").BoardStageLabels | null>>;
}

function LocalRealtimeSync({
  selectedProjectId,
  detailTaskId,
  refreshProjectList,
  refreshTasks,
  refreshArtifactUploads,
  refreshWorkflowOptions,
  setConnection,
  setCommentsRevision,
  setAttachmentsRevision,
  setAutoCutPackagesRevision,
  setBoardStageLabels,
}: LocalRealtimeSyncProps) {
  useEffect(() => {
    const source = new EventSource(resolveTaskboardUrl("/api/events"));
    let refreshTimer: number | undefined;
    let refreshProjectsPending = false;
    let refreshTasksPending = false;

    const scheduleRefresh = (options: { projects?: boolean; tasks?: boolean }) => {
      refreshProjectsPending ||= options.projects === true;
      refreshTasksPending ||= options.tasks === true;
      window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => {
        if (refreshProjectsPending) void refreshProjectList();
        if (refreshTasksPending && selectedProjectId) {
          void refreshTasks(selectedProjectId, { quiet: true });
        }
        refreshProjectsPending = false;
        refreshTasksPending = false;
      }, 120);
    };

    const handleEvent = (event: Event) => {
      const message = event as MessageEvent<string>;
      let payload: { projectId?: string; taskId?: string } = {};
      try {
        payload = JSON.parse(message.data) as { projectId?: string; taskId?: string };
      } catch {
        // A malformed event should not interrupt later updates.
      }
      const affectsSelectedProject = Boolean(selectedProjectId)
        && (!payload.projectId || payload.projectId === selectedProjectId);
      if (event.type === "project.created" || event.type === "project.updated") {
        scheduleRefresh({ projects: true });
        return;
      }
      if (event.type === "autocut.package.updated") {
        setAutoCutPackagesRevision((current) => current + 1);
        return;
      }
      if (event.type === "board-stage-labels.updated") {
        void getBoardStageLabels().then(setBoardStageLabels).catch(() => {});
        return;
      }
      if (event.type.startsWith("task.")) {
        scheduleRefresh({ projects: true, tasks: affectsSelectedProject });
        return;
      }
      if (!affectsSelectedProject) return;
      if (event.type === "workflow.updated") {
        if (selectedProjectId) void refreshWorkflowOptions(selectedProjectId);
        return;
      }
      if (event.type.startsWith("comment.")) {
        if (!detailTaskId || !payload.taskId || payload.taskId === detailTaskId) {
          setCommentsRevision((current) => current + 1);
        }
        scheduleRefresh({ tasks: true });
        return;
      }
      if (event.type.startsWith("attachment.") || event.type.startsWith("artifact.")) {
        if (event.type.startsWith("artifact.")) {
          void refreshArtifactUploads(selectedProjectId, { quiet: true });
        }
        if (!detailTaskId || !payload.taskId || payload.taskId === detailTaskId) {
          setAttachmentsRevision((current) => current + 1);
          if (event.type.startsWith("attachment.")) {
            setCommentsRevision((current) => current + 1);
          }
        }
      }
    };

    EVENT_NAMES.forEach((name) => source.addEventListener(name, handleEvent));
    source.onopen = () => {
      setConnection("live");
      scheduleRefresh({ projects: true, tasks: Boolean(selectedProjectId) });
      void getBoardStageLabels().then(setBoardStageLabels).catch(() => {});
      if (selectedProjectId) {
        void refreshArtifactUploads(selectedProjectId, { quiet: true });
        void refreshWorkflowOptions(selectedProjectId);
      }
      if (detailTaskId) {
        setCommentsRevision((current) => current + 1);
        setAttachmentsRevision((current) => current + 1);
      }
    };
    source.onerror = () => setConnection("reconnecting");

    return () => {
      window.clearTimeout(refreshTimer);
      EVENT_NAMES.forEach((name) => source.removeEventListener(name, handleEvent));
      source.close();
    };
  }, [
    detailTaskId,
    refreshProjectList,
    refreshArtifactUploads,
    refreshTasks,
    refreshWorkflowOptions,
    selectedProjectId,
    setAttachmentsRevision,
    setAutoCutPackagesRevision,
    setBoardStageLabels,
    setCommentsRevision,
    setConnection,
  ]);

  return null;
}

export function App() {
  const query = useMemo(() => new URL(document.baseURI).searchParams, []);
  const host = query.get("host");
  const embedded = host === "codex" || host === "workbuddy";
  const undoShortcut = navigator.userAgent.includes("Macintosh") ? "⌘Z" : "Ctrl+Z";
  const [theme, setTheme] = useState<Theme>(getInitialTheme);
  const [boardStageLabels, setBoardStageLabels] = useState<import("./types").BoardStageLabels | null>(null);
  const [hostContext, setHostContext] = useState<HostContext | null>(null);
  const language = resolveTaskboardLanguage(
    hostContext?.language ?? query.get("lang") ?? navigator.language,
  );
  const { locale, text, statusLabel } = getTaskboardI18n(language, boardStageLabels);
  const [embeddedFrameChallenge, setEmbeddedFrameChallengeState] = useState("");
  const [developmentScan, setDevelopmentScan] = useState<DevelopmentScan>({ workspacePath: null, contexts: [] });
  const [developmentScanLoading, setDevelopmentScanLoading] = useState(false);
  const [manageTaskboardSkillPath, setManageTaskboardSkillPath] = useState("");
  const [taskboardMetadata, setTaskboardMetadata] = useState<TaskboardMetadata | null>(null);
  const [localAiChatAvailable, setLocalAiChatAvailable] = useState(false);
  const [aiThreads, setAiThreads] = useState<AiChatThread[]>([]);
  const [aiOpenThreadRequest, setAiOpenThreadRequest] = useState<AiChatOpenThreadRequest | null>(null);
  const [readActivityKeys, setReadActivityKeys] = useState<Record<string, string>>({});
  const [codexThreadProgress, setCodexThreadProgress] = useState<
    Record<string, {
      completed: number | null;
      total: number | null;
      running: boolean;
    } | null>
  >({});
  const [processingNow, setProcessingNow] = useState(() => Date.now());
  const [recentProjectIds, setRecentProjectIds] = useState(readRecentProjectIds);
  const initialProjectId = query.get("project") ?? recentProjectIds[0] ?? GLOBAL_PROJECT_ID;
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState(initialProjectId);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [archivedTasks, setArchivedTasks] = useState<Task[]>([]);
  const [tasksLoading, setTasksLoading] = useState(false);
  const [hasLoadedTasks, setHasLoadedTasks] = useState(false);
  const [artifactUploadItems, setArtifactUploadItems] = useState<ArtifactUploadListItem[]>([]);
  const [taskArtifactSummaries, setTaskArtifactSummaries] = useState<TaskArtifactSummary[]>([]);
  const [artifactUploadsLoading, setArtifactUploadsLoading] = useState(false);
  const [artifactUploadsError, setArtifactUploadsError] = useState<string | null>(null);
  const [retryingArtifactUploadIds, setRetryingArtifactUploadIds] = useState<Set<string>>(() => new Set());
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<ActionError | null>(null);
  const actionErrorText = actionError === null
    ? null
    : typeof actionError === "string"
      ? actionError
      : text(actionError[0], actionError[1]);
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [search, setSearch] = useState("");
  const [filters, setFilters] = useState(readTaskFilters);
  const [boardView, setBoardView] = useState<BoardView>(() => readProjectBoardView(initialProjectId));
  const [dashboardSummaryAnimatedProjectId, setDashboardSummaryAnimatedProjectId] = useState<string | null>(null);
  const [ganttZoom, setGanttZoom] = useState<GanttZoom>("week");
  const [ganttHideCompleted, setGanttHideCompleted] = useState(false);
  const [ganttTodayRequest, setGanttTodayRequest] = useState(0);
  const [ganttViewMenuOpen, setGanttViewMenuOpen] = useState(false);
  const [otherTasksOpen, setOtherTasksOpen] = useState(false);
  const [otherTasksMounted, setOtherTasksMounted] = useState(false);
  const [otherTasksVisible, setOtherTasksVisible] = useState(false);
  const [otherTasksTab, setOtherTasksTab] = useState<OtherTasksPanelTab>("backlog");
  const [restoringTaskId, setRestoringTaskId] = useState<string | null>(null);
  const [pendingArchivedTaskDelete, setPendingArchivedTaskDelete] = useState<Task | null>(null);
  const [deletingArchivedTaskId, setDeletingArchivedTaskId] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [newTaskDraft, setNewTaskDraft] = useState<NewTaskEditorDraft | null>(null);
  const [detailTaskIdentifier, setDetailTaskIdentifier] = useState<string | null>(
    () => readIssueIdentifier(window.location.search),
  );
  const [commentsRevision, setCommentsRevision] = useState(0);
  const [attachmentsRevision, setAttachmentsRevision] = useState(0);
  const [workflowRevision, setWorkflowRevision] = useState(0);
  const [autoCutPackagesRevision, setAutoCutPackagesRevision] = useState(0);
  const [workflowOptions, setWorkflowOptions] = useState<WorkflowOption[]>(DEFAULT_WORKFLOW_OPTIONS);
  const [feishuCatalog, setFeishuCatalog] = useState<import("./types").FeishuBaseCatalog[]>([]);
  const [selectedFeishuSubjectKey, setSelectedFeishuSubjectKey] = useState<string | null>(null);
  const [feishuConfigurationBaseToken, setFeishuConfigurationBaseToken] = useState<string | null>(null);
  const [feishuConfigurationOpen, setFeishuConfigurationOpen] = useState(false);
  const [unifiedViewsState, setUnifiedViewsState] = useState<UnifiedWorkflowViewsState | null>(null);
  const unifiedViewsStateRef = useRef(unifiedViewsState);
  unifiedViewsStateRef.current = unifiedViewsState;
  const [unifiedStageDisplays, setUnifiedStageDisplays] = useState<StageDisplayOverride[]>([]);
  const [unifiedStageDisplaysLoadedFor, setUnifiedStageDisplaysLoadedFor] = useState<string | null>(null);
  const [unifiedViewsLoading, setUnifiedViewsLoading] = useState(false);
  const [unifiedViewsError, setUnifiedViewsError] = useState<string | null>(null);
  const [unifiedViewsReloadRevision, setUnifiedViewsReloadRevision] = useState(0);
  const [unifiedSearchScope, setUnifiedSearchScope] = useState<"activeView" | "allStages">("activeView");
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [draggedTaskId, setDraggedTaskId] = useState<string | null>(null);
  const [draggedTaskHeight, setDraggedTaskHeight] = useState(0);
  const [dropTarget, setDropTarget] = useState<TaskStatus | null>(null);
  const [movingTaskId, setMovingTaskId] = useState<string | null>(null);
  const [settlingTaskId, setSettlingTaskId] = useState<string | null>(null);
  const [openingProjectId, setOpeningProjectId] = useState<string | null>(null);
  const [openingThreadTaskId, setOpeningThreadTaskId] = useState<string | null>(null);
  const [startingCodexTaskId, setStartingCodexTaskId] = useState<string | null>(null);
  const [projectMenuOpen, setProjectMenuOpen] = useState(
    () => taskboardStorage.getItem(FIRST_USE_COMPLETE_KEY) === null,
  );
  const [projectHistoryOpen, setProjectHistoryOpen] = useState(false);
  const [projectLifecyclePendingId, setProjectLifecyclePendingId] = useState<string | null>(null);
  const [projectContextMenu, setProjectContextMenu] = useState<ProjectContextMenuState | null>(null);
  const [projectCreateOpen, setProjectCreateOpen] = useState(false);
  const [projectName, setProjectName] = useState("");
  const [pendingProjectDelete, setPendingProjectDelete] = useState<ProjectChoice | null>(null);
  const [projectDeleteAssociations, setProjectDeleteAssociations] = useState<ProjectDeleteAssociations | null>(null);
  const [deletingProjectId, setDeletingProjectId] = useState<string | null>(null);
  const [deviceWorkspacePaths, setDeviceWorkspacePaths] = useState(readDeviceWorkspacePaths);
  const [projectAutomations, setProjectAutomations] = useState(readProjectAutomations);
  const [automationPending, setAutomationPending] = useState(false);
  const [automationError, setAutomationError] = useState<string | null>(null);
  const [announcement, setAnnouncementValue] = useState("");
  const [undoNotice, setUndoNotice] = useState<UndoNotice | null>(null);
  const projectRequestGenerationRef = useRef(0);
  const projectRequestAbortControllerRef = useRef<AbortController | null>(null);
  const feishuCatalogRequestGenerationRef = useRef(0);
  const feishuCatalogAbortControllerRef = useRef<AbortController | null>(null);
  const unifiedViewsRequestGenerationRef = useRef(0);
  const unifiedViewsAbortControllerRef = useRef<AbortController | null>(null);
  const unifiedStageDisplaysRequestGenerationRef = useRef(0);
  const unifiedStageDisplaysAbortControllerRef = useRef<AbortController | null>(null);
  const tasksRequestRef = useRef(0);
  const artifactUploadsRequestRef = useRef(0);
  const retryingArtifactUploadIdsRef = useRef(new Set<string>());
  const tasksRef = useRef<Task[]>([]);
  const undoSequenceRef = useRef(0);
  const undoStackRef = useRef<UndoOperation[]>([]);
  const undoInFlightRef = useRef(false);
  const movingTaskRef = useRef<string | null>(null);
  const dragRegionRef = useRef<HTMLDivElement>(null);
  const issueListRef = useRef<HTMLDivElement>(null);
  const unifiedWorkflowScrollRef = useRef<HTMLDivElement>(null);
  const boardColumnScrollRefs = useRef<Partial<Record<BoardColumnScrollKey, HTMLDivElement | null>>>({});
  const pendingDetailSourceScrollRef = useRef<DetailSourceScroll | null>(null);
  const selectedProjectIdRef = useRef(selectedProjectId);
  selectedProjectIdRef.current = selectedProjectId;
  const selectedFeishuSubjectKeyRef = useRef(selectedFeishuSubjectKey);
  selectedFeishuSubjectKeyRef.current = selectedFeishuSubjectKey;
  const projectsRef = useRef(projects);
  projectsRef.current = projects;
  const feishuCatalogRef = useRef(feishuCatalog);
  feishuCatalogRef.current = feishuCatalog;

  const beginProjectRequestContext = useCallback((projectId: string, subjectKey: string | null) => {
    projectRequestAbortControllerRef.current?.abort();
    const controller = new AbortController();
    projectRequestAbortControllerRef.current = controller;
    selectedProjectIdRef.current = projectId;
    selectedFeishuSubjectKeyRef.current = subjectKey;
    return { controller, generation: ++projectRequestGenerationRef.current };
  }, []);

  function projectRequestIsCurrent(
    projectId: string,
    subjectKey: string | null,
    generation: number,
  ) {
    return generation === projectRequestGenerationRef.current
      && selectedProjectIdRef.current === projectId
      && selectedFeishuSubjectKeyRef.current === subjectKey;
  }

  useEffect(() => {
    const { controller } = beginProjectRequestContext(selectedProjectId, selectedFeishuSubjectKey);
    return () => controller.abort();
  }, [beginProjectRequestContext, selectedFeishuSubjectKey, selectedProjectId]);

  const revisionPollingInterval = getRevisionPollingInterval(taskboardMetadata);
  const textRef = useRef(text);
  textRef.current = text;
  setApiText(text);
  function errorMessage(error: unknown): string {
    if (error instanceof ApiError) return error.message;
    if (error instanceof Error) return error.message;
    return textRef.current(
      "加载议题时出现问题。",
      "Something went wrong while loading your issues.",
    );
  }
  const pendingAutomationRequestsRef = useRef(new Map<string, PendingAutomationRequest>());
  const automationRequestInFlightRef = useRef<"list" | "save" | null>(null);
  const loadedAutomationProjectIdsRef = useRef(new Set<string>());
  const queuedAutomationSavesRef = useRef(new Map<string, QueuedProjectAutomationSave>());
  const projectAutomationsRef = useRef(projectAutomations);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const setAnnouncement = useCallback((message: string) => {
    setUndoNotice(null);
    setAnnouncementValue(message);
  }, []);

  const markDashboardSummaryAnimationStarted = useCallback((projectId: string) => {
    setDashboardSummaryAnimatedProjectId(projectId);
  }, []);

  const rememberDeviceWorkspacePath = useCallback((projectId: string, workspacePath: string) => {
    if (projectId === GLOBAL_PROJECT_ID) return;
    const normalizedPath = workspacePath.trim();
    setDeviceWorkspacePaths((current) => {
      if (current[projectId] === normalizedPath || (!normalizedPath && !(projectId in current))) {
        return current;
      }
      const next = { ...current };
      if (normalizedPath) next[projectId] = normalizedPath;
      else delete next[projectId];
      taskboardStorage.setItem(DEVICE_WORKSPACE_PATHS_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const rememberProjectOpen = useCallback((projectId: string) => {
    setRecentProjectIds((current) => {
      if (current[0] === projectId) return current;
      const next = [projectId, ...current.filter((candidate) => candidate !== projectId)];
      taskboardStorage.setItem(RECENT_PROJECT_IDS_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const selectedProject = projects.find((project) => project.id === selectedProjectId) ?? null;
  const selectedFeishuSubject = useMemo(() => {
    const subjects = feishuCatalog.flatMap((base) => base.subjects);
    return subjects.find((subject) => (
      subject.projectId === selectedProjectId && subject.subjectKey === selectedFeishuSubjectKey
    ))
      ?? subjects.find((subject) => subject.projectId === selectedProjectId)
      ?? null;
  }, [feishuCatalog, selectedFeishuSubjectKey, selectedProjectId]);
  const selectedFeishuWorkflowSubjectKey = useMemo(() => (
    findFeishuSubjectKeyForProject(
      selectedProjectId,
      selectedFeishuSubject?.subjectKey ?? null,
      tasks,
      archivedTasks,
      selectedProject?.subjectKey ?? null,
    ) as string | null
  ), [archivedTasks, selectedFeishuSubject?.subjectKey, selectedProject?.subjectKey, selectedProjectId, tasks]);
  const selectedFeishuWorkflowSubjectKeyRef = useRef(selectedFeishuWorkflowSubjectKey);
  selectedFeishuWorkflowSubjectKeyRef.current = selectedFeishuWorkflowSubjectKey;
  const isSelectedFeishuProject = selectedProjectId !== GLOBAL_PROJECT_ID
    && (
      selectedProject?.source === "feishu"
      || Boolean(selectedFeishuSubject)
      || tasks.some((task) => task.projectId === selectedProjectId && isFeishuWorkflowTask(task))
    );
  useEffect(() => {
    if (!isSelectedFeishuProject && otherTasksTab === "ordinary") {
      setOtherTasksTab("backlog");
    }
  }, [isSelectedFeishuProject, otherTasksTab]);
  useLayoutEffect(() => {
    if (isSelectedFeishuProject && boardView === "workflow" && !feishuConfigurationOpen) {
      setBoardView("issues");
      taskboardStorage.setItem(`${PROJECT_VIEW_KEY_PREFIX}${selectedProjectId}`, "issues");
    }
  }, [boardView, feishuConfigurationOpen, isSelectedFeishuProject, selectedProjectId]);
  const unifiedWorkflowTasks = useMemo(() => {
    const projectTasks = tasks.filter((task) => task.projectId === selectedProjectId);
    if (!selectedFeishuWorkflowSubjectKey) return projectTasks;
    return projectTasks.filter((task) => (
      !task.feishuOrigin?.subjectKey
      || task.feishuOrigin.subjectKey === selectedFeishuWorkflowSubjectKey
    ));
  }, [selectedFeishuWorkflowSubjectKey, selectedProjectId, tasks]);
  useLayoutEffect(() => {
    if (selectedProject) rememberProjectOpen(selectedProject.id);
  }, [rememberProjectOpen, selectedProject]);
  const currentUser = hostContext?.user ?? {
    ...DEFAULT_USER_ACTOR,
    name: text("本地用户", "Local user"),
  };
  const selectedDeviceWorkspacePath = selectedProjectId === GLOBAL_PROJECT_ID
    ? undefined
    : deviceWorkspacePaths[selectedProjectId];
  const selectedProjectAutomation = projectAutomations[selectedProjectId];
  const automationProjectContext = useMemo(() => {
    if (!embedded || window.parent === window) {
      return { unavailableReason: text("仅可在 Codex App 中使用", "Available only in the Codex app") };
    }
    if (!isLocalTaskboardOrigin(new URL(document.baseURI).origin)) {
      return { unavailableReason: text("仅本地任务面板可用", "Available only on the local taskboard") };
    }
    if (!selectedProject) {
      return { unavailableReason: text("请先选择项目", "Select a project first") };
    }

    const directCodexProject = hostContext?.projects?.some(
      (project) => project.id === selectedProject.id,
    );
    const workspacePath = deviceWorkspacePaths[selectedProject.id]
      ?? selectedProject.workspacePath
      ?? (
        directCodexProject && hostContext?.projectId === selectedProject.id
          ? hostContext.workspacePath
          : undefined
      );
    const codexProjectId = directCodexProject
      ? selectedProject.id
      : hostContext?.projects?.find(
        (project) => deviceWorkspacePaths[project.id] === workspacePath,
      )?.id;

    if (!workspacePath || !codexProjectId) {
      return { unavailableReason: text(
        "请先在 Codex 中添加并映射该项目目录",
        "Add and map this project directory in Codex first",
      ) };
    }
    if (!manageTaskboardSkillPath) {
      return { unavailableReason: text(
        "任务面板还没有读取到 Skill 路径",
        "Taskboard has not received the Skill path",
      ) };
    }
    return { workspacePath, codexProjectId, unavailableReason: null };
  }, [
    deviceWorkspacePaths,
    embedded,
    hostContext,
    manageTaskboardSkillPath,
    selectedProject,
    text,
  ]);
  const automationRequestContext = useMemo<AutomationRequestContext | null>(() => {
    if (
      !selectedProject
      || !automationProjectContext.codexProjectId
      || !automationProjectContext.workspacePath
      || !manageTaskboardSkillPath
    ) return null;
    return {
      taskboardProjectId: selectedProject.id,
      codexProjectId: automationProjectContext.codexProjectId,
      projectName: selectedProject.name,
      workspacePath: automationProjectContext.workspacePath,
      skillPath: manageTaskboardSkillPath,
    };
  }, [automationProjectContext, manageTaskboardSkillPath, selectedProject]);
  const detailTask = detailTaskIdentifier
    ? tasks.find((task) => task.identifier === detailTaskIdentifier) ?? null
    : null;
  const detailTaskId = detailTask?.id ?? null;
  const contextMenuTask = contextMenu
    ? tasks.find((task) => task.id === contextMenu.taskId) ?? null
    : null;
  const availableLabels = useMemo(
    () => [...new Set([
      ...DEFAULT_LABELS.map((label) => label.name),
      ...tasks.flatMap((task) => task.labels),
    ])],
    [tasks],
  );
  const projectChoices = useMemo<ProjectChoice[]>(() => {
    const persistedById = new Map(projects.map((project) => [project.id, project]));
    const seen = new Set<string>();
    const choices: ProjectChoice[] = [];
    for (const project of hostContext?.projects ?? []) {
      if (!project.id || !project.name || seen.has(project.id)) continue;
      seen.add(project.id);
      choices.push({
        id: project.id,
        name: project.id === GLOBAL_PROJECT_ID
          ? text("全局", "Global")
          : persistedById.get(project.id)?.name ?? project.name,
        issueCount: persistedById.get(project.id)?.issueCount ?? 0,
        archivedIssueCount: persistedById.get(project.id)?.archivedIssueCount ?? 0,
        archivedAt: persistedById.get(project.id)?.archivedAt ?? null,
        source: persistedById.get(project.id)?.source ?? (project.id === GLOBAL_PROJECT_ID ? "global" : "local"),
        inCodex: true,
        persisted: persistedById.has(project.id),
      });
    }
    for (const project of projects) {
      if (seen.has(project.id)) continue;
      choices.push({
        id: project.id,
        name: project.id === GLOBAL_PROJECT_ID ? text("全局", "Global") : project.name,
        issueCount: project.issueCount,
        archivedIssueCount: project.archivedIssueCount,
        archivedAt: project.archivedAt,
        source: project.source,
        inCodex: false,
        persisted: true,
      });
    }
    const recentOrder = new Map(recentProjectIds.map((projectId, index) => [projectId, index]));
    return choices.sort((left, right) => (
      (recentOrder.get(left.id) ?? recentProjectIds.length)
      - (recentOrder.get(right.id) ?? recentProjectIds.length)
    ));
  }, [hostContext?.projects, projects, recentProjectIds, text]);
  const activeProjectChoices = useMemo(
    () => projectChoices.filter((project) => project.archivedAt === null),
    [projectChoices],
  );
  const historicalProjectChoices = useMemo(
    () => projectChoices.filter((project) => project.archivedAt !== null),
    [projectChoices],
  );
  const closeContextMenu = useCallback(() => setContextMenu(null), []);
  const issueReadStorageKey = selectedProjectId
    ? `${ISSUE_READ_KEY_PREFIX}:${taskboardMetadata?.mode ?? "local"}:${selectedProjectId}`
    : null;

  useEffect(() => {
    let mountFrame = 0;
    let showFrame = 0;
    let closeTimer = 0;

    if (otherTasksOpen) {
      setOtherTasksMounted(true);
      mountFrame = window.requestAnimationFrame(() => {
        showFrame = window.requestAnimationFrame(() => setOtherTasksVisible(true));
      });
    } else {
      setOtherTasksVisible(false);
      closeTimer = window.setTimeout(() => setOtherTasksMounted(false), 320);
    }

    return () => {
      window.cancelAnimationFrame(mountFrame);
      window.cancelAnimationFrame(showFrame);
      window.clearTimeout(closeTimer);
    };
  }, [otherTasksOpen]);

  useEffect(() => {
    setReadActivityKeys(issueReadStorageKey ? readIssueActivityKeys(issueReadStorageKey) : {});
  }, [issueReadStorageKey]);

  const markTaskRead = useCallback((task: Task) => {
    if (!issueReadStorageKey || !task.activityKey) return;
    setReadActivityKeys((current) => {
      if (current[task.id] === task.activityKey) return current;
      const next = { ...current, [task.id]: task.activityKey };
      try {
        taskboardStorage.setItem(issueReadStorageKey, JSON.stringify(next));
      } catch {
        // Read state remains valid for this page even when browser persistence is unavailable.
      }
      return next;
    });
  }, [issueReadStorageKey]);

  useEffect(() => {
    if (detailTask) markTaskRead(detailTask);
  }, [detailTask?.activityKey, detailTask?.id, markTaskRead]);

  const writeProjectAutomation = useCallback((
    projectId: string,
    record: ProjectAutomationRecord | null | undefined,
  ) => {
    setProjectAutomations((current) => {
      if (
        record
        && current[projectId]?.automationId === record.automationId
        && current[projectId]?.codexProjectId === record.codexProjectId
        && current[projectId]?.status === record.status
        && current[projectId]?.enabledByUser === record.enabledByUser
        && current[projectId]?.quotaAware === record.quotaAware
        && JSON.stringify(current[projectId]?.quota) === JSON.stringify(record.quota)
        && current[projectId]?.intervalMinutes === record.intervalMinutes
        && current[projectId]?.model === record.model
        && current[projectId]?.reasoningEffort === record.reasoningEffort
      ) {
        return current;
      }
      const next = { ...current };
      if (record) next[projectId] = record;
      else delete next[projectId];
      projectAutomationsRef.current = next;
      taskboardStorage.setItem(PROJECT_AUTOMATIONS_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const sendAutomationRequest = useCallback((
    operation: "ensure-active" | "pause" | "list" | "apply-policy",
    options: ProjectAutomationOptions,
    context: AutomationRequestContext,
    automationId?: string,
  ) => {
    const requestId = window.crypto.randomUUID();
    const response = new Promise<AutomationHostResponse>((resolve, reject) => {
      const timeoutId = window.setTimeout(() => {
        pendingAutomationRequestsRef.current.delete(requestId);
        reject(new Error(textRef.current(
          "Codex 自动化没有响应，请稍后重试",
          "Codex automation did not respond. Try again later.",
        )));
      }, 10_000);
      pendingAutomationRequestsRef.current.set(requestId, { resolve, reject, timeoutId });
    });
    postEmbeddedHostMessage({
      type: "taskboard:automation-request",
      payload: {
        requestId,
        operation,
        taskboardProjectId: context.taskboardProjectId,
        codexProjectId: context.codexProjectId,
        projectName: context.projectName,
        workspacePath: context.workspacePath,
        skillPath: context.skillPath,
        ...(automationId ? { automationId } : {}),
        enabledByUser: options.enabledByUser,
        quotaAware: options.quotaAware,
        intervalMinutes: options.intervalMinutes,
        model: options.model,
        reasoningEffort: options.reasoningEffort,
      },
    });
    return response;
  }, []);

  const drainQueuedAutomationSaves = useCallback(async (preferredProjectId?: string) => {
    if (automationRequestInFlightRef.current) return;
    let nextProjectId = preferredProjectId;
    while (queuedAutomationSavesRef.current.size > 0) {
      const queuedSave = (
        nextProjectId ? queuedAutomationSavesRef.current.get(nextProjectId) : undefined
      ) ?? queuedAutomationSavesRef.current.values().next().value;
      nextProjectId = undefined;
      if (!queuedSave) return;
      queuedAutomationSavesRef.current.delete(queuedSave.projectId);
      const previousRecord = projectAutomationsRef.current[queuedSave.projectId];
      automationRequestInFlightRef.current = "save";
      setAutomationPending(true);
      setAutomationError(null);
      try {
        const response = await sendAutomationRequest(
          "apply-policy",
          queuedSave.options,
          queuedSave.context,
          previousRecord?.automationId,
        );
        const item = isAutomationHostItem(response.item) ? response.item : undefined;
        writeProjectAutomation(queuedSave.projectId, {
          automationId: item?.id,
          codexProjectId: queuedSave.context.codexProjectId,
          status: item?.status ?? "PAUSED",
          enabledByUser: queuedSave.options.enabledByUser,
          quotaAware: queuedSave.options.quotaAware,
          ...(response.quota ? { quota: response.quota } : {}),
          intervalMinutes: queuedSave.options.intervalMinutes,
          model: queuedSave.options.model,
          reasoningEffort: queuedSave.options.reasoningEffort,
        });
      } catch (error) {
        writeProjectAutomation(queuedSave.projectId, previousRecord);
        setAutomationError(error instanceof Error
          ? error.message
          : textRef.current("无法更新自动化", "Could not update automation."));
      } finally {
        automationRequestInFlightRef.current = null;
        setAutomationPending(false);
      }
    }
  }, [sendAutomationRequest, writeProjectAutomation]);

  const reconcileProjectAutomation = useCallback(async () => {
    if (!automationRequestContext) {
      setAutomationError(null);
      return;
    }
    if (automationRequestInFlightRef.current) return;
    const projectId = automationRequestContext.taskboardProjectId;
    const stored = projectAutomationsRef.current[projectId];
    const initialLoad = !loadedAutomationProjectIdsRef.current.has(projectId);
    automationRequestInFlightRef.current = "list";
    if (initialLoad) setAutomationPending(true);
    setAutomationError(null);
    try {
      const options = stored ?? {
        status: "PAUSED" as const,
        ...DEFAULT_AUTOMATION_OPTIONS,
      };
      const response = await sendAutomationRequest(
        "list",
        options,
        automationRequestContext,
        stored?.automationId,
      );
      const items = Array.isArray(response.items)
        ? response.items.filter(isAutomationHostItem)
        : [];
      const policy = isAutomationHostPolicy(response.policy) ? response.policy : null;
      if (!stored) {
        if (!policy) return;
        const item = (isAutomationHostItem(response.item) ? response.item : undefined)
          ?? items.find((candidate) => candidate.id === policy.automationId)
          ?? (items.length === 1 ? items[0] : undefined);
        writeProjectAutomation(projectId, {
          automationId: item?.id ?? policy.automationId,
          codexProjectId: automationRequestContext.codexProjectId,
          status: item?.status ?? "PAUSED",
          enabledByUser: policy.enabledByUser,
          quotaAware: policy.quotaAware,
          ...(response.quota ? { quota: response.quota } : {}),
          intervalMinutes: policy.intervalMinutes,
          model: policy.model,
          reasoningEffort: policy.reasoningEffort,
        });
        return;
      }
      const item = (isAutomationHostItem(response.item) ? response.item : undefined)
        ?? items.find((item) => item.id === stored?.automationId)
        ?? (items.length === 1 ? items[0] : undefined);
      if (!item) {
        if (stored) {
          writeProjectAutomation(projectId, {
            ...stored,
            automationId: undefined,
            status: "PAUSED",
            enabledByUser: policy?.enabledByUser ?? stored.enabledByUser,
            quotaAware: policy?.quotaAware ?? stored.quotaAware,
            ...(response.quota ? { quota: response.quota } : {}),
          });
        }
        return;
      }
      const intervalMinutes = intervalMinutesFromRrule(item.rrule);
      if (!intervalMinutes) return;
      writeProjectAutomation(projectId, {
        automationId: item.id,
        codexProjectId: automationRequestContext.codexProjectId,
        status: item.status,
        enabledByUser: policy?.enabledByUser ?? stored.enabledByUser,
        quotaAware: policy?.quotaAware ?? stored.quotaAware,
        ...(
          response.quota
            ? { quota: response.quota }
            : stored.quota
              ? { quota: stored.quota }
              : {}
        ),
        intervalMinutes,
        model: item.model,
        reasoningEffort: item.reasoningEffort,
      });
    } catch (error) {
      setAutomationError(error instanceof Error
        ? error.message
        : text("无法读取自动化状态", "Could not read the automation status."));
    } finally {
      loadedAutomationProjectIdsRef.current.add(projectId);
      automationRequestInFlightRef.current = null;
      if (initialLoad) setAutomationPending(false);
      void drainQueuedAutomationSaves(projectId);
    }
  }, [
    automationRequestContext,
    drainQueuedAutomationSaves,
    sendAutomationRequest,
    text,
    writeProjectAutomation,
  ]);

  const saveProjectAutomation = useCallback((options: ProjectAutomationOptions) => {
    if (!automationRequestContext) return;
    const queuedSave = {
      projectId: automationRequestContext.taskboardProjectId,
      context: automationRequestContext,
      options,
    };
    queuedAutomationSavesRef.current.set(queuedSave.projectId, queuedSave);
    if (!automationRequestInFlightRef.current) {
      void drainQueuedAutomationSaves(queuedSave.projectId);
    }
  }, [
    automationRequestContext,
    drainQueuedAutomationSaves,
  ]);

  function detailColumnKey(task: Task, stage?: UnifiedWorkflowStage): BoardColumnScrollKey {
    if (stage) return stage;
    const uploads = artifactUploadItems.map((item) => item.upload);
    return (classifyUnifiedStage(task, uploads) as UnifiedWorkflowStage | null) ?? task.status;
  }

  function openTaskDetail(
    task: Pick<Task, "identifier" | "projectId">,
    stage?: UnifiedWorkflowStage,
  ) {
    const fullTask = tasksRef.current.find((candidate) => candidate.identifier === task.identifier);
    if (fullTask) markTaskRead(fullTask);
    if ((boardView === "list" || boardView === "completed_editing") && issueListRef.current) {
      pendingDetailSourceScrollRef.current = {
        projectId: selectedProjectId,
        view: boardView,
        scrollTop: issueListRef.current.scrollTop,
      };
    } else if (boardView === "issues" && fullTask) {
      const columnKey = detailColumnKey(fullTask, stage);
      const scrollContainer = boardColumnScrollRefs.current[columnKey];
      if (scrollContainer) {
        pendingDetailSourceScrollRef.current = {
          projectId: selectedProjectId,
          view: "issues",
          columnKey,
          scrollTop: scrollContainer.scrollTop,
          scrollLeft: unifiedWorkflowScrollRef.current?.scrollLeft ?? 0,
        };
      }
    }
    closeContextMenu();
    setProjectMenuOpen(false);
    setDetailTaskIdentifier(task.identifier);
    const currentIssue = readIssueIdentifier(window.location.search);
    const boardUrl = buildIssueUrl(window.location.href, task.projectId, null);
    if (!currentIssue) {
      window.history.replaceState(window.history.state, "", boardUrl);
    }
    const detailUrl = buildIssueUrl(
      currentIssue ? window.location.href : boardUrl.href,
      task.projectId,
      task.identifier,
    );
    window.history.pushState(window.history.state, "", detailUrl);
  }

  function closeTaskDetail() {
    setDetailTaskIdentifier(null);
    const url = buildIssueUrl(window.location.href, selectedProjectId || null, null);
    window.history.replaceState(window.history.state, "", url);
  }

  useLayoutEffect(() => {
    if (detailTaskIdentifier) return;
    const pendingScroll = pendingDetailSourceScrollRef.current;
    if (!pendingScroll) return;
    if (pendingScroll.view !== boardView || pendingScroll.projectId !== selectedProjectId) {
      pendingDetailSourceScrollRef.current = null;
      return;
    }
    const scrollContainer = pendingScroll.view === "issues"
      ? boardColumnScrollRefs.current[pendingScroll.columnKey]
      : issueListRef.current;
    if (pendingScroll.view === "issues" && unifiedWorkflowScrollRef.current) {
      unifiedWorkflowScrollRef.current.scrollLeft = pendingScroll.scrollLeft;
    }
    pendingDetailSourceScrollRef.current = null;
    if (!scrollContainer) return;
    scrollContainer.scrollTop = pendingScroll.scrollTop;
  }, [boardView, detailTaskIdentifier, selectedProjectId]);

  useEffect(() => {
    function syncRouteFromLocation() {
      const url = new URL(window.location.href);
      const routeProjectId = url.searchParams.get("project") ?? GLOBAL_PROJECT_ID;
      const routeIssueIdentifier = readIssueIdentifier(url.search);
      if (
        routeIssueIdentifier
        && (boardView === "list" || boardView === "completed_editing")
        && issueListRef.current
      ) {
        pendingDetailSourceScrollRef.current = {
          projectId: selectedProjectId,
          view: boardView,
          scrollTop: issueListRef.current.scrollTop,
        };
      } else if (routeIssueIdentifier && boardView === "issues") {
        const routeTask = tasksRef.current.find(
          (task) => task.identifier === routeIssueIdentifier,
        );
        const columnKey = routeTask ? detailColumnKey(routeTask) : null;
        const scrollContainer = columnKey ? boardColumnScrollRefs.current[columnKey] : null;
        if (routeTask && columnKey && scrollContainer) {
          pendingDetailSourceScrollRef.current = {
            projectId: selectedProjectId,
            view: "issues",
            columnKey,
            scrollTop: scrollContainer.scrollTop,
            scrollLeft: unifiedWorkflowScrollRef.current?.scrollLeft ?? 0,
          };
        }
      }
      setDetailTaskIdentifier(routeIssueIdentifier);
      if (routeProjectId === selectedProjectId) return;
      const routeSubject = feishuCatalogRef.current
        .flatMap((base) => base.subjects)
        .find((subject) => subject.projectId === routeProjectId);
      clearRemovedFeishuSelectionState();
      beginProjectRequestContext(routeProjectId, routeSubject?.subjectKey ?? null);
      setBoardView(readProjectBoardView(routeProjectId));
      setSelectedProjectId(routeProjectId);
      setSelectedFeishuSubjectKey(routeSubject?.subjectKey ?? null);
    }

    window.addEventListener("popstate", syncRouteFromLocation);
    return () => window.removeEventListener("popstate", syncRouteFromLocation);
  }, [artifactUploadItems, beginProjectRequestContext, boardView, selectedProjectId]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.embedded = String(embedded);
    document.documentElement.style.colorScheme = theme;
    if (!embedded) taskboardStorage.setItem("taskboard.theme", theme);
  }, [embedded, theme]);

  useEffect(() => {
    if (selectedProjectId) setBoardView(readProjectBoardView(selectedProjectId));
  }, [selectedProjectId]);

  useEffect(() => {
    if (!selectedProjectId) {
      setDashboardSummaryAnimatedProjectId(null);
    } else if (boardView !== "dashboard") {
      setDashboardSummaryAnimatedProjectId(selectedProjectId);
    }
  }, [boardView, selectedProjectId]);

  useEffect(() => {
    writeTaskFilters(filters);
  }, [filters]);

  useEffect(() => {
    tasksRef.current = tasks;
  }, [tasks]);

  useEffect(() => {
    if (taskboardStorage.getItem(FIRST_USE_COMPLETE_KEY) === null) {
      taskboardStorage.setItem(FIRST_USE_COMPLETE_KEY, "true");
    }
  }, []);

  useEffect(() => {
    if (!projectMenuOpen) return;
    function closeProjectMenu(event: PointerEvent) {
      const target = event.target as HTMLElement;
      if (!target.closest("[data-project-switcher]")) setProjectMenuOpen(false);
    }
    function closeProjectMenuWithEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setProjectMenuOpen(false);
    }
    document.addEventListener("pointerdown", closeProjectMenu);
    window.addEventListener("keydown", closeProjectMenuWithEscape);
    return () => {
      document.removeEventListener("pointerdown", closeProjectMenu);
      window.removeEventListener("keydown", closeProjectMenuWithEscape);
    };
  }, [projectMenuOpen]);

  useEffect(() => {
    if (!projectContextMenu) return;
    function closeProjectContextMenu(event: PointerEvent) {
      const target = event.target as HTMLElement;
      if (!target.closest("[data-project-context-menu]")) setProjectContextMenu(null);
    }
    function closeProjectContextMenuWithEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setProjectContextMenu(null);
    }
    document.addEventListener("pointerdown", closeProjectContextMenu);
    window.addEventListener("keydown", closeProjectContextMenuWithEscape);
    return () => {
      document.removeEventListener("pointerdown", closeProjectContextMenu);
      window.removeEventListener("keydown", closeProjectContextMenuWithEscape);
    };
  }, [projectContextMenu]);

  useEffect(() => {
    setAutomationError(null);
    void reconcileProjectAutomation();
  }, [selectedProjectId, reconcileProjectAutomation]);

  useEffect(() => {
    if (!embedded || window.parent === window) return;
    let acknowledgedFrameChallenge = "";

    function receiveHostMessage(event: MessageEvent) {
      if (event.source !== window.parent || !event.data || typeof event.data !== "object") return;
      const message = event.data as { type?: string; payload?: unknown; theme?: unknown };

      if (message.type === "taskboard:frame-challenge") {
        const challenge = typeof message.payload === "object"
          && message.payload
          && "challenge" in message.payload
          && typeof message.payload.challenge === "string"
          ? message.payload.challenge
          : "";
        if (!challenge || challenge === acknowledgedFrameChallenge) return;
        acknowledgedFrameChallenge = challenge;
        setEmbeddedFrameChallenge(challenge);
        setEmbeddedFrameChallengeState(challenge);
        postEmbeddedHostMessage({ type: "taskboard:ready" });
        return;
      }

      if (message.type === "taskboard:automation-response" && message.payload) {
        const payload = message.payload as Partial<AutomationHostResponse>;
        if (typeof payload.requestId !== "string") return;
        const pending = pendingAutomationRequestsRef.current.get(payload.requestId);
        if (!pending) return;
        window.clearTimeout(pending.timeoutId);
        pendingAutomationRequestsRef.current.delete(payload.requestId);
        if (payload.ok) pending.resolve(payload as AutomationHostResponse);
        else pending.reject(new Error(
          typeof payload.error === "string"
            ? payload.error
            : textRef.current("Codex 无法更新自动化", "Codex could not update automation"),
        ));
        return;
      }

      if (message.type === "taskboard:theme" && isTheme(message.theme)) {
        setTheme(message.theme);
        return;
      }

      if (message.type === "taskboard:thread-prepared") {
        setOpeningThreadTaskId(null);
        return;
      }

      if (message.type === "taskboard:thread-create-error" && message.payload) {
        const payload = message.payload as { taskId?: unknown; error?: unknown };
        setOpeningThreadTaskId(null);
        setActionError(typeof payload.error === "string"
          ? payload.error
          : textRef.current("无法在 Codex 中创建对话。", "Could not create the conversation in Codex."));
        return;
      }

      if (message.type !== "taskboard:host-context" || !message.payload) return;
      const payload = message.payload as HostContext;
      setHostContext(payload);
      setCurrentUserActor(payload.user);
      if (isTheme(payload.theme)) setTheme(payload.theme);
      if (host === "codex") void publishHostRuntime(payload);
    }

    const removeExternalLinkHandler = installEmbeddedExternalLinkHandler();
    window.addEventListener("message", receiveHostMessage);
    postEmbeddedHostMessage({ type: "taskboard:frame-awaiting-challenge" });
    return () => {
      window.removeEventListener("message", receiveHostMessage);
      setEmbeddedFrameChallenge("");
      removeExternalLinkHandler();
      for (const pending of pendingAutomationRequestsRef.current.values()) {
        window.clearTimeout(pending.timeoutId);
        pending.reject(new Error(textRef.current(
          "Taskboard 消息桥已关闭",
          "The Taskboard host bridge was closed",
        )));
      }
      pendingAutomationRequestsRef.current.clear();
    };
  }, [embedded, host]);

  useEffect(() => {
    if (host !== "workbuddy") return;
    let disposed = false;
    const syncRuntime = async () => {
      try {
        const runtime = await getHostRuntime();
        if (!disposed) setHostContext(runtime);
      } catch {}
    };
    void syncRuntime();
    const timer = window.setInterval(syncRuntime, 1_000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [host]);

  useLayoutEffect(() => {
    if (!embedded || window.parent === window || !dragRegionRef.current) return;
    const region = dragRegionRef.current;
    const publish = () => {
      const rect = region.getBoundingClientRect();
      postEmbeddedHostMessage({
        type: "taskboard:drag-region",
        payload: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      });
    };
    const observer = new ResizeObserver(publish);
    observer.observe(region);
    window.addEventListener("resize", publish);
    publish();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", publish);
      postEmbeddedHostMessage({ type: "taskboard:drag-region", payload: null });
    };
  }, [detailTaskId, embedded, embeddedFrameChallenge, selectedProjectId]);

  const loadProjectList = useCallback(async (signal?: AbortSignal) => {
    const requestGeneration = projectRequestGenerationRef.current;
    const projectId = selectedProjectIdRef.current;
    const subjectKey = selectedFeishuSubjectKeyRef.current;
    const requestSignal = signal ?? projectRequestAbortControllerRef.current?.signal;
    setLoadError(null);
    try {
      const [nextProjects, metadata, workspaces, stageLabels] = await Promise.all([
        listProjects({ includeArchived: true, signal: requestSignal }),
        getTaskboardMetadata(requestSignal),
        listDeviceWorkspaces(requestSignal),
        getBoardStageLabels(requestSignal),
      ]);
      if (requestGeneration !== projectRequestGenerationRef.current
        || selectedProjectIdRef.current !== projectId
        || selectedFeishuSubjectKeyRef.current !== subjectKey) return;
      setBoardStageLabels(stageLabels);
      setTaskboardMetadata((current) => (
        current
        && current.mode === metadata.mode
        && current.realtime?.transport === metadata.realtime?.transport
        && current.realtime?.intervalMs === metadata.realtime?.intervalMs
        && current.manageTaskboardSkillPath === metadata.manageTaskboardSkillPath
        && current.localCapabilities?.available === metadata.localCapabilities?.available
          ? current
          : metadata
      ));
      setManageTaskboardSkillPath(metadata.manageTaskboardSkillPath ?? "");
      setLocalAiChatAvailable(metadata.capabilities?.localAiChat === true);
      setDeviceWorkspacePaths((current) => {
        const next = { ...current, ...workspaces };
        delete next[GLOBAL_PROJECT_ID];
        if (JSON.stringify(next) === JSON.stringify(current)) return current;
        taskboardStorage.setItem(DEVICE_WORKSPACE_PATHS_KEY, JSON.stringify(next));
        return next;
      });
      setProjects(nextProjects);
      const fromQuery = new URLSearchParams(window.location.search).get("project");
      const nextProjectId = resolveProjectIdAfterRefresh(nextProjects, {
        requestedProjectId: fromQuery,
        currentProjectId: projectId,
        globalProjectId: GLOBAL_PROJECT_ID,
      }) as string;
      if (nextProjectId !== projectId) {
        const nextSubject = feishuCatalogRef.current
          .flatMap((base) => base.subjects)
          .find((subject) => subject.projectId === nextProjectId);
        beginProjectRequestContext(nextProjectId, nextSubject?.subjectKey ?? null);
        setSelectedProjectId(nextProjectId);
        setSelectedFeishuSubjectKey(nextSubject?.subjectKey ?? null);
      }
    } catch (error) {
      if ((error as Error).name !== "AbortError"
        && requestGeneration === projectRequestGenerationRef.current
        && selectedProjectIdRef.current === projectId
        && selectedFeishuSubjectKeyRef.current === subjectKey) {
        setLoadError(errorMessage(error));
      }
    }
  }, [beginProjectRequestContext]);

  useEffect(() => {
    void loadProjectList(projectRequestAbortControllerRef.current?.signal);
  }, [loadProjectList, selectedFeishuSubjectKey, selectedProjectId]);

  const refreshProjectList = useCallback(async () => {
    const requestGeneration = projectRequestGenerationRef.current;
    const projectId = selectedProjectIdRef.current;
    const subjectKey = selectedFeishuSubjectKeyRef.current;
    try {
      const nextProjects = await listProjects({
        includeArchived: true,
        signal: projectRequestAbortControllerRef.current?.signal,
      });
      if (requestGeneration !== projectRequestGenerationRef.current
        || selectedProjectIdRef.current !== projectId
        || selectedFeishuSubjectKeyRef.current !== subjectKey) return;
      setProjects(nextProjects);
    } catch (error) {
      if ((error as Error).name !== "AbortError"
        && requestGeneration === projectRequestGenerationRef.current
        && selectedProjectIdRef.current === projectId
        && selectedFeishuSubjectKeyRef.current === subjectKey) {
        setLoadError(errorMessage(error));
      }
    }
  }, [beginProjectRequestContext]);

  const refreshTasks = useCallback(async (
    projectId: string,
    options: { quiet?: boolean; signal?: AbortSignal } = {},
  ) => {
    const requestId = ++tasksRequestRef.current;
    const requestGeneration = projectRequestGenerationRef.current;
    const subjectKey = selectedFeishuSubjectKeyRef.current;
    const requestSignal = options.signal ?? projectRequestAbortControllerRef.current?.signal;
    if (!options.quiet) setTasksLoading(true);
    setLoadError(null);
    try {
      const [nextTasks, nextArchivedTasks] = await Promise.all([
        listTasks(projectId, requestSignal),
        listArchivedTasks(projectId, requestSignal),
      ]);
      if (requestId !== tasksRequestRef.current
        || requestGeneration !== projectRequestGenerationRef.current
        || selectedProjectIdRef.current !== projectId
        || selectedFeishuSubjectKeyRef.current !== subjectKey) return;
      setTasks(sortTasks(nextTasks));
      setArchivedTasks(sortTasks(nextArchivedTasks));
      setHasLoadedTasks(true);
    } catch (error) {
      if ((error as Error).name !== "AbortError"
        && requestId === tasksRequestRef.current
        && requestGeneration === projectRequestGenerationRef.current
        && selectedProjectIdRef.current === projectId
        && selectedFeishuSubjectKeyRef.current === subjectKey) {
        setLoadError(errorMessage(error));
      }
    } finally {
      if (!options.quiet
        && requestId === tasksRequestRef.current
        && requestGeneration === projectRequestGenerationRef.current
        && selectedProjectIdRef.current === projectId
        && selectedFeishuSubjectKeyRef.current === subjectKey) setTasksLoading(false);
    }
  }, []);

  const refreshArtifactUploads = useCallback(async (
    projectId: string,
    options: { quiet?: boolean; signal?: AbortSignal } = {},
  ) => {
    const requestId = ++artifactUploadsRequestRef.current;
    const requestGeneration = projectRequestGenerationRef.current;
    const subjectKey = selectedFeishuSubjectKeyRef.current;
    const requestSignal = options.signal ?? projectRequestAbortControllerRef.current?.signal;
    if (!options.quiet) setArtifactUploadsLoading(true);
    try {
      const [next, nextArtifactSummaries] = await Promise.all([
        listArtifactUploads(projectId, requestSignal),
        listTaskArtifactSummaries(projectId, requestSignal),
      ]);
      if (requestId !== artifactUploadsRequestRef.current
        || requestGeneration !== projectRequestGenerationRef.current
        || selectedProjectIdRef.current !== projectId
        || selectedFeishuSubjectKeyRef.current !== subjectKey) return;
      setArtifactUploadItems(next);
      setTaskArtifactSummaries(nextArtifactSummaries);
      setArtifactUploadsError(null);
    } catch (error) {
      if ((error as Error).name !== "AbortError"
        && requestId === artifactUploadsRequestRef.current
        && requestGeneration === projectRequestGenerationRef.current
        && selectedProjectIdRef.current === projectId
        && selectedFeishuSubjectKeyRef.current === subjectKey) {
        setArtifactUploadsError(errorMessage(error));
      }
    } finally {
      if (requestId === artifactUploadsRequestRef.current
        && requestGeneration === projectRequestGenerationRef.current
        && selectedProjectIdRef.current === projectId
        && selectedFeishuSubjectKeyRef.current === subjectKey) {
        setArtifactUploadsLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    if (!selectedProjectId) {
      setTasks([]);
      setArchivedTasks([]);
      setHasLoadedTasks(false);
      return;
    }
    setHasLoadedTasks(false);
    void refreshTasks(selectedProjectId, { signal: projectRequestAbortControllerRef.current?.signal });
  }, [refreshTasks, selectedFeishuSubjectKey, selectedProjectId]);

  useEffect(() => {
    if (!selectedProjectId) {
      setArtifactUploadItems([]);
      setTaskArtifactSummaries([]);
      setArtifactUploadsError(null);
      setArtifactUploadsLoading(false);
      return;
    }
    setArtifactUploadItems([]);
    setTaskArtifactSummaries([]);
    setArtifactUploadsError(null);
    void refreshArtifactUploads(selectedProjectId, { signal: projectRequestAbortControllerRef.current?.signal });
  }, [refreshArtifactUploads, selectedFeishuSubjectKey, selectedProjectId]);

  const refreshWorkflowOptions = useCallback(async (projectId: string, signal?: AbortSignal) => {
    const requestGeneration = projectRequestGenerationRef.current;
    const subjectKey = selectedFeishuSubjectKeyRef.current;
    const requestSignal = signal ?? projectRequestAbortControllerRef.current?.signal;
    const record = await getWorkflowWorkspace<unknown>(projectId, requestSignal);
    if (requestSignal?.aborted
      || !projectRequestIsCurrent(projectId, subjectKey, requestGeneration)) return;
    setWorkflowOptions(workflowOptionsFromWorkspace(record.workspace));
  }, []);

  useEffect(() => {
    if (!selectedProjectId) {
      setWorkflowOptions(DEFAULT_WORKFLOW_OPTIONS);
      return;
    }
    setWorkflowOptions(workflowOptionsFromWorkspace(readLegacyWorkflowWorkspace(selectedProjectId)));
    const controller = new AbortController();
    const subjectKey = selectedFeishuSubjectKeyRef.current;
    const requestGeneration = projectRequestGenerationRef.current;
    void refreshWorkflowOptions(selectedProjectId, controller.signal).catch((error) => {
      if ((error as Error).name !== "AbortError"
        && !controller.signal.aborted
        && projectRequestIsCurrent(selectedProjectId, subjectKey, requestGeneration)) {
        setWorkflowOptions(workflowOptionsFromWorkspace(readLegacyWorkflowWorkspace(selectedProjectId)));
      }
    });
    return () => controller.abort();
  }, [refreshWorkflowOptions, selectedFeishuSubjectKey, selectedProjectId]);

  useEffect(() => {
    unifiedViewsAbortControllerRef.current?.abort();
    const viewsController = new AbortController();
    unifiedViewsAbortControllerRef.current = viewsController;
    const viewsGeneration = ++unifiedViewsRequestGenerationRef.current;
    const subjectKey = selectedFeishuWorkflowSubjectKey;

    setUnifiedViewsState(null);
    setUnifiedViewsError(null);
    setUnifiedSearchScope("activeView");
    if (boardView !== "issues" || !subjectKey) {
      setUnifiedViewsLoading(false);
      return () => viewsController.abort();
    }

    setUnifiedViewsLoading(true);
    void getUnifiedWorkflowViews(subjectKey, viewsController.signal).then((viewsState) => {
      if (viewsController.signal.aborted
        || viewsGeneration !== unifiedViewsRequestGenerationRef.current
        || selectedFeishuWorkflowSubjectKeyRef.current !== subjectKey) return;
      setUnifiedViewsState(viewsState);
    }).catch((error) => {
      if ((error as Error).name === "AbortError"
        || viewsGeneration !== unifiedViewsRequestGenerationRef.current
        || selectedFeishuWorkflowSubjectKeyRef.current !== subjectKey) return;
      setUnifiedViewsError(errorMessage(error));
    }).finally(() => {
      if (viewsGeneration === unifiedViewsRequestGenerationRef.current
        && selectedFeishuWorkflowSubjectKeyRef.current === subjectKey) {
        setUnifiedViewsLoading(false);
      }
    });
    return () => viewsController.abort();
  }, [boardView, selectedFeishuWorkflowSubjectKey, unifiedViewsReloadRevision]);

  useEffect(() => {
    unifiedStageDisplaysAbortControllerRef.current?.abort();
    const controller = new AbortController();
    unifiedStageDisplaysAbortControllerRef.current = controller;
    const generation = ++unifiedStageDisplaysRequestGenerationRef.current;
    const subjectKey = selectedFeishuWorkflowSubjectKey;
    setUnifiedStageDisplays([]);
    setUnifiedStageDisplaysLoadedFor(null);
    if (!subjectKey || (boardView !== "issues" && boardView !== "workflow")) {
      return () => controller.abort();
    }
    void getUnifiedWorkflowStageDisplays(subjectKey, controller.signal)
      .then((stageDisplays) => {
        if (controller.signal.aborted
          || generation !== unifiedStageDisplaysRequestGenerationRef.current
          || selectedFeishuWorkflowSubjectKeyRef.current !== subjectKey) return;
        setUnifiedStageDisplays(stageDisplays);
        setUnifiedStageDisplaysLoadedFor(subjectKey);
      })
      .catch((error) => {
        if ((error as Error).name !== "AbortError"
          && generation === unifiedStageDisplaysRequestGenerationRef.current
          && selectedFeishuWorkflowSubjectKeyRef.current === subjectKey) {
          setActionError(errorMessage(error));
        }
      });
    return () => controller.abort();
  }, [boardView, selectedFeishuWorkflowSubjectKey]);

  useEffect(() => {
    feishuCatalogAbortControllerRef.current?.abort();
    const controller = new AbortController();
    feishuCatalogAbortControllerRef.current = controller;
    const catalogGeneration = ++feishuCatalogRequestGenerationRef.current;
    const projectId = selectedProjectIdRef.current;
    const subjectKey = selectedFeishuSubjectKeyRef.current;
    void listFeishuWorkflowCatalog(controller.signal)
      .then((catalog) => {
        if (controller.signal.aborted
          || catalogGeneration !== feishuCatalogRequestGenerationRef.current
          || selectedProjectIdRef.current !== projectId
          || selectedFeishuSubjectKeyRef.current !== subjectKey) return;
        setFeishuCatalog(catalog);
        setFeishuConfigurationBaseToken((current) => current && catalog.some((base) => base.baseToken === current)
          ? current
          : catalog.find((base) => base.subjects.some((subject) => subject.projectId === selectedProjectId))?.baseToken
            ?? catalog[0]?.baseToken
            ?? null);
        setSelectedFeishuSubjectKey((current) => current && catalog.flatMap((base) => base.subjects).some((subject) => subject.subjectKey === current)
          ? current
          : catalog.flatMap((base) => base.subjects).find((subject) => subject.projectId === selectedProjectId)?.subjectKey ?? null);
      })
      .catch(() => { /* Feishu is optional; ordinary projects remain unaffected. */ });
    return () => controller.abort();
  }, [selectedFeishuSubjectKey, selectedProjectId]);

  const addFeishuBaseAndRefreshProjects = useCallback(async (
    url: string,
  ): Promise<import("./types").FeishuBaseCatalog | void> => {
    const projectId = selectedProjectIdRef.current;
    const subjectKey = selectedFeishuSubjectKeyRef.current;
    const { controller: projectController, generation: requestGeneration } = beginProjectRequestContext(projectId, subjectKey);
    feishuCatalogAbortControllerRef.current?.abort();
    const catalogController = new AbortController();
    feishuCatalogAbortControllerRef.current = catalogController;
    const catalogGeneration = ++feishuCatalogRequestGenerationRef.current;
    try {
      const next = await addFeishuBaseFromUrl(url);
      const [nextProjects, nextCatalog] = await Promise.all([
        listProjects({ includeArchived: true, signal: projectController.signal }),
        listFeishuWorkflowCatalog(catalogController.signal),
      ]);
      if (requestGeneration !== projectRequestGenerationRef.current
        || catalogGeneration !== feishuCatalogRequestGenerationRef.current
        || selectedProjectIdRef.current !== projectId
        || selectedFeishuSubjectKeyRef.current !== subjectKey) {
        return;
      }
      setProjects(nextProjects);
      setFeishuCatalog(nextCatalog);
      void refreshTasks(projectId, { quiet: true, signal: projectController.signal });
      void refreshArtifactUploads(projectId, { quiet: true, signal: projectController.signal });
      return nextCatalog.find((base) => base.baseToken === next.baseToken) ?? next;
    } catch (error) {
      if ((error as Error).name === "AbortError"
        || requestGeneration !== projectRequestGenerationRef.current
        || catalogGeneration !== feishuCatalogRequestGenerationRef.current
        || selectedProjectIdRef.current !== projectId
        || selectedFeishuSubjectKeyRef.current !== subjectKey) return;
      throw error;
    }
  }, [beginProjectRequestContext, refreshArtifactUploads, refreshTasks]);

  const updateFeishuSubject = useCallback((subject: import("./types").FeishuSubjectConfig) => {
    setFeishuCatalog((catalog) => catalog.map((base) => ({
      ...base,
      subjects: base.subjects.map((item) => item.subjectKey === subject.subjectKey ? subject : item),
    })));
  }, []);

  const clearRemovedFeishuSelectionState = useCallback(() => {
    tasksRequestRef.current += 1;
    artifactUploadsRequestRef.current += 1;
    unifiedViewsAbortControllerRef.current?.abort();
    unifiedStageDisplaysAbortControllerRef.current?.abort();
    unifiedViewsRequestGenerationRef.current += 1;
    unifiedStageDisplaysRequestGenerationRef.current += 1;
    setDetailTaskIdentifier(null);
    setEditor(null);
    setNewTaskDraft(null);
    setContextMenu(null);
    setProjectContextMenu(null);
    setProjectMenuOpen(false);
    setDraggedTaskId(null);
    setDraggedTaskHeight(0);
    setDropTarget(null);
    movingTaskRef.current = null;
    setMovingTaskId(null);
    setSettlingTaskId(null);
    tasksRef.current = [];
    setTasks([]);
    setArchivedTasks([]);
    setHasLoadedTasks(false);
    setTasksLoading(false);
    setArtifactUploadItems([]);
    setTaskArtifactSummaries([]);
    setArtifactUploadsLoading(false);
    setArtifactUploadsError(null);
    setUnifiedViewsState(null);
    setUnifiedStageDisplays([]);
    setUnifiedStageDisplaysLoadedFor(null);
    setUnifiedViewsLoading(false);
    setUnifiedViewsError(null);
    setUnifiedSearchScope("activeView");
    retryingArtifactUploadIdsRef.current.clear();
    setRetryingArtifactUploadIds(new Set());
    setLoadError(null);
    setActionError(null);
    setOpeningThreadTaskId(null);
    setStartingCodexTaskId(null);
    pendingDetailSourceScrollRef.current = null;
    if (issueListRef.current) issueListRef.current.scrollTop = 0;
    if (unifiedWorkflowScrollRef.current) {
      unifiedWorkflowScrollRef.current.scrollTop = 0;
      unifiedWorkflowScrollRef.current.scrollLeft = 0;
    }
    for (const scrollContainer of Object.values(boardColumnScrollRefs.current)) {
      if (scrollContainer) scrollContainer.scrollTop = 0;
    }
    boardColumnScrollRefs.current = {};
    undoStackRef.current = [];
    setUndoNotice(null);
    setSearch("");
    setFilters(EMPTY_TASK_FILTERS);
  }, []);

  const applyRemovedFeishuCatalog = useCallback((
    nextCatalog: import("./types").FeishuBaseCatalog[],
    nextProjects: Project[],
    previousCatalog: import("./types").FeishuBaseCatalog[],
    previousProjects: Project[],
    projectId: string,
    subjectKey: string | null,
    requestGeneration: number,
    catalogGeneration: number,
  ) => {
    if (requestGeneration !== projectRequestGenerationRef.current
      || catalogGeneration !== feishuCatalogRequestGenerationRef.current
      || selectedProjectIdRef.current !== projectId
      || selectedFeishuSubjectKeyRef.current !== subjectKey) return;
    setFeishuCatalog(nextCatalog);
    setProjects(nextProjects);
    const subjectStillActive = subjectKey !== null && nextCatalog.some((base) => (
      base.subjects.some((subject) => subject.subjectKey === subjectKey)
    ));
    const projectStillActive = nextProjects.some((project) => (
      project.id === projectId && project.archivedAt === null
    ));
    if ((subjectKey === null || subjectStillActive) && projectStillActive) {
      setFeishuConfigurationBaseToken((current) => current && nextCatalog.some((base) => base.baseToken === current)
        ? current
        : nextCatalog[0]?.baseToken ?? null);
      return;
    }

    clearRemovedFeishuSelectionState();
    const previousBase = previousCatalog.find((base) => (
      base.subjects.some((subject) => subject.subjectKey === subjectKey)
    ));
    const previousVisibleSubjects = previousBase?.subjects.filter((subject) => subject.displayEnabled) ?? [];
    const removedSubjectIndex = previousVisibleSubjects.findIndex((subject) => subject.subjectKey === subjectKey);
    const sameBaseSubjects = nextCatalog.find((base) => base.baseToken === previousBase?.baseToken)
      ?.subjects.filter((subject) => subject.displayEnabled) ?? [];
    const sameBaseFallback = removedSubjectIndex >= 0 && sameBaseSubjects.length > 0
      ? sameBaseSubjects[Math.min(removedSubjectIndex, sameBaseSubjects.length - 1)]
      : sameBaseSubjects[0];
    const previousActiveProjects = previousProjects.filter((project) => (
      project.id !== GLOBAL_PROJECT_ID && project.archivedAt === null
    ));
    const removedProjectIndex = previousActiveProjects.findIndex((project) => project.id === projectId);
    const remainingActiveProjects = nextProjects.filter((project) => (
      project.id !== GLOBAL_PROJECT_ID && project.archivedAt === null
    ));
    const fallbackActiveProject = removedProjectIndex >= 0 && remainingActiveProjects.length > 0
      ? remainingActiveProjects[Math.min(removedProjectIndex, remainingActiveProjects.length - 1)]
      : remainingActiveProjects[0];
    const fallbackActiveSubject = fallbackActiveProject
      ? nextCatalog.flatMap((base) => base.subjects).find((subject) => (
        subject.displayEnabled && subject.projectId === fallbackActiveProject.id
      ))
      : null;
    const fallbackSubject = sameBaseFallback
      ?? fallbackActiveSubject
      ?? null;
    const fallbackProjectId = sameBaseFallback?.projectId
      ?? fallbackActiveProject?.id
      ?? GLOBAL_PROJECT_ID;
    const fallbackBaseToken = fallbackSubject
      ? nextCatalog.find((base) => base.subjects.some((subject) => subject.subjectKey === fallbackSubject.subjectKey))?.baseToken
      : null;
    beginProjectRequestContext(fallbackProjectId, fallbackSubject?.subjectKey ?? null);
    setSelectedProjectId(fallbackProjectId);
    setSelectedFeishuSubjectKey(fallbackSubject?.subjectKey ?? null);
    setFeishuConfigurationBaseToken(fallbackBaseToken ?? nextCatalog[0]?.baseToken ?? null);
    const fallbackView = fallbackSubject ? "issues" : readProjectBoardView(fallbackProjectId);
    setBoardView(fallbackView);
    if (fallbackSubject) taskboardStorage.setItem(`${PROJECT_VIEW_KEY_PREFIX}${fallbackProjectId}`, fallbackView);
    rememberProjectOpen(fallbackProjectId);
    const url = buildIssueUrl(window.location.href, fallbackProjectId, null);
    window.history.replaceState(null, "", url);
  }, [beginProjectRequestContext, clearRemovedFeishuSelectionState, rememberProjectOpen]);

  const runFeishuRemoval = useCallback(async (
    operation: () => Promise<import("./types").FeishuBaseCatalog[]>,
  ) => {
    const previousCatalog = feishuCatalogRef.current;
    const previousProjects = projectsRef.current;
    const projectId = selectedProjectIdRef.current;
    const subjectKey = selectedFeishuSubjectKeyRef.current;
    const { controller: projectController, generation: requestGeneration } = beginProjectRequestContext(projectId, subjectKey);
    feishuCatalogAbortControllerRef.current?.abort();
    const catalogController = new AbortController();
    feishuCatalogAbortControllerRef.current = catalogController;
    const catalogGeneration = ++feishuCatalogRequestGenerationRef.current;
    let nextCatalog: import("./types").FeishuBaseCatalog[];
    try {
      nextCatalog = await operation();
    } catch (error) {
      if (requestGeneration !== projectRequestGenerationRef.current
        || catalogGeneration !== feishuCatalogRequestGenerationRef.current
        || selectedProjectIdRef.current !== projectId
        || selectedFeishuSubjectKeyRef.current !== subjectKey) return;
      try {
        const [recoveredCatalog, nextProjects] = await Promise.all([
          listFeishuWorkflowCatalog(catalogController.signal),
          listProjects({ includeArchived: true, signal: projectController.signal }),
        ]);
        applyRemovedFeishuCatalog(
          recoveredCatalog,
          nextProjects,
          previousCatalog,
          previousProjects,
          projectId,
          subjectKey,
          requestGeneration,
          catalogGeneration,
        );
      } catch {
        // Preserve the removal error; the regular catalog poll will retry later.
      }
      throw error;
    }
    try {
      const nextProjects = await listProjects({ includeArchived: true, signal: projectController.signal });
      applyRemovedFeishuCatalog(
        nextCatalog,
        nextProjects,
        previousCatalog,
        previousProjects,
        projectId,
        subjectKey,
        requestGeneration,
        catalogGeneration,
      );
    } catch {
      if (requestGeneration !== projectRequestGenerationRef.current
        || catalogGeneration !== feishuCatalogRequestGenerationRef.current
        || selectedProjectIdRef.current !== projectId
        || selectedFeishuSubjectKeyRef.current !== subjectKey) return;
      try {
        const [recoveredCatalog, nextProjects] = await Promise.all([
          listFeishuWorkflowCatalog(catalogController.signal),
          listProjects({ includeArchived: true, signal: projectController.signal }),
        ]);
        applyRemovedFeishuCatalog(
          recoveredCatalog,
          nextProjects,
          previousCatalog,
          previousProjects,
          projectId,
          subjectKey,
          requestGeneration,
          catalogGeneration,
        );
      } catch {
        // Removal already committed; the regular catalog poll will retry later.
      }
    }
  }, [applyRemovedFeishuCatalog, beginProjectRequestContext]);

  useEffect(() => {
    if (!selectedProjectId) {
      setDevelopmentScan({ workspacePath: null, contexts: [] });
      return;
    }
    const controller = new AbortController();
    const projectId = selectedProjectId;
    const subjectKey = selectedFeishuSubjectKeyRef.current;
    const requestGeneration = projectRequestGenerationRef.current;
    const codexProjectId = projectId === GLOBAL_PROJECT_ID ? hostContext?.projectId : projectId;
    const codexThreadId = hostContext?.threadId ?? detailTask?.threadId ?? undefined;
    setDevelopmentScan({ workspacePath: selectedDeviceWorkspacePath ?? null, contexts: [] });
    setDevelopmentScanLoading(true);
    void listDevelopmentContexts(
      projectId,
      codexProjectId,
      codexThreadId,
      controller.signal,
      selectedDeviceWorkspacePath,
    )
      .then((scan) => {
        if (controller.signal.aborted
          || !projectRequestIsCurrent(projectId, subjectKey, requestGeneration)) return;
        setDevelopmentScan(scan);
        if (scan.workspacePath) rememberDeviceWorkspacePath(projectId, scan.workspacePath);
      })
      .catch((error) => {
        if ((error as Error).name !== "AbortError"
          && projectRequestIsCurrent(projectId, subjectKey, requestGeneration)) {
          setDevelopmentScan({ workspacePath: selectedDeviceWorkspacePath ?? null, contexts: [] });
        }
      })
      .finally(() => {
        if (!controller.signal.aborted
          && projectRequestIsCurrent(projectId, subjectKey, requestGeneration)) {
          setDevelopmentScanLoading(false);
        }
      });
    return () => controller.abort();
  }, [
    detailTask?.threadId,
    hostContext?.projectId,
    hostContext?.threadId,
    rememberDeviceWorkspacePath,
    selectedProjectId,
    selectedDeviceWorkspacePath,
  ]);

  useEffect(() => {
    if (revisionPollingInterval === null) return;
    const controller = new AbortController();
    setConnection("connecting");
    const poller = createRevisionPoller({
      intervalMs: revisionPollingInterval,
      fetchRevision: async (since: number) => {
        try {
          const result = await getTaskboardRevision(since, controller.signal);
          setConnection("live");
          return result;
        } catch (error) {
          if (!controller.signal.aborted) setConnection("reconnecting");
          throw error;
        }
      },
      onInvalidate: () => {
        void refreshProjectList();
        void getBoardStageLabels().then(setBoardStageLabels).catch(() => {});
        const projectId = selectedProjectIdRef.current;
        if (projectId) {
          void refreshTasks(projectId, { quiet: true });
          void refreshArtifactUploads(projectId, { quiet: true });
          void refreshWorkflowOptions(projectId).catch(() => {});
        }
        setWorkflowRevision((current) => current + 1);
        setCommentsRevision((current) => current + 1);
        setAttachmentsRevision((current) => current + 1);
      },
    });
    poller.start();
    return () => {
      controller.abort();
      poller.stop();
    };
  }, [
    revisionPollingInterval,
    refreshProjectList,
    refreshArtifactUploads,
    refreshTasks,
    refreshWorkflowOptions,
  ]);

  function pushUndo(message: string, undo: () => Promise<void>) {
    const operation = { id: ++undoSequenceRef.current, message, undo };
    undoStackRef.current = [...undoStackRef.current.slice(-19), operation];
    setAnnouncementValue("");
    setUndoNotice({ id: operation.id, message });
  }

  async function performUndo() {
    if (undoInFlightRef.current) return;
    const operation = undoStackRef.current.at(-1);
    if (!operation) return;
    undoStackRef.current = undoStackRef.current.slice(0, -1);
    undoInFlightRef.current = true;
    setUndoNotice(null);
    setProjectMenuOpen(false);
    closeContextMenu();
    setActionError(null);
    try {
      await operation.undo();
    } catch (error) {
      setActionError(text(
        `无法撤回这次操作：${errorMessage(error)}`,
        `Could not undo this action: ${errorMessage(error)}`,
      ));
      if (selectedProjectId) void refreshTasks(selectedProjectId, { quiet: true });
    } finally {
      undoInFlightRef.current = false;
    }
  }

  async function restoreTaskDetails(
    snapshot: Task,
    changed: Task,
    assigneeTarget = assigneeTargetForActor(snapshot.assignee, currentUser),
  ) {
    const candidate = tasksRef.current.find((task) => task.id === changed.id);
    const current = candidate && candidate.version >= changed.version ? candidate : changed;
    const restored = await updateTaskRequest(current, {
      ...taskToDraft(snapshot),
      ...(assigneeTarget ? { assigneeTarget } : {}),
    });
    setTasks((tasks) => sortTasks(tasks.map((task) => task.id === restored.id ? restored : task)));
  }

  useEffect(() => {
    function handleShortcut(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const isTyping = target?.matches("input, textarea, select, [contenteditable='true']");
      if (
        event.key.toLowerCase() === "z"
        && (event.metaKey || event.ctrlKey)
        && !event.shiftKey
        && !isTyping
        && !editor
      ) {
        event.preventDefault();
        void performUndo();
        return;
      }
      if (isTyping || contextMenu || projectMenuOpen) return;
      if (
        event.key.toLowerCase() === "c"
        && !event.metaKey
        && !event.ctrlKey
        && selectedProjectId
        && boardView !== "workflow"
        && boardView !== "completed_editing"
        && boardView !== "upload_queue"
        && boardView !== "uploading"
        && boardView !== "uploaded"
        && boardView !== "autocut_packages"
      ) {
        event.preventDefault();
        setEditor({ task: null, status: "todo" });
      }
      if (
        event.key === "/"
        && !detailTaskId
        && selectedProjectId
        && (
          boardView === "issues" || boardView === "list" || boardView === "gantt"
          || boardView === "completed_editing" || boardView === "upload_queue"
          || boardView === "uploading" || boardView === "uploaded"
        )
      ) {
        event.preventDefault();
        document.getElementById("task-search")?.focus();
      }
      if (event.key === "Escape" && detailTaskId) {
        closeTaskDetail();
      }
    }

    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [boardView, contextMenu, detailTaskId, editor, projectMenuOpen, selectedProjectId]);

  const filteredTasks = useMemo(() => {
    return tasks.filter(
      (task) => matchesTaskSearch(task, search, language) && matchesTaskFilters(task, filters),
    );
  }, [filters, language, search, tasks]);

  const filteredArchivedTasks = useMemo(() => archivedTasks.filter(
    (task) => matchesTaskSearch(task, search, language) && matchesTaskFilters(task, filters),
  ), [archivedTasks, filters, language, search]);

  // The unified Feishu board owns every active Feishu status. Keep secondary
  // Feishu statuses and ordinary tasks in distinct panel tabs so no task can
  // appear in both surfaces at once.
  const unifiedTasksByStatus = useMemo(() => {
    const scopedTaskIds = new Set(unifiedWorkflowTasks.map((task) => task.id));
    const grouped = Object.fromEntries(
      TASK_STATUSES.map((status) => [status, [] as Task[]]),
    ) as Record<TaskStatus, Task[]>;
    for (const task of filteredTasks) {
      if (!scopedTaskIds.has(task.id)) continue;
      if (!isFeishuWorkflowTask(task)) continue;
      if (!["backlog", "canceled"].includes(task.status)) continue;
      grouped[task.status].push(task);
    }
    return grouped;
  }, [filteredTasks, unifiedWorkflowTasks]);

  const unifiedOrdinaryTasks = useMemo(() => {
    const scopedTaskIds = new Set(unifiedWorkflowTasks.map((task) => task.id));
    return filteredTasks.filter((task) => (
      scopedTaskIds.has(task.id) && !isFeishuWorkflowTask(task)
    ));
  }, [filteredTasks, unifiedWorkflowTasks]);

  const unifiedArchivedTasks = useMemo(() => {
    const scoped = filteredArchivedTasks.filter((task) => task.projectId === selectedProjectId);
    if (!selectedFeishuWorkflowSubjectKey) return scoped;
    return scoped.filter((task) => (
      !task.feishuOrigin?.subjectKey
      || task.feishuOrigin.subjectKey === selectedFeishuWorkflowSubjectKey
    ));
  }, [filteredArchivedTasks, selectedFeishuWorkflowSubjectKey, selectedProjectId]);

  const completedEditingTasks = useMemo(() => filteredTasks.filter(
    (task) => task.status === "done" && isFeishuWorkflowTask(task),
  ), [filteredTasks]);

  const activeFilterCount = taskFilterCount(filters);
  const hasActiveTaskFilters = Boolean(search.trim()) || activeFilterCount > 0;

  const taskCodexThreadIds = useMemo(() => new Map(
    aiThreads
      .filter((thread) => thread.origin.issueId && thread.codexThreadId)
      .map((thread) => [thread.origin.issueId!, normalizeCodexThreadId(thread.codexThreadId)] as const)
      .filter((entry): entry is readonly [string, string] => Boolean(entry[1])),
  ), [aiThreads]);
  const trackedCodexThreadIds = useMemo(() => [...new Set(tasks
    .filter((task) => task.status === "in_progress")
    .map((task) => taskCodexThreadIds.get(task.id))
    .filter((threadId): threadId is string => Boolean(threadId))
  )].sort(), [taskCodexThreadIds, tasks]);
  const trackedCodexThreadIdsKey = trackedCodexThreadIds.join(",");

  useEffect(() => {
    if (trackedCodexThreadIds.length === 0) {
      setCodexThreadProgress({});
      return;
    }
    let disposed = false;
    const sync = async () => {
      try {
        const progress = await getCodexThreadProgress(trackedCodexThreadIds);
        if (!disposed) {
          setCodexThreadProgress((current) => (
            JSON.stringify(current) === JSON.stringify(progress) ? current : progress
          ));
        }
      } catch {}
    };
    void sync();
    const timer = window.setInterval(sync, 2_000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [trackedCodexThreadIdsKey]);

  const tasksByStatus = useMemo(() => {
    return Object.fromEntries(
      TASK_STATUSES.map((status) => [status, filteredTasks.filter((task) => task.status === status)]),
    ) as Record<TaskStatus, Task[]>;
  }, [filteredTasks]);

  const hasBlockedTasks = tasks.some((task) => task.status === "blocked");
  const mainStatuses = hasBlockedTasks
    ? MAIN_STATUSES
    : MAIN_STATUSES.filter((status) => status !== "blocked");
  const mainBoardMinWidth = (mainStatuses.length * 300) + ((mainStatuses.length - 1) * 24);
  const mainBoardMaxWidth = (mainStatuses.length * 400) + ((mainStatuses.length - 1) * 24);
  const otherTasksColumnCount = mainStatuses.length + 1;
  const otherTasksWidth = `clamp(300px, calc(${100 / otherTasksColumnCount}% - ${(36 + (mainStatuses.length * 24)) / otherTasksColumnCount}px), 400px)`;

  const taskPresentations = useMemo(() => Object.fromEntries(tasks.map((task) => {
    const unread = (task.status === "in_review" || task.status === "blocked")
      && readActivityKeys[task.id] !== task.activityKey;
    const runningNativeThreadId = hostContext?.threadRunning
      ? hostContext.threadId ?? null
      : null;
    const taskThreadId = taskCodexThreadIds.get(task.id);
    return [task.id, taskCardPresentation(
      task,
      aiThreads,
      unread,
      runningNativeThreadId,
      hostContext?.threadTodoProgress ?? null,
      taskThreadId ? codexThreadProgress[taskThreadId] ?? null : undefined,
    )];
  })) as Record<string, TaskCardPresentation>, [
    aiThreads,
    codexThreadProgress,
    hostContext?.threadId,
    hostContext?.threadRunning,
    hostContext?.threadTodoProgress,
    readActivityKeys,
    taskCodexThreadIds,
    tasks,
  ]);
  const hasRunningTask = useMemo(
    () => Object.values(taskPresentations).some((presentation) => presentation.processing.running),
    [taskPresentations],
  );

  useEffect(() => {
    setProcessingNow(Date.now());
    if (!hasRunningTask) return;
    const timer = window.setInterval(() => setProcessingNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [hasRunningTask]);


  function selectBoardView(view: BoardView) {
    endTaskDrag();
    closeContextMenu();
    setGanttViewMenuOpen(false);
    if (view === "autocut_packages") closeTaskDetail();
    if (view !== "workflow") setFeishuConfigurationOpen(false);
    setBoardView(view);
    if (selectedProjectId) {
      taskboardStorage.setItem(`${PROJECT_VIEW_KEY_PREFIX}${selectedProjectId}`, view);
    }
  }

  async function saveEditor(
    draft: TaskDraft,
    attachments: File[],
    inlineImages: PendingInlineImage[],
  ) {
    if (!selectedProjectId || !editor) return;
    const projectId = selectedProjectId;
    const editorSnapshot = editor;
    const subjectKey = selectedFeishuSubjectKeyRef.current;
    const requestGeneration = projectRequestGenerationRef.current;
    setActionError(null);
    try {
      const creating = editorSnapshot.task === null;
      let saved = editorSnapshot.task
        ? await updateTaskRequest(editorSnapshot.task, draft)
        : await createTaskRequest(projectId, draft);
      if (creating) {
        setProjects((current) => current.map((project) => (
          project.id === projectId
            ? { ...project, issueCount: project.issueCount + 1 }
            : project
        )));
      }
      let uploadedAttachments = 0;
      let failedAttachments = 0;
      if (creating && (attachments.length > 0 || inlineImages.length > 0)) {
        const [results, inlineAttachments] = await Promise.all([
          Promise.allSettled(
            attachments.map((file) => uploadAttachment(saved.id, file)),
          ),
          Promise.all(
            inlineImages.map((image) => uploadAttachment(saved.id, image.file)),
          ),
        ]);
        uploadedAttachments = results.filter((result) => result.status === "fulfilled").length;
        failedAttachments = results.length - uploadedAttachments;
        if (inlineImages.length > 0) {
          const description = resolveInlineMediaMarkdown(
            draft.description,
            inlineImages,
            inlineAttachments,
          );
          saved = await updateTaskRequest(saved, { ...draft, description });
        }
      }
      if (!projectRequestIsCurrent(projectId, subjectKey, requestGeneration)) return;
      setTasks((current) => sortTasks([
        ...current.filter((task) => task.id !== saved.id),
        saved,
      ]));
      if (creating) setNewTaskDraft(null);
      setEditor(null);
      if (failedAttachments > 0) {
        setActionError(text(
          `${saved.identifier} 已创建，但有 ${failedAttachments} 个附件上传失败，可在详情页重试。`,
          `${saved.identifier} was created, but ${failedAttachments} attachments failed to upload. Try again from the details page.`,
        ));
      }
      if (creating) {
        const totalUploaded = uploadedAttachments + inlineImages.length;
        const message = text(
          `${saved.identifier} 已创建${totalUploaded > 0 ? `，已上传 ${totalUploaded} 个附件` : ""}。`,
          `${saved.identifier} was created${totalUploaded > 0 ? ` with ${totalUploaded} attachments uploaded` : ""}.`,
        );
        pushUndo(message, async () => {
          const candidate = tasksRef.current.find((task) => task.id === saved.id);
          const current = candidate && candidate.version >= saved.version ? candidate : saved;
          await archiveTaskRequest(current);
          setTasks((tasks) => tasks.filter((task) => task.id !== saved.id));
        });
      } else if (editorSnapshot.task) {
        const previous = editorSnapshot.task;
        const previousAssigneeTarget = assigneeTargetForActor(previous.assignee, currentUser);
        if (!draft.assigneeTarget || previousAssigneeTarget) {
          pushUndo(
            text(`${saved.identifier} 已更新。`, `${saved.identifier} was updated.`),
            () => restoreTaskDetails(previous, saved, previousAssigneeTarget),
          );
        }
      }
    } catch (error) {
      if (error instanceof ApiError
        && error.code === "VERSION_CONFLICT"
        && projectRequestIsCurrent(projectId, subjectKey, requestGeneration)) {
        void refreshTasks(projectId, { quiet: true });
      }
      throw error;
    }
  }

  async function moveTask(
    task: Task,
    status: TaskStatus,
    beforeTaskId: string | null = null,
    useDropPosition = false,
  ) {
    if (
      task.projectId !== selectedProjectIdRef.current
      || (
        isFeishuWorkflowTask(task)
        && task.feishuOrigin?.subjectKey !== selectedFeishuWorkflowSubjectKeyRef.current
      )
    ) {
      setDropTarget(null);
      setDraggedTaskId(null);
      setDraggedTaskHeight(0);
      return;
    }
    if (movingTaskRef.current || movingTaskId) {
      setDropTarget(null);
      setDraggedTaskId(null);
      setDraggedTaskHeight(0);
      return;
    }

    const destination = tasks.filter((candidate) => candidate.status === status && candidate.id !== task.id);
    const statusChanged = task.status !== status;
    const insertionIndex = statusChanged && !useDropPosition
      ? 0
      : beforeTaskId
        ? destination.findIndex((candidate) => candidate.id === beforeTaskId)
        : destination.length;
    const targetIndex = insertionIndex < 0 ? destination.length : insertionIndex;
    const desiredOrder = [...destination];
    desiredOrder.splice(targetIndex, 0, task);
    const currentOrder = tasks.filter((candidate) => candidate.status === status);
    if (
      task.status === status
      && currentOrder.length === desiredOrder.length
      && currentOrder.every((candidate, index) => candidate.id === desiredOrder[index].id)
    ) {
      setDropTarget(null);
      setDraggedTaskId(null);
      setDraggedTaskHeight(0);
      return;
    }
    const previousTask = destination[targetIndex - 1] ?? null;
    const nextTask = destination[targetIndex] ?? null;
    const sortOrder = previousTask && nextTask
      ? (previousTask.sortOrder + nextTask.sortOrder) / 2
      : previousTask
        ? previousTask.sortOrder + 1024
        : nextTask
          ? nextTask.sortOrder - 1024
          : 1024;
    const previous = task;
    setActionError(null);
    movingTaskRef.current = task.id;
    setMovingTaskId(task.id);
    setTasks((current) => sortTasks(current.map((candidate) =>
      candidate.id === task.id ? { ...candidate, status, sortOrder } : candidate,
    )));

    try {
      const execution = task.status === "todo" && status === "in_progress" && isFeishuWorkflowTask(task)
        ? await executeTaskWithCodex(task, "move")
        : null;
      const moved = execution?.task ?? await moveTaskRequest(task, status, sortOrder);
      if (execution?.thread) {
        setAiThreads((current) => [
          execution.thread,
          ...current.filter((thread) => thread.id !== execution.thread.id),
        ]);
      }
      setTasks((current) => sortTasks(current.map((candidate) =>
        candidate.id === moved.id ? moved : candidate,
      )));
      const message = task.status === status
        ? text(`${task.identifier} 排序已调整。`, `${task.identifier} was reordered.`)
        : text(
          `${task.identifier} 已移至${statusLabel(status)}。`,
          `${task.identifier} was moved to ${statusLabel(status)}.`,
        );
      pushUndo(message, async () => {
        const candidate = tasksRef.current.find((current) => current.id === moved.id);
        const current = candidate && candidate.version >= moved.version ? candidate : moved;
        const restored = await moveTaskRequest(current, previous.status, previous.sortOrder);
        setTasks((tasks) => sortTasks(tasks.map((item) => item.id === restored.id ? restored : item)));
      });
    } catch (error) {
      setTasks((current) => sortTasks(current.map((candidate) =>
        candidate.id === previous.id ? previous : candidate,
      )));
      setActionError(error instanceof ApiError && error.code === "VERSION_CONFLICT"
        ? textRef.current(
          "该议题已在其他位置更新，看板已重新同步。",
          "This issue changed elsewhere. The board has been synced.",
        )
        : errorMessage(error));
      if (selectedProjectId) void refreshTasks(selectedProjectId, { quiet: true });
    } finally {
      if (movingTaskRef.current === task.id) movingTaskRef.current = null;
      setMovingTaskId(null);
      setDropTarget(null);
      setDraggedTaskId(null);
      setDraggedTaskHeight(0);
    }
  }

  function startTaskDrag(task: Task, height: number) {
    setDraggedTaskId(task.id);
    setDraggedTaskHeight(height);
    setDropTarget(task.status);
  }

  function endTaskDrag() {
    setDraggedTaskId(null);
    setDraggedTaskHeight(0);
    setDropTarget(null);
  }

  function finishTaskDrop(destination: TaskStatus, taskId: string, beforeTaskId: string | null = null, sourceSurface?: "board" | "other-tasks-panel" | "unified-board") {
    const task = tasksRef.current.find((candidate) => candidate.id === taskId);
    setDraggedTaskId(null);
    setDraggedTaskHeight(0);
    setDropTarget(null);
    if (!task) return;
    if (sourceSurface === "unified-board") {
      const projectId = selectedProjectIdRef.current;
      const subjectKey = selectedFeishuWorkflowSubjectKeyRef.current;
      const viewsState = unifiedViewsStateRef.current;
      const activeView = viewsState?.subjectKey === subjectKey
        ? viewsState.views.find((view) => view.id === viewsState.activeViewId)
        : undefined;
      const visibleStageIds = activeView?.stageIds ?? [];
      if (!canDropUnifiedWorkflowTask({
        projectId,
        subjectKey,
        visibleStageIds,
        task,
        targetStage: destination,
        sourceSurface,
      })) return;
    }
    setSettlingTaskId(task.id);
    window.setTimeout(() => {
      setSettlingTaskId((current) => current === task.id ? null : current);
    }, 220);
    void moveTask(task, destination, beforeTaskId, true);
  }

  async function updateTaskProperties(task: Task, changes: Partial<TaskDraft>): Promise<Task> {
    const previous = task;
    const { assigneeTarget, ...taskChanges } = changes;
    const optimisticAssignee = assigneeTarget
      ? actorForAssigneeTarget(assigneeTarget, currentUser)
      : task.assignee;
    const optimisticParticipants = assigneeTarget
      && !task.participants.some((participant) => actorKey(participant) === actorKey(optimisticAssignee))
      ? [...task.participants, optimisticAssignee]
      : task.participants;
    setActionError(null);
    setTasks((current) => current.map((candidate) =>
      candidate.id === task.id
        ? { ...candidate, ...taskChanges, assignee: optimisticAssignee, participants: optimisticParticipants }
        : candidate,
    ));

    try {
      const updated = await updateTaskRequest(task, { ...taskToDraft(task), ...changes });
      setTasks((current) => sortTasks(current.map((candidate) =>
        candidate.id === updated.id ? updated : candidate,
      )));
      const previousAssigneeTarget = assigneeTargetForActor(previous.assignee, currentUser);
      if (!assigneeTarget || previousAssigneeTarget) {
        pushUndo(
          text(`${task.identifier} 已更新。`, `${task.identifier} was updated.`),
          () => restoreTaskDetails(previous, updated, previousAssigneeTarget),
        );
      }
      return updated;
    } catch (error) {
      setTasks((current) => sortTasks(current.map((candidate) =>
        candidate.id === previous.id ? previous : candidate,
      )));
      setActionError(error instanceof ApiError && error.code === "VERSION_CONFLICT"
        ? text(
          "该议题已在其他位置更新，看板已重新同步。",
          "This issue changed elsewhere. The board has been synced.",
        )
        : errorMessage(error));
      if (selectedProjectId) void refreshTasks(selectedProjectId, { quiet: true });
      throw error;
    }
  }

  async function retryArtifactUploadFromBoard(item: ArtifactUploadListItem) {
    if (retryingArtifactUploadIdsRef.current.has(item.upload.id)) return;
    retryingArtifactUploadIdsRef.current.add(item.upload.id);
    setRetryingArtifactUploadIds(new Set(retryingArtifactUploadIdsRef.current));
    setActionError(null);
    try {
      const upload = await retryTaskArtifactUpload(item.task.id, item.upload.id);
      if (selectedProjectIdRef.current === item.task.projectId) {
        setArtifactUploadItems((current) => current.map((candidate) => (
          candidate.upload.id === upload.id
            ? { ...candidate, upload }
            : candidate
        )));
        void refreshArtifactUploads(item.task.projectId, { quiet: true });
      }
    } catch (error) {
      if (selectedProjectIdRef.current === item.task.projectId) {
        setActionError(errorMessage(error));
      }
    } finally {
      retryingArtifactUploadIdsRef.current.delete(item.upload.id);
      setRetryingArtifactUploadIds(new Set(retryingArtifactUploadIdsRef.current));
    }
  }

  function openFeishuConfiguration(baseToken?: string, subjectKey?: string) {
    const base = feishuCatalog.find((item) => item.baseToken === baseToken)
      ?? feishuCatalog.find((item) => item.subjects.some((subject) => subject.subjectKey === selectedFeishuSubjectKey))
      ?? feishuCatalog[0]
      ?? null;
    const subject = base?.subjects.find((item) => item.subjectKey === subjectKey)
      ?? base?.subjects.find((item) => item.subjectKey === selectedFeishuSubjectKey)
      ?? base?.subjects[0]
      ?? null;
    setFeishuConfigurationBaseToken(base?.baseToken ?? null);
    closeTaskDetail();
    if (subject) {
      changeProject(subject.projectId, "workflow");
      beginProjectRequestContext(subject.projectId, subject.subjectKey);
      setSelectedFeishuSubjectKey(subject.subjectKey);
      setFeishuConfigurationOpen(true);
    } else {
      setSelectedFeishuSubjectKey(null);
      selectBoardView("workflow");
      setFeishuConfigurationOpen(true);
    }
  }

  async function startCodexForTask(task: Task) {
    if (startingCodexTaskId) return;
    setStartingCodexTaskId(task.id);
    setActionError(null);
    try {
      const response = await startTaskWithCodex(task);
      setTasks((current) => sortTasks(current.map((candidate) => (
        candidate.id === response.task.id ? response.task : candidate
      ))));
      setAiThreads((current) => [
        response.thread,
        ...current.filter((thread) => thread.id !== response.thread.id),
      ]);
      setAiOpenThreadRequest((current) => ({
        threadId: response.thread.id,
        requestId: (current?.requestId ?? 0) + 1,
      }));
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setStartingCodexTaskId(null);
    }
  }

  async function mutateTaskRelation(
    action: "add" | "remove",
    task: Task,
    type: IssueRelationType,
    relatedTaskId: string,
  ) {
    setActionError(null);
    try {
      const result = action === "add"
        ? await addTaskRelation(task, type, relatedTaskId)
        : await removeTaskRelation(task, type, relatedTaskId);
      setTasks((current) => sortTasks(current.map((candidate) => {
        if (candidate.id === result.task.id) return result.task;
        if (candidate.id === result.relatedTask.id) return result.relatedTask;
        return candidate;
      })));
      if (selectedProjectId) void refreshTasks(selectedProjectId, { quiet: true });
      return result;
    } catch (error) {
      setActionError(error instanceof ApiError && error.code === "VERSION_CONFLICT"
        ? text(
          "该议题已在其他位置更新，看板已重新同步。",
          "This issue changed elsewhere. The board has been synced.",
        )
        : errorMessage(error));
      if (selectedProjectId) void refreshTasks(selectedProjectId, { quiet: true });
      throw error;
    }
  }

  async function duplicateTask(task: Task) {
    const projectId = task.projectId;
    const subjectKey = selectedFeishuSubjectKeyRef.current;
    const requestGeneration = projectRequestGenerationRef.current;
    setActionError(null);
    try {
      const duplicated = await createTaskRequest(projectId, {
        ...taskToDraft(task),
        assigneeTarget: assigneeTargetForActor(task.assignee, currentUser),
        developmentContext: null,
      });
      if (!projectRequestIsCurrent(projectId, subjectKey, requestGeneration)) return;
      setTasks((current) => sortTasks([...current, duplicated]));
      pushUndo(text(
        `${duplicated.identifier} 副本已创建。`,
        `${duplicated.identifier} copy was created.`,
      ), async () => {
        const candidate = tasksRef.current.find((current) => current.id === duplicated.id);
        const current = candidate && candidate.version >= duplicated.version ? candidate : duplicated;
        await archiveTaskRequest(current);
        setTasks((tasks) => tasks.filter((item) => item.id !== duplicated.id));
      });
    } catch (error) {
      if (projectRequestIsCurrent(projectId, subjectKey, requestGeneration)) {
        setActionError(errorMessage(error));
      }
    }
  }

  async function archiveTask(task: Task) {
    setActionError(null);
    try {
      const archived = await archiveTaskRequest(task);
      setTasks((current) => current.filter((candidate) => candidate.id !== task.id));
      setArchivedTasks((current) => sortTasks([
        ...current.filter((candidate) => candidate.id !== archived.id),
        archived,
      ]));
      pushUndo(text(`${task.identifier} 已归档。`, `${task.identifier} was archived.`), async () => {
        const restored = await restoreTaskRequest(archived);
        setArchivedTasks((current) => current.filter((candidate) => candidate.id !== restored.id));
        setTasks((current) => sortTasks([
          ...current.filter((candidate) => candidate.id !== restored.id),
          restored,
        ]));
      });
    } catch (error) {
      setActionError(error instanceof ApiError && error.code === "VERSION_CONFLICT"
        ? text(
          "该议题已在其他位置更新，看板已重新同步。",
          "This issue changed elsewhere. The board has been synced.",
        )
        : errorMessage(error));
      if (selectedProjectId) void refreshTasks(selectedProjectId, { quiet: true });
    }
  }

  async function restoreArchivedTask(task: Task) {
    setActionError(null);
    setRestoringTaskId(task.id);
    try {
      const restored = await restoreTaskRequest(task);
      setArchivedTasks((current) => current.filter((candidate) => candidate.id !== restored.id));
      setTasks((current) => sortTasks([
        ...current.filter((candidate) => candidate.id !== restored.id),
        restored,
      ]));
      setAnnouncement(text(
        `${restored.identifier} 已恢复。`,
        `${restored.identifier} was restored.`,
      ));
    } catch (error) {
      setActionError(error instanceof ApiError && error.code === "VERSION_CONFLICT"
        ? text(
          "该议题已在其他位置更新，看板已重新同步。",
          "This issue changed elsewhere. The board has been synced.",
        )
        : errorMessage(error));
      if (selectedProjectId) void refreshTasks(selectedProjectId, { quiet: true });
    } finally {
      setRestoringTaskId(null);
    }
  }

  async function deletePendingArchivedTask() {
    if (!pendingArchivedTaskDelete || deletingArchivedTaskId) return;
    const task = pendingArchivedTaskDelete;
    setActionError(null);
    setDeletingArchivedTaskId(task.id);
    try {
      await deleteArchivedTaskRequest(task);
      setArchivedTasks((current) => current.filter((candidate) => candidate.id !== task.id));
      setPendingArchivedTaskDelete(null);
      setAnnouncement(text(
        `${task.identifier} 已永久删除。`,
        `${task.identifier} was permanently deleted.`,
      ));
    } catch (error) {
      setActionError(error instanceof ApiError && error.code === "VERSION_CONFLICT"
        ? text(
          "该议题已在其他位置更新，看板已重新同步。",
          "This issue changed elsewhere. The board has been synced.",
        )
        : errorMessage(error));
      if (selectedProjectId) void refreshTasks(selectedProjectId, { quiet: true });
    } finally {
      setDeletingArchivedTaskId(null);
    }
  }

  async function copyText(content: string, message: string) {
    try {
      await navigator.clipboard.writeText(content);
      setAnnouncement(message);
    } catch {
      setActionError(text("无法写入剪贴板。", "Could not write to the clipboard."));
    }
  }

  function openThread(threadId: string) {
    if (embedded && window.parent !== window) {
      postEmbeddedHostMessage({ type: "taskboard:open-thread", payload: { threadId } });
      return;
    }

    window.location.assign(`codex://threads/${encodeURIComponent(threadId.trim())}`);
  }

  function openTaskConversation(conversation: TaskConversationItem) {
    if (conversation.kind === "local-ai" && conversation.aiThreadId) {
      setAiOpenThreadRequest((current) => ({
        threadId: conversation.aiThreadId!,
        requestId: (current?.requestId ?? 0) + 1,
      }));
      return;
    }
    if (conversation.nativeThreadId) openThread(conversation.nativeThreadId);
  }

  function expandCodexSidebar() {
    if (!embedded || window.parent === window) return;
    postEmbeddedHostMessage({ type: "taskboard:expand-sidebar" });
  }

  function openTaskInThread(task: Task) {
    const worktreePath = task.developmentContext?.type === "worktree"
      ? task.developmentContext.path
      : null;
    const workspacePath = worktreePath
      ?? selectedDeviceWorkspacePath
      ?? developmentScan.workspacePath
      ?? hostContext?.workspacePath;
    const instruction = `e-taskboard 处理任务面板任务 ${task.identifier}，并同步进度状态。`;

    if (!embedded || window.parent === window) {
      const query = new URLSearchParams();
      if (workspacePath) query.set("path", workspacePath);
      query.set("prompt", instruction);
      window.location.assign(`codex://new?${query.toString().replace(/\+/g, "%20")}`);
      return;
    }
    if (openingThreadTaskId) return;
    const codexProject = hostContext?.projects?.find((project) => project.id === selectedProject?.id);
    setOpeningThreadTaskId(task.id);
    setActionError(null);
    postEmbeddedHostMessage({
      type: "taskboard:create-thread",
      payload: {
        taskId: task.id,
        identifier: task.identifier,
        instruction,
        codexProjectId: codexProject?.id ?? (
          selectedProject?.id === GLOBAL_PROJECT_ID ? hostContext?.projectId : selectedProject?.id
        ),
        projectName: selectedProject?.name,
        workspacePath,
        workspaceLabel: worktreePath ? workspaceName(worktreePath) : undefined,
      },
    });
  }

  function changeProject(projectId: string, preferredView?: BoardView) {
    const subject = feishuCatalog.flatMap((base) => base.subjects).find((candidate) => candidate.projectId === projectId);
    beginProjectRequestContext(projectId, subject?.subjectKey ?? null);
    clearRemovedFeishuSelectionState();
    closeContextMenu();
    setProjectContextMenu(null);
    setProjectMenuOpen(false);
    setFeishuConfigurationOpen(false);
    setDetailTaskIdentifier(null);
    if (preferredView) {
      setBoardView(preferredView);
      taskboardStorage.setItem(`${PROJECT_VIEW_KEY_PREFIX}${projectId}`, preferredView);
    } else {
      setBoardView(readProjectBoardView(projectId));
    }
    setSelectedFeishuSubjectKey(subject?.subjectKey ?? null);
    setFeishuConfigurationBaseToken(subject
      ? feishuCatalog.find((base) => base.subjects.some((candidate) => (
        candidate.subjectKey === subject.subjectKey
      )))?.baseToken ?? null
      : null);
    rememberProjectOpen(projectId);
    setSelectedProjectId(projectId);
    setSearch("");
    setFilters(EMPTY_TASK_FILTERS);
    setActionError(null);
    undoStackRef.current = [];
    setUndoNotice(null);
    const url = buildIssueUrl(window.location.href, projectId, null);
    window.history.replaceState(null, "", url);
  }

  async function selectProject(choice: ProjectChoice) {
    if (openingProjectId) return;
    setOpeningProjectId(choice.id);
    setActionError(null);
    try {
      let project = projects.find((candidate) => candidate.id === choice.id) ?? null;
      if (!project) {
        try {
          project = await createProjectRequest({
            id: choice.id,
            name: choice.name,
            workspacePath: null,
          });
          setProjects((current) => [...current, project!]);
        } catch (error) {
          if (!(error instanceof ApiError) || error.code !== "PROJECT_EXISTS") throw error;
          const nextProjects = await listProjects({ includeArchived: true });
          setProjects(nextProjects);
          project = nextProjects.find((candidate) => candidate.id === choice.id) ?? null;
          if (!project) throw error;
        }
      }
      changeProject(project.id);
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setOpeningProjectId(null);
    }
  }

  function openCreateProjectDialog() {
    setProjectMenuOpen(false);
    setProjectContextMenu(null);
    setProjectName("");
    setActionError(null);
    setProjectCreateOpen(true);
  }

  function closeCreateProjectDialog() {
    if (openingProjectId) return;
    setProjectCreateOpen(false);
    setActionError(null);
  }

  async function createTemporaryProject() {
    if (openingProjectId) return;
    const name = projectName.trim();
    if (!name) return;
    const projectId = `temp-${window.crypto.randomUUID()}`;
    setOpeningProjectId(projectId);
    setActionError(null);
    try {
      const project = await createProjectRequest({
        id: projectId,
        name,
        workspacePath: null,
      });
      setProjects((current) => [...current, project]);
      setProjectCreateOpen(false);
      changeProject(project.id);
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setOpeningProjectId(null);
    }
  }

  function requestProjectDelete(project: ProjectChoice) {
    setProjectMenuOpen(false);
    setProjectContextMenu(null);
    setProjectDeleteAssociations(null);
    setPendingProjectDelete(project);
  }

  async function updateProjectArchived(project: ProjectChoice, archived: boolean) {
    if (projectLifecyclePendingId || !project.persisted || project.source !== "local") return;
    setProjectLifecyclePendingId(project.id);
    setActionError(null);
    try {
      const updated = await setProjectArchived(project.id, archived);
      const nextProjects = projectsRef.current.map((candidate) => (
        candidate.id === updated.id ? updated : candidate
      ));
      setProjects(nextProjects);
      setProjectContextMenu(null);
      if (archived && selectedProjectIdRef.current === project.id) {
        const fallback = nextProjects.find((candidate) => (
          candidate.archivedAt === null && candidate.id === GLOBAL_PROJECT_ID
        )) ?? nextProjects.find((candidate) => candidate.archivedAt === null);
        if (fallback) changeProject(fallback.id);
      }
      if (!archived) setProjectHistoryOpen(false);
      setAnnouncement(archived
        ? text(`已归档项目“${project.name}”`, `Archived project “${project.name}”`)
        : text(`已恢复项目“${project.name}”`, `Restored project “${project.name}”`));
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setProjectLifecyclePendingId(null);
    }
  }

  function closeProjectDeleteDialog() {
    if (deletingProjectId) return;
    setPendingProjectDelete(null);
    setProjectDeleteAssociations(null);
  }

  async function deletePendingProject() {
    if (!pendingProjectDelete || deletingProjectId) return;
    const project = pendingProjectDelete;
    setDeletingProjectId(project.id);
    setActionError(null);
    try {
      await deleteProjectRequest(project.id);
      clearUnifiedWorkflowLayoutsForProject(project.id);
      setProjects((current) => current.filter((candidate) => candidate.id !== project.id));
      setRecentProjectIds((current) => {
        const next = current.filter((candidate) => candidate !== project.id);
        taskboardStorage.setItem(RECENT_PROJECT_IDS_KEY, JSON.stringify(next));
        return next;
      });
      setPendingProjectDelete(null);
      setProjectDeleteAssociations(null);
      if (selectedProjectIdRef.current === project.id) {
        const fallback = projectsRef.current.find((candidate) => (
          candidate.id !== project.id && candidate.archivedAt === null && candidate.id === GLOBAL_PROJECT_ID
        )) ?? projectsRef.current.find((candidate) => (
          candidate.id !== project.id && candidate.archivedAt === null
        ));
        if (fallback) changeProject(fallback.id);
      }
      setAnnouncement(text(
        `已删除项目“${project.name}”`,
        `Deleted project “${project.name}”`,
      ));
    } catch (error) {
      if (error instanceof ApiError && error.code === "PROJECT_NOT_EMPTY") {
        const details = error.details as {
          associations?: { total?: number; tasks?: number };
        };
        const total = Number.isInteger(details.associations?.total)
          ? Math.max(1, details.associations!.total!)
          : 1;
        const tasks = Number.isInteger(details.associations?.tasks)
          ? Math.max(0, Math.min(total, details.associations!.tasks!))
          : 0;
        setProjectDeleteAssociations({ total, tasks });
      } else {
        setPendingProjectDelete(null);
        setActionError(errorMessage(error));
      }
    } finally {
      setDeletingProjectId(null);
    }
  }

  const headerProjectName = selectedFeishuSubject
    ? `${selectedFeishuSubject.baseName} / ${selectedFeishuSubject.tableName}`
    : selectedProject?.id === GLOBAL_PROJECT_ID
      ? text("全局", "Global")
      : selectedProject?.name ?? text("任务面板", "Taskboard");
  const projectDeleteAssociationMessage = projectDeleteAssociations
    ? (() => {
      const otherAssociations = projectDeleteAssociations.total - projectDeleteAssociations.tasks;
      if (projectDeleteAssociations.tasks > 0 && otherAssociations > 0) {
        return text(
          `该项目还有 ${projectDeleteAssociations.tasks} 个任务和 ${otherAssociations} 项其他关联数据。请先清理这些数据。`,
          `This project still has ${projectDeleteAssociations.tasks} tasks and ${otherAssociations} other associated records. Remove them first.`,
        );
      }
      if (projectDeleteAssociations.tasks > 0) {
        return text(
          `该项目还有 ${projectDeleteAssociations.tasks} 个任务（包含已归档任务）。请先移动或删除这些任务。`,
          `This project still has ${projectDeleteAssociations.tasks} tasks, including archived tasks. Move or delete them first.`,
        );
      }
      return text(
        `该项目还有 ${projectDeleteAssociations.total} 项关联数据，例如流程配置、摘要或聊天记录。请先清理这些数据。`,
        `This project still has ${projectDeleteAssociations.total} associated records, such as workflow settings, summaries, or chats. Remove them first.`,
      );
    })()
    : null;
  const appShellStyle = embedded
    ? { "--codex-titlebar-left-inset": `${hostContext?.titlebarLeftInset ?? 0}px` } as CSSProperties
    : undefined;

  return (
    <TaskboardLanguageProvider language={language} stageLabels={boardStageLabels}>
      <div className={`app-shell${embedded ? " embedded" : ""}`} style={appShellStyle}>
      {taskboardMetadata && taskboardMetadata.mode !== "cloud" && (
        <LocalRealtimeSync
          selectedProjectId={selectedProjectId}
          detailTaskId={detailTaskId}
          refreshProjectList={refreshProjectList}
          refreshTasks={refreshTasks}
          refreshArtifactUploads={refreshArtifactUploads}
          refreshWorkflowOptions={refreshWorkflowOptions}
          setConnection={setConnection}
          setCommentsRevision={setCommentsRevision}
          setAttachmentsRevision={setAttachmentsRevision}
          setAutoCutPackagesRevision={setAutoCutPackagesRevision}
          setBoardStageLabels={setBoardStageLabels}
        />
      )}
      {!embedded && (
        <aside className="app-nav" aria-label={text("任务面板导航", "Taskboard navigation")}>
          <div className="brand-row">
            <span className="brand-mark" aria-hidden="true"><LinearIcon name="project" /></span>
            <span>{text("任务面板", "Taskboard")}</span>
          </div>

          <nav className="primary-nav" aria-label={text("视图", "Views")}>
            <span className="nav-label">{text("工作区", "Workspace")}</span>
            <button className="nav-item active" type="button" aria-current="page">
              <span className="nav-glyph" aria-hidden="true">
                <LinearIcon name="myIssues" />
              </span>
              {text("议题", "Issues")}
              <span className="nav-count">{tasks.length}</span>
            </button>
            <button className={`nav-item${boardView === "autocut_packages" ? " active" : ""}`} type="button" aria-current={boardView === "autocut_packages" ? "page" : undefined} onClick={() => selectBoardView("autocut_packages")}>
              <span className="nav-glyph" aria-hidden="true"><LinearIcon name="project" /></span>
              {text("Auto-Cut 包", "Auto-Cut packages")}
            </button>
          </nav>

          <FeishuBaseNavigator
            catalog={feishuCatalog}
            selectedSubjectKey={selectedFeishuSubjectKey}
            onAddBase={async (url) => {
              await addFeishuBaseAndRefreshProjects(url);
            }}
            onSelectSubject={(subjectKey) => {
              const subject = feishuCatalog
                .flatMap((base) => base.subjects)
                .find((item) => item.subjectKey === subjectKey);
              if (!subject) return;
              setSelectedFeishuSubjectKey(subjectKey);
              changeProject(subject.projectId, "issues");
            }}
            onOpenConfiguration={openFeishuConfiguration}
            onToggleSubjectDisplay={async (subject, displayEnabled) => {
              updateFeishuSubject(await setFeishuSubjectDisplay(subject, displayEnabled));
            }}
            onDisableSubject={async (subject) => {
              updateFeishuSubject(await setFeishuSubjectDisabled(subject));
            }}
            onRemoveBase={async (baseToken) => {
              await runFeishuRemoval(() => removeFeishuBase(baseToken));
            }}
            onRemoveSubject={async (subjectKey) => {
              await runFeishuRemoval(() => removeFeishuSubject(subjectKey));
            }}
            onError={(message) => setActionError(message)}
          />

          <div className="nav-spacer" />
          <div className="nav-footer">
            <div className={`connection connection-${connection}`}>
              <span aria-hidden="true" />
              {connection === "live"
                ? text("实时同步", "Live sync")
                : text("正在重新连接…", "Reconnecting…")}
            </div>
            <button
              type="button"
              className="theme-toggle"
              onClick={() => setTheme((current) => current === "dark" ? "light" : "dark")}
              aria-label={theme === "dark"
                ? text("切换到浅色模式", "Switch to light theme")
                : text("切换到深色模式", "Switch to dark theme")}
            >
              <span aria-hidden="true"><LinearIcon name={theme === "dark" ? "sun" : "moon"} /></span>
              {theme === "dark"
                ? text("浅色模式", "Light mode")
                : text("深色模式", "Dark mode")}
            </button>
          </div>
        </aside>
      )}

      <main className="workspace">
        <header className="workspace-header">
          <div className="workspace-title">
            <div className="workspace-kicker">
              {detailTask && (
                <button
                  className="detail-back-button"
                  type="button"
                  aria-label={text("返回议题看板", "Back to issue board")}
                  title={text("返回议题看板 (Esc)", "Back to issue board (Esc)")}
                  onClick={closeTaskDetail}
                >
                  <LinearIcon name="chevronLeft" />
                </button>
              )}
              {embedded && hostContext?.sidebarCollapsed && (
                <button
                  className="detail-back-button codex-sidebar-expand-button"
                  type="button"
                  aria-label={text("展开 Codex 侧边栏", "Expand Codex sidebar")}
                  title={text("展开侧边栏", "Expand sidebar")}
                  onClick={expandCodexSidebar}
                >
                  <LinearIcon name="codexSidebarExpand" />
                </button>
              )}
              <div className="header-project-switcher" data-project-switcher>
                <button
                  className="header-project-button"
                  type="button"
                  aria-label={text("切换项目", "Switch project")}
                  aria-haspopup="menu"
                  aria-expanded={projectMenuOpen}
                  onClick={() => {
                    setProjectContextMenu(null);
                    setProjectMenuOpen((current) => !current);
                  }}
                >
                  <span className="project-name">{headerProjectName}</span>
                  <TaskboardIcon className="project-switcher-chevron" name="dropdown" />
                </button>
                {projectMenuOpen && (
                  <div className="header-project-menu" role="menu" aria-label={text("项目", "Projects")}>
                    <span>{text("切换项目", "Switch project")}</span>
                    {activeProjectChoices.map((project) => (
                      <div className="project-menu-row" role="none" key={project.id}>
                        <button
                          type="button"
                          role="menuitemradio"
                          aria-checked={project.id === selectedProjectId}
                          disabled={openingProjectId !== null}
                          onContextMenu={project.persisted && project.source === "local" && project.id !== GLOBAL_PROJECT_ID ? (event) => {
                            event.preventDefault();
                            setProjectContextMenu({
                              project,
                              x: event.clientX,
                              y: event.clientY,
                            });
                          } : undefined}
                          onClick={() => {
                            if (project.id === selectedProjectId) setProjectMenuOpen(false);
                            else void selectProject(project);
                          }}
                        >
                          <TaskboardIcon className="project-avatar" name="projectFolder" />
                          <span>{project.name}</span>
                          {project.id === selectedProjectId && <span className="project-menu-check" aria-hidden="true"><LinearIcon name="check" /></span>}
                        </button>
                        {project.persisted && project.source === "local" && project.id !== GLOBAL_PROJECT_ID && (
                          <button
                            type="button"
                            className="project-menu-archive"
                            role="menuitem"
                            disabled={projectLifecyclePendingId !== null}
                            aria-label={text(`归档 ${project.name}`, `Archive ${project.name}`)}
                            title={text("归档项目", "Archive project")}
                            onClick={() => void updateProjectArchived(project, true)}
                          >
                            <LinearIcon name="folder" />
                          </button>
                        )}
                      </div>
                    ))}
                    {historicalProjectChoices.length > 0 && (
                      <div className="project-history-section">
                        <button
                          type="button"
                          className="project-history-toggle"
                          aria-expanded={projectHistoryOpen}
                          onClick={() => setProjectHistoryOpen((current) => !current)}
                        >
                          <LinearIcon name="chevronRight" />
                          <span>{text("已归档 / 历史项目", "Archived / history")}</span>
                          <small>{historicalProjectChoices.length}</small>
                        </button>
                        {projectHistoryOpen && historicalProjectChoices.map((project) => (
                          <div className="project-history-row" key={project.id}>
                            <button
                              type="button"
                              className="project-history-open"
                              disabled={openingProjectId !== null}
                              aria-label={text(`查看 ${project.name}`, `View ${project.name}`)}
                              onClick={() => void selectProject(project)}
                            >
                              <TaskboardIcon className="project-avatar" name="projectFolder" />
                              <span title={project.name}>
                                <strong>{project.name}</strong>
                                <small>{project.source === "feishu"
                                  ? text("飞书学科", "Feishu subject")
                                  : project.source === "global"
                                    ? text("全局项目", "Global project")
                                    : text("本地项目", "Local project")} · {project.archivedAt
                                  ? new Date(project.archivedAt).toLocaleDateString(locale)
                                  : ""} · {text(
                                    `${project.issueCount + project.archivedIssueCount} 个任务`,
                                    `${project.issueCount + project.archivedIssueCount} tasks`,
                                  )}</small>
                              </span>
                            </button>
                            {project.source === "local" && (
                              <div className="project-history-actions">
                                <button
                                  type="button"
                                  disabled={projectLifecyclePendingId !== null}
                                  onClick={() => void updateProjectArchived(project, false)}
                                >{text("恢复", "Restore")}</button>
                                {project.id.startsWith("temp-") && (
                                  <button
                                    type="button"
                                    className="danger"
                                    disabled={projectLifecyclePendingId !== null}
                                    onClick={() => requestProjectDelete(project)}
                                  >{text("删除", "Delete")}</button>
                                )}
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                    <button
                      type="button"
                      role="menuitem"
                      disabled={openingProjectId !== null}
                      onClick={openCreateProjectDialog}
                    >
                      <TaskboardIcon className="project-avatar" name="create" />
                      <span>{text("创建项目", "Create project")}</span>
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>

          <div ref={dragRegionRef} className="workspace-drag-region" aria-hidden="true" />

          <div className="header-actions">
            {selectedProjectId && boardView !== "autocut_packages" && (
              <ProjectAutomationMenu
                automation={selectedProjectAutomation}
                pending={automationPending}
                error={automationError}
                unavailableReason={automationProjectContext.unavailableReason}
                onOpen={() => void reconcileProjectAutomation()}
                onChange={(options) => void saveProjectAutomation(options)}
              />
            )}
            {selectedProjectId
              && boardView !== "workflow"
              && boardView !== "completed_editing"
              && boardView !== "upload_queue"
              && boardView !== "uploading"
              && boardView !== "uploaded"
              && boardView !== "autocut_packages" && (
              <button
                className="icon-button header-create-button"
                type="button"
                onClick={() => setEditor({ task: null, status: "todo" })}
                aria-label={text("新建议题", "Create issue")}
                title={text("新建议题 (C)", "Create issue (C)")}
              >
                <TaskboardIcon name="create" />
              </button>
            )}
          </div>
        </header>

        {selectedProjectId && !detailTask && boardView !== "autocut_packages" && (
          <div className={`board-toolbar${boardView === "issues" && isSelectedFeishuProject ? " unified-workflow-toolbar" : ""}`}>
          <div className="view-tabs" aria-label={text("看板视图", "Board views")}>
            <button
              className={`view-tab${boardView === "dashboard" ? " active" : ""}`}
              type="button"
              aria-pressed={boardView === "dashboard"}
              onClick={() => selectBoardView("dashboard")}
            >
              {text("仪表盘", "Dashboard")}
            </button>
            <button
              className={`view-tab${boardView === "issues" ? " active" : ""}`}
              type="button"
              aria-pressed={boardView === "issues"}
              onClick={() => selectBoardView("issues")}
            >
              {isSelectedFeishuProject
                ? text("流程看板", "Workflow board")
                : text("议题看板", "Issue board")}
            </button>
            <button
              className={`view-tab${boardView === "list" ? " active" : ""}`}
              type="button"
              aria-pressed={boardView === "list"}
              onClick={() => selectBoardView("list")}
            >
              {text("列表视图", "List")}
            </button>
            <button
              className={`view-tab${boardView === "gantt" ? " active" : ""}`}
              type="button"
              aria-pressed={boardView === "gantt"}
              onClick={() => selectBoardView("gantt")}
            >
              {text("甘特图", "Gantt")}
            </button>
            {SHOW_WORKFLOW_BOARD_ENTRY && !isSelectedFeishuProject && (
              <button
                className={`view-tab${boardView === "workflow" ? " active" : ""}`}
                type="button"
                aria-pressed={boardView === "workflow"}
                onClick={() => selectBoardView("workflow")}
              >
                {text("节点模式", "Workflow")}
              </button>
            )}
          </div>
          {boardView === "issues" && isSelectedFeishuProject && selectedFeishuWorkflowSubjectKey && (
            <div className="unified-workflow-toolbar-controls">
              {unifiedViewsState && unifiedViewsState.subjectKey === selectedFeishuWorkflowSubjectKey ? (
                <UnifiedWorkflowViewControls
                  projectId={selectedProjectId}
                  subjectKey={selectedFeishuWorkflowSubjectKey}
                  state={unifiedViewsState}
                  stageDisplays={unifiedStageDisplays}
                  onChange={setUnifiedViewsState}
                  onError={setActionError}
                />
              ) : unifiedViewsLoading ? (
                <span>{text("正在加载流程视图…", "Loading workflow views…")}</span>
              ) : unifiedViewsError ? (
                <span className="unified-view-load-error" role="alert">
                  {unifiedViewsError}
                  <button type="button" onClick={() => setUnifiedViewsReloadRevision((current) => current + 1)}>
                    {text("重新加载", "Reload")}
                  </button>
                </span>
              ) : null}
              <label className="unified-search-scope">
                <span>{text("搜索范围", "Search scope")}</span>
                <select
                  value={unifiedSearchScope}
                  onChange={(event) => setUnifiedSearchScope(event.target.value as "activeView" | "allStages")}
                >
                  <option value="activeView">{text("当前视图", "Current view")}</option>
                  <option value="allStages">{text("全部流程", "All stages")}</option>
                </select>
              </label>
            </div>
          )}
          {(boardView === "issues" || boardView === "list" || boardView === "gantt") && <div className="toolbar-tools">
            <div className={`search-field${search ? " has-value" : ""}`} title={text("搜索议题 (/)", "Search issues (/)")}>
              <TaskboardIcon className="search-icon" name="search" />
              <input
                id="task-search"
                type="search"
                aria-label={text("搜索议题", "Search issues")}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={text("搜索议题…", "Search issues…")}
              />
              {!search && <kbd>/</kbd>}
              {search && (
                <button
                  className="search-clear"
                  type="button"
                  aria-label={text("清除搜索", "Clear search")}
                  onClick={() => {
                    setSearch("");
                    document.getElementById("task-search")?.focus();
                  }}
                >
                  <LinearIcon name="close" />
                </button>
              )}
            </div>
            {boardView === "gantt" && (
              <div className="gantt-toolbar-controls">
                <label className="gantt-hide-completed">
                  <input type="checkbox" checked={ganttHideCompleted} onChange={(event) => setGanttHideCompleted(event.target.checked)} />
                  <i><LinearIcon name="check" /></i>
                  <span>{text("隐藏已完成", "Hide completed")}</span>
                </label>
                <button type="button" className="gantt-today-button" onClick={() => setGanttTodayRequest((current) => current + 1)}>{text("今天", "Today")}</button>
                <div className="gantt-view-menu-wrap">
                  <button type="button" className="gantt-view-menu-trigger" aria-label={text("时间轴视图选项", "Timeline view options")} aria-expanded={ganttViewMenuOpen} onClick={() => setGanttViewMenuOpen((current) => !current)}>
                    <LinearIcon name="more" />
                  </button>
                  {ganttViewMenuOpen && (
                    <div className="gantt-view-menu" role="menu">
                      {GANTT_ZOOM_OPTIONS.map((value) => (
                        <button type="button" role="menuitemradio" aria-checked={ganttZoom === value} className={ganttZoom === value ? "active" : ""} onClick={() => { setGanttZoom(value); setGanttViewMenuOpen(false); }} key={value}>
                          <span>{language === "zh"
                            ? { day: "日视图", week: "周视图", month: "月视图" }[value]
                            : { day: "Day", week: "Week", month: "Month" }[value]}</span>
                          {ganttZoom === value && <LinearIcon name="check" />}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}
            <TaskFilterMenu
              tasks={tasks}
              search={search}
              labels={availableLabels}
              filters={filters}
              onChange={setFilters}
            />
            {boardView === "issues" && (
              <button
                className={`other-tasks-trigger${otherTasksOpen ? " is-open" : ""}`}
                type="button"
                aria-controls="other-tasks-panel"
                aria-expanded={otherTasksOpen}
                aria-label={otherTasksOpen
                  ? text("关闭其他任务", "Close other issues")
                  : text("打开其他任务", "Open other issues")}
                title={text("其他任务", "Other issues")}
                onClick={() => setOtherTasksOpen((current) => !current)}
              >
                <TaskboardIcon name="panel" />
              </button>
            )}
          </div>}
          </div>
        )}

        {(loadError || actionErrorText) && (
          <div className="error-banner" role="alert">
            <span className="error-mark" aria-hidden="true"><LinearIcon name="alert" /></span>
            <div><strong>{text("任务面板需要处理", "Taskboard needs attention")}</strong><p>{actionErrorText ?? loadError}</p></div>
            <button
              type="button"
              onClick={() => {
                setActionError(null);
                if (selectedProjectId) void refreshTasks(selectedProjectId);
                if (selectedProjectId) void refreshArtifactUploads(selectedProjectId);
                else void loadProjectList();
              }}
            >
              {text("重试", "Try again")}
            </button>
          </div>
        )}

        {boardView === "autocut_packages" ? (
          <div className="autocut-package-view">
            <FeishuPackageManager
              refreshKey={autoCutPackagesRevision}
              onError={(message) => setActionError(message)}
            />
            <BoardStageSettings
              value={boardStageLabels}
              onUpdated={setBoardStageLabels}
              onError={(message) => setActionError(message)}
            />
          </div>
        ) : detailTask && selectedProject ? (
          <TaskDetail
            key={detailTask.id}
            task={detailTask}
            tasks={tasks}
            currentUser={currentUser}
            availableLabels={availableLabels}
            developmentScan={developmentScan}
            developmentScanLoading={developmentScanLoading}
            commentsRevision={commentsRevision}
            attachmentsRevision={attachmentsRevision}
            onUpdate={(current, changes) => updateTaskProperties(current, changes)}
            onOpenTask={openTaskDetail}
            onAddRelation={(current, type, relatedTaskId) => (
              mutateTaskRelation("add", current, type, relatedTaskId)
            )}
            onRemoveRelation={(current, type, relatedTaskId) => (
              mutateTaskRelation("remove", current, type, relatedTaskId)
            )}
            onOpenThread={openThread}
            onOpenInThread={openTaskInThread}
            onStartCodex={startCodexForTask}
            onCopy={(text, message) => void copyText(text, message)}
            openingThread={openingThreadTaskId === detailTask.id}
            startingCodex={startingCodexTaskId === detailTask.id}
            onError={setActionError}
          />
        ) : boardView === "dashboard" ? (
          <DashboardView
            key={selectedProjectId}
            projectId={selectedProjectId}
            projectCreatedAt={selectedProject?.createdAt ?? null}
            tasks={tasks}
            presentations={taskPresentations}
            currentUser={currentUser}
            animateSummary={dashboardSummaryAnimatedProjectId !== selectedProjectId}
            onSummaryAnimationStart={markDashboardSummaryAnimationStarted}
            onOpenTask={openTaskDetail}
            onOpenConversation={openTaskConversation}
          />
        ) : boardView === "issues" && isSelectedFeishuProject ? (
          <div
            className={`issue-board-layout unified-workflow-layout${otherTasksVisible ? " has-other-tasks" : ""}`}
            data-main-columns={mainStatuses.length}
          >
            <div className="unified-workflow-main">
              <UnifiedWorkflowBoard
                key={selectedProjectId}
                projectId={selectedProjectId}
                subjectKey={selectedFeishuWorkflowSubjectKey ?? ""}
                viewId={unifiedViewsState?.subjectKey === selectedFeishuWorkflowSubjectKey
                  ? unifiedViewsState.activeViewId
                  : "all"}
                stageIds={unifiedViewsState?.subjectKey === selectedFeishuWorkflowSubjectKey
                  ? unifiedViewsState.views.find((view) => view.id === unifiedViewsState.activeViewId)?.stageIds
                  : undefined}
                stageDisplays={unifiedStageDisplays}
                searchScope={unifiedSearchScope}
                tasks={unifiedWorkflowTasks}
                uploadItems={artifactUploadItems}
                artifactSummaries={taskArtifactSummaries}
                presentations={taskPresentations}
                now={processingNow}
                loading={tasksLoading && !hasLoadedTasks}
                uploadLoading={artifactUploadsLoading}
                uploadError={artifactUploadsError}
                hasActiveFilters={hasActiveTaskFilters}
                filters={filters}
                search={search}
                availableLabels={availableLabels}
                currentUser={currentUser}
                draggedTaskId={draggedTaskId}
                draggedTaskHeight={draggedTaskHeight}
                movingTaskId={movingTaskId}
                settlingTaskId={settlingTaskId}
                contextMenuTaskId={contextMenu?.taskId ?? null}
                dropTarget={dropTarget}
                onOpenTask={(task, stage) => openTaskDetail(task, stage)}
                onUpdate={updateTaskProperties}
                onComplete={(task) => void moveTask(task, "done")}
                onContextMenu={(task, position) => setContextMenu({ taskId: task.id, ...position })}
                onDragStart={startTaskDrag}
                onDragEnd={endTaskDrag}
                onDragEnter={setDropTarget}
                onDrop={finishTaskDrop}
                onOpenConversation={openTaskConversation}
                onRetryUpload={(item) => void retryArtifactUploadFromBoard(item)}
                retryingUploadIds={retryingArtifactUploadIds}
                onColumnScrollRef={(status, element) => {
                  boardColumnScrollRefs.current[status] = element;
                }}
                onBoardScrollRef={unifiedWorkflowScrollRef}
              />
            </div>
            {otherTasksMounted && (
              <OtherTasksPanel
                open={otherTasksVisible}
                activeTab={otherTasksTab}
                tasksByStatus={unifiedTasksByStatus}
                ordinaryTasks={unifiedOrdinaryTasks}
                archivedTasks={unifiedArchivedTasks}
                presentations={taskPresentations}
                now={processingNow}
                hasActiveFilters={hasActiveTaskFilters}
                isDropTarget={otherTasksTab !== "archived"
                  && otherTasksTab !== "ordinary"
                  && dropTarget === otherTasksTab}
                draggedTaskId={draggedTaskId}
                draggedTaskHeight={draggedTaskHeight}
                movingTaskId={movingTaskId}
                settlingTaskId={settlingTaskId}
                contextMenuTaskId={contextMenu?.taskId ?? null}
                availableLabels={availableLabels}
                currentUser={currentUser}
                restoringTaskId={restoringTaskId}
                deletingTaskId={deletingArchivedTaskId}
                onTabChange={setOtherTasksTab}
                onCreate={(initialStatus) => setEditor({ task: null, status: initialStatus })}
                onRestore={(task) => void restoreArchivedTask(task)}
                onDelete={setPendingArchivedTaskDelete}
                onEdit={openTaskDetail}
                onUpdate={updateTaskProperties}
                onContextMenu={(task, position) => setContextMenu({ taskId: task.id, ...position })}
                onDragStart={startTaskDrag}
                onDragEnd={endTaskDrag}
                onDragEnter={setDropTarget}
                onDrop={finishTaskDrop}
                onOpenConversation={openTaskConversation}
              />
            )}
          </div>
        ) : boardView === "list" ? (
          <IssueListView
            scrollRef={issueListRef}
            tasks={filteredTasks}
            presentations={taskPresentations}
            currentUser={currentUser}
            hasActiveFilters={hasActiveTaskFilters}
            onOpenTask={openTaskDetail}
            onOpenConversation={openTaskConversation}
            onUpdate={updateTaskProperties}
          />
        ) : boardView === "completed_editing" ? (
          <IssueListView
            scrollRef={issueListRef}
            tasks={completedEditingTasks}
            statuses={["done"]}
            presentations={taskPresentations}
            currentUser={currentUser}
            hasActiveFilters={hasActiveTaskFilters}
            onOpenTask={openTaskDetail}
            onOpenConversation={openTaskConversation}
            onUpdate={updateTaskProperties}
          />
        ) : boardView === "upload_queue" || boardView === "uploading" || boardView === "uploaded" ? (
          <ArtifactUploadView
            projectId={selectedProjectId}
            view={boardView}
            revision={attachmentsRevision}
            search={search}
            onOpenTask={openTaskDetail}
          />
        ) : boardView === "gantt" ? (
          <Suspense fallback={<div className="workflow-board-loading">{text("正在打开甘特图…", "Opening Gantt…")}</div>}>
            <GanttView
              tasks={filteredTasks}
              presentations={taskPresentations}
              hasActiveFilters={hasActiveTaskFilters}
              zoom={ganttZoom}
              hideCompleted={ganttHideCompleted}
              todayRequest={ganttTodayRequest}
              onOpenTask={openTaskDetail}
              onUpdate={updateTaskProperties}
            />
          </Suspense>
        ) : boardView === "workflow" && feishuConfigurationOpen ? (
          <div className="workflow-view-stack feishu-configuration-stack">
            <FeishuWorkflowPanel
              catalog={feishuCatalog}
              configurationBaseToken={feishuConfigurationBaseToken}
              selectedSubjectKey={selectedFeishuSubjectKey}
              onSelectSubject={(subjectKey, openProject = true) => {
                const subject = feishuCatalog.flatMap((base) => base.subjects).find((item) => item.subjectKey === subjectKey);
                if (!subject) return;
                changeProject(subject.projectId, openProject ? "issues" : "workflow");
                beginProjectRequestContext(subject.projectId, subjectKey);
                setSelectedFeishuSubjectKey(subjectKey);
                setFeishuConfigurationOpen(!openProject);
              }}
              onAddBase={async (url) => {
                const next = await addFeishuBaseAndRefreshProjects(url);
                if (!next) return;
                const nextSubjectKey = next.subjects[0]?.subjectKey ?? null;
                const nextSubject = next.subjects[0];
                if (nextSubject) {
                  changeProject(nextSubject.projectId, "workflow");
                  beginProjectRequestContext(nextSubject.projectId, nextSubject.subjectKey);
                  setSelectedFeishuSubjectKey(nextSubject.subjectKey);
                  setFeishuConfigurationOpen(true);
                } else {
                  beginProjectRequestContext(selectedProjectIdRef.current, nextSubjectKey);
                  setSelectedFeishuSubjectKey(nextSubjectKey);
                }
                setFeishuConfigurationBaseToken(next.baseToken);
                return next;
              }}
              onCatalogChange={setFeishuCatalog}
              onSubjectChange={updateFeishuSubject}
              onError={(message) => setActionError(message)}
            />
            {selectedFeishuSubjectKey && unifiedStageDisplaysLoadedFor === selectedFeishuSubjectKey ? (
              <UnifiedWorkflowStageSettings
                subjectKey={selectedFeishuSubjectKey}
                overrides={unifiedStageDisplays}
                onChange={(override) => setUnifiedStageDisplays((current) => [
                  ...current.filter((item) => !(
                    item.subjectKey === override.subjectKey && item.stageId === override.stageId
                  )),
                  override,
                ])}
                onError={setActionError}
              />
            ) : selectedFeishuSubjectKey ? (
              <div className="workflow-board-loading">{text("正在加载流程显示设置…", "Loading stage display settings…")}</div>
            ) : null}
          </div>
        ) : boardView === "workflow" && !isSelectedFeishuProject ? (
          <div className="workflow-view-stack">
            <Suspense fallback={<div className="workflow-board-loading">{text("正在打开节点模式…", "Opening workflow…")}</div>}>
              <WorkflowBoard
                key={selectedProject?.id ?? GLOBAL_PROJECT_ID}
                projectId={selectedProject?.id ?? GLOBAL_PROJECT_ID}
                projectName={selectedProject?.name ?? text("当前项目", "Current project")}
                workspacePath={
                  selectedDeviceWorkspacePath
                  ?? developmentScan.workspacePath
                  ?? hostContext?.workspacePath
                }
                revision={workflowRevision}
                onWorkflowsChange={setWorkflowOptions}
              />
            </Suspense>
          </div>
        ) : (
          <div
            className={`issue-board-layout${otherTasksVisible ? " has-other-tasks" : ""}`}
            data-main-columns={mainStatuses.length}
            style={{
              "--main-column-count": mainStatuses.length,
              "--main-board-min-width": `${mainBoardMinWidth}px`,
              "--main-board-max-width": `${mainBoardMaxWidth}px`,
              "--other-tasks-width": otherTasksWidth,
            } as CSSProperties}
          >
            {tasksLoading && !hasLoadedTasks ? (
              <div className="loading-board" aria-label={text("正在加载议题", "Loading issues")} aria-busy="true">
                {mainStatuses.map((status) => (
                  <div className="loading-column" key={status}>
                    <span /><div /><div />
                  </div>
                ))}
              </div>
            ) : (
              <>
                <div className="board-scroll" aria-label={text("议题看板", "Issue board")}>
                  <div className="board">
                    {mainStatuses.map((status) => (
                      <BoardColumn
                        key={status}
                        scrollRef={(element) => {
                          boardColumnScrollRefs.current[status] = element;
                        }}
                        status={status}
                        tasks={tasksByStatus[status]}
                        presentations={taskPresentations}
                        now={processingNow}
                        emptyMessage={hasActiveTaskFilters
                          ? text("当前筛选下无匹配议题", "No issues match the current filters")
                          : text("暂无议题", "No issues")}
                        isDropTarget={dropTarget === status}
                        draggedTaskId={draggedTaskId}
                        draggedTaskHeight={draggedTaskHeight}
                        movingTaskId={movingTaskId}
                        settlingTaskId={settlingTaskId}
                        contextMenuTaskId={contextMenu?.taskId ?? null}
                        availableLabels={availableLabels}
                        currentUser={currentUser}
                        onCreate={(initialStatus) => setEditor({ task: null, status: initialStatus })}
                        onEdit={openTaskDetail}
                        onUpdate={updateTaskProperties}
                        onComplete={(task) => void moveTask(task, "done")}
                        onContextMenu={(task, position) => setContextMenu({ taskId: task.id, ...position })}
                        onDragStart={startTaskDrag}
                        onDragEnd={endTaskDrag}
                        onDragEnter={setDropTarget}
                        onDrop={finishTaskDrop}
                        onOpenConversation={openTaskConversation}
                      />
                    ))}
                  </div>
                </div>
                {otherTasksMounted && (
                  <OtherTasksPanel
                    open={otherTasksVisible}
                    activeTab={otherTasksTab}
                    tasksByStatus={tasksByStatus}
                    archivedTasks={filteredArchivedTasks}
                    presentations={taskPresentations}
                    now={processingNow}
                    hasActiveFilters={hasActiveTaskFilters}
                    isDropTarget={otherTasksTab !== "archived" && dropTarget === otherTasksTab}
                    draggedTaskId={draggedTaskId}
                    draggedTaskHeight={draggedTaskHeight}
                    movingTaskId={movingTaskId}
                    settlingTaskId={settlingTaskId}
                    contextMenuTaskId={contextMenu?.taskId ?? null}
                    availableLabels={availableLabels}
                    currentUser={currentUser}
                    restoringTaskId={restoringTaskId}
                    deletingTaskId={deletingArchivedTaskId}
                    onTabChange={setOtherTasksTab}
                    onCreate={(initialStatus) => setEditor({ task: null, status: initialStatus })}
                    onRestore={(task) => void restoreArchivedTask(task)}
                    onDelete={setPendingArchivedTaskDelete}
                    onEdit={openTaskDetail}
                    onUpdate={updateTaskProperties}
                    onContextMenu={(task, position) => setContextMenu({ taskId: task.id, ...position })}
                    onDragStart={startTaskDrag}
                    onDragEnd={endTaskDrag}
                    onDragEnter={setDropTarget}
                    onDrop={finishTaskDrop}
                    onOpenConversation={openTaskConversation}
                  />
                )}
              </>
            )}
          </div>
        )}
      </main>

      {projectContextMenu && (
        <div
          className="task-context-menu project-context-menu"
          data-project-context-menu
          role="menu"
          aria-label={text(
            `项目“${projectContextMenu.project.name}”`,
            `Project “${projectContextMenu.project.name}”`,
          )}
          style={{ left: projectContextMenu.x, top: projectContextMenu.y }}
        >
          <button
            className="context-menu-item"
            type="button"
            role="menuitem"
            disabled={projectLifecyclePendingId !== null}
            onClick={() => void updateProjectArchived(projectContextMenu.project, true)}
          >
            <span className="context-menu-icon" aria-hidden="true"><LinearIcon name="folder" /></span>
            <span className="context-menu-label">{text("归档项目", "Archive project")}</span>
          </button>
          {projectContextMenu.project.id.startsWith("temp-") && (
            <button
              className="context-menu-item is-danger"
              type="button"
              role="menuitem"
              onClick={() => requestProjectDelete(projectContextMenu.project)}
            >
              <span className="context-menu-icon" aria-hidden="true"><LinearIcon name="trash" /></span>
              <span className="context-menu-label">{text("永久删除项目", "Delete project permanently")}</span>
            </button>
          )}
        </div>
      )}

      {projectCreateOpen && (
        <div
          className="delete-backdrop"
          onPointerDown={(event) => {
            if (event.target === event.currentTarget) closeCreateProjectDialog();
          }}
        >
          <form
            className="delete-dialog project-create-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="project-create-title"
            onSubmit={(event) => {
              event.preventDefault();
              void createTemporaryProject();
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") closeCreateProjectDialog();
            }}
          >
            <h2 id="project-create-title">{text("创建项目", "Create project")}</h2>
            <label>
              <span>{text("项目名称", "Project name")}</span>
              <input
                autoFocus
                maxLength={120}
                required
                value={projectName}
                onChange={(event) => setProjectName(event.target.value)}
              />
            </label>
            {actionErrorText && <p className="project-dialog-error">{actionErrorText}</p>}
            <div>
              <button
                className="button secondary"
                type="button"
                disabled={openingProjectId !== null}
                onClick={closeCreateProjectDialog}
              >
                {text("取消", "Cancel")}
              </button>
              <button
                className="button primary"
                type="submit"
                disabled={!projectName.trim() || openingProjectId !== null}
              >
                {openingProjectId
                  ? text("创建中…", "Creating…")
                  : text("创建", "Create")}
              </button>
            </div>
          </form>
        </div>
      )}

      {pendingProjectDelete && (
        <div
          className="delete-backdrop"
          onPointerDown={(event) => {
            if (event.target === event.currentTarget) closeProjectDeleteDialog();
          }}
        >
          <div
            className="delete-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="project-delete-title"
            onKeyDown={(event) => {
              if (event.key === "Escape") closeProjectDeleteDialog();
            }}
          >
            {projectDeleteAssociations === null ? (
              <>
                <h2 id="project-delete-title">{text(
                  `删除项目“${pendingProjectDelete.name}”？`,
                  `Delete project “${pendingProjectDelete.name}”?`,
                )}</h2>
                <p>{text(
                  "仅空项目可以删除。删除后无法恢复。",
                  "Only empty projects can be deleted. This cannot be undone.",
                )}</p>
                <div>
                  <button
                    className="button secondary"
                    type="button"
                    disabled={deletingProjectId !== null}
                    onClick={closeProjectDeleteDialog}
                  >
                    {text("取消", "Cancel")}
                  </button>
                  <button
                    className="button danger"
                    type="button"
                    disabled={deletingProjectId !== null}
                    onClick={() => void deletePendingProject()}
                  >
                    {deletingProjectId
                      ? text("删除中…", "Deleting…")
                      : text("删除项目", "Delete project")}
                  </button>
                </div>
              </>
            ) : (
              <>
                <h2 id="project-delete-title">{text(
                  `无法删除项目“${pendingProjectDelete.name}”`,
                  `Cannot delete project “${pendingProjectDelete.name}”`,
                )}</h2>
                <p>{projectDeleteAssociationMessage}</p>
                <div>
                  <button className="button primary" type="button" onClick={closeProjectDeleteDialog}>
                    {text("知道了", "Got it")}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {pendingArchivedTaskDelete && (
        <div
          className="delete-backdrop"
          onPointerDown={(event) => {
            if (event.target === event.currentTarget && !deletingArchivedTaskId) {
              setPendingArchivedTaskDelete(null);
            }
          }}
        >
          <div
            className="delete-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="archived-task-delete-title"
            onKeyDown={(event) => {
              if (event.key === "Escape" && !deletingArchivedTaskId) {
                setPendingArchivedTaskDelete(null);
              }
            }}
          >
            <h2 id="archived-task-delete-title">{text(
              `永久删除 ${pendingArchivedTaskDelete.identifier}？`,
              `Permanently delete ${pendingArchivedTaskDelete.identifier}?`,
            )}</h2>
            <p>{text(
              `“${pendingArchivedTaskDelete.title}”及其评论和附件将被永久删除，此操作无法撤销。`,
              `“${pendingArchivedTaskDelete.title}” and its comments and attachments will be permanently deleted. This cannot be undone.`,
            )}</p>
            <div>
              <button
                className="button secondary"
                type="button"
                disabled={deletingArchivedTaskId !== null}
                onClick={() => setPendingArchivedTaskDelete(null)}
              >
                {text("取消", "Cancel")}
              </button>
              <button
                className="button danger"
                type="button"
                disabled={deletingArchivedTaskId !== null}
                onClick={() => void deletePendingArchivedTask()}
              >
                {deletingArchivedTaskId
                  ? text("删除中…", "Deleting…")
                  : text("永久删除", "Delete permanently")}
              </button>
            </div>
          </div>
        </div>
      )}

      {editor && (
        <TaskEditor
          key={editor.task?.id ?? `new-${editor.status}`}
          task={editor.task}
          initialStatus={editor.status}
          initialDraft={editor.task ? null : newTaskDraft}
          labels={availableLabels}
          currentUser={currentUser}
          developmentScan={developmentScan}
          developmentScanLoading={developmentScanLoading}
          onCancel={(draft) => {
            if (!editor.task) setNewTaskDraft(draft);
            setEditor(null);
          }}
          onSave={saveEditor}
        />
      )}

      {contextMenu && contextMenuTask && (
        <TaskContextMenu
          task={contextMenuTask}
          position={{ x: contextMenu.x, y: contextMenu.y }}
          labels={availableLabels}
          onClose={closeContextMenu}
          onEdit={openTaskDetail}
          onStatusChange={(task, status) => void moveTask(task, status)}
          onPriorityChange={(task, nextPriority) => void updateTaskProperties(
            task,
            { priority: nextPriority },
          ).catch(() => {})}
          onLabelsChange={(task, labels) => void updateTaskProperties(
            task,
            { labels },
          ).catch(() => {})}
          onDuplicate={(task) => void duplicateTask(task)}
          onCopy={(text, message) => void copyText(text, message)}
          onOpenInThread={openTaskInThread}
          onArchive={(task) => void archiveTask(task)}
        />
      )}

      <AiChat
        available={localAiChatAvailable}
        projectId={selectedProjectId || null}
        issueId={detailTaskId}
        onThreadsChange={setAiThreads}
        openThreadRequest={aiOpenThreadRequest}
      />

      <div className="sr-only" role="status" aria-live="polite">{announcement}</div>
      {undoNotice && (
        <div
          className="toast undo-toast"
          role="status"
          onAnimationEnd={() => setUndoNotice((current) => current?.id === undoNotice.id ? null : current)}
        >
          <span aria-hidden="true"><LinearIcon name="check" /></span>
          <span className="undo-toast-message">{undoNotice.message}</span>
          <button type="button" onClick={() => void performUndo()}>
            {text("撤回", "Undo")} <kbd>{undoShortcut}</kbd>
          </button>
        </div>
      )}
      {announcement && (
        <div className="toast" role="status" onAnimationEnd={() => setAnnouncementValue("")}>
          <span aria-hidden="true"><LinearIcon name="check" /></span>{announcement}
        </div>
      )}
      </div>
    </TaskboardLanguageProvider>
  );
}
