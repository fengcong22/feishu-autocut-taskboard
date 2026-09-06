import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createTaskboardServer } from "../server/index.mjs";
import { subjectProjectId } from "../server/feishu-workflow-store.mjs";

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

async function createBridge(directory, controlledContext, status = 200) {
  const requests = [];
  const bridge = createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/api/feishu/workflow/controlled-context") {
      response.writeHead(404).end();
      return;
    }
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push(JSON.parse(body));
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(
      status >= 200 && status < 300
        ? { controlledContext }
        : { error: { code: controlledContext } },
    ));
  });
  await new Promise((resolve) => bridge.listen(0, "127.0.0.1", resolve));
  return {
    requests,
    url: `http://127.0.0.1:${bridge.address().port}`,
    async close() { await new Promise((resolve) => bridge.close(resolve)); },
  };
}

async function createFixture({ controlledContext, bridgeStatus = 200 } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-autocut-lifecycle-"));
  const workspacePath = path.join(directory, "workspace");
  const zipSourceDirectory = path.join(directory, "zip-source");
  await mkdir(workspacePath);
  await mkdir(zipSourceDirectory);
  const capturePath = path.join(directory, "codex-env.json");
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
  process.stdin.resume();
  process.stdin.on("end", () => {
    const keys = [
      "CODEX_AUTOCUT_ARTIFACT_REPORT_URL", "CODEX_AUTOCUT_ARTIFACT_REPORT_TOKEN",
      "CODEX_AUTOCUT_SOURCE_MANIFEST_PATH", "CODEX_AUTOCUT_SOURCE_MANIFEST_SHA256",
      "CODEX_AUTOCUT_EXECUTION_INPUT_PATH", "CODEX_AUTOCUT_JOB_ROOT", "CODEX_AUTOCUT_DRAFTS_ROOT",
      "CODEX_AUTOCUT_RESULT_PATH", "CODEX_AUTOCUT_PACKAGE_ZIP_PATH", "CODEX_AUTOCUT_TASK_ID",
      "CODEX_AUTOCUT_RUN_ID", "CODEX_AUTOCUT_SUBJECT_KEY", "CODEX_AUTOCUT_CONFIG_VERSION",
      "CODEX_AUTOCUT_STAGE_ID", "CODEX_AUTOCUT_EVENT_ID", "CODEX_FEISHU_BRIDGE_SECRET",
    ];
    writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify(Object.fromEntries(
      keys.filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]),
    )));
    process.stdout.write('{"type":"thread.started","thread_id":"fixture-session"}\\n');
    process.stdout.write('{"type":"turn.completed"}\\n');
  });
}
`);
  await chmod(codexExecutable, 0o755);
  const bridge = await createBridge(directory, controlledContext, bridgeStatus);
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
  });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  return {
    app,
    bridge,
    baseUrl: `http://127.0.0.1:${address.port}`,
    capturePath,
    directory,
    workspacePath,
    zipSourceDirectory,
  };
}

async function registerSubject(fixture) {
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
    execution: { mode: "manual", concurrencyGroup: "autocut", maxConcurrent: 1, resourceGroups: [] },
    packageRoute: { routeMode: "fixed", packageAlias: "Auto-cut-lite", subjectCodeFieldId: null, branchMap: null },
    upload: {
      enqueueMode: "manual",
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

test("a trusted phased Auto-Cut start persists an immutable run and injects private inputs", async () => {
  const controlledContext = {
    documentLinks: ["https://guanghe.feishu.cn/docx/lifecycle"],
    namingDisplayValue: "课程001",
    namingValueUnique: true,
  };
  const fixture = await createFixture({ controlledContext });
  try {
    const subject = await registerSubject(fixture);
    const created = await jsonRequest(fixture.baseUrl, "/api/local/feishu/tasks", registration(subject, controlledContext));
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
    assert.equal(run.state, "prepared");
    const manifest = JSON.parse(await readFile(run.manifestPath, "utf8"));
    assert.deepEqual(manifest.binding, {
      task_id: created.body.task.id,
      run_id: started.body.run.id,
      subject_key: SUBJECT_KEY,
      config_version: subject.configVersion,
      stage_id: "initial",
      event_id: "evt-lifecycle-1",
    });
    const env = JSON.parse(await readFile(fixture.capturePath, "utf8"));
    assert.equal(env.CODEX_AUTOCUT_TASK_ID, created.body.task.id);
    assert.equal(env.CODEX_AUTOCUT_RUN_ID, started.body.run.id);
    assert.equal(env.CODEX_AUTOCUT_SUBJECT_KEY, SUBJECT_KEY);
    assert.equal(env.CODEX_AUTOCUT_STAGE_ID, "initial");
    assert.equal(env.CODEX_AUTOCUT_EVENT_ID, "evt-lifecycle-1");
    assert.equal(env.CODEX_FEISHU_BRIDGE_SECRET, undefined);
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
  } finally {
    await fixture.app.close();
    await fixture.bridge.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});
