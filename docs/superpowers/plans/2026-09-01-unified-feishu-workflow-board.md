# Unified Feishu Workflow Board Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Make the selected Feishu subject's editing and upload lifecycle visible in one operational board without changing execution, upload, or Bridge behavior.

**Architecture:** Keep the existing Taskboard task status model and upload API. Add a small pure client-side stage classifier that combines the current project's tasks with ArtifactUploadListItem[] records, then render task stages and upload stages in one horizontal board. Keep the existing independent views and APIs as compatibility code, but normalize their persisted view values to the unified board when the project is opened.

**Tech Stack:** React 19, TypeScript, Vite, Node.js node:test, existing Taskboard SSE events and API helpers.

## Global Constraints

- Only the currently selected project/Feishu subject is rendered; tasks from another Base or subject must never be merged into the board.
- The first slice is a presentation change; do not change Bridge filtering, task registration, Auto-Cut scheduling, five-second delay, Codex invocation, ZIP validation, upload copying, or Feishu writeback.
- Bridge and Taskboard remain loopback-only on 127.0.0.1.
- Upload columns are read-only for drag-and-drop; upload state changes continue through the existing idempotent upload and retry endpoints.
- Do not expose targetPath, storageKey, credentials, commands, prompts, or Bridge secrets in board cards or list APIs.
- A task appears in at most one unified stage. Upload priority is uploading > upload_queue (queued or failed) > uploaded > completed_editing; otherwise the task's real status is used.
- Existing worktree changes belong to the user and must not be reverted or staged accidentally.

---

### Task 1: Add and Test the Unified Stage Classifier

**Files:**
- Create: web/src/unifiedWorkflow.mjs
- Create: test/unified-workflow.test.mjs

**Interfaces:**
- Consumes: Task-shaped objects and ArtifactUpload[] status records.
- Produces: UNIFIED_WORKFLOW_STAGES, classifyUnifiedStage(task, uploads), and groupUnifiedWorkflowItems(tasks, uploadItems) for the React board.

- [ ] **Step 1: Write the failing tests**

~~~js
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classifyUnifiedStage,
  groupUnifiedWorkflowItems,
} from "../web/src/unifiedWorkflow.mjs";

const task = (status = "done", id = "task-1") => ({
  id,
  status,
  feishuOrigin: { source: "feishu-base", executionMode: "manual" },
});

const upload = (status, taskId = "task-1") => ({
  id: status + "-" + taskId,
  taskId,
  artifactId: status + "-artifact",
  status,
});

test("upload activity takes precedence over the underlying task status", () => {
  assert.equal(classifyUnifiedStage(task("done"), [upload("uploading")]), "uploading");
  assert.equal(classifyUnifiedStage(task("done"), [upload("queued")]), "upload_queue");
  assert.equal(classifyUnifiedStage(task("done"), [upload("failed")]), "upload_queue");
  assert.equal(classifyUnifiedStage(task("done"), [upload("uploaded")]), "uploaded");
  assert.equal(classifyUnifiedStage(task("done"), []), "completed_editing");
});

test("ordinary active Feishu statuses keep their own stage", () => {
  assert.equal(classifyUnifiedStage(task("todo"), []), "todo");
  assert.equal(classifyUnifiedStage(task("queued"), []), "queued");
  assert.equal(classifyUnifiedStage(task("in_progress"), []), "in_progress");
  assert.equal(classifyUnifiedStage(task("in_review"), []), "in_review");
  assert.equal(classifyUnifiedStage(task("blocked"), []), "blocked");
});

test("non-Feishu and secondary tasks are excluded", () => {
  assert.equal(classifyUnifiedStage({ id: "local", status: "todo" }, []), null);
  assert.equal(classifyUnifiedStage(task("canceled"), []), null);
  assert.equal(classifyUnifiedStage(task("backlog"), []), null);
});

test("grouping returns one item in one stage and ignores uploads for other tasks", () => {
  const groups = groupUnifiedWorkflowItems(
    [task("done"), task("todo", "task-2")],
    [upload("uploaded"), upload("queued", "task-2")],
  );
  assert.equal(groups.completed_editing.length, 0);
  assert.equal(groups.uploaded.length, 1);
  assert.equal(groups.upload_queue.length, 1);
  assert.equal(groups.todo.length, 0);
});
~~~

