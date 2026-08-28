import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createTaskboardServer as createTaskboardServerBase } from "../server/index.mjs";
import { createArtifactService } from "../server/artifact-service.mjs";
import { subjectProjectId } from "../server/feishu-workflow-store.mjs";
import { createArtifactUploadWorker } from "../server/upload-worker.mjs";
import { createStoredZip } from "./stored-zip-fixture.mjs";

const TEST_FEISHU_BRIDGE_SECRET = "fixture-feishu-bridge-secret-2026";
const createTaskboardServer = (options = {}) => createTaskboardServerBase({
  feishuBridgeSecret: TEST_FEISHU_BRIDGE_SECRET,
  ...options,
});

function manualFeishuDescription(baseToken = "bas_artifact", tableId = "tbl_chinese", snapshot = {}) {
  const metadata = {
    version: 1,
    source: "feishu-base",
    eventId: "artifact-upload-fixture",
    baseToken,
    tableId,
    subjectKey: `${baseToken}:${tableId}`,
    recordId: "rec_artifact",
    triggerField: "status",
    triggerValue: "待剪辑",
    mode: "manual",
    packageAlias: "Auto-cut-A",
    ...snapshot,
  };
  const encoded = Buffer.from(JSON.stringify(metadata), "utf8").toString("base64url");
  return `<!-- feishu-codex-task:v1:${encoded} -->`;
}

function automaticFeishuDescription(baseToken, tableId, snapshot = {}) {
  const metadata = {
    version: 1,
    source: "feishu-base",
    eventId: `artifact-upload-auto-${baseToken}-${tableId}`,
    baseToken,
    tableId,
    subjectKey: `${baseToken}:${tableId}`,
    recordId: "rec_artifact_auto",
    triggerField: "status",
    triggerValue: "待剪辑",
    mode: "automatic",
    executionMode: "automatic",
    packageAlias: "Auto-cut-A",
    ...snapshot,
  };
  const encoded = Buffer.from(JSON.stringify(metadata), "utf8").toString("base64url");
  return `<!-- feishu-codex-task:v1:${encoded} -->`;
}

async function request(baseUrl, pathname, options = {}) {
  const headers = new Headers(options.headers);
  const rawFeishu = options.rawFeishu === true;
  const isFeishuCreate = !rawFeishu
    && (pathname === "/api/tasks" || pathname === "/api/local/feishu/tasks")
    && options.method === "POST"
    && options.json && typeof options.json.description === "string"
    && options.json.description.includes("feishu-codex-task");
  const requestPath = isFeishuCreate ? "/api/local/feishu/tasks" : pathname;
  if (isFeishuCreate) {
    headers.set("x-taskboard-client", "feishu-bridge");
    headers.set("x-feishu-bridge-secret", TEST_FEISHU_BRIDGE_SECRET);
  }
  let requestJson = options.json;
  let requestedStatus = null;
  if (isFeishuCreate) {
    requestedStatus = options.json.status ?? "todo";
    const metadata = JSON.parse(Buffer.from(
      options.json.description.match(/feishu-codex-task:v1:([A-Za-z0-9_-]+)/u)[1],
      "base64url",
    ).toString("utf8"));
    const subjectKey = metadata.subjectKey ?? `${metadata.baseToken}:${metadata.tableId}`;
    requestJson = {
      ...options.json,
      projectId: subjectProjectId(subjectKey),
      status: requestedStatus === "blocked" ? "blocked" : "todo",
    };
  }
  if (options.json !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const response = await fetch(`${baseUrl}${requestPath}`, {
    method: options.method,
    headers,
    body: requestJson === undefined ? options.body : JSON.stringify(requestJson),
  });
  const text = await response.text();
  const result = { response, body: text ? JSON.parse(text) : undefined };
  if (
    isFeishuCreate
    && result.body?.task
    && !["todo", "blocked"].includes(requestedStatus)
  ) {
    const moved = await request(baseUrl, `/api/tasks/${encodeURIComponent(result.body.task.id)}`, {
      method: "PATCH",
      json: { version: result.body.task.version, status: requestedStatus },
    });
    if (moved.body?.task) result.body.task = moved.body.task;
  }
  return result;
}

async function waitForUpload(baseUrl, taskId, uploadId, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await request(baseUrl, `/api/local/tasks/${encodeURIComponent(taskId)}/upload`);
    const upload = result.body.uploads.find((candidate) => candidate.id === uploadId);
    if (upload?.status === "uploaded") return upload;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for artifact upload '${uploadId}'`);
}

async function waitForUploadStatus(baseUrl, taskId, uploadId, status, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await request(baseUrl, `/api/local/tasks/${encodeURIComponent(taskId)}/upload`);
    const upload = result.body.uploads.find((candidate) => candidate.id === uploadId);
    if (upload?.status === status) return upload;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for artifact upload '${uploadId}' to reach '${status}'`);
}

test("server begins listening without waiting for upload recovery to drain", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-upload-start-"));
  let releaseStart;
  let listening;
  const uploadWorker = {
    start() {
      return new Promise((resolve) => { releaseStart = resolve; });
    },
    wake() { return Promise.resolve(); },
    async close() { releaseStart?.(); },
  };
  const app = createTaskboardServer({
    dataDirectory: directory,
    codexExecutable: process.execPath,
    uploadWorker,
  });
  try {
    listening = app.listen({ host: "127.0.0.1", port: 0 });
    const outcome = await Promise.race([
      listening.then(() => "listening"),
      new Promise((resolve) => setTimeout(() => resolve("timed-out"), 100)),
    ]);
    assert.equal(outcome, "listening");
  } finally {
    await app.close();
    await Promise.allSettled([listening]);
    await rm(directory, { recursive: true, force: true });
  }
});

