import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const appSource = await readFile(new URL("../web/src/App.tsx", import.meta.url), "utf8");
const apiSource = await readFile(new URL("../web/src/api.ts", import.meta.url), "utf8");
const styles = await readFile(new URL("../web/src/styles.css", import.meta.url), "utf8");
const editorSource = await readFile(new URL("../web/src/components/TaskEditor.tsx", import.meta.url), "utf8");
const detailSource = await readFile(new URL("../web/src/components/TaskDetail.tsx", import.meta.url), "utf8");
const labelPickerSource = await readFile(new URL("../web/src/components/LabelPicker.tsx", import.meta.url), "utf8");
const pendingAttachmentsSource = await readFile(new URL("../web/src/components/PendingAttachments.tsx", import.meta.url), "utf8");
const labelsSource = await readFile(new URL("../web/src/labels.ts", import.meta.url), "utf8");
const feishuNavigatorSource = await readFile(new URL("../web/src/components/FeishuBaseNavigator.tsx", import.meta.url), "utf8");
const addFeishuLifecycleSource = appSource.slice(
  appSource.indexOf("const addFeishuBaseAndRefreshProjects"),
  appSource.indexOf("const updateFeishuSubject"),
);
const addFeishuBaseFromConfigurationSource = appSource.slice(
  appSource.indexOf("onAddBase={async (url) => {", appSource.indexOf("<FeishuWorkflowPanel")),
  appSource.indexOf("onCatalogChange={setFeishuCatalog}"),
);
const applyFeishuRemovalSource = appSource.slice(
  appSource.indexOf("const applyRemovedFeishuCatalog"),
  appSource.indexOf("const runFeishuRemoval"),
);
const runFeishuRemovalSource = appSource.slice(
  appSource.indexOf("const runFeishuRemoval"),
  appSource.indexOf("useEffect(() => {", appSource.indexOf("const runFeishuRemoval")),
);
const popstateSource = appSource.slice(
  appSource.indexOf("function syncRouteFromLocation()"),
  appSource.indexOf("window.addEventListener(\"popstate\""),
);
const moveTaskSource = appSource.slice(
  appSource.indexOf("async function moveTask"),
  appSource.indexOf("function startTaskDrag", appSource.indexOf("async function moveTask")),
);
const refreshWorkflowOptionsSource = appSource.slice(
  appSource.indexOf("const refreshWorkflowOptions"),
  appSource.indexOf("useEffect(() => {", appSource.indexOf("const refreshWorkflowOptions")),
);
const workflowOptionsEffectStart = appSource.indexOf(
  "useEffect(() => {",
  appSource.indexOf("const refreshWorkflowOptions"),
);
const workflowOptionsEffectSource = appSource.slice(
  workflowOptionsEffectStart,
  appSource.indexOf("useEffect(() => {", workflowOptionsEffectStart + 1),
);
const developmentContextSource = appSource.slice(
  appSource.indexOf("setDevelopmentScanLoading(true)"),
  appSource.indexOf("function pushUndo"),
);
const duplicateTaskSource = appSource.slice(
  appSource.indexOf("async function duplicateTask"),
  appSource.indexOf("async function archiveTask", appSource.indexOf("async function duplicateTask")),
);
const saveEditorSource = appSource.slice(
  appSource.indexOf("async function saveEditor"),
  appSource.indexOf("async function moveTask", appSource.indexOf("async function saveEditor")),
);