- [ ] **Step 2: Run the focused test and verify it fails**

Run: node --test test/unified-workflow.test.mjs

Expected: FAIL because web/src/unifiedWorkflow.mjs does not exist yet.

- [ ] **Step 3: Implement the minimal classifier**

Create web/src/unifiedWorkflow.mjs with these exact stage IDs and precedence:

~~~js
export const UNIFIED_WORKFLOW_STAGES = [
  "todo",
  "queued",
  "in_progress",
  "in_review",
  "completed_editing",
  "upload_queue",
  "uploading",
  "uploaded",
  "blocked",
];

const ACTIVE_TASK_STAGES = new Set(["todo", "queued", "in_progress", "in_review", "blocked"]);

export function classifyUnifiedStage(task, uploads = []) {
  if (!task || task.feishuOrigin?.source !== "feishu-base") return null;
  if (task.status === "backlog" || task.status === "canceled") return null;
  const taskUploads = uploads.filter((candidate) => candidate?.taskId === task.id);
  if (taskUploads.some((candidate) => candidate.status === "uploading")) return "uploading";
  if (taskUploads.some((candidate) => candidate.status === "queued" || candidate.status === "failed")) return "upload_queue";
  if (taskUploads.some((candidate) => candidate.status === "uploaded")) return "uploaded";
  if (task.status === "done") return "completed_editing";
  return ACTIVE_TASK_STAGES.has(task.status) ? task.status : null;
}

export function groupUnifiedWorkflowItems(tasks, uploadItems = []) {
  const uploadsByTask = new Map();
  for (const item of uploadItems) {
    const candidate = item?.upload;
    if (!candidate?.taskId) continue;
    const list = uploadsByTask.get(candidate.taskId) ?? [];
    list.push(candidate);
    uploadsByTask.set(candidate.taskId, list);
  }
  const groups = Object.fromEntries(UNIFIED_WORKFLOW_STAGES.map((stage) => [stage, []]));
  for (const task of tasks) {
    const uploads = uploadsByTask.get(task.id) ?? [];
    const stage = classifyUnifiedStage(task, uploads);
    if (stage) groups[stage].push({ task, uploads, stage });
  }
  return groups;
}
~~~

- [ ] **Step 4: Run the focused test and verify it passes**

Run: node --test test/unified-workflow.test.mjs

Expected: 4 tests pass with 0 failures.

- [ ] **Step 5: Commit the isolated classifier**

~~~powershell
git add web/src/unifiedWorkflow.mjs test/unified-workflow.test.mjs
git commit -m "feat: classify unified Feishu workflow stages"
~~~

### Task 2: Load Project Upload Summaries Alongside Tasks

**Files:**
- Modify: web/src/App.tsx:504-630, 667-705, 1537-1581, 590-610
- Test: test/unified-workflow-board-ui.test.mjs

**Interfaces:**
- Consumes: listArtifactUploads(projectId, signal) from web/src/api.ts and ArtifactUploadListItem from web/src/types.ts.
- Produces: App state artifactUploadItems, artifactUploadsLoading, artifactUploadsError, and a refresh callback passed to UnifiedWorkflowBoard.

- [ ] **Step 1: Add a failing source-contract test**

~~~js
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const source = () => readFile(new URL("../web/src/App.tsx", import.meta.url), "utf8");

