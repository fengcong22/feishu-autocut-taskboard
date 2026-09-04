import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const appSource = await readFile(new URL("../web/src/App.tsx", import.meta.url), "utf8");
const apiSource = await readFile(new URL("../web/src/api.ts", import.meta.url), "utf8");
const detailSource = await readFile(new URL("../web/src/components/TaskDetail.tsx", import.meta.url), "utf8");

test("Task Detail exposes a manual Codex start action and opens the returned live thread", () => {
  assert.match(apiSource, /startTaskWithCodex/);
  assert.match(apiSource, /\/api\/tasks\/\$\{encodeURIComponent\(task\.id\)\}\/start-ai/);
  assert.match(appSource, /startTaskWithCodex/);
  assert.match(appSource, /aiOpenThreadRequest/);
  assert.match(appSource, /threadId: response\.thread\.id/);
  assert.match(detailSource, /onStartCodex/);
  assert.match(detailSource, /启动 Codex|启动.*Codex|Start Codex/);
  assert.match(detailSource, /startingCodex/);
});
