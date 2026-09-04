import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createTaskboardServer } from "../server/index.mjs";
import { subjectProjectId } from "../server/feishu-workflow-store.mjs";

const FEISHU_BRIDGE_SECRET = "fixture-artifact-summary-secret-2026";
const PACKAGE_ALIAS = "Auto-cut-A";

function feishuDescription({
  eventId,
  baseToken,
  tableId,
  recordId,
}) {
  const metadata = {
    version: 1,
    source: "feishu-base",
    eventId,
    baseToken,
    tableId,
    subjectKey: `${baseToken}:${tableId}`,
    recordId,
    triggerField: "progress",
    triggerValue: "待剪辑",
    mode: "manual",
    packageAlias: PACKAGE_ALIAS,
  };
  const encoded = Buffer.from(JSON.stringify(metadata), "utf8").toString("base64url");
  return `<!-- feishu-codex-task:v1:${encoded} -->`;
}

async function request(baseUrl, pathname, options = {}) {
  const headers = new Headers(options.headers);
  let body;
  if (options.json !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(options.json);
  }
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: options.method,
    headers,
    body,
  });
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : undefined };
}

async function createTask(baseUrl, input, { trusted = false } = {}) {
  const result = await request(
    baseUrl,
    trusted ? "/api/local/feishu/tasks" : "/api/tasks",
    {
      method: "POST",
      headers: trusted
        ? {
            "x-taskboard-client": "feishu-bridge",
            "x-feishu-bridge-secret": FEISHU_BRIDGE_SECRET,
          }
        : undefined,
      json: {
        projectId: input.projectId,
        title: input.title,
        description: input.description,
        status: "todo",
        priority: "none",
        labels: input.labels ?? [],
      },
    },
  );
  assert.equal(result.response.status, 201);
  return result.body.task;
}