test("App refreshes project upload summaries and reacts to upload events", async () => {
  const app = await source();
  assert.match(app, /listArtifactUploads\(projectId/);
  assert.match(app, /artifactUploadItems/);
  assert.match(app, /refreshArtifactUploads/);
  assert.match(app, /artifact\.upload\.updated/);
});
~~~

- [ ] **Step 2: Run the test to verify the missing wiring**

Run: node --test test/unified-workflow-board-ui.test.mjs

Expected: FAIL because the new state and callback names are absent.

- [ ] **Step 3: Add the refresh state and callback**

In App.tsx, add:

~~~tsx
const [artifactUploadItems, setArtifactUploadItems] = useState<ArtifactUploadListItem[]>([]);
const [artifactUploadsLoading, setArtifactUploadsLoading] = useState(false);
const [artifactUploadsError, setArtifactUploadsError] = useState<string | null>(null);
const artifactUploadsRequestRef = useRef(0);

const refreshArtifactUploads = useCallback(async (
  projectId: string,
  options: { quiet?: boolean; signal?: AbortSignal } = {},
) => {
  const requestId = ++artifactUploadsRequestRef.current;
  if (!options.quiet) setArtifactUploadsLoading(true);
  try {
    const next = await listArtifactUploads(projectId, options.signal);
    if (requestId !== artifactUploadsRequestRef.current) return;
    setArtifactUploadItems(next);
    setArtifactUploadsError(null);
  } catch (error) {
    if ((error as Error).name !== "AbortError" && requestId === artifactUploadsRequestRef.current) {
      setArtifactUploadsError(errorMessage(error));
    }
  } finally {
    if (!options.quiet && requestId === artifactUploadsRequestRef.current) setArtifactUploadsLoading(false);
  }
}, []);

useEffect(() => {
  if (!selectedProjectId) {
    setArtifactUploadItems([]);
    return;
  }
  const controller = new AbortController();
  void refreshArtifactUploads(selectedProjectId, { signal: controller.signal });
  return () => controller.abort();
}, [refreshArtifactUploads, selectedProjectId]);
~~~

Extend LocalRealtimeSyncProps with refreshArtifactUploads, call it for selected-project artifact.* events, and call it in source.onopen so reconnect recovery reloads the upload summaries. Keep the existing detail attachmentsRevision behavior unchanged.

- [ ] **Step 4: Run the wiring test and the type checker**

Run: node --test test/unified-workflow-board-ui.test.mjs and npm run typecheck

Expected: the source test passes and TypeScript exits 0.

- [ ] **Step 5: Commit the data refresh boundary**

~~~powershell
git add web/src/App.tsx test/unified-workflow-board-ui.test.mjs
git commit -m "feat: refresh unified workflow upload summaries"
~~~

### Task 3: Build Read-Only Unified Workflow Columns and Cards

**Files:**
- Create: web/src/components/UnifiedWorkflowBoard.tsx
- Modify: web/src/components/TaskCard.tsx:27-46,415-435
- Test: test/unified-workflow-board-ui.test.mjs

**Interfaces:**
- Consumes: groupUnifiedWorkflowItems, TaskCard, TaskboardIcon, ArtifactUploadListItem, existing drag and task mutation callbacks.
- Produces: UnifiedWorkflowBoard with eight ordinary workflow columns plus an on-demand blocked column; real task columns accept existing task drag operations, upload columns are read-only and expose retry actions.

- [ ] **Step 1: Add failing component contract assertions**

~~~js
test("unified board renders all editing and upload stages", async () => {
  const source = await readFile(new URL("../web/src/components/UnifiedWorkflowBoard.tsx", import.meta.url), "utf8");
  for (const stage of ["待处理", "排队中", "处理中", "待验收", "已完成剪辑", "上传队列", "上传中", "已上传"]) {
    assert.match(source, new RegExp(stage));
  }
  assert.match(source, /groupUnifiedWorkflowItems/);
  assert.match(source, /readOnly/);
  assert.match(source, /retry/);
});

test("TaskCard can be rendered without starting a status drag", async () => {
  const source = await readFile(new URL("../web/src/components/TaskCard.tsx", import.meta.url), "utf8");
  assert.match(source, /dragEnabled\\?: boolean/);
  assert.match(source, /draggable=\\{dragEnabled/);
});
~~~

- [ ] **Step 2: Run the test and verify it fails**

Run: node --test test/unified-workflow-board-ui.test.mjs

Expected: FAIL because the component and dragEnabled prop do not exist.

- [ ] **Step 3: Add the optional non-dragging card behavior**

In TaskCard.tsx, add dragEnabled?: boolean to TaskCardProps, default it to true in the component parameters, and change the article attributes to:

~~~tsx
draggable={dragEnabled && !isMoving}
onDragStart={dragEnabled ? (event) => {
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", task.id);
  event.dataTransfer.setData("application/x-taskboard-task", task.id);
  onDragStart(task, event.currentTarget.offsetHeight);
} : undefined}
onDragEnd={dragEnabled ? onDragEnd : undefined}
~~~

- [ ] **Step 4: Implement the unified board component**

Use this prop contract:

~~~tsx
export interface UnifiedWorkflowBoardProps {
  tasks: Task[];
  uploadItems: ArtifactUploadListItem[];
  presentations: Record<string, TaskCardPresentation>;
  now: number;
  loading: boolean;
  uploadLoading: boolean;
  uploadError: string | null;
  search: string;
  hasActiveFilters: boolean;
  availableLabels: string[];
  currentUser: ActorIdentity;
  draggedTaskId: string | null;
  draggedTaskHeight: number;
  movingTaskId: string | null;
  settlingTaskId: string | null;
  contextMenuTaskId: string | null;
  dropTarget: TaskStatus | null;
  onOpenTask: (task: Task) => void;
  onUpdate: (task: Task, changes: Partial<TaskDraft>) => Promise<Task>;
  onComplete: (task: Task) => void;
  onContextMenu: (task: Task, position: { x: number; y: number }) => void;
  onDragStart: (task: Task, height: number) => void;
  onDragEnd: () => void;
  onDragEnter: (status: TaskStatus) => void;
  onDrop: (status: TaskStatus, taskId: string, beforeTaskId: string | null) => void;
  onOpenConversation: (conversation: TaskConversationItem) => void;
  onRetryUpload: (item: ArtifactUploadListItem) => void;
}
~~~

The component must filter uploadItems to task IDs in tasks, call groupUnifiedWorkflowItems, render stable 300px columns in the specified order, use TaskCard with dragEnabled={false} for virtual upload stages, and put failed-upload retry buttons on the upload-queue cards. The upload error is rendered inside the upload area while task columns remain visible. The component accepts the current search query and matches it against task identifier/title, the configured Auto-Cut package alias, and associated ZIP filenames.

- [ ] **Step 5: Run focused UI tests and typecheck**

Run: node --test test/unified-workflow-board-ui.test.mjs and npm run typecheck

Expected: all component assertions pass and TypeScript exits 0.

- [ ] **Step 6: Commit the read-only board component**

~~~powershell
git add web/src/components/UnifiedWorkflowBoard.tsx web/src/components/TaskCard.tsx test/unified-workflow-board-ui.test.mjs
git commit -m "feat: render unified editing and upload board"
~~~

### Task 4: Make the Unified Board the Selected Subject's Main View

**Files:**
- Modify: web/src/App.tsx:308-315, 1946-1954, 2809-2885, 3021-3208
- Modify: test/board-views.test.mjs
- Modify: test/artifact-upload-views.test.mjs

**Interfaces:**
- Consumes: UnifiedWorkflowBoard, App upload state and existing task callbacks.
- Produces: issues as the unified workflow view; old upload view values normalize to issues when read from local storage, while the old component remains available for compatibility.

- [ ] **Step 1: Write failing migration and toolbar tests**

~~~js
test("the primary project view is the unified workflow board", async () => {
  const app = await source("web/src/App.tsx");
  assert.match(app, /UnifiedWorkflowBoard/);
  assert.match(app, /流程看板/);
  assert.doesNotMatch(app, /onClick=\\{\\(\\) => selectBoardView\\("upload_queue"\\)\\}/);
  assert.doesNotMatch(app, /onClick=\\{\\(\\) => selectBoardView\\("uploading"\\)\\}/);
  assert.doesNotMatch(app, /onClick=\\{\\(\\) => selectBoardView\\("uploaded"\\)\\}/);
});

test("legacy upload view memories resolve to the unified board", async () => {
  const app = await source("web/src/App.tsx");
  assert.match(app, /upload_queue.*issues|uploading.*issues|uploaded.*issues/);
});
~~~

- [ ] **Step 2: Run the focused view tests and verify they fail**

Run: node --test test/board-views.test.mjs test/artifact-upload-views.test.mjs

Expected: FAIL because the toolbar still exposes the three independent upload tabs and the issues branch still renders only the task columns.

- [ ] **Step 3: Normalize the persisted view and replace the primary branch**

Change readProjectBoardView so completed_editing, upload_queue, uploading, and uploaded return issues. Rename the primary tab copy to 流程看板/Workflow board. Remove only the four independent upload tab buttons from the main toolbar; retain list, Gantt, workflow, package manager, and the existing component source.

Replace the current issues board branch with:

~~~tsx
<UnifiedWorkflowBoard
  key={selectedProjectId}
  tasks={filteredTasks}
  uploadItems={artifactUploadItems}
  presentations={taskPresentations}
  now={processingNow}
  loading={tasksLoading && !hasLoadedTasks}
  uploadLoading={artifactUploadsLoading}
  uploadError={artifactUploadsError}
  search={search}
  hasActiveFilters={hasActiveTaskFilters}
  availableLabels={availableLabels}
  currentUser={currentUser}
  draggedTaskId={draggedTaskId}
  draggedTaskHeight={draggedTaskHeight}
  movingTaskId={movingTaskId}
  settlingTaskId={settlingTaskId}
  contextMenuTaskId={contextMenu?.taskId ?? null}
  dropTarget={dropTarget}
  onOpenTask={openTaskDetail}
  onUpdate={updateTaskProperties}
  onComplete={(task) => void moveTask(task, "done")}
  onContextMenu={(task, position) => setContextMenu({ taskId: task.id, ...position })}
  onDragStart={startTaskDrag}
  onDragEnd={endTaskDrag}
  onDragEnter={setDropTarget}
  onDrop={finishTaskDrop}
  onOpenConversation={openTaskConversation}
  onRetryUpload={(item) => void retryArtifactUploadFromBoard(item)}
/>
~~~

retryArtifactUploadFromBoard must call the existing retryTaskArtifactUpload helper, update the matching artifactUploadItems entry optimistically only after a successful response, and set the existing safe actionError on failure.

- [ ] **Step 4: Update the source-contract tests**

Keep tests that protect the old ArtifactUploadView API, but change the App assertions to require the unified board and absence of primary upload-tab buttons. Add an assertion that the selected project ID is passed to the upload refresh path.

- [ ] **Step 5: Run focused tests and typecheck**

Run: node --test test/board-views.test.mjs test/artifact-upload-views.test.mjs test/unified-workflow.test.mjs test/unified-workflow-board-ui.test.mjs and npm run typecheck

Expected: all focused tests pass and TypeScript exits 0.

- [ ] **Step 6: Commit the view integration**

~~~powershell
git add web/src/App.tsx test/board-views.test.mjs test/artifact-upload-views.test.mjs
git commit -m "feat: make unified workflow board the main subject view"
~~~

### Task 5: Add Stable Responsive Styling and Search Semantics

**Files:**
- Modify: web/src/styles.css
- Modify: web/src/components/UnifiedWorkflowBoard.tsx
- Modify: test/unified-workflow-board-ui.test.mjs

**Interfaces:**
- Consumes: the existing board container and Taskboard theme variables.
- Produces: a horizontally scrollable desktop board, mobile snap-scrolling columns, stable card dimensions, and search matching for task ID/title, ZIP filename, and package alias.

- [ ] **Step 1: Write failing styling/search assertions**

~~~js
test("unified board has stable responsive layout and searchable upload metadata", async () => {
  const styles = await readFile(new URL("../web/src/styles.css", import.meta.url), "utf8");
  const board = await readFile(new URL("../web/src/components/UnifiedWorkflowBoard.tsx", import.meta.url), "utf8");
  assert.match(styles, /\\.unified-workflow-board/);
  assert.match(styles, /scroll-snap-type:\\s*x\\s+mandatory/);
  assert.match(board, /upload\\.filename/);
  assert.match(board, /packageAlias/);
});
~~~

- [ ] **Step 2: Run the test and verify it fails**

Run: node --test test/unified-workflow-board-ui.test.mjs

Expected: FAIL because the new selectors and search fields are absent.

- [ ] **Step 3: Add the layout and search implementation**

Add .unified-workflow-board, .unified-workflow-board-scroll, .unified-workflow-board-grid, .unified-workflow-column, .unified-workflow-column--upload, and mobile @media (max-width: 719px) rules. Use minmax(300px, 1fr), width: max-content, min-height: 0, overflow-x: auto, and scroll-snap-type: x mandatory; do not use viewport-scaled font sizes.

In the component's visible-item memo, retain matchesTaskFilters for task fields and additionally match the normalized search query against task.identifier, task.title, task.feishuOrigin?.packageAlias, and every associated upload filename. Do not include target paths or storage keys.

- [ ] **Step 4: Run the UI tests and typecheck**

Run: node --test test/unified-workflow-board-ui.test.mjs and npm run typecheck

Expected: all assertions pass and TypeScript exits 0.

- [ ] **Step 5: Commit the responsive styling**

~~~powershell
git add web/src/styles.css web/src/components/UnifiedWorkflowBoard.tsx test/unified-workflow-board-ui.test.mjs
git commit -m "style: make unified workflow board responsive"
~~~

### Task 6: Verify Automatic Processing Without Changing Upload Policy

**Files:**
- Modify: README.zh-CN.md
- Modify: README.md
- Test: existing test/task-start-flow.test.mjs, test/feishu-execution-coordinator.test.mjs, test/artifact-upload-queue.test.mjs

**Interfaces:**
- Consumes: the finished unified board and existing automatic Auto-Cut execution path.
- Produces: documented manual acceptance criteria and evidence that UI consolidation did not change automatic execution or upload safety.

- [ ] **Step 1: Run the focused execution and upload regression suites**

Run:

~~~powershell
node --test test/task-start-flow.test.mjs test/feishu-execution-coordinator.test.mjs test/artifact-upload-queue.test.mjs test/unified-workflow.test.mjs
~~~

Expected: all tests pass; no test may start a real user Auto-Cut package.

- [ ] **Step 2: Build and run repository checks**

Run:

~~~powershell
npm run typecheck
npm run build:web
git diff --check
~~~

Expected: all commands exit 0 and there are no whitespace errors.

- [ ] **Step 3: Restart and health-check the local services**

From D:\\codex\\codex-feishu, run:

~~~powershell
.\\scripts\\stop-local.ps1
.\\scripts\\start-local.ps1
.\\scripts\\check-local.ps1
~~~

Expected: Taskboard is healthy on http://127.0.0.1:47823, Bridge is healthy on http://127.0.0.1:47824, and no existing task is started automatically.

- [ ] **Step 4: Perform the manual UI acceptance sequence**

1. Select one Base and one visible subject; verify no task from another subject appears.
2. Confirm the historical uploaded task appears only in 已上传.
3. Create one automatic test task and observe 待处理 → 排队中/处理中 → 已完成剪辑.
4. Keep upload enqueue mode manual, select the verified ZIP, and observe 上传队列 → 上传中 → 已上传 on the same page.
5. Switch to another subject and confirm the board and upload counts reset to that subject only.

- [ ] **Step 5: Document the user-facing workflow and commit**

Add a short Chinese and English README section explaining that the selected subject is the page scope, the eight columns are one unified view, and automatic processing remains independently configurable. Then commit only the README files:

~~~powershell
git add README.md README.zh-CN.md
git commit -m "docs: explain unified Feishu workflow board"
~~~

## Final Verification Checklist

- [ ] node --test test/unified-workflow.test.mjs test/unified-workflow-board-ui.test.mjs test/board-views.test.mjs test/artifact-upload-views.test.mjs
- [ ] node --test test/task-start-flow.test.mjs test/feishu-execution-coordinator.test.mjs test/artifact-upload-queue.test.mjs
- [ ] npm run typecheck
- [ ] npm run build:web
- [ ] git diff --check
- [ ] D:\\codex\\codex-feishu\\scripts\\check-local.ps1
- [ ] Manual acceptance completed without starting an unintended real Auto-Cut task.
