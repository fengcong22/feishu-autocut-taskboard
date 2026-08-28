import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const ganttSource = await readFile(new URL("../web/src/components/GanttView.tsx", import.meta.url), "utf8");

test("the gantt view uses configurable board stage labels", () => {
  assert.match(ganttSource, /useTaskboardI18n\(\)/);
  assert.match(ganttSource, /function ganttGroupLabel[\s\S]*statusLabel\(status\)/);
  assert.match(ganttSource, /ganttGroupLabel\(group, i18nRef\.current\.statusLabel\)/);
  assert.doesNotMatch(ganttSource, /i18nRef\.current\.text\(group\.chineseLabel, group\.englishLabel\)/);
});
