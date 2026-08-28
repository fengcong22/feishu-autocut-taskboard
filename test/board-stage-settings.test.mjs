import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { ApiError, TaskboardDatabase } from "../server/database.mjs";
import { createTaskboardServer } from "../server/index.mjs";

const statuses = ["backlog", "todo", "queued", "in_progress", "in_review", "blocked", "done", "canceled"];

function labels(prefix) {
  return {
    zh: Object.fromEntries(statuses.map((status) => [status, `${prefix}-${status}`])),
    en: Object.fromEntries(statuses.map((status) => [status, `${prefix}-${status}-en`])),
  };
}

async function request(baseUrl, pathname, options = {}) {
  const headers = new Headers(options.headers);
  if (options.json !== undefined) headers.set("content-type", "application/json");
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers,
    body: options.json === undefined ? options.body : JSON.stringify(options.json),
  });
  let body = null;
  try { body = await response.json(); } catch {}
  return { response, body };
}

test("board stage labels persist with defaults and compare-and-swap versions", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-stage-labels-"));
  const database = new TaskboardDatabase(path.join(directory, "taskboard.sqlite"));
  try {
    const defaults = database.getBoardStageLabels();
    assert.equal(defaults.version, 1);
    assert.equal(defaults.labels.zh.todo, "待处理");
    assert.equal(defaults.labels.zh.queued, "排队中");
    assert.equal(defaults.labels.zh.in_progress, "处理中");
    const saved = database.saveBoardStageLabels(defaults.version, labels("自定义"));
    assert.equal(saved.version, 2);
    assert.equal(saved.labels.zh.done, "自定义-done");
    assert.throws(
      () => database.saveBoardStageLabels(defaults.version, labels("过期")),
      (error) => error instanceof ApiError
        && error.code === "BOARD_STAGE_LABELS_CONFLICT"
        && error.details?.current?.version === 2,
    );
    assert.deepEqual(database.getBoardStageLabels(), saved);
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("board stage label API exposes global settings and preserves internal task statuses", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-stage-label-api-"));
  const app = createTaskboardServer({ dataDirectory: directory });
  try {
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const initial = await request(baseUrl, "/api/local/board-stage-labels");
    assert.equal(initial.response.status, 200);
    const saved = await request(baseUrl, "/api/local/board-stage-labels", {
      method: "PATCH",
      json: { expectedVersion: initial.body.version, labels: labels("面板") },
    });
    assert.equal(saved.response.status, 200);
    assert.equal(saved.body.labels.zh.todo, "面板-todo");
    const conflict = await request(baseUrl, "/api/local/board-stage-labels", {
      method: "PATCH",
      json: { expectedVersion: initial.body.version, labels: labels("冲突") },
    });
    assert.equal(conflict.response.status, 409);
    assert.equal(conflict.body.error.code, "BOARD_STAGE_LABELS_CONFLICT");
    assert.equal(app.database.getBoardStageLabels().labels.zh.queued, "面板-queued");
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("stage label UI is global and keeps internal status IDs stable", async () => {
  const [component, i18n, app, types, api] = await Promise.all([
    readFile(new URL("../web/src/components/BoardStageSettings.tsx", import.meta.url), "utf8"),
    readFile(new URL("../web/src/i18n.tsx", import.meta.url), "utf8"),
    readFile(new URL("../web/src/App.tsx", import.meta.url), "utf8"),
    readFile(new URL("../web/src/types.ts", import.meta.url), "utf8"),
    readFile(new URL("../web/src/api.ts", import.meta.url), "utf8"),
  ]);
  assert.match(component, /getBoardStageLabels/);
  assert.match(component, /saveBoardStageLabels/);
  assert.match(component, /expectedVersion/);
  assert.match(component, /冲突|conflict/i);
  assert.match(component, /TASK_STATUSES\.map/);
  assert.match(i18n, /statusLabel/);
  assert.match(i18n, /BoardStageLabels/);
  assert.match(app, /<BoardStageSettings/);
  assert.match(app, /boardStageLabels/);
  assert.match(types, /interface BoardStageLabels/);
  assert.match(api, /\/api\/local\/board-stage-labels/);
  assert.match(api, /saveBoardStageLabels/);
  assert.doesNotMatch(component, /set.*status|statusId.*label/);
});

test("workflow status controls use the same configurable stage labels", async () => {
  const [inspector, catalog, board] = await Promise.all([
    readFile(new URL("../web/src/components/WorkflowInspector.tsx", import.meta.url), "utf8"),
    readFile(new URL("../web/src/components/workflowCatalog.ts", import.meta.url), "utf8"),
    readFile(new URL("../web/src/components/WorkflowBoard.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(inspector, /const \{ text, statusLabel \} = useTaskboardI18n\(\)/);
  assert.match(inspector, /statusLabel\(status\.value\)/);
  assert.match(catalog, /statusLabel\?: \(status: TaskStatus\) => string/);
  assert.match(catalog, /statusLabel\(.*Status/);
  assert.match(board, /workflowNodeDisplayTitle\(node\.data, text, statusLabel\)/);
});
