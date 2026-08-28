export const TASK_STATUSES = [
  "backlog",
  "todo",
  "queued",
  "in_progress",
  "in_review",
  "blocked",
  "done",
  "canceled",
] as const;
export const TASK_PRIORITIES = ["none", "urgent", "high", "medium", "low"] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];
export type TaskPriority = (typeof TASK_PRIORITIES)[number];
export type ActorType = "user" | "agent";
export type AssigneeTarget = "current-user" | "codex-agent";
export type IssueRelationType = "parent" | "blocks" | "blocked_by" | "related";

export interface ActorIdentity {
  type: ActorType;
  id: string;
  name: string;
  avatarUrl: string | null;
}

export type DevelopmentContext =
  | { type: "branch"; branch: string }
  | { type: "worktree"; path: string; branch: string | null };

export type Recurrence = {
  interval: number;
  unit: "day" | "week" | "month" | "year";
};

export interface DevelopmentScan {
  workspacePath: string | null;
  contexts: DevelopmentContext[];
}

export interface TaskboardMetadata {
  manageTaskboardSkillPath?: string;
  capabilities?: TaskboardCapabilities;
  mode?: "local" | "cloud";
  realtime?: {
    transport: "poll";
    intervalMs: number;
  };
  localCapabilities?: {
    available: boolean;
  };
}

export interface TaskboardCapabilities {
  localAiChat: boolean;
}

export type AiChatSandbox = "read-only" | "workspace-write" | "danger-full-access";
export type AiChatThreadStatus = "idle" | "running" | "failed";
export type AiChatRunStatus = "running" | "completed" | "failed" | "interrupted";

export interface AiChatModel {
  slug: string;
  displayName: string;
  description: string;
  defaultReasoningEffort: string;
  supportedReasoningEfforts: string[];
  serviceTiers: Array<{ id: string; name: string }>;
}

export interface AiChatSkill {
  id: string;
  label: string;
  description: string;
  path: string;
  scope: "user" | "repo" | "system" | "admin";
}

export interface AiChatAttachmentInput {
  filename: string;
  contentType: string;
  dataBase64: string;
}

export interface AiChatCatalog {
  models: AiChatModel[];
  skills: AiChatSkill[];
  sandboxes: string[];
}

export interface AiChatOrigin {
  projectId: string;
  projectName: string;
  workspacePath: string;
  issueId?: string;
  issueIdentifier?: string;
}

export interface AiChatRun {
  id: string;
  threadId: string;
  status: AiChatRunStatus;
  exitCode?: number | null;
  error?: string | null;
  startedAt?: string;
  finishedAt?: string | null;
}

export interface AiChatTodoProgress {
  completed: number;
  total: number;
  eventId: string;
  updatedAt: string;
}

export interface AiChatThread {
  id: string;
  title: string;
  status: AiChatThreadStatus;
  origin: AiChatOrigin;
  codexThreadId: string | null;
  model: string;
  reasoningEffort: string;
  sandbox: AiChatSandbox;
  createdAt: string;
  updatedAt: string;
  currentRun?: AiChatRun | null;
  latestTodo?: AiChatTodoProgress | null;
}

export interface AiChatEvent {
  id: string;
  threadId?: string;
  runId?: string | null;
  type: string;
  role: "user" | "assistant" | "activity" | "error";
  content: string;
  data?: Record<string, unknown> | null;
  createdAt?: string;
}

export interface AiChatThreadSnapshot {
  thread: AiChatThread;
  events: AiChatEvent[];
  runs: AiChatRun[];
}

export interface WorkflowCapabilityOption {
  id: string;
  label: string;
  scope: "user" | "repo" | "system" | "admin";
}

export interface WorkflowMcpServerOption {
  id: string;
  label: string;
  transport: string;
}

export interface WorkflowCapabilities {
  skills: WorkflowCapabilityOption[];
  mcpServers: WorkflowMcpServerOption[];
}

export interface WorkflowOption {
  id: string;
  name: string;
}

export interface WorkflowWorkspaceRecord<T = unknown> {
  projectId: string;
  workspace: T | null;
  version: number;
  updatedAt: string | null;
}

