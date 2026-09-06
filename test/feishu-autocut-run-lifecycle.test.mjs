import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createTaskboardServer } from "../server/index.mjs";
import { TaskboardDatabase } from "../server/database.mjs";
import { subjectProjectId } from "../server/feishu-workflow-store.mjs";
import { createStoredZip } from "./stored-zip-fixture.mjs";

const SECRET = "lifecycle-fixture-secret";
const SUBJECT_KEY = "bas_lifecycle:tbl_math";

async function jsonRequest(baseUrl, pathname, body, { method = "POST", headers = {} } = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: {
      "content-type": "application/json",
      "x-taskboard-client": "feishu-bridge",
      "x-feishu-bridge-secret": SECRET,
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : null };
}

async function waitForRun(app, taskId, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = app.database.listFeishuAutoCutRuns(taskId)[0];
    if (run) return run;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for Auto-Cut run for '${taskId}'`);
}

async function waitForRuns(app, taskId, count, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const runs = app.database.listFeishuAutoCutRuns(taskId);
    if (runs.length >= count) return runs;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${count} Auto-Cut runs for '${taskId}'`);
}

async function waitForJsonFile(filename, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { return JSON.parse(await readFile(filename, "utf8")); } catch {}
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for '${filename}'`);
}

async function waitForTaskStatus(app, taskId, status, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const task = app.database.getTask(taskId);
    if (task?.status === status) return task;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for task '${taskId}' to reach '${status}'`);
}

async function createBridge(controlledContext, status = 200) {
  const requests = [];
  let currentContext = controlledContext;
  let currentStatus = status;
  const bridge = createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/api/feishu/workflow/controlled-context") {
      response.writeHead(404).end();
      return;
    }
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push(JSON.parse(body));
    response.writeHead(currentStatus, { "content-type": "application/json" });
    response.end(JSON.stringify(
      currentStatus >= 200 && currentStatus < 300
        ? { controlledContext: currentContext }
        : { error: { code: currentContext } },
    ));
  });
  await new Promise((resolve) => bridge.listen(0, "127.0.0.1", resolve));
  return {
    requests,
    url: `http://127.0.0.1:${bridge.address().port}`,
    setResponse(nextContext, nextStatus = 200) {
      currentContext = nextContext;
      currentStatus = nextStatus;
    },
    async close() { await new Promise((resolve) => bridge.close(resolve)); },
  };
}

async function createFixture({
  controlledContext,
  bridgeStatus = 200,
  turnDelayMs = 0,
  allowAutomaticExecution = false,
  autoCutRunner = undefined,
} = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-autocut-lifecycle-"));
  const workspacePath = path.join(directory, "workspace");
  const zipSourceDirectory = path.join(directory, "zip-source");
  await mkdir(workspacePath);
  await mkdir(zipSourceDirectory);
  const capturePath = path.join(directory, "codex-env.json");
  const promptCapturePath = path.join(directory, "codex-prompt.txt");
  const codexExecutable = path.join(directory, "fake-codex.mjs");
  await writeFile(codexExecutable, `
import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "debug") {
  process.stdout.write(${JSON.stringify(JSON.stringify({
    models: [{ slug: "fixture", default_reasoning_level: "low", supported_reasoning_levels: [{ effort: "low" }] }],
  }))});
} else if (args[0] === "app-server") {
  process.stdin.setEncoding("utf8");
  let buffer = "";
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\\n")) >= 0) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      if (message.id === 1) process.stdout.write('{"id":1,"result":{}}\\n');
      if (message.id === 2) process.stdout.write('{"id":2,"result":{"data":[]}}\\n');
    }
  });
} else {
  let prompt = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { prompt += chunk; });
  process.stdin.on("end", () => {
    const keys = [
      "CODEX_AUTOCUT_ARTIFACT_REPORT_URL", "CODEX_AUTOCUT_ARTIFACT_REPORT_TOKEN",
      "CODEX_AUTOCUT_SOURCE_MANIFEST_PATH", "CODEX_AUTOCUT_SOURCE_MANIFEST_SHA256",
      "CODEX_AUTOCUT_EXECUTION_INPUT_PATH", "CODEX_AUTOCUT_JOB_ROOT", "CODEX_AUTOCUT_DRAFTS_ROOT",
      "CODEX_AUTOCUT_RESULT_PATH", "CODEX_AUTOCUT_PACKAGE_ZIP_PATH", "CODEX_AUTOCUT_TASK_ID",
      "CODEX_AUTOCUT_RUN_ID", "CODEX_AUTOCUT_SUBJECT_KEY", "CODEX_AUTOCUT_CONFIG_VERSION",
      "CODEX_AUTOCUT_STAGE_ID", "CODEX_AUTOCUT_EVENT_ID", "CODEX_FEISHU_BRIDGE_SECRET",
    ];
    writeFileSync(${JSON.stringify(promptCapturePath)}, prompt);
    writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify(Object.fromEntries(
      keys.filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]),
    )));
    setTimeout(() => {
      process.stdout.write('{"type":"thread.started","thread_id":"fixture-session"}\\n');
      process.stdout.write('{"type":"turn.completed"}\\n');
    }, ${JSON.stringify(turnDelayMs)});
  });
}
`);
  await chmod(codexExecutable, 0o755);
  const bridge = await createBridge(controlledContext, bridgeStatus);
  const app = createTaskboardServer({
    dataDirectory: directory,
    codexExecutable,
    feishuBridgeUrl: bridge.url,
    feishuBridgeSecret: SECRET,
    processEnv: { ...process.env, CODEX_FEISHU_BRIDGE_SECRET: SECRET },
    feishuPackages: {
      packages: {
        "Auto-cut-lite": {
          alias: "Auto-cut-lite",
          name: "Auto-Cut Lite",
          projectId: "autocut-lite",
          workspacePath,
          zipSourceDirectory,
          prompt: "trusted package prompt",
          state: "enabled",
          revision: 1,
          maxConcurrent: 1,
        },
      },
    },
    feishuWorkflowSync: async () => ({ ok: true }),
    allowAutomaticExecution,
    autoCutRunner,
  });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  return {
    app,
    bridge,
    baseUrl: `http://127.0.0.1:${address.port}`,
    capturePath,
    promptCapturePath,
    directory,
    workspacePath,
    zipSourceDirectory,
  };
}

