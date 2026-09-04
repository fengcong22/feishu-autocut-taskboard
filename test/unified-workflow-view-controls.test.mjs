import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const componentUrl = new URL(
  "../web/src/components/UnifiedWorkflowViewControls.tsx",
  import.meta.url,
);

async function componentSource() {
  try {
    return await readFile(componentUrl, "utf8");
  } catch {
    return "";
  }
}

test("view controls support blank creation, copy, rename, reorder, default, and protected system view", async () => {
  const source = await componentSource();

  for (const token of [
    "新建视图",
    "New view",
    "复制视图",
    "Copy view",
    "编辑视图",
    "Edit view",
    "设为默认",
    "Set as default",
    "删除视图",
    "Delete view",
    "全部流程",
    "All stages",
    "stateRevision",
    "viewRevision",
  ]) {
    assert.match(source, new RegExp(token));
  }

  assert.match(source, /isSystem/);
  assert.match(source, /stageIds:\s*\[\]/);
  assert.match(source, /至少选择一个流程|at least one stage/);
  assert.match(source, /moveStage/);
  assert.match(source, /chevronLeft/);
  assert.match(source, /chevronRight/);
});

test("adding a stage preserves the user's existing manual order", async () => {
  const source = await componentSource();

  assert.match(
    source,
    /current\.stageIds\.includes\(stageId\)\s*\?\s*current\.stageIds\s*:\s*\[\.\.\.current\.stageIds,\s*stageId\]/,
  );
  assert.doesNotMatch(source, /STAGES\.filter\(\(candidate\)/);
  assert.match(source, /function moveStage/);
});

test("the subject entry contract opens and persists its configured default view", async () => {
  const source = await componentSource();

  assert.match(source, /const enteredSubjectKeyRef = useRef<string \| null>\(null\)/);
  assert.match(
    source,
    /if \(subjectKeyRef\.current !== subjectKey\)\s*enteredSubjectKeyRef\.current = null;/,
  );
  assert.match(source, /queueMicrotask\(\(\) => \{/);
  assert.match(source, /let cancelled = false;[\s\S]*?return \(\) => \{\s*cancelled = true;/);
  assert.match(
    source,
    /enteredSubjectKeyRef\.current === subjectKey[\s\S]*?currentState\.defaultViewId[\s\S]*?void selectView\(defaultView\.id\)/,
  );
  assert.match(
    source,
    /updateUnifiedWorkflowView\(selected\.id,[\s\S]*?activeViewId:\s*selected\.id/,
  );
});

test("read-only historical views can be inspected without calling a mutation API", async () => {
  const source = await componentSource();
  const selectStart = source.indexOf("async function selectView");
  const selectEnd = source.indexOf("function beginCreate", selectStart);
  const selectSource = source.slice(selectStart, selectEnd);

  assert.match(selectSource, /if \(selectionState\.readOnly\)/);
  assert.match(selectSource, /activeViewId:\s*selected\.id/);
  assert.match(selectSource, /setCurrentState\(nextState\)/);
  assert.match(selectSource, /onChange\(nextState\)/);
  assert.match(
    selectSource,
    /if \(selectionState\.readOnly\)[\s\S]*?return;[\s\S]*?updateUnifiedWorkflowView/,
  );
  assert.match(source, /disabled=\{Boolean\(busyAction\)\}[\s\S]*?onChange=\{\(event\) => void selectView/);
  assert.match(source, /readOnly \? text\("查看", "Inspect"\) : text\("启用", "Activate"\)/);

  for (const mutationGuard of ["beginCreate", "beginCopy", "beginEdit", "saveDraft", "setDefaultView", "removeView"]) {
    const start = source.indexOf(`function ${mutationGuard}`);
    const end = source.indexOf("\n  }", start);
    assert.match(source.slice(start, end), /currentState\.readOnly/);
  }
});

test("the visible view manager operates on every subject view without activating it first", async () => {
  const source = await componentSource();

  assert.match(source, /管理视图/);
  assert.match(source, /Manage views/);
  assert.match(source, /const \[managerOpen, setManagerOpen\] = useState\(false\)/);
  assert.match(
    source,
    /const subjectViews = currentState\.views\.filter\(\(view\) => view\.subjectKey === subjectKey\)/,
  );
  assert.match(source, /managerOpen\s*&&/);
  assert.match(source, /subjectViews\.map\(\(view\) =>/);
  assert.match(source, /onClick=\{\(\) => void selectView\(view\.id\)\}/);
  assert.match(source, /onClick=\{\(\) => beginCopy\(view\)\}/);
  assert.match(source, /onClick=\{\(\) => beginEdit\(view\)\}/);
  assert.match(source, /onClick=\{\(\) => void setDefaultView\(view\)\}/);
  assert.match(source, /onClick=\{\(\) => void removeView\(view\)\}/);
  assert.doesNotMatch(source, /onClick=\{\(\) => activeView && beginCopy\(activeView\)\}/);
  assert.doesNotMatch(
    source,
    /selectView\(view\.id\)[\s\S]{0,120}(?:beginEdit|setDefaultView|removeView)\(view\)/,
  );
});

test("view controls persist through the view API and offer conflict reload", async () => {
  const source = await componentSource();

  for (const apiName of [
    "getUnifiedWorkflowViews",
    "createUnifiedWorkflowView",
    "updateUnifiedWorkflowView",
    "deleteUnifiedWorkflowView",
  ]) {
    assert.match(source, new RegExp(apiName));
  }

  assert.match(source, /VERSION_CONFLICT/);
  assert.match(source, /重新加载/);
  assert.match(source, /Reload/);
  assert.match(source, /activeViewId/);
  assert.match(source, /defaultViewId/);
});

test("deleting a custom view clears its browser-only layout after the API succeeds", async () => {
  const source = await componentSource();
  const removeStart = source.indexOf("async function removeView");
  const removeEnd = source.indexOf("async function reloadViews", removeStart);
  const removeViewSource = source.slice(removeStart, removeEnd);

  assert.match(source, /projectId: string/);
  assert.match(source, /resetUnifiedWorkflowLayout/);
  assert.match(
    removeViewSource,
    /await deleteUnifiedWorkflowView\([\s\S]*?resetUnifiedWorkflowLayout\(projectId, view\.id\)/,
  );
});

test("view controls isolate subjects, honor read-only state, and expose accessible labels", async () => {
  const source = await componentSource();

  assert.match(source, /subjectKeyRef/);
  assert.match(source, /state\.subjectKey === subjectKey/);
  assert.match(source, /readOnly/);
  assert.match(source, /aria-label/);
  assert.match(source, /aria-describedby/);
  assert.match(source, /type="checkbox"/);
  assert.match(source, /role="alert"/);
  assert.match(source, /当前学科/);
  assert.match(source, /current subject/i);
});

test("only editing can exclude its own view from subject name uniqueness", async () => {
  const source = await componentSource();

  assert.match(source, /const excludedViewId = value\.kind === "edit"/);
  assert.match(source, /view\.id !== excludedViewId/);
});

test("stale async responses are rejected after unmount or an A-B-A subject cycle", async () => {
  const source = await componentSource();

  assert.match(source, /requestGenerationRef/);
  assert.match(source, /requestGenerationRef\.current \+= 1/);
  assert.match(source, /function operationIsCurrent/);
  assert.match(source, /operation\.generation === requestGenerationRef\.current/);
  assert.match(source, /useLayoutEffect\(\(\) => \{/);
  assert.match(
    source,
    /useLayoutEffect\(\(\) => \{[\s\S]*?subjectKeyRef\.current = subjectKey;\s*requestGenerationRef\.current \+= 1;/,
  );
  assert.match(source, /return \(\) => \{/);
});

test("the localized system option is distinct without tightening the persisted naming contract", async () => {
  const source = await componentSource();

  assert.match(source, /全部流程（系统）/);
  assert.match(source, /All stages \(system\)/);
  assert.doesNotMatch(source, /RESERVED_SYSTEM_VIEW_NAMES/);
});
