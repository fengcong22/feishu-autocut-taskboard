import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { createTaskboardServer } from "../server/index.mjs";
import { TaskboardDatabase } from "../server/database.mjs";
import { subjectProjectId } from "../server/feishu-workflow-store.mjs";

const runningApps = [];

afterEach(async () => {
  while (runningApps.length > 0) {
    const { app, directory } = runningApps.pop();
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

async function startServer(configure) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codex-taskboard-lifecycle-"));
  const options = configure ? await configure(directory) : {};
  const app = createTaskboardServer({ dataDirectory: directory, ...options });
  const address = await app.listen({ port: 0 });
  runningApps.push({ app, directory });
  return `http://127.0.0.1:${address.port}`;
}

async function request(baseUrl, pathname, options = {}) {
  const headers = new Headers(options.headers);
  if (options.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json");
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers,
    body: options.body === undefined || typeof options.body === "string" ? options.body : JSON.stringify(options.body),
  });
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : undefined };
}

test("active listing omits archived projects and explicit history includes them", async () => {
  const baseUrl = await startServer();
  await request(baseUrl, "/api/projects", { method: "POST", body: { id: "temp-history", name: "History", workspacePath: null } });
  const archived = await request(baseUrl, "/api/projects/temp-history/archive", { method: "POST", body: { archived: true } });
  assert.equal(archived.response.status, 200);
  assert.notEqual(archived.body.project.archivedAt, null);
  assert.equal((await request(baseUrl, "/api/projects")).body.projects.some((project) => project.id === "temp-history"), false);
  const all = await request(baseUrl, "/api/projects?includeArchived=true");
  assert.equal(all.body.projects.find((project) => project.id === "temp-history").archivedAt !== null, true);
});

test("archived projects reject writes until restored", async () => {
  const baseUrl = await startServer();
  await request(baseUrl, "/api/projects", { method: "POST", body: { id: "temp-write-guard", name: "Guard", workspacePath: null } });
  await request(baseUrl, "/api/projects/temp-write-guard/archive", { method: "POST", body: { archived: true } });
  const blocked = await request(baseUrl, "/api/tasks", { method: "POST", body: { projectId: "temp-write-guard", title: "Must fail" } });
  assert.equal(blocked.response.status, 409);
  assert.equal(blocked.body.error.code, "PROJECT_ARCHIVED");
  const restored = await request(baseUrl, "/api/projects/temp-write-guard/archive", { method: "POST", body: { archived: false } });
  assert.equal(restored.body.project.archivedAt, null);
});

test("permanent deletion checks archived tasks and non-task associations", async () => {
  const baseUrl = await startServer();
  await request(baseUrl, "/api/projects", { method: "POST", body: { id: "temp-protected", name: "Protected", workspacePath: null } });
  const created = await request(baseUrl, "/api/tasks", { method: "POST", body: { projectId: "temp-protected", title: "Archived issue" } });
  await request(baseUrl, `/api/tasks/${created.body.task.id}/archive`, { method: "POST", body: { version: created.body.task.version } });
  const result = await request(baseUrl, "/api/projects/temp-protected", { method: "DELETE" });
  assert.equal(result.response.status, 409);
  assert.equal(result.body.error.code, "PROJECT_NOT_EMPTY");
  assert.equal(result.body.error.details.associations.tasks, 1);
});

test("an empty manually-created project can be archived and permanently deleted", async () => {
  const baseUrl = await startServer();
  await request(baseUrl, "/api/projects", { method: "POST", body: { id: "temp-empty", name: "Empty", workspacePath: null } });
  await request(baseUrl, "/api/projects/temp-empty/archive", { method: "POST", body: { archived: true } });
  assert.equal((await request(baseUrl, "/api/projects/temp-empty", { method: "DELETE" })).response.status, 204);
});

test("project list accepts only includeArchived", async () => {
  const baseUrl = await startServer();
  const result = await request(baseUrl, "/api/projects?includeArchived=true&unexpected=x");
  assert.equal(result.response.status, 400);
  assert.equal(result.body.error.code, "UNKNOWN_QUERY_PARAMETER");
});

test("source workflow freeze archives its validated Feishu project in the caller transaction", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codex-taskboard-freeze-"));
  const filename = path.join(directory, "taskboard.sqlite");
  const database = new TaskboardDatabase(filename);
  try {
    const timestamp = new Date().toISOString();
    const projectId = subjectProjectId("base-freeze:table");
    database.database.prepare(`INSERT INTO projects
      (id, name, workspace_path, source, next_task_number, created_at, updated_at)
      VALUES (?, 'Feishu', NULL, 'feishu', 1, ?, ?)`
    ).run(projectId, timestamp, timestamp);
    database.database.prepare(`INSERT INTO feishu_bases
      (base_token, base_name, created_at, updated_at)
      VALUES ('base-freeze', 'Base', ?, ?)`
    ).run(timestamp, timestamp);
    database.database.prepare(`INSERT INTO feishu_subjects
      (subject_key, base_token, table_id, table_name, project_id, lifecycle, config_version,
       config_json, metadata_json, created_at, updated_at)
      VALUES ('base-freeze:table', 'base-freeze', 'table', 'Table', ?, 'enabled', 1,
       '{}', '{}', ?, ?)`
    ).run(projectId, timestamp, timestamp);
    database.database.exec("BEGIN IMMEDIATE");
    const frozen = database.freezeSourceWorkflowState("base-freeze:table", database.database);
    assert.notEqual(frozen.archivedAt, null);
    database.database.exec("COMMIT");
    assert.notEqual(database.getProject(projectId).archivedAt, null);
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("source workflow freeze rejects a non-deterministic Feishu project identity", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codex-taskboard-freeze-mismatch-"));
  const database = new TaskboardDatabase(path.join(directory, "taskboard.sqlite"));
  try {
    const timestamp = new Date().toISOString();
    database.database.prepare("INSERT INTO projects (id, name, source, next_task_number, created_at, updated_at) VALUES ('feishu-wrong', 'Wrong', 'feishu', 1, ?, ?)").run(timestamp, timestamp);
    database.database.prepare("INSERT INTO feishu_bases (base_token, base_name, created_at, updated_at) VALUES ('base-wrong', 'Base', ?, ?)").run(timestamp, timestamp);
    database.database.prepare(`INSERT INTO feishu_subjects
      (subject_key, base_token, table_id, table_name, project_id, lifecycle, config_version, config_json, metadata_json, created_at, updated_at)
      VALUES ('base-wrong:table', 'base-wrong', 'table', 'Table', 'feishu-wrong', 'enabled', 1, '{}', '{}', ?, ?)`
    ).run(timestamp, timestamp);
    assert.throws(() => database.freezeSourceWorkflowState("base-wrong:table"), (error) => error.code === "PROJECT_SOURCE_MISMATCH");
    assert.equal(database.getProject("feishu-wrong").archivedAt, null);
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});
