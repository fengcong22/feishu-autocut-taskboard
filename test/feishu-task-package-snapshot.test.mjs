import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createTaskboardServer } from "../server/index.mjs";
import { subjectProjectId } from "../server/feishu-workflow-store.mjs";

const SECRET = "fixture-bridge-secret";

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-package-snapshot-"));
  const workspace = path.join(directory, "workspace");
  await mkdir(workspace);
  const app = createTaskboardServer({
    dataDirectory: directory,
    codexExecutable: process.execPath,
    feishuBridgeSecret: SECRET,
    feishuPackages: {
      packages: {
        "Auto-cut-A": {
          name: "Auto-cut A",
          projectId: "package-project",
          workspacePath: workspace,
          model: "fixture-model",
          reasoningEffort: "low",
          prompt: "run fixture workflow",
          zipSourceDirectory: path.join(directory, "zips"),
          maxConcurrent: 2,
          state: "enabled",
        },
      },
    },
    feishuWorkflowSync: async () => ({ ok: true }),
  });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  return { app, directory, baseUrl: `http://127.0.0.1:${address.port}` };
}

function description(overrides = {}) {
  const metadata = {
    version: 1,
    source: "feishu-base",
    eventId: "evt-snapshot",
    baseToken: "bas_snapshot",
    tableId: "tbl_subject",
    subjectKey: "bas_snapshot:tbl_subject",
    recordId: "rec-snapshot",
    triggerField: "待制作",
    triggerValue: "待制作",
    mode: "manual",
    packageAlias: "Auto-cut-A",
    ...overrides,
  };
  return `<!-- feishu-codex-task:v1:${Buffer.from(JSON.stringify(metadata), "utf8").toString("base64url")} -->`;
}

async function request(baseUrl, body) {
  const response = await fetch(`${baseUrl}/api/local/feishu/tasks`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-taskboard-client": "feishu-bridge",
      "x-feishu-bridge-secret": SECRET,
    },
    body: JSON.stringify(body),
  });
  return { response, body: await response.json() };
}

test("subject editor uses configured package aliases instead of free text", async () => {
  const source = await import("node:fs/promises").then(({ readFile }) => readFile(
    new URL("../web/src/components/FeishuWorkflowPanel.tsx", import.meta.url),
    "utf8",
  ));
  assert.match(source, /listFeishuPackages/);
  assert.match(source, /<select[^>]*value=\{subjectForm\.packageAlias\}/s);
  assert.doesNotMatch(source, /包别名<input value=\{subjectForm\.packageAlias\}/);
  assert.match(source, /selectedPackage\.state !== "enabled"/);
  assert.match(source, /packageAlias: subject\.packageRoute\?\.packageAlias \?\? ""/);
});

test("Bridge registration stores a server-owned package snapshot outside the task description", async () => {
  const fixtureData = await fixture();
  try {
    const projectId = subjectProjectId("bas_snapshot:tbl_subject");
    fixtureData.app.database.createProject({ id: projectId, name: "语文", workspacePath: fixtureData.directory });
    const result = await request(fixtureData.baseUrl, {
      projectId,
      title: "Snapshot task",
      description: description(),
      status: "todo",
      priority: "high",
      labels: ["feishu"],
      assigneeTarget: "current-user",
    });
    assert.equal(result.response.status, 201);
    const task = result.body.task;
    assert.doesNotMatch(task.description, /fixture-model|run fixture workflow|workspace/);
    const snapshot = fixtureData.app.database.getFeishuTaskPackageSnapshot(task.id);
    assert.equal(snapshot.packageAlias, "Auto-cut-A");
    assert.equal(snapshot.packageRevision, 1);
    assert.equal(snapshot.model, "fixture-model");
    assert.equal(snapshot.reasoningEffort, "low");
    assert.equal(snapshot.prompt, "run fixture workflow");
    assert.equal(snapshot.workspacePath, path.join(fixtureData.directory, "workspace"));
    assert.equal(snapshot.zipSourceDirectory, path.join(fixtureData.directory, "zips"));
  } finally {
    await fixtureData.app.close();
    await rm(fixtureData.directory, { recursive: true, force: true });
  }
});