export interface Project {
  id: string;
  name: string;
  workspacePath: string | null;
  issueCount: number;
  createdAt: string;
  updatedAt: string;
}

export type FeishuPackageState = "draft" | "enabled" | "disabled";

export interface AutoCutPackageDraft {
  alias: string;
  name: string;
  projectId: string;
  workspacePath: string | null;
  model: string | null;
  reasoningEffort: string | null;
  prompt: string | null;
  zipSourceDirectory: string | null;
  maxConcurrent: number;
}

export interface FeishuPackage extends AutoCutPackageDraft {
  projectName?: string;
  state: FeishuPackageState;
  revision: number;
  updatedAt: string;
}

export type AutoCutPackageReference =
  | {
    type: "subject";
    subjectKey: string;
    baseToken: string;
    baseName: string;
    tableId: string;
    tableName: string;
    lifecycle: "enabled";
  }
  | {
    type: "task";
    taskId: string;
    identifier: string;
    title: string;
    status: TaskStatus;
    subjectKey?: string;
  };

export interface FeishuPackageSummary extends FeishuPackage {
  referenceCount: number;
  references: AutoCutPackageReference[];
}

export interface FeishuFieldOption {
  id: string;
  name: string;
  color?: number;
}

export interface FeishuFieldMetadata {
  fieldId: string;
  fieldName: string;
  type: number | string | null;
  uiType: string | null;
  options: FeishuFieldOption[];
}

export interface FeishuSubjectConfig {
  subjectKey: string;
  baseToken: string;
  baseName: string;
  tableId: string;
  tableName: string;
  projectId: string;
  displayEnabled: boolean;
  lifecycle: "draft" | "enabled" | "disabled";
  configVersion: number;
  trigger?: { fieldId: string; fieldName: string; startValue: string; optionId: string | null };
  title?: { fieldId: string | null; fieldName: string | null };
  execution?: { mode: "manual" | "automatic"; concurrencyGroup: string; maxConcurrent: number; resourceGroups: string[] };
  packageRoute?: { routeMode: "fixed"; packageAlias: string; subjectCodeFieldId: string | null; branchMap: Record<string, string> | null };
  upload?: { enqueueMode: "manual" | "automatic"; artifactSourceMode: string; artifactSourcePath: string | null; targetId: string | null; targetPath: string | null; uploadConcurrency: number };
  metadata?: { fields?: FeishuFieldMetadata[] };
  createdAt: string;
  updatedAt: string;
}

export interface FeishuBaseCatalog {
  baseToken: string;
  baseName: string;
  sourceUrlLabel: string | null;
  metadataRefreshedAt: number | null;
  subjects: FeishuSubjectConfig[];
  createdAt: string;
  updatedAt: string;
}

export interface FeishuWorkflowShareConfiguration {
  schemaVersion: number;
  configVersion?: number;
  createdAt?: string | number | null;
  updatedAt?: string | number | null;
  bases: FeishuBaseCatalog[];
}

export interface FeishuWorkflowShareDiagnostic {
  code: string;
  severity: "info" | "warning" | "error";
  path?: string;
  alias?: string;
  message: string;
}

export interface FeishuWorkflowShareResult {
  configuration: FeishuWorkflowShareConfiguration;
  catalog?: FeishuBaseCatalog[];
  diagnostics: FeishuWorkflowShareDiagnostic[];
  diagnosticsOk?: boolean;
  dryRun: boolean;
}

export interface ProjectSummary {
  projectId: string;
  summary: string | null;
  updatedAt: string | null;
  refreshing: boolean;
  error: string | null;
}

export interface TaskRelationSummary {
  id: string;
  identifier: string;
  projectId: string;
  title: string;
  status: TaskStatus;
  priority: TaskPriority;
  assignee: ActorIdentity;
  archivedAt: string | null;
}

export interface TaskRelations {
  parent: TaskRelationSummary | null;
  subIssues: TaskRelationSummary[];
  blockedBy: TaskRelationSummary[];
  blocks: TaskRelationSummary[];
  related: TaskRelationSummary[];
}