async function registerSubject(fixture, {
  executionMode = "manual",
  enqueueMode = "manual",
} = {}) {
  const catalog = await jsonRequest(fixture.baseUrl, "/api/local/feishu/workflow/catalog", {
    baseToken: "bas_lifecycle",
    baseName: "Lifecycle Base",
    tables: [{
      tableId: "tbl_math",
      tableName: "数学",
      fields: [
        {
          fieldId: "fld_status",
          fieldName: "流程",
          type: 3,
          uiType: "SingleSelect",
          options: [
            { id: "opt_other", name: "其他" },
            { id: "opt_initial", name: "初稿" },
          ],
        },
        { fieldId: "fld_document", fieldName: "素材文档", type: 1, uiType: "Text" },
        { fieldId: "fld_name", fieldName: "命名", type: 1, uiType: "Text" },
      ],
    }],
  });
  assert.equal(catalog.response.status, 201, JSON.stringify(catalog.body));
  const subject = catalog.body.catalog[0].subjects[0];
  const route = `/api/local/feishu/workflow/subjects/${encodeURIComponent(SUBJECT_KEY)}`;
  const stage = {
    enabled: true,
    trigger: { fieldId: "fld_status", fieldName: "流程", optionId: "opt_initial", value: "初稿" },
    videoSource: { kind: "docx_section", anchorText: "录屏" },
    reviewSource: { kind: "docx_section", anchorText: "修改意见" },
    audio: { mode: "video_original" },
    artifactTargetPath: path.join(fixture.directory, "stage-output"),
    nameSuffix: "_初稿",
  };
  const patch = await jsonRequest(fixture.baseUrl, route, {
    statusField: { fieldId: "fld_status", fieldName: "流程" },
    documentField: { fieldId: "fld_document", fieldName: "素材文档" },
    namingField: { fieldId: "fld_name", fieldName: "命名" },
    stages: { initial: stage, first_review: { ...stage, enabled: false }, final_review: { ...stage, enabled: false } },
    trigger: { fieldId: "fld_status", fieldName: "流程", startValue: "初稿", optionId: "opt_initial" },
    title: { fieldId: null, fieldName: null },
    execution: { mode: executionMode, concurrencyGroup: "autocut", maxConcurrent: 1, resourceGroups: [] },
    packageRoute: { routeMode: "fixed", packageAlias: "Auto-cut-lite", subjectCodeFieldId: null, branchMap: null },
    upload: {
      enqueueMode,
      artifactSourceMode: "driver_report",
      artifactSourcePath: fixture.zipSourceDirectory,
      targetId: "target",
      targetPath: path.join(fixture.directory, "upload"),
      uploadConcurrency: 1,
    },
  }, { method: "PATCH" });
  assert.equal(patch.response.status, 200, JSON.stringify(patch.body));
  const enabled = await jsonRequest(fixture.baseUrl, `${route}/enable`, {
    expectedVersion: patch.body.subject.configVersion,
  });
  assert.equal(enabled.response.status, 200, JSON.stringify(enabled.body));
  return enabled.body.subject;
}

function registration(subject, controlledContext) {
  return {
    event: {
      eventId: "evt-lifecycle-1",
      baseToken: "bas_lifecycle",
      tableId: "tbl_math",
      recordId: "rec_1",
      statusFieldId: "fld_status",
      beforeOptionId: "opt_other",
      afterOptionId: "opt_initial",
    },
    binding: { subjectKey: SUBJECT_KEY, configVersion: subject.configVersion, stageId: "initial" },
    controlledContext,
  };
}

function feishuDescription(origin) {
  const encoded = Buffer.from(JSON.stringify(origin), "utf8").toString("base64url");
  return `<!-- feishu-codex-task:v1:${encoded} -->`;
}

function runBinding(run) {
  return {
    task_id: run.taskId,
    run_id: run.runId,
    subject_key: run.subjectKey,
    config_version: run.configVersion,
    stage_id: run.stageId,
    event_id: run.eventId,
  };
}

async function writePassingRunResult(run, {
  includePackageReceipt = true,
  draftRoot = run.artifactName,
  resultOverrides = {},
  receiptOverrides = {},
} = {}) {
  const zip = createStoredZip([
    { name: `${draftRoot}/draft_content.json`, content: "{}" },
    { name: `${draftRoot}/draft_meta_info.json`, content: "{}" },
  ]);
  await writeFile(run.packageZipPath, zip);
  const archiveSha256 = createHash("sha256").update(zip).digest("hex");
  await writeFile(run.resultPath, `${JSON.stringify({
    schema_version: 1,
    binding: runBinding(run),
    manifest_sha256: run.manifestSha256,
    status: "pass",
    package_zip: run.packageZipPath,
    archive_sha256: archiveSha256,
    draft_name: run.artifactName,
    ...resultOverrides,
  })}\n`);
  if (includePackageReceipt) {
    await writeFile(`${run.packageZipPath}.receipt.json`, `${JSON.stringify({
      schema_version: 2,
      status: "pass",
      workflow_mode: "lite",
      delivery_mode: "lite_zip",
      archive_path: run.packageZipPath,
      archive_sha256: archiveSha256,
      package_root_name: run.artifactName,
      draft_name: run.artifactName,
      zip_crc_pass: true,
      zip_tree_identity_pass: true,
      source_manifest_sha256: run.manifestSha256,
      binding: runBinding(run),
      source_pairs: [],
      package_zip: run.packageZipPath,
      ...receiptOverrides,
    })}\n`);
  }
  return archiveSha256;
}