function createArtifact(database, taskId, suffix, timestamp) {
  return database.createTaskArtifact(taskId, {
    id: `artifact-${suffix}`,
    storageKey: `private/storage/${suffix}.zip`,
    filename: `${suffix}.zip`,
    contentType: "application/zip",
    size: 128,
    sha256: suffix.padEnd(64, "0").slice(0, 64),
    sourceMode: "manual_select",
    validationStatus: "verified",
    entryCount: 2,
    draftRoot: `private-draft-${suffix}`,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
}

async function createFixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-artifact-summaries-"));
  const app = createTaskboardServer({
    dataDirectory: directory,
    codexExecutable: process.execPath,
    feishuBridgeSecret: FEISHU_BRIDGE_SECRET,
    feishuPackages: {
      packages: {
        [PACKAGE_ALIAS]: {
          projectId: "auto-cut-a",
          workspacePath: directory,
          prompt: "fixture prompt",
        },
      },
    },
  });
  app.database.createProject({ id: "auto-cut-a", name: "Auto Cut A", workspacePath: directory });
  for (const subjectKey of ["bas_one:tbl_chinese", "bas_two:tbl_math"]) {
    app.database.createProject({
      id: subjectProjectId(subjectKey),
      name: subjectKey,
      workspacePath: directory,
    });
  }
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  return { app, baseUrl: `http://127.0.0.1:${address.port}`, directory };
}

test("project artifact summaries expose only trusted Feishu task ZIP metadata", async () => {
  const fixture = await createFixture();
  try {
    const projectId = subjectProjectId("bas_one:tbl_chinese");
    const trustedDescription = feishuDescription({
      eventId: "event-trusted",
      baseToken: "bas_one",
      tableId: "tbl_chinese",
      recordId: "rec-trusted",
    });
    const trusted = await createTask(fixture.baseUrl, {
      projectId,
      title: "可信任务",
      description: trustedDescription,
      labels: ["feishu"],
    }, { trusted: true });
    const visibleArtifact = createArtifact(
      fixture.app.database,
      trusted.id,
      "visible",
      "2026-09-01T08:00:00.000Z",
    );

    const ordinary = await createTask(fixture.baseUrl, {
      projectId,
      title: "普通任务",
      description: "ordinary task",
    });
    createArtifact(fixture.app.database, ordinary.id, "ordinary", "2026-09-01T08:01:00.000Z");

    const forged = await createTask(fixture.baseUrl, {
      projectId,
      title: "伪造来源任务",
      description: feishuDescription({
        eventId: "event-forged",
        baseToken: "bas_one",
        tableId: "tbl_chinese",
        recordId: "rec-forged",
      }),
      labels: ["feishu"],
    });
    createArtifact(fixture.app.database, forged.id, "forged", "2026-09-01T08:02:00.000Z");

    const mismatched = await createTask(fixture.baseUrl, {
      projectId,
      title: "来源不匹配任务",
      description: feishuDescription({
        eventId: "event-mismatched",
        baseToken: "bas_one",
        tableId: "tbl_chinese",
        recordId: "rec-before",
      }),
      labels: ["feishu"],
    }, { trusted: true });
    const changed = await request(fixture.baseUrl, `/api/tasks/${encodeURIComponent(mismatched.id)}`, {
      method: "PATCH",
      json: {
        version: mismatched.version,
        description: feishuDescription({
          eventId: "event-mismatched",
          baseToken: "bas_one",
          tableId: "tbl_chinese",
          recordId: "rec-after",
        }),
      },
    });
    assert.equal(changed.response.status, 200);
    createArtifact(fixture.app.database, mismatched.id, "mismatched", "2026-09-01T08:03:00.000Z");

    const otherProject = await createTask(fixture.baseUrl, {
      projectId: subjectProjectId("bas_two:tbl_math"),
      title: "其他项目任务",
      description: feishuDescription({
        eventId: "event-other-project",
        baseToken: "bas_two",
        tableId: "tbl_math",
        recordId: "rec-other-project",
      }),
      labels: ["feishu"],
    }, { trusted: true });
    createArtifact(fixture.app.database, otherProject.id, "other-project", "2026-09-01T08:04:00.000Z");

    const result = await request(
      fixture.baseUrl,
      `/api/local/task-artifact-summaries?projectId=${encodeURIComponent(projectId)}`,
    );
    assert.equal(result.response.status, 200);
    assert.deepEqual(result.body, {
      summaries: [{
        id: visibleArtifact.id,
        taskId: trusted.id,
        filename: "visible.zip",
        validationStatus: "verified",
        createdAt: "2026-09-01T08:00:00.000Z",
        updatedAt: "2026-09-01T08:00:00.000Z",
      }],
    });
    assert.deepEqual(
      Object.keys(result.body.summaries[0]).sort(),
      ["createdAt", "filename", "id", "taskId", "updatedAt", "validationStatus"],
    );
    for (const forbidden of [
      "storageKey", "sourcePath", "targetPath", "draftRoot", "sourceMode", "sha256", "secret",
    ]) {
      assert.equal(JSON.stringify(result.body).includes(forbidden), false);
    }
  } finally {
    await fixture.app.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("project artifact summaries require one valid project id and allow only GET", async () => {
  const fixture = await createFixture();
  try {
    const missing = await request(fixture.baseUrl, "/api/local/task-artifact-summaries");
    assert.equal(missing.response.status, 400);
    assert.equal(missing.body.error.code, "INVALID_QUERY_PARAMETER");

    const unknown = await request(
      fixture.baseUrl,
      "/api/local/task-artifact-summaries?projectId=auto-cut-a&extra=1",
    );
    assert.equal(unknown.response.status, 400);
    assert.equal(unknown.body.error.code, "UNKNOWN_QUERY_PARAMETER");

    const method = await request(
      fixture.baseUrl,
      "/api/local/task-artifact-summaries?projectId=auto-cut-a",
      { method: "POST", json: {} },
    );
    assert.equal(method.response.status, 405);
  } finally {
    await fixture.app.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("project artifact summaries do not hydrate full task records for each ZIP", async () => {
  const fixture = await createFixture();
  const originalGetTask = fixture.app.database.getTask;
  try {
    const projectId = subjectProjectId("bas_one:tbl_chinese");
    const task = await createTask(fixture.baseUrl, {
      projectId,
      title: "多个草稿包",
      description: feishuDescription({
        eventId: "event-multiple-zips",
        baseToken: "bas_one",
        tableId: "tbl_chinese",
        recordId: "rec-multiple-zips",
      }),
      labels: ["feishu"],
    }, { trusted: true });
    createArtifact(fixture.app.database, task.id, "first", "2026-09-01T08:00:00.000Z");
    createArtifact(fixture.app.database, task.id, "second", "2026-09-01T08:01:00.000Z");

    fixture.app.database.getTask = () => {
      throw new Error("summary listing must not hydrate a complete task");
    };
    const result = await request(
      fixture.baseUrl,
      `/api/local/task-artifact-summaries?projectId=${encodeURIComponent(projectId)}`,
    );
    assert.equal(result.response.status, 200);
    assert.deepEqual(result.body.summaries.map((summary) => summary.filename), [
      "second.zip",
      "first.zip",
    ]);
  } finally {
    fixture.app.database.getTask = originalGetTask;
    await fixture.app.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("web API exposes the typed project artifact summary reader", async () => {
  const [api, types] = await Promise.all([
    readFile(new URL("../web/src/api.ts", import.meta.url), "utf8"),
    readFile(new URL("../web/src/types.ts", import.meta.url), "utf8"),
  ]);
  assert.match(types, /export interface TaskArtifactSummary/);
  assert.match(api, /export async function listTaskArtifactSummaries/);
  assert.match(api, /\/api\/local\/task-artifact-summaries\?\$\{params\}/);
});
