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

export type BoardStageLabelsByLanguage = Record<TaskStatus, string>;

export interface BoardStageLabels {
  version: number;
  labels: {
    zh: BoardStageLabelsByLanguage;
    en: BoardStageLabelsByLanguage;
  };
}
export type ActorType = "user" | "agent";
export type AssigneeTarget = "current-user" | "codex-agent";
export type IssueRelationType = "parent" | "blocks" | "blocked_by" | "related";
export type IssueRelationOrigin = "manual" | "mention";

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
  realtime?:
    | { transport: "poll"; intervalMs: number }
    | { transport: "websocket"; endpoint: string };
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

export const COMPOSER_CONTRACT_VERSION = "composer.v1" as const;

export type ComposerTrigger = "@" | "/";
export type ComposerSurface = "ai-chat" | "issue-description" | "comment";

export type ComposerSourceKind =
  | "skills"
  | "slash"
  | "apps"
  | "files"
  | "agents"
  | "plugins"
  | "customPrompts";

export type ComposerSourceReasonCode =
  | "SOURCE_UNAVAILABLE"
  | "NO_STABLE_CATALOG"
  | "ACTION_UNVERIFIED"
  | "INVOCATION_NAME_UNAVAILABLE"
  | "ENCODER_UNSUPPORTED"
  | "EXPERIMENTAL_SOURCE_NOT_ALLOWED";

export interface ComposerSourceState {
  kind: ComposerSourceKind;
  state: "available" | "unavailable" | "unsupported";
  reasonCode: ComposerSourceReasonCode | null;
}

interface ComposerCandidateBase {
  candidateRef: string;
  label: string;
  description: string | null;
  group: string;
  groupOrder: number;
  itemOrder: number;
  selectable: true;
  insertionText?: string;
}

export interface ComposerReferencePersistence {
  format: "taskboard.composer-reference.v1";
  kind: "skill" | "agent";
  referenceKey: string;
  markdown: string;
}

export interface ComposerInsertTextSelection {
  type: "insertText";
  text: string;
}

export interface ComposerSkillCandidate extends ComposerCandidateBase {
  kind: "skill";
  trigger: "@" | "/";
  persistence?: ComposerReferencePersistence;
}

export interface ComposerAgentCandidate extends ComposerCandidateBase {
  kind: "agent";
  trigger: "@";
  persistence?: ComposerReferencePersistence;
}

export interface ComposerSlashActionCandidate extends ComposerCandidateBase {
  kind: "slashAction";
  trigger: "/";
  command: string;
  dispatch: {
    type: "client" | "server";
    handlerId: string;
  };
  selection?: ComposerInsertTextSelection;
}

export type ComposerCandidate =
  | ComposerSkillCandidate
  | ComposerAgentCandidate
  | ComposerSlashActionCandidate;

export interface ComposerCandidatesQuery {
  projectId?: string;
  threadId?: string;
  surface?: ComposerSurface;
  trigger: ComposerTrigger;
  query: string;
  codexProjectId?: string;
  codexProjectKind?: "local" | "remote";
  codexHostId?: string;
  workspacePath?: string;
}

export interface ComposerCandidatesResponse {
  contractVersion: typeof COMPOSER_CONTRACT_VERSION;
  revision: string;
  candidates: ComposerCandidate[];
  sources: ComposerSourceState[];
}

export interface ComposerTextNode {
  type: "text";
  text: string;
}

export interface ComposerSkillNode {
  type: "skill";
  candidateRef: string;
  label: string;
}

export interface ComposerAgentNode {
  type: "agent";
  candidateRef: string;
  label: string;
}

export type ComposerNode = ComposerTextNode | ComposerSkillNode | ComposerAgentNode;

export interface ComposerPersistedReferenceNode {
  type: "persistedReference";
  referenceKind: "skill" | "agent";
  referenceKey: string;
  label: string;
}

export interface ComposerUnsupportedReferenceNode {
  type: "unsupportedReference";
  referenceUri: string;
  label: string;
}

export interface ComposerPersistedDocument {
  version: 1;
  nodes: Array<ComposerTextNode | ComposerPersistedReferenceNode | ComposerUnsupportedReferenceNode>;
}

export interface ComposerDocument {
  version: 1;
  nodes: ComposerNode[];
}

export interface ComposerRebindRequest {
  contractVersion: typeof COMPOSER_CONTRACT_VERSION;
  projectId: string;
  threadId?: string;
  document: ComposerPersistedDocument;
}

export interface ComposerRebindBinding {
  nodeIndex: number;
  status: "resolved" | "unavailable";
  referenceKind: "skill" | "agent" | "unsupported";
  label?: string;
  reasonCode?:
    | "SOURCE_UNAVAILABLE"
    | "REFERENCE_NOT_FOUND"
    | "REFERENCE_AMBIGUOUS"
    | "REFERENCE_KIND_UNSUPPORTED"
    | "REFERENCE_FORMAT_UNSUPPORTED";
}

export type ComposerRebindResponse = {
  contractVersion: typeof COMPOSER_CONTRACT_VERSION;
  revision: string;
  bindings: ComposerRebindBinding[];
  sources: ComposerSourceState[];
  diagnostics: unknown[];
} & (
  | { ready: true; document: ComposerDocument }
  | { ready: false; document?: never }
);