test("a manual Feishu task copies a verified Jianying ZIP through the local upload queue", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-artifact-upload-"));
  const destinationDirectory = path.join(directory, "upload-target");
  const app = createTaskboardServer({
    dataDirectory: directory,
    codexExecutable: process.execPath,
    feishuPackages: {
      packages: {
        "Auto-cut-A": {
          projectId: "auto-cut-a",
          workspacePath: directory,
          prompt: "fixture prompt",
        },
      },
    },
    feishuWorkflowSync: async () => ({ ok: true }),
  });
  try {
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const catalog = await request(baseUrl, "/api/local/feishu/workflow/catalog", {
      method: "POST",
      json: {
        baseToken: "bas_artifact",
        baseName: "剪辑学科",
        tables: [{ tableId: "tbl_chinese", tableName: "语文", fields: [] }],
      },
    });
    assert.equal(catalog.response.status, 201);
    const subject = catalog.body.catalog[0].subjects[0];
    const subjectKey = encodeURIComponent(subject.subjectKey);
    const saved = await request(baseUrl, `/api/local/feishu/workflow/subjects/${subjectKey}`, {
      method: "PATCH",
      json: {
        upload: {
          enqueueMode: "manual",
          artifactSourceMode: "manual_select",
          artifactSourcePath: null,
          targetId: "fixture-upload-target",
          targetPath: destinationDirectory,
          uploadConcurrency: 1,
        },
      },
    });
    assert.equal(saved.response.status, 200);

    const taskResult = await request(baseUrl, "/api/tasks", {
      method: "POST",
      json: {
        projectId: subject.projectId,
        title: "语文剪映草稿",
        description: manualFeishuDescription("bas_artifact", "tbl_chinese"),
        status: "in_progress",
        priority: "none",
        labels: ["feishu"],
      },
    });
    assert.equal(taskResult.response.status, 201);
    const task = taskResult.body.task;
    const zip = createStoredZip([
      { name: "draft/draft_content.json", content: "{}" },
      { name: "draft/draft_meta_info.json", content: "{}" },
    ]);
    const artifactResult = await request(baseUrl, `/api/local/tasks/${encodeURIComponent(task.id)}/artifacts`, {
      method: "POST",
      headers: {
        "content-type": "application/zip",
        "x-taskboard-filename": encodeURIComponent("语文剪映草稿.zip"),
      },
      body: zip,
    });
    assert.equal(artifactResult.response.status, 201);
    const artifact = artifactResult.body.artifact;
    assert.equal(Object.hasOwn(artifact, "storageKey"), false);

    const awaitingReview = await request(baseUrl, `/api/tasks/${encodeURIComponent(task.id)}`);
    assert.equal(awaitingReview.body.task.status, "in_review");
    const accepted = await request(baseUrl, `/api/tasks/${encodeURIComponent(task.id)}`, {
      method: "PATCH",
      json: { version: awaitingReview.body.task.version, status: "done" },
    });
    assert.equal(accepted.response.status, 200);
    assert.equal(accepted.body.task.status, "done");

    const queued = await request(baseUrl, `/api/local/tasks/${encodeURIComponent(task.id)}/upload-queue`, {
      method: "POST",
      json: { artifactId: artifact.id },
    });
    assert.equal(queued.response.status, 202);
    assert.equal(queued.body.upload.targetId, "fixture-upload-target");
    assert.equal(Object.hasOwn(queued.body.upload, "storageKey"), false);
    assert.equal(Object.hasOwn(queued.body.upload, "targetPath"), false);

    const uploaded = await waitForUpload(baseUrl, task.id, queued.body.upload.id);
    assert.equal(uploaded.status, "uploaded");
    assert.equal(Object.hasOwn(uploaded, "storageKey"), false);
    assert.equal(Object.hasOwn(uploaded, "targetPath"), false);
    const projectUploads = await request(
      baseUrl,
      `/api/local/artifact-uploads?projectId=${encodeURIComponent(subject.projectId)}`,
    );
    assert.equal(projectUploads.response.status, 200);
    assert.equal(projectUploads.body.items.length, 1);
    assert.equal(projectUploads.body.items[0].task.id, task.id);
    assert.equal(projectUploads.body.items[0].upload.id, queued.body.upload.id);
    assert.equal(Object.hasOwn(projectUploads.body.items[0].upload, "storageKey"), false);
    assert.equal(Object.hasOwn(projectUploads.body.items[0].upload, "targetPath"), false);
    const copied = await readFile(path.join(destinationDirectory, artifact.filename));
    assert.equal(createHash("sha256").update(copied).digest("hex"), artifact.sha256);

    const currentTask = await request(baseUrl, `/api/tasks/${encodeURIComponent(task.id)}`);
    assert.equal(currentTask.response.status, 200);
    assert.equal(currentTask.body.task.status, "done");
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("automatic upload mode follows ZIP verification and manual acceptance without duplicate jobs", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-artifact-auto-enqueue-"));
  const destinationDirectory = path.join(directory, "upload-target");
  const uploadWorker = { start() {}, wake() {}, async close() {} };
  const app = createTaskboardServer({
    dataDirectory: directory,
    codexExecutable: process.execPath,
    uploadWorker,
    feishuPackages: {
      packages: {
        "Auto-cut-A": {
          projectId: "auto-cut-a",
          workspacePath: directory,
          prompt: "fixture prompt",
          zipSourceDirectory: path.join(directory, "zip-source"),
        },
      },
    },
    feishuWorkflowSync: async () => ({ ok: true }),
  });
  try {
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const catalog = await request(baseUrl, "/api/local/feishu/workflow/catalog", {
      method: "POST",
      json: {
        baseToken: "bas_auto_enqueue",
        baseName: "剪辑学科",
        tables: [{ tableId: "tbl_subject", tableName: "语文", fields: [] }],
      },
    });
    const subject = catalog.body.catalog[0].subjects[0];
    const key = encodeURIComponent(subject.subjectKey);
    const saved = await request(baseUrl, `/api/local/feishu/workflow/subjects/${key}`, {
      method: "PATCH",
      json: {
        upload: {
          enqueueMode: "automatic",
          artifactSourceMode: "manual_select",
          artifactSourcePath: null,
          targetId: "automatic-target",
          targetPath: destinationDirectory,
          uploadConcurrency: 1,
        },
      },
    });
    assert.equal(saved.response.status, 200);

    const zip = createStoredZip([
      { name: "draft/draft_content.json", content: "{}" },
      { name: "draft/draft_meta_info.json", content: "{}" },
    ]);
    const automaticTask = (await request(baseUrl, "/api/tasks", {
      method: "POST",
      json: {
        projectId: subject.projectId,
        title: "自动剪辑",
        description: automaticFeishuDescription("bas_auto_enqueue", "tbl_subject"),
        status: "in_progress",
        priority: "none",
        labels: ["feishu"],
      },
    })).body.task;
    const automaticArtifact = await request(
      baseUrl,
      `/api/local/tasks/${encodeURIComponent(automaticTask.id)}/artifacts`,
      {
        method: "POST",
        headers: {
          "content-type": "application/zip",
          "x-taskboard-filename": encodeURIComponent("automatic.zip"),
        },
        body: zip,
      },
    );
    assert.equal(automaticArtifact.response.status, 201);
    assert.equal((await request(baseUrl, `/api/tasks/${automaticTask.id}`)).body.task.status, "done");
    const automaticUploads = await request(baseUrl, `/api/local/tasks/${automaticTask.id}/upload`);
    assert.equal(automaticUploads.body.uploads.length, 1);
    assert.equal(automaticUploads.body.uploads[0].status, "queued");

    const repeatedArtifact = await request(
      baseUrl,
      `/api/local/tasks/${encodeURIComponent(automaticTask.id)}/artifacts`,
      {
        method: "POST",
        headers: {
          "content-type": "application/zip",
          "x-taskboard-filename": encodeURIComponent("automatic.zip"),
        },
        body: zip,
      },
    );
    assert.equal(repeatedArtifact.response.status, 200);
    assert.equal(repeatedArtifact.body.artifact.id, automaticArtifact.body.artifact.id);
    assert.equal((await request(baseUrl, `/api/local/tasks/${automaticTask.id}/upload`)).body.uploads.length, 1);

    const manualTask = (await request(baseUrl, "/api/tasks", {
      method: "POST",
      json: {
        projectId: subject.projectId,
        title: "手动验收剪辑",
        description: manualFeishuDescription("bas_auto_enqueue", "tbl_subject"),
        status: "in_progress",
        priority: "none",
        labels: ["feishu"],
      },
    })).body.task;
    const manualArtifact = await request(baseUrl, `/api/local/tasks/${manualTask.id}/artifacts`, {
      method: "POST",
      headers: {
        "content-type": "application/zip",
        "x-taskboard-filename": encodeURIComponent("manual.zip"),
      },
      body: zip,
    });
    assert.equal(manualArtifact.response.status, 201);
    const awaitingReview = (await request(baseUrl, `/api/tasks/${manualTask.id}`)).body.task;
    assert.equal(awaitingReview.status, "in_review");
    assert.equal((await request(baseUrl, `/api/local/tasks/${manualTask.id}/upload`)).body.uploads.length, 0);

    const accepted = await request(baseUrl, `/api/tasks/${manualTask.id}`, {
      method: "PATCH",
      json: { version: awaitingReview.version, status: "done" },
    });
    assert.equal(accepted.response.status, 200);
    assert.equal((await request(baseUrl, `/api/local/tasks/${manualTask.id}/upload`)).body.uploads.length, 1);
    const repeatedAcceptance = await request(baseUrl, `/api/tasks/${manualTask.id}`, {
      method: "PATCH",
      json: { version: accepted.body.task.version, status: "done" },
    });
    assert.equal(repeatedAcceptance.response.status, 200);
    assert.equal((await request(baseUrl, `/api/local/tasks/${manualTask.id}/upload`)).body.uploads.length, 1);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("automatic upload enqueue is recovered from completed tasks after a restart", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-artifact-auto-recovery-"));
  const destinationDirectory = path.join(directory, "upload-target");
  const options = {
    dataDirectory: directory,
    codexExecutable: process.execPath,
    uploadWorker: { start() {}, wake() {}, async close() {} },
    feishuPackages: {
      packages: {
        "Auto-cut-A": {
          projectId: "auto-cut-a",
          workspacePath: directory,
          prompt: "fixture prompt",
          zipSourceDirectory: path.join(directory, "zip-source"),
        },
      },
    },
    feishuWorkflowSync: async () => ({ ok: true }),
  };
  let app;
  try {
    app = createTaskboardServer(options);
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const catalog = await request(baseUrl, "/api/local/feishu/workflow/catalog", {
      method: "POST",
      json: {
        baseToken: "bas_auto_recovery",
        baseName: "剪辑学科",
        tables: [{ tableId: "tbl_subject", tableName: "语文", fields: [] }],
      },
    });
    const subject = catalog.body.catalog[0].subjects[0];
    const saved = await request(baseUrl, `/api/local/feishu/workflow/subjects/${encodeURIComponent(subject.subjectKey)}`, {
      method: "PATCH",
      json: {
        upload: {
          enqueueMode: "automatic",
          artifactSourceMode: "manual_select",
          artifactSourcePath: null,
          targetId: "automatic-target",
          targetPath: destinationDirectory,
          uploadConcurrency: 1,
        },
      },
    });
    assert.equal(saved.response.status, 200);
    const task = (await request(baseUrl, "/api/tasks", {
      method: "POST",
      json: {
        projectId: subject.projectId,
        title: "自动入队恢复",
        description: automaticFeishuDescription("bas_auto_recovery", "tbl_subject"),
        status: "in_progress",
        priority: "none",
        labels: ["feishu"],
      },
    })).body.task;
    const zip = createStoredZip([
      { name: "draft/draft_content.json", content: "{}" },
      { name: "draft/draft_meta_info.json", content: "{}" },
    ]);
    const originalCreate = app.database.createArtifactUpload;
    app.database.createArtifactUpload = () => {
      throw new Error("simulated enqueue interruption");
    };
    const artifactResult = await request(baseUrl, `/api/local/tasks/${task.id}/artifacts`, {
      method: "POST",
      headers: {
        "content-type": "application/zip",
        "x-taskboard-filename": encodeURIComponent("recovery.zip"),
      },
      body: zip,
    });
    app.database.createArtifactUpload = originalCreate;
    assert.equal(artifactResult.response.status, 201);
    assert.equal(artifactResult.body.task.status, "done");
    assert.equal(
      artifactResult.body.task.feishuPackageSnapshot.zipSourceDirectory,
      path.join(directory, "zip-source"),
    );
    assert.deepEqual((await request(baseUrl, `/api/local/tasks/${task.id}/upload`)).body.uploads, []);
    await app.close();
    app = createTaskboardServer(options);
    const restartedAddress = await app.listen({ host: "127.0.0.1", port: 0 });
    const restartedUrl = `http://127.0.0.1:${restartedAddress.port}`;
    const uploads = await request(restartedUrl, `/api/local/tasks/${task.id}/upload`);
    assert.equal(uploads.response.status, 200);
    assert.equal(uploads.body.uploads.length, 1);
    assert.equal(uploads.body.uploads[0].status, "queued");
  } finally {
    await app?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a task keeps the upload target and concurrency from its creation-time subject version", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-artifact-upload-snapshot-"));
  const originalTarget = path.join(directory, "original-target");
  const replacementTarget = path.join(directory, "replacement-target");
  const uploadWorker = { start() {}, wake() {}, async close() {} };
  const app = createTaskboardServer({
    dataDirectory: directory,
    codexExecutable: process.execPath,
    uploadWorker,
    feishuPackages: {
      packages: {
        "Auto-cut-A": { projectId: "auto-cut-a", workspacePath: directory, prompt: "fixture prompt" },
      },
    },
    feishuWorkflowSync: async () => ({ ok: true }),
  });
  try {
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const catalog = await request(baseUrl, "/api/local/feishu/workflow/catalog", {
      method: "POST",
      json: {
        baseToken: "bas_snapshot",
        baseName: "剪辑学科",
        tables: [{ tableId: "tbl_subject", tableName: "语文", fields: [] }],
      },
    });
    const subject = catalog.body.catalog[0].subjects[0];
    const key = encodeURIComponent(subject.subjectKey);
    const original = await request(baseUrl, `/api/local/feishu/workflow/subjects/${key}`, {
      method: "PATCH",
      json: {
        upload: {
          enqueueMode: "automatic",
          artifactSourceMode: "manual_select",
          artifactSourcePath: null,
          targetId: "original-target",
          targetPath: originalTarget,
          uploadConcurrency: 2,
        },
      },
    });
    assert.equal(original.response.status, 200);

    const task = (await request(baseUrl, "/api/tasks", {
      method: "POST",
      json: {
        projectId: subject.projectId,
        title: "配置快照",
        description: automaticFeishuDescription("bas_snapshot", "tbl_subject", {
          subjectKey: subject.subjectKey,
          configVersion: original.body.subject.configVersion,
          uploadMode: "automatic",
        }),
        status: "in_progress",
        priority: "none",
        labels: ["feishu"],
      },
    })).body.task;

    const replacement = await request(baseUrl, `/api/local/feishu/workflow/subjects/${key}`, {
      method: "PATCH",
      json: {
        expectedVersion: original.body.subject.configVersion,
        upload: {
          enqueueMode: "automatic",
          artifactSourceMode: "manual_select",
          artifactSourcePath: null,
          targetId: "replacement-target",
          targetPath: replacementTarget,
          uploadConcurrency: 7,
        },
      },
    });
    assert.equal(replacement.response.status, 200);

    const artifact = await request(baseUrl, `/api/local/tasks/${task.id}/artifacts`, {
      method: "POST",
      headers: {
        "content-type": "application/zip",
        "x-taskboard-filename": encodeURIComponent("snapshot.zip"),
      },
      body: createStoredZip([
        { name: "draft/draft_content.json", content: "{}" },
        { name: "draft/draft_meta_info.json", content: "{}" },
      ]),
    });
    assert.equal(artifact.response.status, 201);

    const row = app.database.database.prepare(`
      SELECT target_id, target_path, upload_concurrency
      FROM artifact_uploads WHERE task_id = ?
    `).get(task.id);
    assert.deepEqual({ ...row }, {
      target_id: "original-target",
      target_path: originalTarget,
      upload_concurrency: 2,
    });
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a manual task cannot enter the upload queue before review approval", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-artifact-upload-review-gate-"));
  const destinationDirectory = path.join(directory, "upload-target");
  const uploadWorker = { start() {}, wake() {}, async close() {} };
  const app = createTaskboardServer({
    dataDirectory: directory,
    codexExecutable: process.execPath,
    uploadWorker,
    feishuPackages: {
      packages: {
        "Auto-cut-A": { projectId: "auto-cut-a", workspacePath: directory, prompt: "fixture prompt" },
      },
    },
    feishuWorkflowSync: async () => ({ ok: true }),
  });
  try {
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const catalog = await request(baseUrl, "/api/local/feishu/workflow/catalog", {
      method: "POST",
      json: {
        baseToken: "bas_review_gate",
        baseName: "剪辑学科",
        tables: [{ tableId: "tbl_subject", tableName: "语文", fields: [] }],
      },
    });
    const subject = catalog.body.catalog[0].subjects[0];
    const key = encodeURIComponent(subject.subjectKey);
    await request(baseUrl, `/api/local/feishu/workflow/subjects/${key}`, {
      method: "PATCH",
      json: {
        upload: {
          enqueueMode: "manual",
          artifactSourceMode: "manual_select",
          artifactSourcePath: null,
          targetId: "review-target",
          targetPath: destinationDirectory,
          uploadConcurrency: 1,
        },
      },
    });
    const task = (await request(baseUrl, "/api/tasks", {
      method: "POST",
      json: {
        projectId: subject.projectId,
        title: "待验收上传门禁",
        description: manualFeishuDescription("bas_review_gate", "tbl_subject"),
        status: "in_review",
        priority: "none",
        labels: ["feishu"],
      },
    })).body.task;
    const artifact = (await request(baseUrl, `/api/local/tasks/${task.id}/artifacts`, {
      method: "POST",
      headers: {
        "content-type": "application/zip",
        "x-taskboard-filename": encodeURIComponent("review.zip"),
      },
      body: createStoredZip([
        { name: "draft/draft_content.json", content: "{}" },
        { name: "draft/draft_meta_info.json", content: "{}" },
      ]),
    })).body.artifact;

    const queued = await request(baseUrl, `/api/local/tasks/${task.id}/upload-queue`, {
      method: "POST",
      json: { artifactId: artifact.id },
    });
    assert.equal(queued.response.status, 409);
    assert.equal(queued.body.error.code, "TASK_NOT_UPLOAD_READY");
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("upload queue is idempotent for the same artifact and destination", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-artifact-upload-idempotent-"));
  const destinationDirectory = path.join(directory, "upload-target");
  const app = createTaskboardServer({
    dataDirectory: directory,
    codexExecutable: process.execPath,
    feishuPackages: {
      packages: {
        "Auto-cut-A": { projectId: "auto-cut-a", workspacePath: directory, prompt: "fixture prompt" },
      },
    },
    feishuWorkflowSync: async () => ({ ok: true }),
  });
  try {
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const catalog = await request(baseUrl, "/api/local/feishu/workflow/catalog", {
      method: "POST",
      json: { baseToken: "bas_idempotent", baseName: "剪辑学科", tables: [{ tableId: "tbl_subject", tableName: "语文", fields: [] }] },
    });
    const subject = catalog.body.catalog[0].subjects[0];
    const subjectKey = encodeURIComponent(subject.subjectKey);
    const saved = await request(baseUrl, `/api/local/feishu/workflow/subjects/${subjectKey}`, {
      method: "PATCH",
      json: { upload: { enqueueMode: "manual", artifactSourceMode: "manual_select", artifactSourcePath: null, targetId: "target", targetPath: destinationDirectory, uploadConcurrency: 1 } },
    });
    assert.equal(saved.response.status, 200);
    const taskResult = await request(baseUrl, "/api/tasks", {
      method: "POST",
      json: { projectId: subject.projectId, title: "幂等测试", description: manualFeishuDescription("bas_idempotent", "tbl_subject"), status: "in_review", priority: "none", labels: ["feishu"] },
    });
    const task = taskResult.body.task;
    const artifactResult = await request(baseUrl, `/api/local/tasks/${encodeURIComponent(task.id)}/artifacts`, {
      method: "POST",
      headers: { "content-type": "application/zip", "x-taskboard-filename": encodeURIComponent("same.zip") },
      body: createStoredZip([
        { name: "draft/draft_content.json", content: "{}" },
        { name: "draft/draft_meta_info.json", content: "{}" },
      ]),
    });
    const artifact = artifactResult.body.artifact;
    const awaitingReview = (await request(baseUrl, `/api/tasks/${encodeURIComponent(task.id)}`)).body.task;
    const accepted = await request(baseUrl, `/api/tasks/${encodeURIComponent(task.id)}`, {
      method: "PATCH",
      json: { version: awaitingReview.version, status: "done" },
    });
    assert.equal(accepted.response.status, 200);
    const first = await request(baseUrl, `/api/local/tasks/${encodeURIComponent(task.id)}/upload-queue`, { method: "POST", json: { artifactId: artifact.id } });
    const second = await request(baseUrl, `/api/local/tasks/${encodeURIComponent(task.id)}/upload-queue`, { method: "POST", json: { artifactId: artifact.id } });
    assert.equal(first.response.status, 202);
    assert.equal(second.response.status, 202);
    assert.equal(second.body.upload.id, first.body.upload.id);
    await waitForUpload(baseUrl, task.id, first.body.upload.id);
    const entries = await request(baseUrl, `/api/local/tasks/${encodeURIComponent(task.id)}/upload`);
    assert.equal(entries.body.uploads.length, 1);
    await access(path.join(destinationDirectory, artifact.filename));
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a different ZIP with the same destination filename is rejected without overwrite", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-artifact-upload-conflict-"));
  const destinationDirectory = path.join(directory, "upload-target");
  const app = createTaskboardServer({
    dataDirectory: directory,
    codexExecutable: process.execPath,
    feishuPackages: { packages: { "Auto-cut-A": { projectId: "auto-cut-a", workspacePath: directory, prompt: "fixture prompt" } } },
    feishuWorkflowSync: async () => ({ ok: true }),
  });
  try {
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const catalog = await request(baseUrl, "/api/local/feishu/workflow/catalog", { method: "POST", json: { baseToken: "bas_conflict", baseName: "剪辑学科", tables: [{ tableId: "tbl_subject", tableName: "语文", fields: [] }] } });
    const subject = catalog.body.catalog[0].subjects[0];
    const key = encodeURIComponent(subject.subjectKey);
    await request(baseUrl, `/api/local/feishu/workflow/subjects/${key}`, { method: "PATCH", json: { upload: { enqueueMode: "manual", artifactSourceMode: "manual_select", artifactSourcePath: null, targetId: "target", targetPath: destinationDirectory, uploadConcurrency: 1 } } });
    const firstTask = (await request(baseUrl, "/api/tasks", {
      method: "POST",
      json: {
        projectId: subject.projectId,
        title: "冲突测试一",
        description: automaticFeishuDescription("bas_conflict", "tbl_subject"),
        status: "in_progress",
        priority: "none",
        labels: ["feishu"],
      },
    })).body.task;
    const firstZip = createStoredZip([
      { name: "draft/draft_content.json", content: "{\"value\":\"one\"}" },
      { name: "draft/draft_meta_info.json", content: "{}" },
    ]);
    const firstArtifact = (await request(baseUrl, `/api/local/tasks/${encodeURIComponent(firstTask.id)}/artifacts`, { method: "POST", headers: { "content-type": "application/zip", "x-taskboard-filename": encodeURIComponent("same.zip") }, body: firstZip })).body.artifact;
    const firstUpload = (await request(baseUrl, `/api/local/tasks/${encodeURIComponent(firstTask.id)}/upload-queue`, { method: "POST", json: { artifactId: firstArtifact.id } })).body.upload;
    await waitForUpload(baseUrl, firstTask.id, firstUpload.id);

    const secondTask = (await request(baseUrl, "/api/tasks", {
      method: "POST",
      json: {
        projectId: subject.projectId,
        title: "冲突测试二",
        description: automaticFeishuDescription("bas_conflict", "tbl_subject"),
        status: "in_progress",
        priority: "none",
        labels: ["feishu"],
      },
    })).body.task;
    const secondArtifact = (await request(baseUrl, `/api/local/tasks/${encodeURIComponent(secondTask.id)}/artifacts`, { method: "POST", headers: { "content-type": "application/zip", "x-taskboard-filename": encodeURIComponent("same.zip") }, body: createStoredZip([{ name: "draft/draft_content.json", content: "{\"value\":\"two\"}" }, { name: "draft/draft_meta_info.json", content: "{}" }]) })).body.artifact;
    const secondUploadResult = await request(baseUrl, `/api/local/tasks/${encodeURIComponent(secondTask.id)}/upload-queue`, { method: "POST", json: { artifactId: secondArtifact.id } });
    assert.equal(secondUploadResult.response.status, 202);
    const failed = await waitForUploadStatus(baseUrl, secondTask.id, secondUploadResult.body.upload.id, "failed");
    assert.equal(failed.errorCode, "TARGET_FILE_CONFLICT");
    assert.deepEqual(await readFile(path.join(destinationDirectory, "same.zip")), firstZip);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("missing artifact content fails safely and can be retried after restoration", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-artifact-upload-retry-"));
  const destinationDirectory = path.join(directory, "upload-target");
  const uploadWorker = { start() {}, wake() {}, async close() {} };
  const app = createTaskboardServer({
    dataDirectory: directory,
    codexExecutable: process.execPath,
    uploadWorker,
    feishuPackages: { packages: { "Auto-cut-A": { projectId: "auto-cut-a", workspacePath: directory, prompt: "fixture prompt" } } },
    feishuWorkflowSync: async () => ({ ok: true }),
  });
  try {
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const catalog = await request(baseUrl, "/api/local/feishu/workflow/catalog", { method: "POST", json: { baseToken: "bas_retry", baseName: "剪辑学科", tables: [{ tableId: "tbl_subject", tableName: "语文", fields: [] }] } });
    const subject = catalog.body.catalog[0].subjects[0];
    const key = encodeURIComponent(subject.subjectKey);
    await request(baseUrl, `/api/local/feishu/workflow/subjects/${key}`, { method: "PATCH", json: { upload: { enqueueMode: "manual", artifactSourceMode: "manual_select", artifactSourcePath: null, targetId: "target", targetPath: destinationDirectory, uploadConcurrency: 1 } } });
    const task = (await request(baseUrl, "/api/tasks", { method: "POST", json: { projectId: subject.projectId, title: "重试测试", description: automaticFeishuDescription("bas_retry", "tbl_subject"), status: "in_progress", priority: "none", labels: ["feishu"] } })).body.task;
    const zip = createStoredZip([
      { name: "draft/draft_content.json", content: "{\"value\":\"retry\"}" },
      { name: "draft/draft_meta_info.json", content: "{}" },
    ]);
    const artifact = (await request(baseUrl, `/api/local/tasks/${encodeURIComponent(task.id)}/artifacts`, { method: "POST", headers: { "content-type": "application/zip", "x-taskboard-filename": encodeURIComponent("retry.zip") }, body: zip })).body.artifact;
    const upload = (await request(baseUrl, `/api/local/tasks/${encodeURIComponent(task.id)}/upload-queue`, { method: "POST", json: { artifactId: artifact.id } })).body.upload;
    const [storageKey] = await readdir(path.join(directory, "artifacts"));
    const storagePath = path.join(directory, "artifacts", storageKey);
    const storedBytes = await readFile(storagePath);
    await rm(storagePath, { force: true });
    const worker = createArtifactUploadWorker({
      database: app.database,
      artifactService: createArtifactService({ rootDirectory: path.join(directory, "artifacts") }),
    });
    await worker.start();
    const failed = await waitForUploadStatus(baseUrl, task.id, upload.id, "failed");
    assert.equal(failed.errorCode, "ARTIFACT_CONTENT_MISSING");
    const duplicate = await request(baseUrl, `/api/local/tasks/${encodeURIComponent(task.id)}/artifacts`, {
      method: "POST",
      headers: { "content-type": "application/zip", "x-taskboard-filename": encodeURIComponent("retry.zip") },
      body: zip,
    });
    assert.equal(duplicate.response.status, 409);
    assert.equal(duplicate.body.error.code, "ARTIFACT_CONTENT_MISSING");
    const retryResult = await request(baseUrl, `/api/local/tasks/${encodeURIComponent(task.id)}/upload/retry`, { method: "POST", json: { uploadId: upload.id } });
    assert.equal(retryResult.response.status, 202);
    assert.equal(retryResult.body.upload.status, "queued");
    await writeFile(storagePath, storedBytes, { flag: "wx" });
    await worker.wake();
    await waitForUpload(baseUrl, task.id, upload.id);
    await worker.close();
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

async function assertUploadCompletionRechecksTrustedFeishuProvenance({ baseToken, taskChanges }) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-artifact-upload-final-provenance-"));
  const destinationDirectory = path.join(directory, "upload-target");
  const realArtifactService = createArtifactService({ rootDirectory: path.join(directory, "artifacts") });
  let gateNextDownload = false;
  let releaseCopy;
  let signalCopyStarted;
  const copyStarted = new Promise((resolve) => { signalCopyStarted = resolve; });
  const copyGate = new Promise((resolve) => { releaseCopy = resolve; });
  const artifactService = {
    ...realArtifactService,
    createDownloadStream(storageKey) {
      const source = realArtifactService.createDownloadStream(storageKey);
      if (!gateNextDownload) return source;
      gateNextDownload = false;
      return (async function* gatedDownload() {
        let firstChunk = true;
        for await (const chunk of source) {
          if (firstChunk) {
            firstChunk = false;
            signalCopyStarted();
            await copyGate;
          }
          yield chunk;
        }
      })();
    },
  };
  const app = createTaskboardServer({
    dataDirectory: directory,
    artifactService,
    codexExecutable: process.execPath,
    feishuPackages: {
      packages: {
        "Auto-cut-A": { projectId: "auto-cut-a", workspacePath: directory, prompt: "fixture prompt" },
      },
    },
    feishuWorkflowSync: async () => ({ ok: true }),
  });
  try {
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const catalog = await request(baseUrl, "/api/local/feishu/workflow/catalog", {
      method: "POST",
      json: {
        baseToken,
        baseName: "剪辑学科",
        tables: [{ tableId: "tbl_subject", tableName: "语文", fields: [] }],
      },
    });
    const subject = catalog.body.catalog[0].subjects[0];
    const key = encodeURIComponent(subject.subjectKey);
    await request(baseUrl, `/api/local/feishu/workflow/subjects/${key}`, {
      method: "PATCH",
      json: {
        upload: {
          enqueueMode: "manual",
          artifactSourceMode: "manual_select",
          artifactSourcePath: null,
          targetId: "target",
          targetPath: destinationDirectory,
          uploadConcurrency: 1,
        },
      },
    });
    const task = (await request(baseUrl, "/api/local/feishu/tasks", {
      method: "POST",
      headers: { "x-taskboard-client": "feishu-bridge" },
      json: {
        projectId: subject.projectId,
        title: "上传结束来源复核",
        description: manualFeishuDescription(baseToken, "tbl_subject"),
        status: "in_review",
        priority: "none",
        labels: ["feishu"],
      },
    })).body.task;
    const artifact = (await request(baseUrl, `/api/local/tasks/${encodeURIComponent(task.id)}/artifacts`, {
      method: "POST",
      headers: {
        "content-type": "application/zip",
        "x-taskboard-filename": encodeURIComponent("final-provenance.zip"),
      },
      body: createStoredZip([
        { name: "draft/draft_content.json", content: "{}" },
        { name: "draft/draft_meta_info.json", content: "{}" },
      ]),
    })).body.artifact;
    const awaitingReview = (await request(baseUrl, `/api/tasks/${encodeURIComponent(task.id)}`)).body.task;
    const accepted = await request(baseUrl, `/api/tasks/${encodeURIComponent(task.id)}`, {
      method: "PATCH",
      json: { version: awaitingReview.version, status: "done" },
    });
    assert.equal(accepted.response.status, 200);

    gateNextDownload = true;
    const queued = await request(baseUrl, `/api/local/tasks/${encodeURIComponent(task.id)}/upload-queue`, {
      method: "POST",
      json: { artifactId: artifact.id },
    });
    assert.equal(queued.response.status, 202);
    await copyStarted;

    const edited = await request(baseUrl, `/api/tasks/${encodeURIComponent(task.id)}`, {
      method: "PATCH",
      json: { version: accepted.body.task.version, ...taskChanges },
    });
    assert.equal(edited.response.status, 200);
    releaseCopy();

    const deadline = Date.now() + 3_000;
    let failed;
    while (Date.now() < deadline) {
      const current = app.database.getArtifactUpload(queued.body.upload.id);
      if (current?.status !== "queued" && current?.status !== "uploading") {
        failed = current;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(failed, "upload should settle after the copy resumes");
    assert.equal(failed.status, "failed");
    assert.equal(failed.errorCode, "TASK_PROVENANCE_CHANGED");
    await assert.rejects(access(path.join(destinationDirectory, "final-provenance.zip")));
  } finally {
    releaseCopy?.();
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
}

test("upload completion rechecks the trusted Feishu marker after a long copy", async () => {
  await assertUploadCompletionRechecksTrustedFeishuProvenance({
    baseToken: "bas_final_provenance_marker",
    taskChanges: { description: "来源 marker 已被移除" },
  });
});

test("upload completion rechecks the trusted Feishu label after a long copy", async () => {
  await assertUploadCompletionRechecksTrustedFeishuProvenance({
    baseToken: "bas_final_provenance_label",
    taskChanges: { labels: [] },
  });
});

test("upload completion requires the task to remain done", async () => {
  await assertUploadCompletionRechecksTrustedFeishuProvenance({
    baseToken: "bas_final_provenance_status",
    taskChanges: { status: "in_progress" },
  });
});

test("editing a trusted Feishu task revokes upload queue access and retry", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-artifact-upload-provenance-"));
  const destinationDirectory = path.join(directory, "upload-target");
  const uploadWorker = { start() {}, wake() {}, async close() {} };
  const app = createTaskboardServer({
    dataDirectory: directory,
    codexExecutable: process.execPath,
    uploadWorker,
    feishuPackages: {
      packages: {
        "Auto-cut-A": { projectId: "auto-cut-a", workspacePath: directory, prompt: "fixture prompt" },
      },
    },
    feishuWorkflowSync: async () => ({ ok: true }),
  });
  try {
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const catalog = await request(baseUrl, "/api/local/feishu/workflow/catalog", {
      method: "POST",
      json: {
        baseToken: "bas_provenance_upload",
        baseName: "剪辑学科",
        tables: [{ tableId: "tbl_subject", tableName: "语文", fields: [] }],
      },
    });
    const subject = catalog.body.catalog[0].subjects[0];
    const key = encodeURIComponent(subject.subjectKey);
    const saved = await request(baseUrl, `/api/local/feishu/workflow/subjects/${key}`, {
      method: "PATCH",
      json: {
        upload: {
          enqueueMode: "manual",
          artifactSourceMode: "manual_select",
          artifactSourcePath: null,
          targetId: "target",
          targetPath: destinationDirectory,
          uploadConcurrency: 1,
        },
      },
    });
    assert.equal(saved.response.status, 200);
    const task = (await request(baseUrl, "/api/local/feishu/tasks", {
      method: "POST",
      headers: { "x-taskboard-client": "feishu-bridge" },
      json: {
        projectId: subject.projectId,
        title: "篡改上传权限测试",
        description: manualFeishuDescription("bas_provenance_upload", "tbl_subject"),
        status: "in_review",
        priority: "none",
        labels: ["feishu"],
      },
    })).body.task;
    const artifact = (await request(baseUrl, `/api/local/tasks/${encodeURIComponent(task.id)}/artifacts`, {
      method: "POST",
      headers: {
        "content-type": "application/zip",
        "x-taskboard-filename": encodeURIComponent("tampered.zip"),
      },
      body: createStoredZip([
        { name: "draft/draft_content.json", content: "{}" },
        { name: "draft/draft_meta_info.json", content: "{}" },
      ]),
    })).body.artifact;
    const awaitingReview = (await request(baseUrl, `/api/tasks/${encodeURIComponent(task.id)}`)).body.task;
    const accepted = await request(baseUrl, `/api/tasks/${encodeURIComponent(task.id)}`, {
      method: "PATCH",
      json: { version: awaitingReview.version, status: "done" },
    });
    assert.equal(accepted.response.status, 200);
    const upload = (await request(baseUrl, `/api/local/tasks/${encodeURIComponent(task.id)}/upload-queue`, {
      method: "POST",
      json: { artifactId: artifact.id },
    })).body.upload;

    const edited = await request(baseUrl, `/api/tasks/${encodeURIComponent(task.id)}`, {
      method: "PATCH",
      json: { version: accepted.body.task.version, description: "被编辑后的任务" },
    });
    assert.equal(edited.response.status, 200);

    const listed = await request(baseUrl, `/api/local/tasks/${encodeURIComponent(task.id)}/upload`);
    assert.equal(listed.response.status, 409);
    assert.equal(listed.body.error.code, "TASK_NOT_ARTIFACT_ELIGIBLE");

    app.database.database.prepare(
      "UPDATE artifact_uploads SET status = 'failed', error_code = 'FIXTURE_FAILED' WHERE id = ?",
    ).run(upload.id);
    const retried = await request(baseUrl, `/api/local/tasks/${encodeURIComponent(task.id)}/upload/retry`, {
      method: "POST",
      json: { uploadId: upload.id },
    });
    assert.equal(retried.response.status, 409);
    assert.equal(retried.body.error.code, "TASK_NOT_ARTIFACT_ELIGIBLE");
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("an archived task cannot be permanently deleted while its ZIP upload is queued", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-artifact-upload-delete-"));
  const destinationDirectory = path.join(directory, "upload-target");
  const uploadWorker = {
    start() {},
    wake() {},
    async close() {},
  };
  const app = createTaskboardServer({
    dataDirectory: directory,
    codexExecutable: process.execPath,
    uploadWorker,
    feishuPackages: { packages: { "Auto-cut-A": { projectId: "auto-cut-a", workspacePath: directory, prompt: "fixture prompt" } } },
    feishuWorkflowSync: async () => ({ ok: true }),
  });
  try {
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const catalog = await request(baseUrl, "/api/local/feishu/workflow/catalog", { method: "POST", json: { baseToken: "bas_delete", baseName: "剪辑学科", tables: [{ tableId: "tbl_subject", tableName: "语文", fields: [] }] } });
    const subject = catalog.body.catalog[0].subjects[0];
    const key = encodeURIComponent(subject.subjectKey);
    await request(baseUrl, `/api/local/feishu/workflow/subjects/${key}`, { method: "PATCH", json: { upload: { enqueueMode: "manual", artifactSourceMode: "manual_select", artifactSourcePath: null, targetId: "target", targetPath: destinationDirectory, uploadConcurrency: 1 } } });
    const task = (await request(baseUrl, "/api/tasks", { method: "POST", json: { projectId: subject.projectId, title: "删除保护", description: manualFeishuDescription("bas_delete", "tbl_subject"), status: "in_review", priority: "none", labels: ["feishu"] } })).body.task;
    const artifact = (await request(baseUrl, `/api/local/tasks/${encodeURIComponent(task.id)}/artifacts`, { method: "POST", headers: { "content-type": "application/zip", "x-taskboard-filename": encodeURIComponent("delete.zip") }, body: createStoredZip([{ name: "draft/draft_content.json", content: "{\"value\":\"delete\"}" }, { name: "draft/draft_meta_info.json", content: "{}" }]) })).body.artifact;
    const accepted = await request(baseUrl, `/api/tasks/${encodeURIComponent(task.id)}`, {
      method: "PATCH",
      json: { version: task.version, status: "done" },
    });
    assert.equal(accepted.response.status, 200);
    const upload = (await request(baseUrl, `/api/local/tasks/${encodeURIComponent(task.id)}/upload-queue`, { method: "POST", json: { artifactId: artifact.id } })).body.upload;
    assert.equal(upload.status, "queued");
    const refusedArtifactDelete = await request(baseUrl, `/api/local/artifacts/${encodeURIComponent(artifact.id)}`, { method: "DELETE" });
    assert.equal(refusedArtifactDelete.response.status, 409);
    assert.equal(refusedArtifactDelete.body.error.code, "ARTIFACT_UPLOAD_ACTIVE");
    const stillDownloadable = await fetch(`${baseUrl}/api/local/artifacts/${encodeURIComponent(artifact.id)}/download`);
    assert.equal(stillDownloadable.status, 200);
    assert.equal(createHash("sha256").update(Buffer.from(await stillDownloadable.arrayBuffer())).digest("hex"), artifact.sha256);

    const archived = await request(baseUrl, `/api/tasks/${encodeURIComponent(task.id)}/archive`, { method: "POST", json: { version: accepted.body.task.version } });
    assert.equal(archived.response.status, 200);
    const deleted = await request(baseUrl, `/api/tasks/${encodeURIComponent(task.id)}`, { method: "DELETE", json: { version: archived.body.task.version } });
    assert.equal(deleted.response.status, 409);
    assert.equal(deleted.body.error.code, "ARTIFACT_UPLOAD_ACTIVE");
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