export interface TaskConversationRef {
  threadId: string;
  source: "task" | "comment";
  sourceId: string;
  title: string;
  updatedAt: string;
}

export interface Task {
  id: string;
  identifier: string;
  projectId: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  labels: string[];
  sortOrder: number;
  threadId: string | null;
  conversationRefs: TaskConversationRef[];
  participants: ActorIdentity[];
  previewImage: Attachment | null;
  activityKey: string;
  activityUpdatedAt: string;
  creatorType: ActorType;
  creatorId: string;
  creatorName: string;
  creatorAvatarUrl: string | null;
  assignee: ActorIdentity;
  workflowId: string | null;
  developmentContext: DevelopmentContext | null;
  startDate: string | null;
  dueDate: string | null;
  recurrence: Recurrence | null;
  archivedAt: string | null;
  relations: TaskRelations;
  version: number;
  createdAt: string;
  updatedAt: string;
  feishuOrigin?: FeishuTaskOrigin;
  feishuPackageSnapshot?: FeishuTaskPackageSnapshot;
}

export interface Comment {
  id: string;
  taskId: string;
  body: string;
  authorType: ActorType;
  authorId: string;
  authorName: string;
  authorAvatarUrl: string | null;
  threadId: string | null;
  attachments: Attachment[];
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface TaskActivityChange {
  field: string;
  before: unknown;
  after: unknown;
}

export interface TaskChangeActivity {
  id: string;
  taskId: string;
  actorType: ActorType;
  actorId: string;
  actorName: string;
  actorAvatarUrl: string | null;
  changes: TaskActivityChange[];
  createdAt: string;
}

export interface Attachment {
  id: string;
  taskId: string;
  commentId: string | null;
  filename: string;
  contentType: string;
  size: number;
  createdAt: string;
}

export interface TaskArtifact {
  id: string;
  taskId: string;
  filename: string;
  contentType: string;
  size: number;
  sha256: string;
  sourceMode: string;
  validationStatus: string;
  entryCount: number;
  draftRoot: string;
  createdAt: string;
  updatedAt: string;
}

export interface FeishuTaskOrigin {
  taskId?: string;
  version: number;
  source: "feishu-base";
  eventId: string;
  baseToken: string;
  tableId: string;
  recordId: string;
  triggerField?: string;
  triggerFieldId?: string;
  triggerValue?: string;
  subjectKey?: string;
  configVersion?: number;
  mode?: "manual" | "automatic";
  executionMode?: "manual" | "automatic";
  uploadMode?: "manual" | "automatic";
  packageAlias?: string;
  packageSource?: string;
  concurrencyGroup?: string;
  maxConcurrent?: number;
  resourceGroups?: string[];
}

export interface FeishuTaskPackageSnapshot {
  zipSourceDirectory: string | null;
}

export interface ArtifactUpload {
  id: string;
  taskId: string;
  artifactId: string;
  subjectKey: string;
  filename: string;
  sha256: string;
  status: "queued" | "uploading" | "uploaded" | "failed";
  attemptCount: number;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
}

export interface ArtifactUploadListItem {
  upload: ArtifactUpload;
  task: Task;
}

export interface HostContext {
  user?: ActorIdentity;
  language?: string;
  workspacePath?: string;
  threadId?: string;
  theme?: "light" | "dark";
  projectId?: string;
  projects?: Array<{ id: string; name: string }>;
  titlebarLeftInset?: number;
  sidebarCollapsed?: boolean;
  threadRunning?: boolean;
  threadTodoProgress?: {
    completed: number;
    total: number;
  };
}

export interface TaskDraft {
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  labels: string[];
  assigneeTarget?: AssigneeTarget;
  developmentContext: DevelopmentContext | null;
  startDate: string | null;
  dueDate: string | null;
  recurrence: Recurrence | null;
}

export interface TaskEvent {
  type: string;
  projectId?: string;
  taskId?: string;
  task?: Task;
  comment?: Comment;
  attachment?: Attachment;
  project?: Project;
  at: string;
}
