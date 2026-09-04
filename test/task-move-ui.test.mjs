import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const appSource = await readFile(new URL("../web/src/App.tsx", import.meta.url), "utf8");
const apiSource = await readFile(new URL("../web/src/api.ts", import.meta.url), "utf8");
const unifiedBoardSource = await readFile(
  new URL("../web/src/components/UnifiedWorkflowBoard.tsx", import.meta.url),
  "utf8",
);

test("dragging a ready Feishu workflow task into processing uses unified execution", () => {
  assert.match(apiSource, /export async function executeTaskWithCodex/);
  assert.match(appSource, /executeTaskWithCodex/);
  assert.match(
    appSource,
    /task\.status === "todo"\s*&&\s*status === "in_progress"\s*&&\s*isFeishuWorkflowTask\(task\)/s,
  );
  assert.match(appSource, /await executeTaskWithCodex\(task, "move"\)/);
});

test("non-Feishu and non-processing moves retain the normal move request", () => {
  assert.match(appSource, /await moveTaskRequest\(task, status, sortOrder\)/);
});

test("task drops use a synchronous ref lock until the move settles", () => {
  assert.match(appSource, /const movingTaskRef = useRef<string \| null>\(null\);/);
  assert.match(appSource, /if \(movingTaskRef\.current \|\| movingTaskId\)/);
  assert.match(appSource, /movingTaskRef\.current = task\.id;/);
  assert.match(appSource, /movingTaskRef\.current = null;/);
});

test("unified-board drops carry a source surface and use the subject-scoped guard", () => {
  assert.match(appSource, /canDropUnifiedWorkflowTask/);
  assert.match(appSource, /sourceSurface/);
  assert.match(appSource, /unified-board/);
  assert.match(unifiedBoardSource, /canDropUnifiedWorkflowTask/);
  assert.match(unifiedBoardSource, /sourceSurface/);
  assert.match(unifiedBoardSource, /visibleStageIds/);
  assert.match(unifiedBoardSource, /subjectKey/);
  assert.match(unifiedBoardSource, /taskById\.get\(taskId\)/);
  assert.doesNotMatch(unifiedBoardSource, /items\.find\(\(item\) => item\.task\.id === taskId\)/);
});

test("unified-board drops reject a panel source before submitting the move", () => {
  assert.match(unifiedBoardSource, /if \([^\n]*sourceSurface[^\n]*!==\s*"unified-board"/);
  assert.match(unifiedBoardSource, /return;[\s\S]*setDropBeforeTaskId\(undefined\)/);
  assert.match(appSource, /sourceSurface === "unified-board"/);
});

test("the App drop boundary revalidates the current subject and visible stages", () => {
  assert.match(appSource, /function finishTaskDrop\(destination: TaskStatus, taskId: string, beforeTaskId: string \| null = null, sourceSurface/);
  assert.match(appSource, /canDropUnifiedWorkflowTask\(/);
  assert.match(appSource, /selectedFeishuWorkflowSubjectKeyRef\.current/);
  assert.match(appSource, /visibleStageIds/);
  assert.match(appSource, /sourceSurface === "unified-board"/);
});