async function reportRunArtifact(fixture, run, overrides = {}) {
  const claim = fixture.app.database.getTaskAiStartForArtifactReport(run.taskId, run.runId);
  assert.ok(claim);
  return jsonRequest(
    fixture.baseUrl,
    `/api/local/tasks/${encodeURIComponent(run.taskId)}/runs/${encodeURIComponent(run.runId)}/artifact-report`,
    {
      path: overrides.path ?? run.packageZipPath,
      sha256: overrides.sha256,
      manifestSha256: overrides.manifestSha256 ?? run.manifestSha256,
    },
    {
      headers: {
        authorization: `Bearer ${claim.claimToken}`,
        "x-taskboard-client": "taskctl",
      },
    },
  );
}

test("an authorized phased retry runs locally without starting another Codex turn", async () => {
  const controlledContext = {
    documentLinks: ["https://guanghe.feishu.cn/docx/taskboard-owned-runner"],
    namingDisplayValue: "课程000",
    namingValueUnique: true,
  };
  const invocations = [];
  let fixture;
  fixture = await createFixture({
    controlledContext,
    allowAutomaticExecution: true,
    autoCutRunner: async ({ run }) => {
      invocations.push(run.runId);
      await writePassingRunResult(run);
      return { exitCode: 0 };
    },
  });
  try {
    const subject = await registerSubject(fixture, {
      executionMode: "automatic",
      enqueueMode: "automatic",
    });
    const created = await jsonRequest(
      fixture.baseUrl,
      "/api/local/feishu/tasks",
      registration(subject, controlledContext),
    );
    assert.equal(created.response.status, 201, JSON.stringify(created.body));
    const firstStart = await jsonRequest(
      fixture.baseUrl,
      `/api/tasks/${created.body.task.id}/start-ai`,
      {},
    );
    assert.equal(firstStart.response.status, 202, JSON.stringify(firstStart.body));
    const [firstRun] = await waitForRuns(fixture.app, created.body.task.id, 1);
    const blocked = await waitForTaskStatus(fixture.app, created.body.task.id, "blocked");
    assert.deepEqual(invocations, []);
    assert.equal((await readFile(fixture.promptCapturePath, "utf8")).includes("trusted package prompt"), true);

    const retried = await jsonRequest(
      fixture.baseUrl,
      `/api/local/tasks/${encodeURIComponent(blocked.id)}/autocut-retry`,
      {
        version: blocked.version,
        runConsent: {
          allowVideoAudioAsr: true,
          allowConfiguredLocalOutput: true,
        },
      },
    );
    assert.equal(retried.response.status, 202, JSON.stringify(retried.body));
    assert.equal(retried.body.execution.trigger, "retry");
    const runs = await waitForRuns(fixture.app, created.body.task.id, 2);
    const run = runs[1];
    assert.notEqual(run.runId, firstRun.runId);
    await waitForTaskStatus(fixture.app, created.body.task.id, "done");
    assert.deepEqual(invocations, [run.runId]);
    assert.deepEqual(fixture.app.database.listAiChatEvents(retried.body.thread.id), []);
    const artifact = fixture.app.database.getTaskArtifactForRun(created.body.task.id, run.runId);
    assert.equal(artifact?.validationStatus, "verified");
    assert.equal(fixture.app.database.listTaskArtifactUploads(created.body.task.id).length, 1);
    assert.equal(fixture.app.database.listAiChatRuns(firstStart.body.thread.id).length, 1);
  } finally {
    await fixture.app.close();
    await fixture.bridge.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("a trusted phased Auto-Cut start persists an immutable run and injects private inputs", async () => {
  const controlledContext = {
    documentLinks: ["https://guanghe.feishu.cn/docx/lifecycle"],
    namingDisplayValue: "课程001",
    namingValueUnique: true,
  };
  const fixture = await createFixture({ controlledContext });
  try {
    const subject = await registerSubject(fixture);
    const created = await jsonRequest(fixture.baseUrl, "/api/local/feishu/tasks", registration(subject, {
      documentLinks: ["https://guanghe.feishu.cn/docx/registration-snapshot"],
      namingDisplayValue: "旧名称",
      namingValueUnique: true,
    }));
    assert.equal(created.response.status, 201, JSON.stringify(created.body));
    const started = await jsonRequest(fixture.baseUrl, `/api/tasks/${created.body.task.id}/start-ai`, {});
    assert.equal(started.response.status, 202, JSON.stringify(started.body));
    const run = await waitForRun(fixture.app, created.body.task.id);
    assert.equal(run.runId, started.body.run.id);
    assert.equal(run.taskId, created.body.task.id);
    assert.equal(run.subjectKey, SUBJECT_KEY);
    assert.equal(run.configVersion, subject.configVersion);
    assert.equal(run.stageId, "initial");
    assert.equal(run.eventId, "evt-lifecycle-1");
    assert.equal(run.state, "running");
    const manifest = JSON.parse(await readFile(run.manifestPath, "utf8"));
    assert.deepEqual(manifest.binding, {
      task_id: created.body.task.id,
      run_id: started.body.run.id,
      subject_key: SUBJECT_KEY,
      config_version: subject.configVersion,
      stage_id: "initial",
      event_id: "evt-lifecycle-1",
    });
    assert.equal(manifest.document.url, controlledContext.documentLinks[0]);
    assert.equal(run.artifactName, "课程001_初稿");
    const env = await waitForJsonFile(fixture.capturePath);
    assert.equal(env.CODEX_AUTOCUT_ARTIFACT_REPORT_URL.endsWith(
      `/api/local/tasks/${encodeURIComponent(created.body.task.id)}/runs/${encodeURIComponent(started.body.run.id)}/artifact-report`,
    ), true);
    assert.ok(env.CODEX_AUTOCUT_ARTIFACT_REPORT_TOKEN.length >= 32);
    assert.equal(env.CODEX_AUTOCUT_SOURCE_MANIFEST_PATH, run.manifestPath);
    assert.equal(env.CODEX_AUTOCUT_SOURCE_MANIFEST_SHA256, run.manifestSha256);
    assert.equal(env.CODEX_AUTOCUT_EXECUTION_INPUT_PATH, run.executionInputPath);
    assert.equal(env.CODEX_AUTOCUT_JOB_ROOT, path.dirname(run.manifestPath));
    assert.equal(env.CODEX_AUTOCUT_DRAFTS_ROOT, run.draftsRoot);
    assert.equal(env.CODEX_AUTOCUT_RESULT_PATH, run.resultPath);
    assert.equal(env.CODEX_AUTOCUT_PACKAGE_ZIP_PATH, run.packageZipPath);
    assert.equal(env.CODEX_AUTOCUT_TASK_ID, created.body.task.id);
    assert.equal(env.CODEX_AUTOCUT_RUN_ID, started.body.run.id);
    assert.equal(env.CODEX_AUTOCUT_SUBJECT_KEY, SUBJECT_KEY);
    assert.equal(env.CODEX_AUTOCUT_CONFIG_VERSION, String(subject.configVersion));
    assert.equal(env.CODEX_AUTOCUT_STAGE_ID, "initial");
    assert.equal(env.CODEX_AUTOCUT_EVENT_ID, "evt-lifecycle-1");
    assert.equal(env.CODEX_FEISHU_BRIDGE_SECRET, undefined);
    assert.deepEqual(fixture.bridge.requests, [{
      subjectKey: SUBJECT_KEY,
      configVersion: subject.configVersion,
      baseToken: "bas_lifecycle",
      tableId: "tbl_math",
      recordId: "rec_1",
    }]);
    await waitForTaskStatus(fixture.app, run.taskId, "blocked");
    const blockedRun = fixture.app.database.getFeishuAutoCutRun(run.runId);
    assert.equal(blockedRun.state, "blocked");
    assert.equal(blockedRun.errorCode, "autocut_result_missing");
    const attempts = await jsonRequest(
      fixture.baseUrl,
      `/api/local/tasks/${encodeURIComponent(run.taskId)}/autocut-runs`,
      undefined,
      { method: "GET" },
    );
    assert.equal(attempts.response.status, 200, JSON.stringify(attempts.body));
    assert.deepEqual(attempts.body.runs, [{
      runId: blockedRun.runId,
      taskId: blockedRun.taskId,
      attempt: blockedRun.attempt,
      subjectKey: blockedRun.subjectKey,
      configVersion: blockedRun.configVersion,
      stageId: blockedRun.stageId,
      eventId: blockedRun.eventId,
      manifestSha256: blockedRun.manifestSha256,
      artifactName: blockedRun.artifactName,
      state: blockedRun.state,
      errorCode: blockedRun.errorCode,
      errorMessage: blockedRun.errorMessage,
      createdAt: blockedRun.createdAt,
      updatedAt: blockedRun.updatedAt,
    }]);
  } finally {
    await fixture.app.close();
    await fixture.bridge.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("controlled-context preparation failure blocks and preserves the task and AI run", async () => {
  const fixture = await createFixture({ controlledContext: "document_link_missing", bridgeStatus: 409 });
  try {
    const subject = await registerSubject(fixture);
    const created = await jsonRequest(fixture.baseUrl, "/api/local/feishu/tasks", registration(subject, {
      documentLinks: ["https://guanghe.feishu.cn/docx/stale"],
      namingDisplayValue: "课程002",
      namingValueUnique: true,
    }));
    assert.equal(created.response.status, 201, JSON.stringify(created.body));
    const started = await jsonRequest(fixture.baseUrl, `/api/tasks/${created.body.task.id}/start-ai`, {});
    assert.equal(started.response.status, 409, JSON.stringify(started.body));
    const task = fixture.app.database.getTask(created.body.task.id);
    assert.equal(task.status, "blocked");
    const run = await waitForRun(fixture.app, task.id);
    assert.equal(run.state, "blocked");
    assert.equal(run.errorCode, "document_link_missing");
    const aiRuns = fixture.app.database.listAiChatRuns(task.threadId);
    assert.equal(aiRuns.length, 1);
    assert.equal(aiRuns[0].status, "failed");
    assert.equal(fixture.app.database.getFeishuExecution(task.id), null);
    await assert.rejects(() => readFile(fixture.capturePath, "utf8"), /ENOENT/);
  } finally {
    await fixture.app.close();
    await fixture.bridge.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("a phased report binds the terminal receipt and uploads to the frozen stage destination", async () => {
  const controlledContext = {
    documentLinks: ["https://guanghe.feishu.cn/docx/report-lifecycle"],
    namingDisplayValue: "课程003",
    namingValueUnique: true,
  };
  const fixture = await createFixture({
    controlledContext,
    turnDelayMs: 500,
    allowAutomaticExecution: true,
  });
  try {
    const subject = await registerSubject(fixture, {
      executionMode: "automatic",
      enqueueMode: "automatic",
    });
    const created = await jsonRequest(
      fixture.baseUrl,
      "/api/local/feishu/tasks",
      registration(subject, controlledContext),
    );
    assert.equal(created.response.status, 201, JSON.stringify(created.body));
    const started = await jsonRequest(fixture.baseUrl, `/api/tasks/${created.body.task.id}/start-ai`, {});
    assert.equal(started.response.status, 202, JSON.stringify(started.body));
    const run = await waitForRun(fixture.app, created.body.task.id);
    const archiveSha256 = await writePassingRunResult(run);
    const reported = await reportRunArtifact(fixture, run, { sha256: archiveSha256 });
    assert.equal(reported.response.status, 201, JSON.stringify(reported.body));
    assert.equal(fixture.app.database.getFeishuAutoCutRun(run.runId).state, "reported");

    const completed = await waitForTaskStatus(fixture.app, run.taskId, "done");
    assert.equal(completed.status, "done");
    assert.equal(fixture.app.database.getFeishuAutoCutRun(run.runId).state, "completed");
    const [upload] = fixture.app.database.listTaskArtifactUploads(run.taskId);
    assert.ok(upload);
    const storedUpload = fixture.app.database.database.prepare(
      "SELECT target_path FROM artifact_uploads WHERE id = ?",
    ).get(upload.id);
    assert.equal(storedUpload.target_path, path.join(fixture.directory, "stage-output"));
  } finally {
    await fixture.app.close();
    await fixture.bridge.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("a phased report rejects a result without the exact adjacent package receipt", async () => {
  const controlledContext = {
    documentLinks: ["https://guanghe.feishu.cn/docx/missing-package-receipt"],
    namingDisplayValue: "课程003A",
    namingValueUnique: true,
  };
  const fixture = await createFixture({ controlledContext, turnDelayMs: 1_000 });
  try {
    const subject = await registerSubject(fixture);
    const created = await jsonRequest(
      fixture.baseUrl,
      "/api/local/feishu/tasks",
      registration(subject, controlledContext),
    );
    const started = await jsonRequest(fixture.baseUrl, `/api/tasks/${created.body.task.id}/start-ai`, {});
    assert.equal(started.response.status, 202, JSON.stringify(started.body));
    const run = await waitForRun(fixture.app, created.body.task.id);
    const archiveSha256 = await writePassingRunResult(run, { includePackageReceipt: false });
    const reported = await reportRunArtifact(fixture, run, { sha256: archiveSha256 });
    assert.equal(reported.response.status, 409, JSON.stringify(reported.body));
    assert.equal(reported.body.error.code, "autocut_package_receipt_missing");
    assert.deepEqual(fixture.app.database.listTaskArtifacts(run.taskId), []);
  } finally {
    await fixture.app.close();
    await fixture.bridge.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("a phased report rejects a ZIP whose actual draft root differs from the frozen name", async () => {
  const controlledContext = {
    documentLinks: ["https://guanghe.feishu.cn/docx/wrong-zip-root"],
    namingDisplayValue: "课程003B",
    namingValueUnique: true,
  };
  const fixture = await createFixture({ controlledContext, turnDelayMs: 1_000 });
  try {
    const subject = await registerSubject(fixture);
    const created = await jsonRequest(
      fixture.baseUrl,
      "/api/local/feishu/tasks",
      registration(subject, controlledContext),
    );
    const started = await jsonRequest(fixture.baseUrl, `/api/tasks/${created.body.task.id}/start-ai`, {});
    assert.equal(started.response.status, 202, JSON.stringify(started.body));
    const run = await waitForRun(fixture.app, created.body.task.id);
    const archiveSha256 = await writePassingRunResult(run, { draftRoot: "另一个草稿" });
    const reported = await reportRunArtifact(fixture, run, { sha256: archiveSha256 });
    assert.equal(reported.response.status, 409, JSON.stringify(reported.body));
    assert.equal(reported.body.error.code, "AUTOCUT_RUN_BINDING_MISMATCH");
    assert.deepEqual(fixture.app.database.listTaskArtifacts(run.taskId), []);
  } finally {
    await fixture.app.close();
    await fixture.bridge.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("a phased report rejects every mismatched package receipt identity and validation field", async () => {
  const controlledContext = {
    documentLinks: ["https://guanghe.feishu.cn/docx/mismatched-package-receipt"],
    namingDisplayValue: "课程003C",
    namingValueUnique: true,
  };
  const fixture = await createFixture({ controlledContext, turnDelayMs: 5_000 });
  try {
    const subject = await registerSubject(fixture);
    const created = await jsonRequest(
      fixture.baseUrl,
      "/api/local/feishu/tasks",
      registration(subject, controlledContext),
    );
    const started = await jsonRequest(fixture.baseUrl, `/api/tasks/${created.body.task.id}/start-ai`, {});
    assert.equal(started.response.status, 202, JSON.stringify(started.body));
    const run = await waitForRun(fixture.app, created.body.task.id);
    const otherPath = path.join(path.dirname(run.packageZipPath), "other.zip");
    const cases = [
      ["binding", { binding: { ...runBinding(run), run_id: "other-run" } }, "AUTOCUT_RUN_BINDING_MISMATCH"],
      ["manifest", { source_manifest_sha256: "b".repeat(64) }, "AUTOCUT_RUN_BINDING_MISMATCH"],
      ["package path", { package_zip: otherPath }, "AUTOCUT_RUN_BINDING_MISMATCH"],
      ["archive path", { archive_path: otherPath }, "AUTOCUT_RUN_BINDING_MISMATCH"],
      ["archive hash", { archive_sha256: "b".repeat(64) }, "AUTOCUT_RUN_BINDING_MISMATCH"],
      ["draft name", { draft_name: "other-draft" }, "AUTOCUT_RUN_BINDING_MISMATCH"],
      ["package root", { package_root_name: "other-draft" }, "AUTOCUT_RUN_BINDING_MISMATCH"],
      ["workflow mode", { workflow_mode: "full" }, "autocut_package_receipt_invalid"],
      ["delivery mode", { delivery_mode: "native" }, "autocut_package_receipt_invalid"],
      ["CRC validation", { zip_crc_pass: false }, "autocut_package_receipt_invalid"],
      ["tree validation", { zip_tree_identity_pass: false }, "autocut_package_receipt_invalid"],
      ["source pairs", { source_pairs: null }, "autocut_package_receipt_invalid"],
    ];
    for (const [name, receiptOverrides, errorCode] of cases) {
      const archiveSha256 = await writePassingRunResult(run, { receiptOverrides });
      const reported = await reportRunArtifact(fixture, run, { sha256: archiveSha256 });
      assert.equal(reported.response.status, 409, `${name}: ${JSON.stringify(reported.body)}`);
      assert.equal(reported.body.error.code, errorCode, name);
      assert.deepEqual(fixture.app.database.listTaskArtifacts(run.taskId), [], name);
    }
  } finally {
    await fixture.app.close();
    await fixture.bridge.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("a phased report rejects result or report bindings that differ from the exact run", async () => {
  const controlledContext = {
    documentLinks: ["https://guanghe.feishu.cn/docx/mismatched-run-result"],
    namingDisplayValue: "课程003D",
    namingValueUnique: true,
  };
  const fixture = await createFixture({ controlledContext, turnDelayMs: 5_000 });
  try {
    const subject = await registerSubject(fixture);
    const created = await jsonRequest(
      fixture.baseUrl,
      "/api/local/feishu/tasks",
      registration(subject, controlledContext),
    );
    const started = await jsonRequest(fixture.baseUrl, `/api/tasks/${created.body.task.id}/start-ai`, {});
    assert.equal(started.response.status, 202, JSON.stringify(started.body));
    const run = await waitForRun(fixture.app, created.body.task.id);
    const otherPath = path.join(path.dirname(run.packageZipPath), "other.zip");
    const cases = [
      ["result binding", { resultOverrides: { binding: { ...runBinding(run), task_id: "other-task" } } }, {}],
      ["result manifest", { resultOverrides: { manifest_sha256: "b".repeat(64) } }, {}],
      ["result package path", { resultOverrides: { package_zip: otherPath } }, {}],
      ["result archive hash", { resultOverrides: { archive_sha256: "b".repeat(64) } }, {}],
      ["result draft name", { resultOverrides: { draft_name: "other-draft" } }, {}],
      ["reported manifest", {}, { manifestSha256: "b".repeat(64) }],
      ["reported ZIP path", {}, { path: otherPath }],
      ["reported archive hash", {}, { sha256: "b".repeat(64) }],
    ];
    for (const [name, resultOptions, reportOverrides] of cases) {
      const archiveSha256 = await writePassingRunResult(run, resultOptions);
      if (reportOverrides.path) {
        await writeFile(reportOverrides.path, await readFile(run.packageZipPath));
      }
      const reported = await reportRunArtifact(fixture, run, {
        sha256: archiveSha256,
        ...reportOverrides,
      });
      assert.equal(reported.response.status, 409, `${name}: ${JSON.stringify(reported.body)}`);
      assert.equal(reported.body.error.code, "AUTOCUT_RUN_BINDING_MISMATCH", name);
      assert.deepEqual(fixture.app.database.listTaskArtifacts(run.taskId), [], name);
    }
  } finally {
    await fixture.app.close();
    await fixture.bridge.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("a manual phased run enters review without automatically enqueueing its ZIP", async () => {
  const controlledContext = {
    documentLinks: ["https://guanghe.feishu.cn/docx/manual-lifecycle"],
    namingDisplayValue: "课程004",
    namingValueUnique: true,
  };
  const fixture = await createFixture({ controlledContext, turnDelayMs: 500 });
  try {
    const subject = await registerSubject(fixture, {
      executionMode: "manual",
      enqueueMode: "automatic",
    });
    const created = await jsonRequest(
      fixture.baseUrl,
      "/api/local/feishu/tasks",
      registration(subject, controlledContext),
    );
    assert.equal(created.response.status, 201, JSON.stringify(created.body));
    const started = await jsonRequest(fixture.baseUrl, `/api/tasks/${created.body.task.id}/start-ai`, {});
    assert.equal(started.response.status, 202, JSON.stringify(started.body));
    const run = await waitForRun(fixture.app, created.body.task.id);
    const archiveSha256 = await writePassingRunResult(run);
    const reported = await reportRunArtifact(fixture, run, { sha256: archiveSha256 });
    assert.equal(reported.response.status, 201, JSON.stringify(reported.body));

    const completed = await waitForTaskStatus(fixture.app, run.taskId, "in_review");
    assert.equal(completed.status, "in_review");
    assert.equal(fixture.app.database.getFeishuAutoCutRun(run.runId).state, "completed");
    assert.deepEqual(fixture.app.database.listTaskArtifactUploads(run.taskId), []);
  } finally {
    await fixture.app.close();
    await fixture.bridge.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("startup recovery revalidates phased terminal receipts before completing a claimed task", async () => {
  const controlledContext = {
    documentLinks: ["https://guanghe.feishu.cn/docx/startup-recovery"],
    namingDisplayValue: "课程004A",
    namingValueUnique: true,
  };
  const fixture = await createFixture({ controlledContext, turnDelayMs: 500 });
  let originalClosed = false;
  let restartedApp = null;
  try {
    const subject = await registerSubject(fixture);
    const created = await jsonRequest(
      fixture.baseUrl,
      "/api/local/feishu/tasks",
      registration(subject, controlledContext),
    );
    const started = await jsonRequest(fixture.baseUrl, `/api/tasks/${created.body.task.id}/start-ai`, {});
    assert.equal(started.response.status, 202, JSON.stringify(started.body));
    const run = await waitForRun(fixture.app, created.body.task.id);
    const archiveSha256 = await writePassingRunResult(run);
    const reported = await reportRunArtifact(fixture, run, { sha256: archiveSha256 });
    assert.equal(reported.response.status, 201, JSON.stringify(reported.body));
    await waitForTaskStatus(fixture.app, run.taskId, "in_review");
    const completedTask = fixture.app.database.getTask(run.taskId);

    await fixture.app.close();
    originalClosed = true;
    const database = new TaskboardDatabase(path.join(fixture.directory, "taskboard.sqlite"));
    try {
      const timestamp = new Date().toISOString();
      database.database.prepare(
        "UPDATE tasks SET status = 'in_progress', version = version + 1, updated_at = ? WHERE id = ?",
      ).run(timestamp, run.taskId);
      database.database.prepare("DELETE FROM task_completion_artifacts WHERE task_id = ?").run(run.taskId);
      database.database.prepare(
        "UPDATE feishu_autocut_runs SET state = 'reported', updated_at = ? WHERE run_id = ?",
      ).run(timestamp, run.runId);
      const activity = database.database.prepare(
        "SELECT MAX(rowid) AS rowid FROM task_activities WHERE task_id = ?",
      ).get(run.taskId);
      database.database.prepare(`
        INSERT INTO task_ai_starts
          (task_id, claim_token, thread_id, run_id, claimed_at, updated_at, claimed_activity_rowid)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        run.taskId,
        "startup-recovery-claim",
        completedTask.threadId,
        run.runId,
        timestamp,
        timestamp,
        activity.rowid,
      );
    } finally {
      database.close();
    }
    await writeFile(`${run.packageZipPath}.receipt.json`, "{invalid-json");

    restartedApp = createTaskboardServer({
      dataDirectory: fixture.directory,
      codexExecutable: process.execPath,
      feishuPackages: {
        packages: {
          "Auto-cut-lite": {
            alias: "Auto-cut-lite",
            name: "Auto-Cut Lite",
            projectId: "autocut-lite",
            workspacePath: fixture.workspacePath,
            zipSourceDirectory: fixture.zipSourceDirectory,
            prompt: "trusted package prompt",
            state: "enabled",
            revision: 1,
            maxConcurrent: 1,
          },
        },
      },
      feishuWorkflowSync: async () => ({ ok: true }),
    });
    const recovered = await waitForTaskStatus(restartedApp, run.taskId, "blocked", 1_000);
    assert.equal(recovered.status, "blocked");
    const recoveredRun = restartedApp.database.getFeishuAutoCutRun(run.runId);
    assert.equal(recoveredRun.state, "blocked");
    assert.equal(recoveredRun.errorCode, "autocut_package_receipt_invalid");
  } finally {
    await restartedApp?.close();
    if (!originalClosed) await fixture.app.close();
    await fixture.bridge.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("an explicit phased retry creates a new attempt and preserves the blocked run", async () => {
  const invocations = [];
  const fixture = await createFixture({
    controlledContext: "document_link_missing",
    bridgeStatus: 409,
    autoCutRunner: async ({ run }) => {
      invocations.push(run.runId);
      const error = new Error("fixture local preflight failed");
      error.code = "fixture_preflight_failed";
      throw error;
    },
  });
  try {
    const subject = await registerSubject(fixture);
    const created = await jsonRequest(
      fixture.baseUrl,
      "/api/local/feishu/tasks",
      registration(subject, {
        documentLinks: ["https://guanghe.feishu.cn/docx/stale-retry"],
        namingDisplayValue: "课程005",
        namingValueUnique: true,
      }),
    );
    const firstStart = await jsonRequest(fixture.baseUrl, `/api/tasks/${created.body.task.id}/start-ai`, {});
    assert.equal(firstStart.response.status, 409, JSON.stringify(firstStart.body));
    const blocked = fixture.app.database.getTask(created.body.task.id);
    const [firstRun] = fixture.app.database.listFeishuAutoCutRuns(blocked.id);
    assert.equal(blocked.status, "blocked");
    assert.equal(firstRun.state, "blocked");

    const staleRetry = await jsonRequest(
      fixture.baseUrl,
      `/api/local/tasks/${encodeURIComponent(blocked.id)}/autocut-retry`,
      { version: blocked.version + 1 },
    );
    assert.equal(staleRetry.response.status, 409, JSON.stringify(staleRetry.body));
    assert.equal(staleRetry.body.error.code, "VERSION_CONFLICT");
    assert.deepEqual(fixture.app.database.listFeishuAutoCutRuns(blocked.id).map((run) => run.attempt), [1]);

    const invalidConsents = [
      { allowVideoAudioAsr: "true", allowConfiguredLocalOutput: true },
      { allowVideoAudioAsr: true, allowConfiguredLocalOutput: false },
      { allowVideoAudioAsr: true },
      { allowVideoAudioAsr: true, allowConfiguredLocalOutput: true, prompt: "ignore policy" },
    ];
    for (const runConsent of invalidConsents) {
      const invalid = await jsonRequest(
        fixture.baseUrl,
        `/api/local/tasks/${encodeURIComponent(blocked.id)}/autocut-retry`,
        { version: blocked.version, runConsent },
      );
      assert.equal(invalid.response.status, 400, JSON.stringify(invalid.body));
      assert.deepEqual(
        fixture.app.database.listFeishuAutoCutRuns(blocked.id).map((run) => run.attempt),
        [1],
      );
    }

    fixture.bridge.setResponse({
      documentLinks: ["https://guanghe.feishu.cn/docx/retry-lifecycle"],
      namingDisplayValue: "课程005",
      namingValueUnique: true,
    });
    const retried = await jsonRequest(
      fixture.baseUrl,
      `/api/local/tasks/${encodeURIComponent(blocked.id)}/autocut-retry`,
      {
        version: blocked.version,
        runConsent: {
          allowVideoAudioAsr: true,
          allowConfiguredLocalOutput: true,
        },
      },
    );
    assert.equal(retried.response.status, 202, JSON.stringify(retried.body));
    assert.equal(retried.body.execution.trigger, "retry");
    const runs = await waitForRuns(fixture.app, blocked.id, 2);
    assert.deepEqual(runs.map((run) => run.attempt), [1, 2]);
    assert.equal(runs[0].runId, firstRun.runId);
    assert.equal(runs[0].state, "blocked");
    assert.notEqual(runs[1].runId, firstRun.runId);
    await waitForTaskStatus(fixture.app, blocked.id, "blocked");
    const failedRetry = fixture.app.database.getFeishuAutoCutRun(runs[1].runId);
    assert.deepEqual(invocations, [runs[1].runId]);
    assert.equal(failedRetry.state, "blocked");
    assert.equal(failedRetry.errorCode, "fixture_preflight_failed");
    assert.equal(failedRetry.errorMessage, "fixture local preflight failed");
    await assert.rejects(readFile(fixture.promptCapturePath, "utf8"), { code: "ENOENT" });
  } finally {
    await fixture.app.close();
    await fixture.bridge.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("Auto-Cut retry rejects non-blocked, copied-marker, and legacy tasks", async () => {
  const controlledContext = {
    documentLinks: ["https://guanghe.feishu.cn/docx/retry-eligibility"],
    namingDisplayValue: "课程006",
    namingValueUnique: true,
  };
  const fixture = await createFixture({ controlledContext });
  try {
    const subject = await registerSubject(fixture);
    const phased = await jsonRequest(
      fixture.baseUrl,
      "/api/local/feishu/tasks",
      registration(subject, controlledContext),
    );
    assert.equal(phased.response.status, 201, JSON.stringify(phased.body));
    const nonBlocked = await jsonRequest(
      fixture.baseUrl,
      `/api/local/tasks/${encodeURIComponent(phased.body.task.id)}/autocut-retry`,
      {
        version: phased.body.task.version,
        runConsent: {
          allowVideoAudioAsr: true,
          allowConfiguredLocalOutput: true,
        },
      },
    );
    assert.equal(nonBlocked.response.status, 409, JSON.stringify(nonBlocked.body));
    assert.equal(nonBlocked.body.error.code, "AUTOCUT_RETRY_NOT_ALLOWED");

    const actor = { type: "user", id: "local-user", name: "本地用户", avatarUrl: null };
    const copiedMarker = fixture.app.database.createTask({
      projectId: subject.projectId,
      title: "Copied marker",
      description: phased.body.task.description,
      status: "blocked",
      priority: "none",
      labels: ["feishu"],
      actor,
      assignee: actor,
      startDate: null,
      dueDate: null,
    });
    const forged = await jsonRequest(
      fixture.baseUrl,
      `/api/local/tasks/${encodeURIComponent(copiedMarker.id)}/autocut-retry`,
      {
        version: copiedMarker.version,
        runConsent: {
          allowVideoAudioAsr: true,
          allowConfiguredLocalOutput: true,
        },
      },
    );
    assert.equal(forged.response.status, 409, JSON.stringify(forged.body));
    assert.equal(forged.body.error.code, "TASK_NOT_STARTABLE");

    const legacyOrigin = {
      version: 1,
      source: "feishu-base",
      eventId: "evt-legacy-retry",
      baseToken: "bas_lifecycle",
      tableId: "tbl_math",
      subjectKey: SUBJECT_KEY,
      recordId: "rec_legacy_retry",
      triggerField: "流程",
      triggerValue: "待剪辑",
      mode: "manual",
      executionMode: "manual",
      packageAlias: "Auto-cut-lite",
    };
    const legacy = await jsonRequest(fixture.baseUrl, "/api/local/feishu/tasks", {
      projectId: subject.projectId,
      title: "Legacy Auto-Cut",
      description: feishuDescription(legacyOrigin),
      status: "blocked",
      priority: "none",
      labels: ["feishu"],
    });
    assert.equal(legacy.response.status, 201, JSON.stringify(legacy.body));
    const legacyRetry = await jsonRequest(
      fixture.baseUrl,
      `/api/local/tasks/${encodeURIComponent(legacy.body.task.id)}/autocut-retry`,
      {
        version: legacy.body.task.version,
        runConsent: {
          allowVideoAudioAsr: true,
          allowConfiguredLocalOutput: true,
        },
      },
    );
    assert.equal(legacyRetry.response.status, 409, JSON.stringify(legacyRetry.body));
    assert.equal(legacyRetry.body.error.code, "AUTOCUT_RETRY_NOT_ALLOWED");
  } finally {
    await fixture.app.close();
    await fixture.bridge.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});
