import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { test } from "node:test";
import os from "node:os";
import path from "node:path";

import { createTaskboardServer } from "../server/index.mjs";
import { UNIFIED_WORKFLOW_STAGES } from "../shared/unified-workflow-stages.mjs";

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-stage-display-"));
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
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  return { app, directory, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function request(baseUrl, route, options = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    ...options,
    headers: { "content-type": "application/json", ...options.headers },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return { response, body: await response.json() };
}

async function createSubjects(baseUrl, baseToken = "bas_stage_display") {
  const result = await request(baseUrl, "/api/local/feishu/workflow/catalog", {
    method: "POST",
    body: {
      baseToken,
      baseName: "Stage Display Base",
      tables: [
        { tableId: "tbl_a", tableName: "Subject A", fields: [] },
        { tableId: "tbl_b", tableName: "Subject B", fields: [] },
      ],
    },
  });
  assert.equal(result.response.status, 201);
  return result.body.catalog[0].subjects;
}

async function getDisplays(baseUrl, subjectKey) {
  return request(
    baseUrl,
    `/api/local/feishu/workflow/stage-displays?subjectKey=${encodeURIComponent(subjectKey)}`,
  );
}

async function patchDisplay(baseUrl, subjectKey, stageId, body) {
  const result = await request(
    baseUrl,
    `/api/local/feishu/workflow/stage-displays/${encodeURIComponent(stageId)}`,
    { method: "PATCH", body: { subjectKey, ...body } },
  );
  if (result.response.status >= 400) {
    const error = new Error(result.body.error?.message ?? "Request failed");
    error.code = result.body.error?.code;
    error.details = result.body.error?.details;
    throw error;
  }
  return result;
}

async function closeFixture(fixtureData) {
  await fixtureData.app.close();
  await rm(fixtureData.directory, { recursive: true, force: true });
}

test("stage display GET creates nine empty rows scoped to one subject", async () => {
  const fixtureData = await fixture();
  try {
    const [subjectA, subjectB] = await createSubjects(fixtureData.baseUrl);
    const first = await getDisplays(fixtureData.baseUrl, subjectA.subjectKey);
    assert.equal(first.response.status, 200);
    assert.deepEqual(first.body.overrides.map((entry) => entry.stageId), UNIFIED_WORKFLOW_STAGES);
    assert.equal(first.body.overrides.length, UNIFIED_WORKFLOW_STAGES.length);
    assert.ok(first.body.overrides.every((entry) => (
      entry.subjectKey === subjectA.subjectKey
      && entry.revision === 1
      && entry.zhName === null
      && entry.enName === null
      && entry.zhDescription === null
      && entry.enDescription === null
    )));

    const second = await getDisplays(fixtureData.baseUrl, subjectB.subjectKey);
    assert.equal(second.response.status, 200);
    assert.ok(second.body.overrides.every((entry) => entry.subjectKey === subjectB.subjectKey));
  } finally {
    await closeFixture(fixtureData);
  }
});

test("stage display updates retain omitted fields, support null reset, and stay isolated", async () => {
  const fixtureData = await fixture();
  try {
    const [subjectA, subjectB] = await createSubjects(fixtureData.baseUrl, "bas_stage_display_isolation");
    const initial = await getDisplays(fixtureData.baseUrl, subjectA.subjectKey);
    const saved = await patchDisplay(fixtureData.baseUrl, subjectA.subjectKey, "in_progress", {
      revision: initial.body.overrides.find((entry) => entry.stageId === "in_progress").revision,
      zhName: "剪辑处理中",
      zhDescription: "正在运行 Auto-Cut",
    });
    const changed = saved.body.overrides.find((entry) => entry.stageId === "in_progress");
    assert.equal(changed.zhName, "剪辑处理中");
    assert.equal(changed.zhDescription, "正在运行 Auto-Cut");
    assert.equal(changed.enName, null);
    assert.equal(changed.revision, 2);

    const untouched = await getDisplays(fixtureData.baseUrl, subjectB.subjectKey);
    assert.ok(untouched.body.overrides.every((entry) => (
      entry.zhName === null && entry.enName === null
      && entry.zhDescription === null && entry.enDescription === null
    )));

    const reset = await patchDisplay(fixtureData.baseUrl, subjectA.subjectKey, "in_progress", {
      revision: changed.revision,
      zhName: null,
      zhDescription: null,
    });
    const resetRow = reset.body.overrides.find((entry) => entry.stageId === "in_progress");
    assert.equal(resetRow.zhName, null);
    assert.equal(resetRow.zhDescription, null);
    assert.equal(resetRow.revision, 3);
  } finally {
    await closeFixture(fixtureData);
  }
});

test("stage display validation rejects markup, controls, overlong text, and stale revisions", async () => {
  const fixtureData = await fixture();
  try {
    const [subject] = await createSubjects(fixtureData.baseUrl, "bas_stage_display_validation");
    const initial = await getDisplays(fixtureData.baseUrl, subject.subjectKey);
    const revision = initial.body.overrides.find((entry) => entry.stageId === "in_progress").revision;
    await assert.rejects(
      patchDisplay(fixtureData.baseUrl, subject.subjectKey, "in_progress", {
        revision,
        zhName: "<b>处理中</b>",
      }),
      (error) => error.code === "INVALID_FIELD",
    );
    await assert.rejects(
      patchDisplay(fixtureData.baseUrl, subject.subjectKey, "in_progress", {
        revision,
        zhName: "处理中\n",
      }),
      (error) => error.code === "INVALID_FIELD",
    );
    await assert.rejects(
      patchDisplay(fixtureData.baseUrl, subject.subjectKey, "in_progress", {
        revision,
        zhName: "处理\u200b中",
      }),
      (error) => error.code === "INVALID_FIELD",
    );
    await assert.rejects(
      patchDisplay(fixtureData.baseUrl, subject.subjectKey, "in_progress", {
        revision,
        zhDescription: "x".repeat(121),
      }),
      (error) => error.code === "INVALID_FIELD",
    );
    await patchDisplay(fixtureData.baseUrl, subject.subjectKey, "in_progress", {
      revision,
      zhName: "处理中",
    });
    await assert.rejects(
      patchDisplay(fixtureData.baseUrl, subject.subjectKey, "in_progress", {
        revision,
        enName: "Stale",
      }),
      (error) => error.code === "VERSION_CONFLICT"
        && error.details.expectedVersion === revision
        && error.details.actualVersion === revision + 1,
    );
  } finally {
    await closeFixture(fixtureData);
  }
});

test("stage display routes reject malformed query/body and removed subjects", async () => {
  const fixtureData = await fixture();
  try {
    const [subject] = await createSubjects(fixtureData.baseUrl, "bas_stage_display_routes");
    const missing = await request(fixtureData.baseUrl, "/api/local/feishu/workflow/stage-displays");
    assert.equal(missing.response.status, 400);
    assert.equal(missing.body.error.code, "INVALID_QUERY_PARAMETER");
    const duplicate = await request(
      fixtureData.baseUrl,
      "/api/local/feishu/workflow/stage-displays?subjectKey=a&subjectKey=b",
    );
    assert.equal(duplicate.response.status, 400);
    assert.equal(duplicate.body.error.code, "INVALID_QUERY_PARAMETER");
    const unknownQuery = await request(
      fixtureData.baseUrl,
      "/api/local/feishu/workflow/stage-displays?subjectKey=a&extra=true",
    );
    assert.equal(unknownQuery.response.status, 400);
    assert.equal(unknownQuery.body.error.code, "UNKNOWN_QUERY_PARAMETER");

    const initial = await getDisplays(fixtureData.baseUrl, subject.subjectKey);
    const revision = initial.body.overrides[0].revision;
    const unknownBody = await request(
      fixtureData.baseUrl,
      "/api/local/feishu/workflow/stage-displays/todo",
      { method: "PATCH", body: { subjectKey: subject.subjectKey, revision, extra: true } },
    );
    assert.equal(unknownBody.response.status, 400);
    assert.equal(unknownBody.body.error.code, "UNKNOWN_FIELD");
    const invalidStage = await request(
      fixtureData.baseUrl,
      "/api/local/feishu/workflow/stage-displays/not-a-stage",
      { method: "PATCH", body: { subjectKey: subject.subjectKey, revision } },
    );
    assert.equal(invalidStage.response.status, 400);
    assert.equal(invalidStage.body.error.code, "INVALID_FIELD");

    const removed = await request(
      fixtureData.baseUrl,
      `/api/local/feishu/workflow/subjects/${encodeURIComponent(subject.subjectKey)}`,
      { method: "DELETE", body: {} },
    );
    assert.equal(removed.response.status, 200);
    await assert.rejects(
      patchDisplay(fixtureData.baseUrl, subject.subjectKey, "todo", { revision }),
      (error) => error.code === "SUBJECT_REMOVED",
    );
  } finally {
    await closeFixture(fixtureData);
  }
});

test("stage settings component is subject-scoped, editable, resettable, and accessible", async () => {
  const source = await readFile(
    new URL("../web/src/components/UnifiedWorkflowStageSettings.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /subjectKey/);
  assert.match(source, /UNIFIED_WORKFLOW_STAGES/);
  assert.match(source, /zhName/);
  assert.match(source, /enName/);
  assert.match(source, /zhDescription/);
  assert.match(source, /enDescription/);
  assert.match(source, /重置|Reset/);
  assert.match(source, /aria-label/);
  assert.match(source, /aria-describedby/);
  assert.match(source, /readOnly|readOnly=/);
});