export interface ComposerTurnInput {
  contractVersion: typeof COMPOSER_CONTRACT_VERSION;
  revision: string;
  document: ComposerDocument;
  dangerFullAccessConfirmed?: boolean;
  attachments?: AiChatAttachmentInput[];
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
  codexProjectId?: string;
  codexProjectKind?: "local" | "remote";
  codexHostId?: string;
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

export interface CodexProjectIdentity {
  codexProjectId: string;
  codexProjectKind: "local" | "remote";
  codexHostId: string;
  workspacePath: string;
}

export interface CodexThreadBinding extends CodexProjectIdentity {
  threadId: string;
}

export interface Project {
  id: string;
  name: string;
  workspacePath: string | null;
  source: "global" | "local" | "feishu" | "jira";
  labels: string[];
  issueCount: number;
  archivedIssueCount: number;
  archivedAt: string | null;
  subjectKey?: string | null;
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

export type FeishuStageId = "initial" | "first_review" | "final_review";
export type FeishuStageSourceKind = "docx_section" | "base_attachment";
export type FeishuStageAudioMode = "video_original" | "replace_original";

export interface FeishuStageSource {
  kind: FeishuStageSourceKind;
  anchorText?: string;
  fieldId?: string;
}

export interface FeishuStageConfig {
  enabled: boolean;
  trigger: {
    fieldId: string | null;
    fieldName?: string | null;
    optionId: string | null;
    value: string;
  };
  videoSource: FeishuStageSource;
  reviewSource: FeishuStageSource;
  audio: {
    mode: FeishuStageAudioMode;
    source?: FeishuStageSource | null;
    durationToleranceSeconds?: number;
  };
  artifactTargetPath?: string | null;
  nameSuffix: string;
}

export type FeishuStageConfigMap = Record<FeishuStageId, FeishuStageConfig>;

export interface FeishuAutoCutRun {
  runId: string;
  taskId: string;
  attempt: number;
  subjectKey: string;
  configVersion: number;
  stageId: FeishuStageId;
  eventId: string;
  manifestSha256: string | null;
  state: "preparing" | "prepared" | "running" | "blocked" | "reported" | "completed";
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
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
  statusField?: { fieldId: string; fieldName: string; type?: string; options?: FeishuFieldOption[] };
  documentField?: { fieldId: string; fieldName: string; kind?: string };
  namingField?: { fieldId: string; fieldName: string; kind?: string };
  stages?: FeishuStageConfigMap;
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

export type UnifiedWorkflowStage =
  | "todo"
  | "queued"
  | "in_progress"
  | "blocked"
  | "in_review"
  | "completed_editing"
  | "upload_queue"
  | "uploading"
  | "uploaded";

export interface StageDisplayOverride {
  subjectKey: string;
  stageId: UnifiedWorkflowStage;
  zhName: string | null;
  enName: string | null;
  zhDescription: string | null;
  enDescription: string | null;
  revision: number;
  updatedAt: string;
}

export interface UnifiedWorkflowView {
  id: string;
  subjectKey: string;
  name: string;
  stageIds: UnifiedWorkflowStage[];
  isSystem: boolean;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface UnifiedWorkflowViewsState {
  schemaVersion: 1;
  subjectKey: string;
  revision: number;
  defaultViewId: string;
  activeViewId: string;
  views: UnifiedWorkflowView[];
  readOnly: boolean;
}

export interface CreateUnifiedWorkflowViewInput {
  subjectKey: string;
  name: string;
  stageIds: UnifiedWorkflowStage[];
  stateRevision: number;
}

export interface UpdateUnifiedWorkflowViewInput {
  subjectKey: string;
  stateRevision: number;
  viewRevision?: number;
  name?: string;
  stageIds?: UnifiedWorkflowStage[];
  defaultViewId?: string;
  activeViewId?: string;
}

export interface ProjectSummary {
  projectId: string;
  summary: string | null;
  updatedAt: string | null;
  refreshing: boolean;
  error: string | null;
}

export interface ProjectReadme {
  projectId: string;
  content: string;
  version: number;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface ProjectReadmeAttachment {
  id: string;
  projectId: string;
  kind: "inline";
  filename: string;
  contentType: string;
  size: number;
  createdAt: string;
}

export interface TaskRelationSummary {
  id: string;
  identifier: string;
  externalKey?: string | null;
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

interface TaskConversationRefBase {
  source: "task" | "comment";
  sourceId: string;
  title: string;
  updatedAt: string;
}

export type TaskConversationRef = TaskConversationRefBase & (
  | (CodexThreadBinding & { legacyLocal?: false })
  | { threadId: string; legacyLocal: true }
);

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
  threadBinding: CodexThreadBinding | null;
  legacyLocalThreadId: string | null;
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
  source: "local" | "jira";
  externalOrigin?: string | null;
  externalKey?: string | null;
  externalUrl: string | null;
  archivedAt: string | null;
  relations: TaskRelations;
  version: number;
  createdAt: string;
  updatedAt: string;
  feishuOrigin?: FeishuTaskOrigin;
  feishuPackageSnapshot?: FeishuTaskPackageSnapshot;
}

export interface JiraConnection {
  configured: boolean;
  baseUrl: string | null;
  username: string | null;
  displayName: string | null;
  projects: string[];
  projectId: string;
  lastSyncedAt: string | null;
  insecureHttp: boolean;
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
  threadBinding: CodexThreadBinding | null;
  legacyLocalThreadId: string | null;
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
  kind: "inline" | "attachment";
  filename: string;
  contentType: string;
  size: number;
  createdAt: string;
}

export interface TaskArtifact {
  id: string;
  taskId: string;
  runId: string | null;
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

export interface TaskArtifactSummary {
  id: string;
  taskId: string;
  filename: string;
  validationStatus: "verified";
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
  stageId?: FeishuStageId;
  stageLabel?: string;
  eventOccurredAt?: number | null;
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
  targetId: string | null;
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
  projects?: Array<{
    id: string;
    name: string;
    projectKind?: "local" | "remote";
    workspacePath?: string;
    hostId?: string;
  }>;
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
