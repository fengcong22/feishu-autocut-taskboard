import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const source = () => readFile(new URL("../web/src/App.tsx", import.meta.url), "utf8");

test("App refreshes project upload summaries and reacts to upload events", async () => {
  const app = await source();
  assert.match(app, /listArtifactUploads\(projectId/);
  assert.match(app, /listTaskArtifactSummaries\(projectId/);
  assert.match(
    app,
    /Promise\.all\(\[\s*listArtifactUploads\(projectId, requestSignal\),\s*listTaskArtifactSummaries\(projectId, requestSignal\),\s*\]\)/,
  );
  assert.match(app, /artifactUploadItems/);
  assert.match(app, /taskArtifactSummaries/);
  assert.match(app, /refreshArtifactUploads/);
  assert.match(app, /artifact\.upload\.updated/);
});

test("App refreshes verified task ZIP summaries for the selected project", async () => {
  const app = await source();
  assert.match(app, /listTaskArtifactSummaries\(projectId/);
  assert.match(app, /taskArtifactSummaries/);
  assert.match(app, /setTaskArtifactSummaries\(nextArtifactSummaries\)/);
  assert.match(app, /artifactSummaries=\{taskArtifactSummaries\}/);
});

test("App routes Feishu subject issues through the unified board and exposes upload retry", async () => {
  const app = await source();
  assert.match(app, /isSelectedFeishuProject/);
  assert.match(app, /<UnifiedWorkflowBoard[\s\S]*?uploadItems=\{artifactUploadItems\}/);
  assert.match(app, /onRetryUpload=\{[^}]*retryArtifactUploadFromBoard/);
  assert.doesNotMatch(app, /onClick=\{\(\) => selectBoardView\("upload_queue"\)\}/);
  assert.doesNotMatch(app, /onClick=\{\(\) => selectBoardView\("uploading"\)\}/);
  assert.doesNotMatch(app, /onClick=\{\(\) => selectBoardView\("uploaded"\)\}/);
});

test("Feishu unified board keeps the other-task panel available within the selected subject", async () => {
  const app = await source();
  assert.match(app, /const unifiedTasksByStatus/);
  assert.match(app, /const unifiedArchivedTasks/);
  const branchStart = app.indexOf('boardView === "issues" && isSelectedFeishuProject');
  const branchEnd = app.indexOf(') : boardView === "list"', branchStart);
  assert.ok(branchStart >= 0 && branchEnd > branchStart, "expected the Feishu issues branch");
  const branch = app.slice(branchStart, branchEnd);
  assert.match(branch, /<UnifiedWorkflowBoard/);
  assert.match(branch, /<OtherTasksPanel/);
  assert.match(branch, /tasksByStatus=\{unifiedTasksByStatus\}/);
  assert.match(branch, /archivedTasks=\{unifiedArchivedTasks\}/);
});

test("the shared error retry reloads task and upload state", async () => {
  const app = await source();
  assert.match(app, /if \(selectedProjectId\) void refreshTasks\(selectedProjectId\);[\s\S]*?refreshArtifactUploads\(selectedProjectId\)/);
});

test("unified board renders all editing and upload stages", async () => {
  const board = await readFile(
    new URL("../web/src/components/UnifiedWorkflowBoard.tsx", import.meta.url),
    "utf8",
  );
  for (const stage of ["待处理", "排队中", "处理中", "待验收", "已完成剪辑", "上传队列", "上传中", "已上传"]) {
    assert.match(board, new RegExp(stage));
  }
  assert.match(board, /groupUnifiedWorkflowItems/);
  assert.match(board, /readOnly/);
  assert.match(board, /retry/);
});

test("completed-editing cards show and search verified ZIP summaries before upload", async () => {
  const [app, board] = await Promise.all([
    source(),
    readFile(new URL("../web/src/components/UnifiedWorkflowBoard.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(app, /artifactSummaries=\{taskArtifactSummaries\}/);
  assert.match(board, /artifactSummaries: TaskArtifactSummary\[\]/);
  assert.match(board, /matchesUnifiedWorkflowMetadataSearch/);
  assert.match(board, /artifact\.validationStatus/);
  assert.match(board, /artifact\.updatedAt/);
  assert.match(board, /已验证|Verified/);
});

test("TaskCard can be rendered without starting a status drag", async () => {
  const card = await readFile(
    new URL("../web/src/components/TaskCard.tsx", import.meta.url),
    "utf8",
  );
  assert.match(card, /dragEnabled\?: boolean/);
  assert.match(card, /draggable=\{dragEnabled/);
});

test("unified board exposes responsive columns and searchable upload metadata", async () => {
  const board = await readFile(
    new URL("../web/src/components/UnifiedWorkflowBoard.tsx", import.meta.url),
    "utf8",
  );
  const styles = await readFile(new URL("../web/src/styles.css", import.meta.url), "utf8");
  assert.match(styles, /\.unified-workflow-board/);
  assert.match(styles, /scroll-snap-type:\s*x\s+mandatory/);
  assert.match(board, /upload\.filename/);
  assert.match(board, /packageAlias/);
  assert.match(board, /matchesTaskFilters/);
});

test("cloud revision recovery refreshes project upload summaries", async () => {
  const app = await source();
  assert.match(
    app,
    /onInvalidate:\s*\(\) => \{[\s\S]*?refreshArtifactUploads\(projectId,\s*\{\s*quiet:\s*true\s*\}\)/,
  );
});

test("unified board uses configurable labels for real task statuses while keeping upload labels local", async () => {
  const board = await readFile(
    new URL("../web/src/components/UnifiedWorkflowBoard.tsx", import.meta.url),
    "utf8",
  );
  assert.match(board, /const \{ language, locale, statusLabel, text \} = useTaskboardI18n\(\)/);
  assert.match(board, /definition\.taskStatus \? statusLabel\(definition\.taskStatus\) : text\(definition\.label, definition\.englishLabel\)/);
});

test("unified board summarizes the trusted Auto-Cut alias and execution mode without exposing paths", async () => {
  const board = await readFile(
    new URL("../web/src/components/UnifiedWorkflowBoard.tsx", import.meta.url),
    "utf8",
  );
  assert.match(board, /task\.feishuOrigin\?\.packageAlias/);
  assert.match(board, /task\.feishuOrigin\?\.(?:executionMode|mode)/);
  assert.match(board, /自动|Automatic/);
  assert.match(board, /手动|Manual/);
  assert.doesNotMatch(board, /packageSource/);
});

test("unified board disables each failed-upload retry while its request is in flight", async () => {
  const app = await source();
  const board = await readFile(
    new URL("../web/src/components/UnifiedWorkflowBoard.tsx", import.meta.url),
    "utf8",
  );
  assert.match(board, /retryingUploadIds\?: ReadonlySet<string>/);
  assert.match(board, /retryingUploadIds\.has\(upload\.id\)/);
  assert.match(board, /disabled=\{[^}]*retryingUploadIds\.has\(upload\.id\)/);
  assert.match(app, /const \[retryingArtifactUploadIds, setRetryingArtifactUploadIds\] = useState<Set<string>>/);
  assert.match(app, /retryingArtifactUploadIdsRef\.current\.has\(item\.upload\.id\)/);
  assert.match(app, /retryingUploadIds=\{retryingArtifactUploadIds\}/);
});

test("unified board maps upload error codes to fixed safe copy", async () => {
  const board = await readFile(
    new URL("../web/src/components/UnifiedWorkflowBoard.tsx", import.meta.url),
    "utf8",
  );
  assert.match(board, /function uploadErrorLabel\(/);
  assert.match(board, /TARGET_FILE_CONFLICT/);
  assert.match(board, /ARTIFACT_CONTENT_MISSING/);
  assert.match(board, /upload\.errorCode/);
  assert.doesNotMatch(board, /title=\{upload\.errorMessage\}/);
  assert.doesNotMatch(board, />\{upload\.errorMessage\}</);
});

test("unified board restores the exact workflow stage after closing task detail", async () => {
  const app = await source();
  const board = await readFile(
    new URL("../web/src/components/UnifiedWorkflowBoard.tsx", import.meta.url),
    "utf8",
  );

  assert.match(board, /onOpenTask: \(task: Task, stage: UnifiedWorkflowStage\) => void/);
  assert.match(board, /onEdit=\{\(task\) => onOpenTask\(task, definition\.id\)\}/);
  assert.match(board, /onColumnScrollRef\?: \(stage: UnifiedWorkflowStage, element: HTMLDivElement \| null\) => void/);
  assert.match(board, /onColumnScrollRef\?\.\(definition\.id, element\)/);
  assert.match(app, /type BoardColumnScrollKey = TaskStatus \| UnifiedWorkflowStage/);
  assert.match(app, /function detailColumnKey\(task: Task, stage\?: UnifiedWorkflowStage\)/);
  assert.match(app, /onOpenTask=\{\(task, stage\) => openTaskDetail\(task, stage\)\}/);
  const routeSyncStart = app.indexOf("function syncRouteFromLocation");
  const routeSyncEnd = app.indexOf("window.addEventListener", routeSyncStart);
  const routeSync = app.slice(routeSyncStart, routeSyncEnd);
  assert.match(app, /classifyUnifiedStage\(task, uploads\)/);
  assert.match(routeSync, /detailColumnKey\(routeTask\)/);
  assert.doesNotMatch(routeSync, /boardColumnScrollRefs\.current\[routeTask\.status\]/);
});

test("unified board restores its horizontal viewport after closing task detail", async () => {
  const app = await source();
  const board = await readFile(
    new URL("../web/src/components/UnifiedWorkflowBoard.tsx", import.meta.url),
    "utf8",
  );

  assert.match(board, /onBoardScrollRef\?: Ref<HTMLDivElement>/);
  assert.match(board, /className="unified-workflow-board-scroll"[\s\S]*?ref=\{(?:onBoardScrollRef|assignBoardElement)\}/);
  assert.match(app, /const unifiedWorkflowScrollRef = useRef<HTMLDivElement>\(null\)/);
  assert.match(app, /scrollLeft: unifiedWorkflowScrollRef\.current\?\.scrollLeft \?\? 0/);
  assert.match(app, /unifiedWorkflowScrollRef\.current\.scrollLeft = pendingScroll\.scrollLeft/);
  assert.match(app, /onBoardScrollRef=\{unifiedWorkflowScrollRef\}/);
});

test("Feishu projects keep ordinary active tasks in a dedicated other-task tab", async () => {
  const app = await source();
  const panel = await readFile(
    new URL("../web/src/components/OtherTasksPanel.tsx", import.meta.url),
    "utf8",
  );
  const statuses = await readFile(
    new URL("../web/src/issueBoardStatuses.ts", import.meta.url),
    "utf8",
  );

  assert.match(statuses, /export type OtherTasksPanelTab = OtherTaskTab \| "ordinary"/);
  assert.match(app, /useState<OtherTasksPanelTab>\("backlog"\)/);
  assert.match(app, /const unifiedOrdinaryTasks = useMemo/);
  assert.match(app, /!isFeishuWorkflowTask\(task\)/);
  assert.match(app, /ordinaryTasks=\{unifiedOrdinaryTasks\}/);
  assert.match(panel, /ordinaryTasks\?: Task\[\]/);
  assert.match(panel, /text\("普通任务", "Ordinary issues"\)/);
  assert.match(panel, /dragEnabled=\{!ordinary\}/);
});

test("the selected Feishu header identifies both Base and subject table", async () => {
  const app = await source();
  assert.match(
    app,
    /const headerProjectName = selectedFeishuSubject[\s\S]*?selectedFeishuSubject\.baseName[\s\S]*?selectedFeishuSubject\.tableName/,
  );
});

test("workflow cards show stage timing and a safe uploaded target alias", async () => {
  const board = await readFile(
    new URL("../web/src/components/UnifiedWorkflowBoard.tsx", import.meta.url),
    "utf8",
  );
  const types = await readFile(new URL("../web/src/types.ts", import.meta.url), "utf8");

  assert.match(board, /task\.updatedAt/);
  assert.match(board, /formatTimestamp\(task\.updatedAt, locale\)/);
  assert.match(types, /targetId: string \| null/);
  assert.match(board, /upload\.targetId/);
  assert.match(board, /上传目标|Upload target/);
  assert.doesNotMatch(board, /upload\.targetPath/);
});

test("completed editing cards show verified unqueued ZIP summaries", async () => {
  const board = await readFile(
    new URL("../web/src/components/UnifiedWorkflowBoard.tsx", import.meta.url),
    "utf8",
  );

  assert.match(board, /artifactSummaries: TaskArtifactSummary\[\]/);
  assert.match(board, /item\.artifacts/);
  assert.match(board, /已验证 ZIP|Verified ZIP/);
  assert.match(board, /artifact\.filename/);
  assert.doesNotMatch(board, /artifact\.sha256|artifact\.storageKey|artifact\.draftRoot/);
});

test("workflow cards keep unqueued ZIPs visible beside other upload states", async () => {
  const board = await readFile(
    new URL("../web/src/components/UnifiedWorkflowBoard.tsx", import.meta.url),
    "utf8",
  );

  assert.match(board, /summarizeUnifiedWorkflowArtifacts/);
  assert.match(board, /unifiedWorkflowZipEntries/);
  assert.match(board, /zipEntries\.map\(\(entry\)/);
  assert.match(board, /zipCount/);
});

test("workflow column headers distinguish task and ZIP counts", async () => {
  const board = await readFile(
    new URL("../web/src/components/UnifiedWorkflowBoard.tsx", import.meta.url),
    "utf8",
  );

  assert.match(board, /const zipCount = items\.reduce/);
  assert.match(board, /unified-workflow-column-task-count/);
  assert.match(board, /unified-workflow-column-zip-count/);
});

test("hidden workflow summaries stay syncing while upload data is unavailable", async () => {
  const board = await readFile(
    new URL("../web/src/components/UnifiedWorkflowBoard.tsx", import.meta.url),
    "utf8",
  );

  assert.match(board, /summarizeHiddenUnifiedWorkflow\(filteredGroups, renderedStageIds, \{[\s\S]*?uploadLoading,[\s\S]*?uploadError,/);
  assert.match(board, /hasHiddenStages && hiddenSummary\.status === "syncing"/);
});

test("unified board exposes thresholded blank-area pointer panning and independent column scrolling", async () => {
  const [board, app] = await Promise.all([
    readFile(new URL("../web/src/components/UnifiedWorkflowBoard.tsx", import.meta.url), "utf8"),
    source(),
  ]);

  assert.match(board, /onPointerDown/);
  assert.match(board, /onPointerMove/);
  assert.match(board, /onPointerUp/);
  assert.match(board, /onPointerCancel/);
  assert.match(board, /setPointerCapture/);
  assert.match(board, /PAN_THRESHOLD_PX\s*=\s*6/);
  assert.match(board, /button.*0|event\.button\s*!==\s*0/);
  assert.match(board, /button,?\s*a,?\s*input|button,a,input/);
  assert.match(board, /draggable=true|\[draggable=['"]true['"]\]/);
  assert.match(board, /onColumnScroll/);
  assert.match(board, /scrollLeft/);
  assert.match(board, /scrollTop/);
  assert.match(app, /projectId=\{selectedProjectId\}/);
  assert.match(app, /viewId=/);
});

test("unified board clears pan state when a pointer ends outside the board", async () => {
  const board = await readFile(
    new URL("../web/src/components/UnifiedWorkflowBoard.tsx", import.meta.url),
    "utf8",
  );

  assert.match(board, /window\.addEventListener\("pointerup"[\s\S]*?true\)/);
  assert.match(board, /window\.addEventListener\("pointercancel"[\s\S]*?true\)/);
  assert.match(board, /subjectKey[\s\S]*?layoutScopeKey[\s\S]*?useLayoutEffect/);
});

test("unified board edge-scrolls only during an active unified task drag", async () => {
  const board = await readFile(
    new URL("../web/src/components/UnifiedWorkflowBoard.tsx", import.meta.url),
    "utf8",
  );

  assert.match(board, /EDGE_AUTO_SCROLL_ZONE_PX/);
  assert.match(board, /EDGE_AUTO_SCROLL_STEP_PX/);
  assert.match(board, /requestAnimationFrame/);
  assert.match(board, /hasUnifiedWorkflowDragType\(event\.dataTransfer\.types\)/);
  assert.match(board, /draggedTaskIdRef/);
  assert.match(board, /onDragOver=\{handleBoardDragOver\}/);
});

test("unified board restores saved scroll after asynchronous task content is ready", async () => {
  const board = await readFile(
    new URL("../web/src/components/UnifiedWorkflowBoard.tsx", import.meta.url),
    "utf8",
  );

  assert.match(board, /if \(loading\) return;[\s\S]*?restoreScrollPositions\(\)/);
  assert.match(board, /\[loading,[\s\S]*?visibleGroups/);
});

test("unified board projects the active saved view and merges subject stage display overrides", async () => {
  const board = await readFile(
    new URL("../web/src/components/UnifiedWorkflowBoard.tsx", import.meta.url),
    "utf8",
  );
  assert.match(board, /projectUnifiedWorkflowGroups/);
  assert.match(board, /stageIds\?:/);
  assert.match(board, /stageDisplays\?:/);
  assert.match(board, /displayDescription/);
  assert.match(board, /selectedStageIds/);
  assert.match(board, /visibleGroups/);
});

test("all-stage search exposes safe hidden matches and reveals a stage without mutating the saved view", async () => {
  const board = await readFile(
    new URL("../web/src/components/UnifiedWorkflowBoard.tsx", import.meta.url),
    "utf8",
  );
  assert.match(board, /searchScope\?:\s*"activeView" \| "allStages"/);
  assert.match(board, /hidden.*match|hiddenMatches/i);
  assert.match(board, /allStages/);
  assert.match(board, /onOpenTask\(.*stage|onOpenTask/);
  assert.match(board, /reveal|Reveal|显示流程/);
  assert.doesNotMatch(board, /updateUnifiedWorkflowView|saveUnifiedWorkflowView/);
  assert.doesNotMatch(board, /item\.task\.description/);
  assert.doesNotMatch(board, /upload\.(?:targetPath|storageKey|sha256|errorMessage)/);
});

test("ZIP details use an accessible disclosure with scoped expansion and automatic failure visibility", async () => {
  const board = await readFile(
    new URL("../web/src/components/UnifiedWorkflowBoard.tsx", import.meta.url),
    "utf8",
  );
  assert.match(board, /aria-expanded=\{/);
  assert.match(board, /aria-controls=/);
  assert.match(board, /zipExpansion/);
  assert.match(board, /unifiedWorkflowZipEntries/);
  assert.match(board, /zipEntries\.map\(\(entry\)/);
  assert.match(board, /unifiedWorkflowZipExpansionKey\(item\.task\.id, entry\.identity\)/);
  assert.match(board, /upload\.status === "uploading"/);
  assert.match(board, /upload\.status === "failed"/);
  assert.match(board, /search\.trim\(\)/);
  assert.doesNotMatch(board, /artifact\.(?:sha256|storageKey|draftRoot)/);
  assert.doesNotMatch(board, /upload\.(?:sha256|storageKey|targetPath|errorMessage)/);
});

test("upload stages remain read-only drop surfaces", async () => {
  const board = await readFile(
    new URL("../web/src/components/UnifiedWorkflowBoard.tsx", import.meta.url),
    "utf8",
  );
  assert.match(board, /const readOnly = definition\.upload/);
  assert.match(board, /data-read-only=\{readOnly/);
  assert.match(board, /dragEnabled=\{!readOnly\}/);
  assert.match(board, /onDrop=\{readOnly \? undefined/);
  assert.match(board, /onComplete=\{!readOnly \? onComplete : undefined\}/);
});

test("unified-board dragover uses a source-specific type before protected payload data is readable", async () => {
  const board = await readFile(
    new URL("../web/src/components/UnifiedWorkflowBoard.tsx", import.meta.url),
    "utf8",
  );
  const taskCard = await readFile(new URL("../web/src/components/TaskCard.tsx", import.meta.url), "utf8");

  assert.match(taskCard, /UNIFIED_WORKFLOW_DRAG_MIME_TYPE/);
  assert.match(taskCard, /dragSourceSurface === "unified-board"[\s\S]*setData\(UNIFIED_WORKFLOW_DRAG_MIME_TYPE, "1"\)/);
  assert.match(board, /hasUnifiedWorkflowDragType\(event\.dataTransfer\.types\)/);
  assert.doesNotMatch(
    board,
    /onDragOver=[\s\S]*?getData\("application\/x-taskboard-source-surface"\)/,
  );
});

test("unified board scopes stage display overrides and reveal resets to the active subject", async () => {
  const board = await readFile(
    new URL("../web/src/components/UnifiedWorkflowBoard.tsx", import.meta.url),
    "utf8",
  );
  const displayMapStart = board.indexOf("const stageDisplayMap = useMemo");
  const displayMapEnd = board.indexOf("const visibleDefinitions = useMemo", displayMapStart);
  assert.ok(displayMapStart >= 0 && displayMapEnd > displayMapStart, "expected the stage display map block");
  const displayMap = board.slice(displayMapStart, displayMapEnd);
  assert.match(displayMap, /override\.subjectKey\s*===\s*subjectKey/);
  assert.match(displayMap, /\},\s*\[stageDisplays,\s*subjectKey\]\)/);
  assert.match(
    board,
    /setRevealedStageIds\(\[\]\);\s*\n\s*\},\s*\[[^\]]*\bsubjectKey\b[^\]]*\]\)/,
  );
});
