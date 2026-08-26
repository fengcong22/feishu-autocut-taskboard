import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const source = async (file) => readFile(new URL(`../${file}`, import.meta.url), "utf8");

test("global Auto-Cut package manager exposes package CRUD editor", async () => {
  const component = await source("web/src/components/FeishuPackageManager.tsx");
  const app = await source("web/src/App.tsx");
  const api = await source("web/src/api.ts");
  const types = await source("web/src/types.ts");
  assert.match(component, /FeishuPackageManager/);
  assert.match(component, /新增|Add/);
  assert.match(component, /保存草稿|Save draft/);
  assert.match(component, /发现模型|Discover models/);
  assert.match(component, /启用|Enable/);
  assert.match(component, /停用|Disable/);
  assert.match(component, /删除|Delete/);
  assert.match(component, /referenceCount|引用/);
  assert.match(component, /workspacePath/);
  assert.match(component, /zipSourceDirectory/);
  assert.match(component, /reasoningEffort/);
  assert.match(component, /maxConcurrent/);
  assert.match(component, /raw|prompt/);
  assert.match(app, /FeishuPackageManager/);
  assert.match(app, /autocut_packages/);
  assert.match(api, /listFeishuPackages/);
  assert.match(api, /saveFeishuPackageDraft/);
  assert.match(api, /enableFeishuPackage/);
  assert.match(api, /disableFeishuPackage/);
  assert.match(api, /removeFeishuPackage/);
  assert.match(api, /discoverFeishuPackageModels/);
  assert.match(types, /interface FeishuPackage/);
});

test("package manager is global and hides project creation controls", async () => {
  const app = await source("web/src/App.tsx");
  const component = await source("web/src/components/FeishuPackageManager.tsx");
  assert.match(app, /type BoardView[\s\S]*autocut_packages/);
  assert.match(app, /boardView === "autocut_packages"/);
  assert.match(component, /onPackageChange/);
  assert.match(component, /aria-label=.*Auto-Cut/);
  assert.doesNotMatch(component, /selectedProject/);
});

test("package manager has responsive two-pane layout without exposing local paths in list", async () => {
  const component = await source("web/src/components/FeishuPackageManager.tsx");
  const styles = await source("web/src/styles.css");
  assert.match(component, /package-list/);
  assert.match(component, /package-editor/);
  assert.match(component, /state/);
  assert.match(component, /referenceCount/);
  assert.match(styles, /feishu-package-manager/);
  assert.match(styles, /@media/);
  assert.match(styles, /feishu-package-editor/);
});
