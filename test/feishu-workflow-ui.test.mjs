import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const source = async (file) => readFile(new URL(`../${file}`, import.meta.url), "utf8");

test("Feishu workflow panel exposes Base and subject navigation", async () => {
  const panel = await source("web/src/components/FeishuWorkflowPanel.tsx");
  const helper = await source("web/src/feishuWorkflow.ts");
  const app = await source("web/src/App.tsx");
  assert.match(panel, /FeishuWorkflowPanel/);
  assert.match(panel, /onAddBase/);
  assert.match(panel, /onSelectSubject/);
  assert.match(panel, /保存草稿/);
  assert.match(panel, /启用/);
  assert.match(panel, /停用/);
  assert.match(panel, /待剪辑|待制作/);
  assert.match(panel, /上传路径/);
  assert.match(helper, /listFeishuWorkflowCatalog/);
  assert.match(helper, /selectedSubjectKey/);
  assert.match(app, /FeishuWorkflowPanel/);
  assert.match(app, /listFeishuWorkflowCatalog/);
});

test("panel source filters hidden subjects while retaining draft and enabled labels", async () => {
  const panel = await source("web/src/components/FeishuWorkflowPanel.tsx");
  assert.match(panel, /displayEnabled/);
  assert.match(panel, /lifecycle/);
  assert.match(panel, /draft/);
  assert.match(panel, /enabled/);
  assert.match(panel, /subjects\.filter/);
  assert.match(panel, /未显示/);
  assert.match(panel, /显示/);
  assert.match(panel, /onToggleDisplay/);
  assert.match(panel, /导出共享配置/);
  assert.match(panel, /导入共享配置/);
  assert.match(panel, /importFeishuWorkflowShare/);
  assert.match(panel, /exportFeishuWorkflowShare/);
  assert.match(panel, /warnings\.slice\(0, 8\)/);
  assert.match(panel, /entry\.message/);
  assert.match(panel, /还有.*项/);
});

test("adding a Base refreshes the project catalog before selecting its subject", async () => {
  const app = await source("web/src/App.tsx");
  assert.match(app, /addFeishuBaseFromUrl/);
  assert.match(app, /refreshProjectList\(\)/);
  assert.match(app, /onAddBase=\{[^}]*addFeishuBase/);
});

test("subject settings expose ZIP source, upload policy, and execution routing controls", async () => {
  const panel = await source("web/src/components/FeishuWorkflowPanel.tsx");
  for (const field of [
    "artifactSourceMode",
    "artifactSourcePath",
    "enqueueMode",
    "targetId",
    "targetPath",
    "uploadConcurrency",
    "packageAlias",
    "concurrencyGroup",
    "resourceGroups",
  ]) {
    assert.match(panel, new RegExp(field));
  }
  assert.match(panel, /<option value="manual_select">手动选择<\/option>/);
  assert.match(panel, /<option value="watch_directory" disabled>/);
  assert.match(panel, /<option value="driver_report">Auto-Cut 上报<\/option>/);
  assert.doesNotMatch(panel, /<option value="driver_report" disabled>/);
  assert.match(panel, /subjectForm\.artifactSourceMode === "driver_report"\s*&&\s*!subjectForm\.artifactSourcePath\.trim\(\)/);
  assert.match(panel, /subjectForm\.artifactSourceMode === "watch_directory"/);
  assert.match(panel, /artifactSourceMode: subjectForm\.artifactSourceMode/);
  assert.match(panel, /artifactSourcePath: subjectForm\.artifactSourceMode === "manual_select"\s*\? null/);
  assert.match(panel, /uploadConcurrency/);
  assert.match(panel, /保存草稿/);
});

test("trigger settings bind Feishu metadata field and option identities", async () => {
  const panel = await source("web/src/components/FeishuWorkflowPanel.tsx");
  const types = await source("web/src/types.ts");
  assert.match(types, /interface FeishuFieldMetadata/);
  assert.match(types, /options: FeishuFieldOption\[\]/);
  assert.match(panel, /selected\.metadata\?\.fields/);
  assert.match(panel, /triggerFieldId/);
  assert.match(panel, /fieldId: subjectForm\.triggerFieldId/);
  assert.match(panel, /fieldName: subjectForm\.triggerFieldName/);
  assert.match(panel, /optionId: subjectForm\.optionId/);
  assert.match(panel, /expectedVersion: selected\.configVersion/);
  assert.match(panel, /startValueOptions/);
  assert.match(panel, /option\.id/);
  assert.match(panel, /option\.name/);
});

test("left Base navigation opens a subject board and keeps configuration scoped to its Base", async () => {
  const navigator = await source("web/src/components/FeishuBaseNavigator.tsx");
  const panel = await source("web/src/components/FeishuWorkflowPanel.tsx");
  const app = await source("web/src/App.tsx");
  assert.match(navigator, /FeishuBaseNavigator/);
  assert.match(navigator, /aria-expanded/);
  assert.match(navigator, /subject\.displayEnabled/);
  assert.match(navigator, /onSelectSubject\(subject\.subjectKey\)/);
  assert.match(app, /changeProject\(subject\.projectId, ["']issues["']\)/);
  assert.match(app, /<FeishuBaseNavigator/);
  assert.match(app, /onOpenConfiguration=\{openFeishuConfiguration\}/);
  assert.match(app, /setFeishuConfigurationBaseToken\(base\?\.baseToken \?\? null\)/);
  assert.match(panel, /catalog\.filter\(\(base\) => base\.baseToken === configurationBaseToken\)/);
  assert.doesNotMatch(app, /<FeishuWorkflowPanel[\s\S]*?compact=\{true\}/);
});

test("workflow view can be retained per project when returning from a subject board", async () => {
  const app = await source("web/src/App.tsx");
  assert.match(app, /view === ["']workflow["']/);
});

test("hidden subject selection stays in configuration while visible subjects open their task board", async () => {
  const panel = await source("web/src/components/FeishuWorkflowPanel.tsx");
  const app = await source("web/src/App.tsx");
  assert.match(panel, /onSelectSubject\(subject\.subjectKey, true\)/);
  assert.match(panel, /onSelectSubject\(subject\.subjectKey, false\)/);
  assert.match(app, /onSelectSubject=\{\(subjectKey, openProject = true\)/);
  assert.match(app, /changeProject\(subject\.projectId, openProject \? ["']issues["'] : ["']workflow["']\)/);
  assert.match(app, /setFeishuConfigurationOpen\(!openProject\)/);
});

test("draft subjects can stop an older Bridge snapshot before re-enabling", async () => {
  const panel = await source("web/src/components/FeishuWorkflowPanel.tsx");
  assert.match(panel, /停用旧 Bridge 快照/);
  assert.match(panel, /transition\("disable"\)/);
});

test("subject workflow settings keep stage display editing separate from global labels", async () => {
  const settings = await source("web/src/components/UnifiedWorkflowStageSettings.tsx");
  const api = await source("web/src/api.ts");
  const types = await source("web/src/types.ts");
  assert.match(settings, /UnifiedWorkflowStageSettings/);
  assert.match(settings, /subjectKey/);
  assert.match(settings, /onChange/);
  assert.match(settings, /onError/);
  assert.match(settings, /Save|保存/);
  assert.match(settings, /Reset|重置/);
  assert.match(api, /getUnifiedWorkflowStageDisplays/);
  assert.match(api, /saveUnifiedWorkflowStageDisplay/);
  assert.match(types, /interface StageDisplayOverride/);
});
