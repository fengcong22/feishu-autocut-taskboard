import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const appSource = await readFile(new URL("../web/src/App.tsx", import.meta.url), "utf8");
const issueListSource = await readFile(new URL("../web/src/components/IssueListView.tsx", import.meta.url), "utf8");
const unifiedBoardSource = await readFile(new URL("../web/src/components/UnifiedWorkflowBoard.tsx", import.meta.url), "utf8");

test("completed editing is a unified Feishu stage with legacy view compatibility", () => {
  assert.match(appSource, /type BoardView = [\s\S]*?"completed_editing"/);
  assert.match(appSource, /view === "dashboard" \|\| view === "list" \|\| view === "gantt" \|\| view === "issues" \|\| view === "completed_editing"/);
  assert.match(appSource, /view === "completed_editing"[\s\S]*?view === "upload_queue"[\s\S]*?view === "uploading"[\s\S]*?view === "uploaded"/);
  assert.match(appSource, /setItem\([\s\S]*?"issues"\)/);
  assert.match(appSource, /return task\.feishuOrigin\?\.source === "feishu-base"/);
  assert.match(appSource, /const completedEditingTasks = useMemo\([\s\S]*?task\.status === "done" && isFeishuWorkflowTask\(task\)/);
  assert.match(unifiedBoardSource, /已完成剪辑/);
  assert.match(appSource, /boardView === "issues" && isSelectedFeishuProject[\s\S]*?<UnifiedWorkflowBoard/);
  assert.match(appSource, /boardView === "completed_editing"[\s\S]*?<IssueListView[\s\S]*?tasks=\{completedEditingTasks\}[\s\S]*?statuses=\{\["done"\]\}/);
});

test("the reused list can scope to done and opens its scoped completed section", () => {
  assert.match(issueListSource, /statuses\?: readonly TaskStatus\[\]/);
  assert.match(issueListSource, /const visibleStatuses = statuses \?\? TASK_STATUSES/);
  assert.match(issueListSource, /COLLAPSED_BY_DEFAULT\.filter\(\(status\) => !statuses\?\.includes\(status\)\)/);
  assert.match(issueListSource, /visibleStatuses\.map\(\(status\) =>/);
});
