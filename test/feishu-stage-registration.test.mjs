import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createTaskboardServer } from "../server/index.mjs";
import { subjectProjectId } from "../server/feishu-workflow-store.mjs";

const SECRET = "fixture-stage-registration-secret";
const SUBJECT_KEY = "bas_stage:tbl_math";

function stage(stageId, optionId, value) {
  return {
    enabled: true,
    trigger: { fieldId: "fld_status", optionId, value },
    videoSource: { kind: "docx_section", anchorText: "录屏" },
    reviewSource: { kind: "docx_section", anchorText: "修改意见" },
    audio: { mode: "video_original" },
    artifactTargetPath: `C:\\approved\\${stageId}`,
    nameSuffix: `_${value}`,
  };
}

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-stage-registration-"));
  const workspace = path.join(directory, "workspace");
  const zipSourceDirectory = path.join(directory, "zips");
  await mkdir(workspace);
  await mkdir(zipSourceDirectory);
  const app = createTaskboardServer({
    dataDirectory: directory,
    codexExecutable: process.execPath,
    feishuBridgeSecret: SECRET,
    feishuWorkflowSync: async () => ({ ok: true }),
    feishuPackages: {
      packages: {
        "Auto-cut-lite": {
          name: "Auto-Cut Lite",
          projectId: "autocut-lite",
          workspacePath: workspace,
          zipSourceDirectory,
          prompt: "trusted package prompt",
          state: "enabled",
        },
      },
    },
  });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return { app, baseUrl, directory, workspace, zipSourceDirectory };
}

async function request(baseUrl, pathname, body, headers = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-taskboard-client": "feishu-bridge",
      "x-feishu-bridge-secret": SECRET,
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : undefined };
}

async function enableSubject(fixtureData) {
  const catalog = await request(fixtureData.baseUrl, "/api/local/feishu/workflow/catalog", {
    baseToken: "bas_stage",
    baseName: "阶段 Base",
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
            { id: "opt_review", name: "初审修改" },
            { id: "opt_final", name: "终审修改" },
          ],
        },
        { fieldId: "fld_document", fieldName: "素材文档", type: 1, uiType: "Text" },
        { fieldId: "fld_name", fieldName: "命名", type: 1, uiType: "Text" },
      ],
    }],
  });
  assert.equal(catalog.response.status, 201);
  const subject = catalog.body.catalog[0].subjects[0];
  const route = `/api/local/feishu/workflow/subjects/${encodeURIComponent(subject.subjectKey)}`;
  const draft = await request(fixtureData.baseUrl, route.replace("/api/local/feishu/workflow", "/api/local/feishu/workflow"), {
    // The request helper defaults to POST; use a direct PATCH below.
  });
  assert.equal(draft.response.status, 405);
  const patchResponse = await fetch(`${fixtureData.baseUrl}${route}`, {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      "x-taskboard-client": "feishu-bridge",
      "x-feishu-bridge-secret": SECRET,
    },
    body: JSON.stringify({
      statusField: { fieldId: "fld_status", fieldName: "流程" },
      documentField: { fieldId: "fld_document", fieldName: "素材文档" },
      namingField: { fieldId: "fld_name", fieldName: "命名" },
      stages: {
        initial: stage("initial", "opt_initial", "初稿"),
        first_review: stage("first_review", "opt_review", "初审修改"),
        final_review: stage("final_review", "opt_final", "终审修改"),
      },
      trigger: { fieldId: "fld_status", fieldName: "流程", startValue: "初稿", optionId: "opt_initial" },
      title: { fieldId: null, fieldName: null },
      execution: { mode: "automatic", concurrencyGroup: "autocut", maxConcurrent: 3, resourceGroups: [] },
      packageRoute: { routeMode: "fixed", packageAlias: "Auto-cut-lite", subjectCodeFieldId: null, branchMap: null },
      upload: {
        enqueueMode: "automatic",
        artifactSourceMode: "driver_report",
        artifactSourcePath: fixtureData.zipSourceDirectory,
        targetId: "target",
        targetPath: path.join(fixtureData.directory, "upload"),
        uploadConcurrency: 2,
      },
    }),
  });
  assert.equal(patchResponse.status, 200);
  const patched = await patchResponse.json();
  const enable = await fetch(`${fixtureData.baseUrl}${route}/enable`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-taskboard-client": "feishu-bridge",
      "x-feishu-bridge-secret": SECRET,
    },
    body: JSON.stringify({ expectedVersion: patched.subject.configVersion }),
  });
  assert.equal(enable.status, 200);
  return (await enable.json()).subject;
}

function registration(subject, overrides = {}) {
  return {
    event: {
      eventId: "evt-stage-1",
      baseToken: "bas_stage",
      tableId: "tbl_math",
      recordId: "rec_1",
      statusFieldId: "fld_status",
      beforeOptionId: "opt_other",
      afterOptionId: "opt_initial",
      occurredAt: overrides.event?.occurredAt ?? Date.now(),
      ...overrides.event,
    },
    binding: {
      subjectKey: SUBJECT_KEY,
      configVersion: subject.configVersion,
      stageId: "initial",
      ...overrides.binding,
    },
    controlledContext: {
      documentLinks: ["https://guanghe.feishu.cn/docx/opaque-token"],
      namingDisplayValue: "课程001",
      namingValueUnique: true,
      ...overrides.controlledContext,
    },
  };
}

test("canonical stage registration derives execution policy from the enabled snapshot and replays idempotently", async () => {
  const fixtureData = await fixture();
  try {
    const subject = await enableSubject(fixtureData);
    const payload = registration(subject);
    const first = await request(fixtureData.baseUrl, "/api/local/feishu/tasks", payload);
    assert.equal(first.response.status, 201, JSON.stringify(first.body));
    assert.equal(first.body.task.feishuOrigin.stageId, "initial");
    assert.equal(first.body.task.feishuOrigin.configVersion, subject.configVersion);
    assert.equal(first.body.task.feishuOrigin.packageAlias, "Auto-cut-lite");
    assert.equal(first.body.task.feishuOrigin.executionMode, "automatic");

    const replay = await request(fixtureData.baseUrl, "/api/local/feishu/tasks", payload);
    assert.equal(replay.response.status, 200, JSON.stringify(replay.body));
    assert.equal(replay.body.task.id, first.body.task.id);
  } finally {
    await fixtureData.app.close();
    await rm(fixtureData.directory, { recursive: true, force: true });
  }
});

test("canonical stage registration rejects an event rebound to another stage", async () => {
  const fixtureData = await fixture();
  try {
    const subject = await enableSubject(fixtureData);
    const payload = registration(subject);
    const first = await request(fixtureData.baseUrl, "/api/local/feishu/tasks", payload);
    assert.equal(first.response.status, 201, JSON.stringify(first.body));
    const conflict = await request(
      fixtureData.baseUrl,
      "/api/local/feishu/tasks",
      registration(subject, {
        binding: { stageId: "final_review" },
        event: { afterOptionId: "opt_final", occurredAt: payload.event.occurredAt },
      }),
    );
    assert.equal(conflict.response.status, 409, JSON.stringify(conflict.body));
    assert.equal(conflict.body.error.code, "FEISHU_EVENT_BINDING_CONFLICT");
  } finally {
    await fixtureData.app.close();
    await rm(fixtureData.directory, { recursive: true, force: true });
  }
});