test("the project switcher merges live Codex projects with persisted Taskboard projects", () => {
  assert.match(appSource, /hostContext\?\.projects \?\? \[\]/);
  assert.match(appSource, /persistedById/);
  assert.match(appSource, /name: project\.id === GLOBAL_PROJECT_ID\s*\? text\("全局", "Global"\)\s*: persistedById\.get\(project\.id\)\?\.name \?\? project\.name/);
  assert.match(appSource, /for \(const project of projects\) \{[\s\S]*?inCodex: false,[\s\S]*?persisted: true/);
  assert.match(appSource, /activeProjectChoices\.map\(\(project\) => \(/);
  assert.match(appSource, /historicalProjectChoices\.map\(\(project\) => \(/);
  assert.match(appSource, /createProjectRequest/);
  assert.match(apiSource, /export async function createProject/);
});

test("each device stores an independent workspace path for every project", () => {
  assert.match(appSource, /const DEVICE_WORKSPACE_PATHS_KEY = "taskboard\.deviceWorkspacePaths\.v1"/);
  assert.match(appSource, /function readDeviceWorkspacePaths\(\)/);
  assert.match(appSource, /rememberDeviceWorkspacePath/);
  assert.match(appSource, /const \[nextProjects, metadata, workspaces(?:, stageLabels)?\] = await Promise\.all\(\[/);
  assert.match(appSource, /listDeviceWorkspaces\(requestSignal\)/);
  assert.match(appSource, /const selectedDeviceWorkspacePath = selectedProjectId === GLOBAL_PROJECT_ID[\s\S]*?: deviceWorkspacePaths\[selectedProjectId\]/);
  assert.match(appSource, /listDevelopmentContexts\([\s\S]*?selectedDeviceWorkspacePath,[\s\S]*?\)/);
  assert.match(apiSource, /query\.set\("workspacePath", workspacePath\)/);
  assert.match(apiSource, /\/api\/device-workspaces/);
});

test("project selection starts from the route or recent projects and updates the route", () => {
  assert.match(appSource, /const RECENT_PROJECT_IDS_KEY = "taskboard\.recentProjectIds\.v1"/);
  assert.match(appSource, /const initialProjectId = query\.get\("project"\) \?\? recentProjectIds\[0\] \?\? GLOBAL_PROJECT_ID/);
  assert.match(appSource, /const rememberProjectOpen = useCallback/);
  assert.match(appSource, /taskboardStorage\.setItem\(RECENT_PROJECT_IDS_KEY, JSON\.stringify\(next\)\)/);
  assert.match(appSource, /function changeProject\(projectId: string, preferredView\?: BoardView\)/);
  assert.match(appSource, /setSelectedProjectId\(projectId\)/);
  assert.match(appSource, /const url = buildIssueUrl\(window\.location\.href, projectId, null\)/);
  assert.match(appSource, /window\.history\.replaceState\(null, "", url\)/);
});

test("history project switches clear stale task state before selecting the new scope", () => {
  assert.match(popstateSource, /clearRemovedFeishuSelectionState\(\)/);
  assert.ok(
    popstateSource.indexOf("clearRemovedFeishuSelectionState()")
      < popstateSource.indexOf("setSelectedProjectId(routeProjectId)"),
    "popstate must clear project-scoped state before rendering the new project",
  );
});

test("task moves reject a task from a different active project or Feishu subject", () => {
  assert.match(moveTaskSource, /task\.projectId\s*!==\s*selectedProjectIdRef\.current/);
  assert.match(moveTaskSource, /task\.feishuOrigin\?\.subjectKey\s*!==\s*selectedFeishuWorkflowSubjectKeyRef\.current/);
});

test("Feishu removal selects the next subject and rejects late project responses", () => {
  assert.match(appSource, /const projectRequestGenerationRef = useRef\(0\)/);
  assert.match(appSource, /const projectRequestAbortControllerRef = useRef<AbortController \| null>\(null\)/);
  assert.match(appSource, /const feishuCatalogRequestGenerationRef = useRef\(0\)/);
  assert.match(appSource, /const feishuCatalogAbortControllerRef = useRef<AbortController \| null>\(null\)/);
  assert.match(appSource, /requestGeneration !== projectRequestGenerationRef\.current/);
  assert.match(appSource, /selectedProjectIdRef\.current !== projectId/);
  assert.match(appSource, /selectedFeishuSubjectKeyRef\.current !== subjectKey/);
  assert.match(appSource, /catalogGeneration !== feishuCatalogRequestGenerationRef\.current/);
  assert.match(appSource, /clearRemovedFeishuSelectionState/);
  assert.match(appSource, /sameBaseSubjects\[Math\.min\(removedSubjectIndex, sameBaseSubjects\.length - 1\)\]/);
  assert.match(applyFeishuRemovalSource, /const fallbackActiveProject =[\s\S]*?const fallbackActiveSubject =[\s\S]*?const fallbackProjectId = sameBaseFallback\?\.projectId\s*\?\? fallbackActiveProject\?\.id\s*\?\? GLOBAL_PROJECT_ID/);
  assert.match(applyFeishuRemovalSource, /const fallbackSubject = sameBaseFallback\s*\?\? fallbackActiveSubject\s*\?\? null/);
  assert.match(runFeishuRemovalSource, /const previousProjects = projectsRef\.current/);
  assert.match(applyFeishuRemovalSource, /const previousActiveProjects = previousProjects\.filter/);
  assert.match(appSource, /rememberProjectOpen\(fallbackProjectId\)/);
  assert.match(appSource, /buildIssueUrl\(window\.location\.href, fallbackProjectId, null\)/);
  assert.match(feishuNavigatorSource, /从 Taskboard 移除/);
  assert.match(feishuNavigatorSource, /飞书数据不会被删除/);
});

test("all project-scoped async results reject stale project and subject generations", () => {
  assert.match(appSource, /function projectRequestIsCurrent\(/);
  assert.match(refreshWorkflowOptionsSource, /const requestGeneration = projectRequestGenerationRef\.current/);
  assert.match(refreshWorkflowOptionsSource, /const subjectKey = selectedFeishuSubjectKeyRef\.current/);
  assert.match(refreshWorkflowOptionsSource, /projectRequestIsCurrent\(projectId, subjectKey, requestGeneration\)/);
  assert.match(workflowOptionsEffectSource, /const subjectKey = selectedFeishuSubjectKeyRef\.current/);
  assert.match(workflowOptionsEffectSource, /const requestGeneration = projectRequestGenerationRef\.current/);
  assert.match(workflowOptionsEffectSource, /projectRequestIsCurrent\(selectedProjectId, subjectKey, requestGeneration\)/);
  assert.match(workflowOptionsEffectSource, /\[refreshWorkflowOptions, selectedFeishuSubjectKey, selectedProjectId\]/);
  assert.match(developmentContextSource, /projectRequestIsCurrent\(projectId, subjectKey, requestGeneration\)/);
  assert.match(saveEditorSource, /const projectId = selectedProjectId/);
  assert.match(saveEditorSource, /const subjectKey = selectedFeishuSubjectKeyRef\.current/);
  assert.match(saveEditorSource, /const requestGeneration = projectRequestGenerationRef\.current/);
  assert.ok(
    saveEditorSource.indexOf("projectRequestIsCurrent(projectId, subjectKey, requestGeneration)")
      < saveEditorSource.indexOf("setTasks("),
    "save response must be checked before it can update the selected board",
  );
  assert.ok(
    saveEditorSource.indexOf("projectRequestIsCurrent(projectId, subjectKey, requestGeneration)")
      < saveEditorSource.indexOf("pushUndo("),
    "save response must be checked before it can add an undo operation for the selected board",
  );
  assert.doesNotMatch(saveEditorSource, /refreshTasks\(selectedProjectId/);
  assert.match(duplicateTaskSource, /projectRequestIsCurrent\(projectId, subjectKey, requestGeneration\)/);
  assert.ok(
    duplicateTaskSource.indexOf("projectRequestIsCurrent(projectId, subjectKey, requestGeneration)")
      < duplicateTaskSource.indexOf("setTasks("),
    "duplicate response must be checked before it can update the selected board",
  );
});

test("project history refreshes across clients, remains viewable, and scrolls within the viewport", () => {
  assert.match(appSource, /"project\.updated"/);
  assert.match(appSource, /event\.type === "project\.created" \|\| event\.type === "project\.updated"/);
  assert.match(appSource, /aria-label=\{text\(`查看 \$\{project\.name\}`/);
  assert.match(appSource, /void selectProject\(project\)/);
  assert.match(styles, /\.header-project-menu \{[\s\S]*?max-height:[^;]+;[\s\S]*?overflow-y:\s*auto/);
});

test("protected project deletion reports association data instead of mislabeling every row as an issue", () => {
  assert.match(appSource, /projectDeleteAssociations/);
  assert.match(appSource, /关联数据/);
  assert.match(appSource, /associated records/i);
  assert.doesNotMatch(appSource, /projectDeleteIssueCount/);
});

test("project deletion clears only its browser-only workflow layouts after the server succeeds", () => {
  const deleteStart = appSource.indexOf("async function deletePendingProject");
  const deleteEnd = appSource.indexOf("function openProjectDeleteDialog", deleteStart);
  const deleteSource = appSource.slice(deleteStart, deleteEnd);

  assert.match(appSource, /clearUnifiedWorkflowLayoutsForProject/);
  assert.match(
    deleteSource,
    /await deleteProjectRequest\(project\.id\);\s*clearUnifiedWorkflowLayoutsForProject\(project\.id\);/,
  );
});

test("stale Feishu add failures are discarded before they reach the navigator", () => {
  assert.match(addFeishuLifecycleSource, /try \{\s*const next = await addFeishuBaseFromUrl\(url\)/);
  assert.match(addFeishuLifecycleSource, /catch \(error\) \{[\s\S]*?selectedProjectIdRef\.current !== projectId[\s\S]*?selectedFeishuSubjectKeyRef\.current !== subjectKey[\s\S]*?return;[\s\S]*?throw error/);
});

test("adding a Base from configuration keeps the newly added Base selected after project switching", () => {
  const projectSwitchIndex = addFeishuBaseFromConfigurationSource.indexOf("changeProject(nextSubject.projectId");
  const baseSelectionIndex = addFeishuBaseFromConfigurationSource.indexOf("setFeishuConfigurationBaseToken(next.baseToken)");

  assert.notEqual(projectSwitchIndex, -1);
  assert.notEqual(baseSelectionIndex, -1);
  assert.ok(projectSwitchIndex < baseSelectionIndex);
});

test("successful Feishu removal does not report a later refresh failure as a removal error", () => {
  assert.match(runFeishuRemovalSource, /let nextCatalog:[^;]+;\s*try \{\s*nextCatalog = await operation\(\);\s*\} catch \(error\) \{[\s\S]*?throw error;\s*\}\s*try \{/);
  assert.match(runFeishuRemovalSource, /try \{\s*const nextProjects = await listProjects\(\{ includeArchived: true, signal: projectController\.signal \}\);[\s\S]*?\} catch \{[\s\S]*?listFeishuWorkflowCatalog\(catalogController\.signal\)[\s\S]*?\}\s*\}\s*\}, \[applyRemovedFeishuCatalog/);
});

test("the selected project exposes the current board surfaces", () => {
  assert.match(appSource, /<header className="workspace-header">/);
  assert.match(appSource, /<div className=\{`board-toolbar\$\{boardView === "issues" && isSelectedFeishuProject \? " unified-workflow-toolbar" : ""\}`\}>/);
  assert.match(appSource, /<DashboardView/);
  assert.match(appSource, /<IssueListView/);
  assert.match(appSource, /<GanttView/);
  assert.match(appSource, /<BoardColumn/);
  assert.match(styles, /\.workspace-header \{[\s\S]*?border-bottom: var\(--border-hairline\) solid var\(--border\)/);
});

test("new issues stage attachments in the composer and upload them after creation", () => {
  assert.match(editorSource, /type="file"[\s\S]*?multiple/);
  assert.match(editorSource, /<PendingAttachments[\s\S]*?uploadLabel=\{text\("保存后上传", "Upload after saving"\)\}/);
  assert.match(pendingAttachmentsSource, /className="composer-attachment-list"/);
  assert.match(appSource, /Promise\.allSettled/);
  assert.match(appSource, /uploadAttachment\(saved\.id, file\)/);
  assert.match(appSource, /附件上传失败，可在详情页重试/);
});

test("the issue composer includes Linear-style labels and scheduling", () => {
  for (const label of ["缺陷", "特性", "for-claude", "hold", "改进", "phase-1", "phase-6"]) {
    assert.match(labelsSource, new RegExp(label));
  }
  assert.match(editorSource, /<LabelPicker/);
  assert.match(labelPickerSource, /text\(`创建 “\$\{normalizedSearch\}”`, `Create “\$\{normalizedSearch\}”`\)/);
  assert.match(editorSource, /设置截止日期/);
  assert.match(editorSource, /设置重复/);
  assert.match(editorSource, /最早截止日期/);
  assert.match(editorSource, /developmentScan\.contexts/);
});

test("the current project is shown only in navigation, not in issue creation or detail properties", () => {
  assert.doesNotMatch(editorSource, /property-project|dialog-project-icon|project\?\.name/);
  assert.doesNotMatch(detailSource, /detail-property-label">项目|project-property-icon|project\.name/);
  assert.doesNotMatch(styles, /\.property-project|\.dialog-project-icon|\.project-property-icon/);
  assert.match(appSource, /createTaskRequest\(projectId, draft\)/);
  assert.match(appSource, /className="header-project-switcher"/);
});

test("the project header exposes project, automation, and create controls", () => {
  assert.match(appSource, /className="header-project-button"[\s\S]*?aria-haspopup="menu"/);
  assert.match(appSource, /className="header-project-menu" role="menu" aria-label=\{text\("项目", "Projects"\)\}/);
  assert.match(appSource, /<ProjectAutomationMenu/);
  assert.match(appSource, /className="icon-button header-create-button"/);
  assert.match(styles, /\.header-project-menu \{[\s\S]*?-webkit-app-region: no-drag/);
});

test("the project header keeps detail navigation separate from the project switcher", () => {
  assert.match(appSource, /const headerProjectName = selectedFeishuSubject\s*\? `\$\{selectedFeishuSubject\.baseName\} \/ \$\{selectedFeishuSubject\.tableName\}`\s*: selectedProject\?\.id === GLOBAL_PROJECT_ID\s*\? text\("全局", "Global"\)\s*: selectedProject\?\.name \?\? text\("任务面板", "Taskboard"\)/);
  assert.match(appSource, /detailTask && \([\s\S]*?aria-label=\{text\("返回议题看板", "Back to issue board"\)\}[\s\S]*?<\/button>/);
  assert.match(appSource, /className="header-project-switcher"[\s\S]*?<span className="project-name">\{headerProjectName\}<\/span>/);
  assert.doesNotMatch(appSource, /className="issue-root-button"/);
  assert.doesNotMatch(appSource, /detailTask\?\.identifier \?\? "议题"/);
});

test("the collapsed Codex sidebar can be expanded immediately left of the project switcher", () => {
  assert.match(
    appSource,
    /hostContext\?\.sidebarCollapsed[\s\S]*?className="detail-back-button codex-sidebar-expand-button"[\s\S]*?className="header-project-switcher"/,
  );
  assert.match(styles, /\.codex-sidebar-expand-button \{[\s\S]*?width: 28px;[\s\S]*?height: 28px;/);
});

test("embedded mode omits the app navigation and keeps a draggable header region", () => {
  assert.match(appSource, /!embedded && \([\s\S]*?<aside className="app-nav"/);
  assert.match(appSource, /<header className="workspace-header">/);
  assert.match(appSource, /ref=\{dragRegionRef\} className="workspace-drag-region"/);
  assert.match(styles, /\.workspace-drag-region \{[\s\S]*?flex: 1;[\s\S]*?align-self: stretch/);
  assert.match(styles, /\.app-shell\.embedded \.workspace-drag-region \{[\s\S]*?-webkit-app-region: drag/);
});

test("realtime updates remain active on the project home and reconcile after reconnecting", () => {
  assert.match(appSource, /useEffect\(\(\) => \{\s*const source = new EventSource\(resolveTaskboardUrl\("\/api\/events"\)\)/);
  assert.match(appSource, /event\.type\.startsWith\("task\."\)[\s\S]*?scheduleRefresh\(\{ projects: true, tasks: affectsSelectedProject \}\)/);
  assert.match(appSource, /source\.onopen = \(\) => \{[\s\S]*?scheduleRefresh\(\{ projects: true, tasks: Boolean\(selectedProjectId\) \}\)/);
});
