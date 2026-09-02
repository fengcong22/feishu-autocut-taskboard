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