test("registered tasks keep their package revision until an explicit refresh", async () => {
  const fixtureData = await fixture();
  try {
    const projectId = subjectProjectId("bas_snapshot:tbl_subject");
    fixtureData.app.database.createProject({ id: projectId, name: "语文", workspacePath: fixtureData.directory });
    const created = await request(fixtureData.baseUrl, {
      projectId,
      title: "Immutable snapshot",
      description: description({ eventId: "evt-snapshot-2", recordId: "rec-snapshot-2" }),
      status: "todo",
      priority: "high",
      labels: ["feishu"],
    });
    assert.equal(created.response.status, 201);
    const task = created.body.task;
    assert.equal(fixtureData.app.database.getFeishuTaskPackageSnapshot(task.id).prompt, "run fixture workflow");
    assert.equal(fixtureData.app.database.getFeishuTaskPackageSnapshot(task.id).packageRevision, 1);
    assert.equal(fixtureData.app.database.getFeishuTaskPackageSnapshot(task.id).prompt, "run fixture workflow");
  } finally {
    await fixtureData.app.close();
    await rm(fixtureData.directory, { recursive: true, force: true });
  }
});

test("package refresh replaces the snapshot only for a waiting trusted task", async () => {
  const fixtureData = await fixture();
  try {
    const projectId = subjectProjectId("bas_snapshot:tbl_subject");
    fixtureData.app.database.createProject({ id: projectId, name: "语文", workspacePath: fixtureData.directory });
    const created = await request(fixtureData.baseUrl, {
      projectId,
      title: "Refreshable task",
      description: description({ eventId: "evt-refresh", recordId: "rec-refresh" }),
      status: "todo",
      priority: "high",
      labels: ["feishu"],
    });
    assert.equal(created.response.status, 201);
    const refreshed = await fetch(`${fixtureData.baseUrl}/api/local/tasks/${created.body.task.id}/package-refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: created.body.task.version }),
    });
    const payload = await refreshed.json();
    assert.equal(refreshed.status, 200);
    assert.equal(payload.task.version, created.body.task.version + 1);
    assert.equal(fixtureData.app.database.getFeishuTaskPackageSnapshot(created.body.task.id).packageRevision, 1);
  } finally {
    await fixtureData.app.close();
    await rm(fixtureData.directory, { recursive: true, force: true });
  }
});

test("a known disabled package accepts a held start without launching Codex", async () => {
  const fixtureData = await fixture();
  try {
    const projectId = subjectProjectId("bas_snapshot:tbl_subject");
    fixtureData.app.database.createProject({ id: projectId, name: "语文", workspacePath: fixtureData.directory });
    const listed = await fetch(`${fixtureData.baseUrl}/api/local/autocut/packages`).then((response) => response.json());
    const disabled = await fetch(`${fixtureData.baseUrl}/api/local/autocut/packages/Auto-cut-A/disable`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ revision: listed.packages[0].revision }),
    });
    assert.equal(disabled.status, 200);
    const created = await request(fixtureData.baseUrl, {
      projectId,
      title: "Held disabled package",
      description: description({ eventId: "evt-disabled", recordId: "rec-disabled" }),
      status: "todo",
      priority: "high",
      labels: ["feishu"],
    });
    assert.equal(created.response.status, 201);
    assert.equal(fixtureData.app.database.getFeishuTaskPackageSnapshot(created.body.task.id).packageAlias, "Auto-cut-A");
    const start = await fetch(`${fixtureData.baseUrl}/api/tasks/${created.body.task.id}/start-ai`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const startBody = await start.json();
    assert.equal(start.status, 202);
    assert.equal(startBody.task.status, "todo");
    assert.equal(startBody.task.threadId, null);
    assert.equal(startBody.execution.state, "delayed");
    assert.equal(fixtureData.app.database.getFeishuExecution(created.body.task.id).state, "delayed");
    assert.equal(fixtureData.app.database.listAiChatThreads().length, 0);
  } finally {
    await fixtureData.app.close();
    await rm(fixtureData.directory, { recursive: true, force: true });
  }
});
