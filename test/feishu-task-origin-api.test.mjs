import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createTaskboardServer } from "../server/index.mjs";
import { subjectProjectId } from "../server/feishu-workflow-store.mjs";

const FEISHU_BRIDGE_SECRET = "fixture-feishu-bridge-secret-2026";

async function createFixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-feishu-origin-api-"));
  const app = createTaskboardServer({
    dataDirectory: directory,
    codexExecutable: process.execPath,
    feishuBridgeSecret: FEISHU_BRIDGE_SECRET,
    feishuPackages: {
      packages: {
        "Auto-cut-copyA": {
          projectId: "auto-cut-copy-a",
          workspacePath: directory,
          prompt: "fixture prompt",
        },
      },
    },
  });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  app.database.createProject({
    id: subjectProjectId("bas_origin_api:tbl_subject_chinese"),
    name: "Chinese",
    workspacePath: directory,
  });
  return { app, baseUrl: `http://127.0.0.1:${address.port}`, directory };
}

async function request(baseUrl, pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      "x-feishu-bridge-secret": FEISHU_BRIDGE_SECRET,
      ...options.headers,
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : undefined };
}

test("Bridge provenance routes reject a forged local client secret", async () => {
  const fixture = await createFixture();
  try {
    const response = await fetch(`${fixture.baseUrl}/api/local/feishu/tasks`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-taskboard-client": "feishu-bridge",
        "x-feishu-bridge-secret": "wrong-secret",
      },
      body: JSON.stringify(taskBody("event-forged-secret", "record-forged-secret")),
    });
    const body = await response.json();
    assert.equal(response.status, 403);
    assert.equal(body.error.code, "FEISHU_BRIDGE_AUTH_FAILED");
  } finally {
    await fixture.app.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

function description(eventId, recordId, { includeSubjectKey = true } = {}) {
  const metadata = {
    version: 1,
    source: "feishu-base",
    eventId,
    baseToken: "bas_origin_api",
    tableId: "tbl_subject_chinese",
    recordId,
    triggerFieldId: "fld_progress",
    triggerValue: "待剪辑",
    mode: "manual",
    packageAlias: "Auto-cut-copyA",
    packageSource: "table-default",
    ...(includeSubjectKey ? { subjectKey: "bas_origin_api:tbl_subject_chinese" } : {}),
  };
  const encoded = Buffer.from(JSON.stringify(metadata), "utf8").toString("base64url");
  return `<!-- feishu-codex-task:v1:${encoded} -->\n\nfixture task`;
}

function taskBody(eventId, recordId, options = {}) {
  return {
    projectId: subjectProjectId("bas_origin_api:tbl_subject_chinese"),
    title: `剪辑 ${recordId}`,
    description: description(eventId, recordId, options),
    status: "todo",
    priority: "high",
    labels: ["feishu"],
  };
}

function blockedDescription(eventId = "event-blocked", recordId = "record-blocked") {
  const metadata = {
    version: 1,
    source: "feishu-base",
    eventId,
    baseToken: "bas_origin_api",
    tableId: "tbl_subject_chinese",
    subjectKey: "bas_origin_api:tbl_subject_chinese",
    recordId,
    triggerField: "进度",
    triggerValue: "待剪辑",
    mode: "manual",
  };
  const encoded = Buffer.from(JSON.stringify(metadata), "utf8").toString("base64url");
  return `<!-- feishu-codex-task:v1:${encoded} -->`;
}

test("Bridge provenance routes isolate trusted tasks from forged markers", async () => {
  const fixture = await createFixture();
  try {
    const project = await request(fixture.baseUrl, "/api/projects", {
      method: "POST",
      body: { id: "auto-cut-copy-a", name: "Auto-cut-copyA", workspacePath: fixture.directory },
    });
    assert.equal(project.response.status, 201);
    const forged = await request(fixture.baseUrl, "/api/tasks", {
      method: "POST",
      ordinary: true,
      body: taskBody("event-forged", "record-forged"),
    });
    assert.equal(forged.response.status, 201);
    assert.equal(forged.body.task.feishuOrigin, undefined);

    const trusted = await request(fixture.baseUrl, "/api/local/feishu/tasks", {
      method: "POST",
      headers: { "x-taskboard-client": "feishu-bridge" },
      body: taskBody("event-trusted", "record-trusted"),
    });
    assert.equal(trusted.response.status, 201);
    assert.equal(trusted.body.task.feishuOrigin.eventId, "event-trusted");
    assert.equal(trusted.body.task.feishuOrigin.packageSource, "table-default");
    assert.equal(trusted.body.task.feishuOrigin.statusFieldId, "fld_progress");

    const byEvent = await request(
      fixture.baseUrl,
      `/api/local/feishu/tasks?eventId=event-trusted&projectId=${encodeURIComponent(subjectProjectId("bas_origin_api:tbl_subject_chinese"))}&archived=all`,
      { method: "GET", headers: { "x-taskboard-client": "feishu-bridge" } },
    );
    assert.equal(byEvent.response.status, 200);
    assert.equal(byEvent.body.task.id, trusted.body.task.id);

    const waiting = await request(
      fixture.baseUrl,
      "/api/local/feishu/tasks?baseToken=bas_origin_api&tableId=tbl_subject_chinese&recordId=record-trusted&triggerFieldId=fld_progress&triggerValue=%E5%BE%85%E5%89%AA%E8%BE%91&status=todo&archived=false",
      { method: "GET", headers: { "x-taskboard-client": "feishu-bridge" } },
    );
    assert.equal(waiting.response.status, 200);
    assert.deepEqual(waiting.body.tasks.map((task) => task.id), [trusted.body.task.id]);

    const boardTasks = await request(
      fixture.baseUrl,
      `/api/tasks?projectId=${encodeURIComponent(subjectProjectId("bas_origin_api:tbl_subject_chinese"))}&archived=false`,
      { method: "GET" },
    );
    assert.equal(boardTasks.response.status, 200);
    const boardTrusted = boardTasks.body.tasks.find((task) => task.id === trusted.body.task.id);
    const boardForged = boardTasks.body.tasks.find((task) => task.id === forged.body.task.id);
    assert.equal(boardTrusted.feishuOrigin.eventId, "event-trusted");
    assert.equal(boardForged.feishuOrigin, undefined);

    const running = await request(fixture.baseUrl, "/api/local/feishu/tasks", {
      method: "POST",
      headers: { "x-taskboard-client": "feishu-bridge" },
      body: taskBody("event-running", "record-running"),
    });
    assert.equal(running.response.status, 201);
    const movedRunning = await request(
      fixture.baseUrl,
      `/api/tasks/${encodeURIComponent(running.body.task.id)}`,
      { method: "PATCH", body: { version: running.body.task.version, status: "in_progress" } },
    );
    assert.equal(movedRunning.response.status, 200);
    const refusedArchive = await request(
      fixture.baseUrl,
      `/api/local/feishu/tasks/${encodeURIComponent(running.body.task.id)}/archive`,
      {
        method: "POST",
        headers: { "x-taskboard-client": "feishu-bridge" },
        body: { version: movedRunning.body.task.version },
      },
    );
    assert.equal(refusedArchive.response.status, 409);
    assert.equal(refusedArchive.body.error.code, "TASK_NOT_WAITING");

    const forgedLookup = await request(
      fixture.baseUrl,
      `/api/local/feishu/tasks?eventId=event-forged&projectId=${encodeURIComponent(subjectProjectId("bas_origin_api:tbl_subject_chinese"))}&archived=all`,
      { method: "GET", headers: { "x-taskboard-client": "feishu-bridge" } },
    );
    assert.equal(forgedLookup.response.status, 200);
    assert.equal(forgedLookup.body.task, null);

    const unknownQuery = await request(
      fixture.baseUrl,
      "/api/local/feishu/tasks?eventId=event-trusted&unexpected=1",
      { method: "GET", headers: { "x-taskboard-client": "feishu-bridge" } },
    );
    assert.equal(unknownQuery.response.status, 400);
    assert.equal(unknownQuery.body.error.code, "UNKNOWN_QUERY_PARAMETER");

    const repeatedQuery = await request(
      fixture.baseUrl,
      "/api/local/feishu/tasks?eventId=event-trusted&eventId=event-trusted",
      { method: "GET", headers: { "x-taskboard-client": "feishu-bridge" } },
    );
    assert.equal(repeatedQuery.response.status, 400);
    assert.equal(repeatedQuery.body.error.code, "INVALID_QUERY_PARAMETER");

    const archived = await request(
      fixture.baseUrl,
      `/api/local/feishu/tasks/${encodeURIComponent(trusted.body.task.id)}/archive`,
      {
        method: "POST",
        headers: { "x-taskboard-client": "feishu-bridge" },
        body: { version: trusted.body.task.version },
      },
    );
    assert.equal(archived.response.status, 200);
    assert.equal(archived.body.task.status, "todo");
    assert.ok(archived.body.task.archivedAt);

    const archivedEvent = await request(
      fixture.baseUrl,
      `/api/local/feishu/tasks?eventId=event-trusted&projectId=${encodeURIComponent(subjectProjectId("bas_origin_api:tbl_subject_chinese"))}&archived=false`,
      { method: "GET", headers: { "x-taskboard-client": "feishu-bridge" } },
    );
    assert.equal(archivedEvent.response.status, 200);
    assert.equal(archivedEvent.body.task, null);

    const archivedWaiting = await request(
      fixture.baseUrl,
      "/api/local/feishu/tasks?baseToken=bas_origin_api&tableId=tbl_subject_chinese&recordId=record-trusted&triggerFieldId=fld_progress&triggerValue=%E5%BE%85%E5%89%AA%E8%BE%91&status=todo&archived=false",
      { method: "GET", headers: { "x-taskboard-client": "feishu-bridge" } },
    );
    assert.equal(archivedWaiting.response.status, 200);
    assert.deepEqual(archivedWaiting.body.tasks, []);

    const forgedArchive = await request(
      fixture.baseUrl,
      `/api/local/feishu/tasks/${encodeURIComponent(forged.body.task.id)}/archive`,
      {
        method: "POST",
        headers: { "x-taskboard-client": "feishu-bridge" },
        body: { version: forged.body.task.version },
      },
    );
    assert.equal(forgedArchive.response.status, 409);
    assert.equal(forgedArchive.body.error.code, "TASK_NOT_STARTABLE");
  } finally {
    await fixture.app.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("dedicated Feishu creation preserves blocked tasks without a package alias", async () => {
  const fixture = await createFixture();
  try {
    const blocked = await request(fixture.baseUrl, "/api/local/feishu/tasks", {
      method: "POST",
      headers: { "x-taskboard-client": "feishu-bridge" },
      body: {
        projectId: subjectProjectId("bas_origin_api:tbl_subject_chinese"),
        title: "缺少项目包",
        description: blockedDescription(),
        status: "blocked",
        priority: "high",
        labels: ["feishu", "blocked"],
      },
    });
    assert.equal(blocked.response.status, 201);
    assert.equal(blocked.body.task.status, "blocked");
    assert.equal(blocked.body.task.feishuOrigin.packageAlias, undefined);
  } finally {
    await fixture.app.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("trusted Feishu tasks cannot be moved away from their subject project", async () => {
  const fixture = await createFixture();
  try {
    for (const project of [
      { id: "other-project", name: "Other project" },
    ]) {
      const created = await request(fixture.baseUrl, "/api/projects", {
        method: "POST",
        body: { ...project, workspacePath: fixture.directory },
      });
      assert.equal(created.response.status, 201);
    }
    const trusted = await request(fixture.baseUrl, "/api/local/feishu/tasks", {
      method: "POST",
      headers: { "x-taskboard-client": "feishu-bridge" },
      body: taskBody("event-project-move", "record-project-move"),
    });
    assert.equal(trusted.response.status, 201);

    const moved = await request(
      fixture.baseUrl,
      `/api/tasks/${encodeURIComponent(trusted.body.task.id)}`,
      {
        method: "PATCH",
        body: { version: trusted.body.task.version, projectId: "other-project" },
      },
    );
    assert.equal(moved.response.status, 409);
    assert.equal(moved.body.error.code, "FEISHU_PROJECT_MOVE_BLOCKED");
  } finally {
    await fixture.app.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("dedicated Feishu creation binds project identity and allows only waiting states", async () => {
  const fixture = await createFixture();
  const expectedProjectId = subjectProjectId("bas_origin_api:tbl_subject_chinese");
  try {
    const wrongProject = await request(fixture.baseUrl, "/api/local/feishu/tasks", {
      method: "POST",
      headers: { "x-taskboard-client": "feishu-bridge" },
      body: { ...taskBody("event-wrong-project", "record-wrong-project"), projectId: "auto-cut-copy-a" },
    });
    assert.equal(wrongProject.response.status, 409);
    assert.equal(wrongProject.body.error.code, "FEISHU_PROJECT_ID_MISMATCH");

    const wrongStatus = await request(fixture.baseUrl, "/api/local/feishu/tasks", {
      method: "POST",
      headers: { "x-taskboard-client": "feishu-bridge" },
      body: { ...taskBody("event-wrong-status", "record-wrong-status"), projectId: expectedProjectId, status: "in_progress" },
    });
    assert.equal(wrongStatus.response.status, 409);
    assert.equal(wrongStatus.body.error.code, "FEISHU_TASK_INITIAL_STATUS_INVALID");

    const missingSubject = await request(fixture.baseUrl, "/api/local/feishu/tasks", {
      method: "POST",
      headers: { "x-taskboard-client": "feishu-bridge" },
      body: {
        ...taskBody("event-missing-subject", "record-missing-subject", { includeSubjectKey: false }),
        projectId: expectedProjectId,
      },
    });
    assert.equal(missingSubject.response.status, 409);
    assert.equal(missingSubject.body.error.code, "FEISHU_SUBJECT_IDENTITY_REQUIRED");
  } finally {
    await fixture.app.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});
