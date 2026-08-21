import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { TaskboardDatabase } from "../server/database.mjs";
import { createFeishuWorkflowStore, subjectProjectId } from "../server/feishu-workflow-store.mjs";

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-feishu-workflow-"));
  const database = new TaskboardDatabase(path.join(directory, "taskboard.sqlite"));
  const store = createFeishuWorkflowStore({ database });
  return { directory, database, store };
}

function preview() {
  return {
    baseToken: "bas_demo",
    baseName: "学科 Base",
    sourceUrlLabel: "https://example.test/base/bas_demo",
    metadataRefreshedAt: 1710000000000,
    tables: [{
      tableId: "tbl_math",
      tableName: "数学",
      fields: [
        { fieldId: "fld_status", fieldName: "待制作", type: 3, uiType: "SingleSelect", options: [{ id: "opt_ready", name: "待制作" }] },
      ],
    }],
  };
}

function subjectPatch() {
  return {
    displayEnabled: true,
    trigger: { fieldId: "fld_status", fieldName: "待制作", startValue: "待制作", optionId: "opt_ready" },
    title: { fieldId: null, fieldName: null },
    execution: { mode: "manual", concurrencyGroup: "autocut", maxConcurrent: 1, resourceGroups: [] },
    packageRoute: { routeMode: "fixed", packageAlias: "Auto-cut-A", subjectCodeFieldId: null, branchMap: null },
    upload: { enqueueMode: "manual", artifactSourceMode: "manual_select", artifactSourcePath: null, targetId: null, targetPath: null, uploadConcurrency: 1 },
  };
}

test("catalog preview creates independent Base/subject rows and deterministic project ids", async () => {
  const { directory, database, store } = await fixture();
  try {
    const catalog = await store.upsertBasePreview(preview());
    assert.equal(catalog.baseToken, "bas_demo");
    assert.equal(catalog.subjects.length, 1);
    assert.equal(catalog.subjects[0].subjectKey, "bas_demo:tbl_math");
    assert.equal(catalog.subjects[0].projectId, subjectProjectId("bas_demo:tbl_math"));
    assert.match(catalog.subjects[0].projectId, /^feishu-[a-f0-9]{16}$/);
    assert.equal(database.database.prepare("SELECT COUNT(*) AS count FROM feishu_bases").get().count, 1);
    assert.equal(database.database.prepare("SELECT COUNT(*) AS count FROM feishu_subjects").get().count, 1);
    const again = await store.listCatalog();
    assert.deepEqual(again, [catalog]);
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("subject draft save increments version and enable/disable use optimistic checks", async () => {
  const { directory, database, store } = await fixture();
  try {
    await store.upsertBasePreview(preview());
    const key = "bas_demo:tbl_math";
    const draft = await store.saveSubjectDraft(key, subjectPatch());
    assert.equal(draft.lifecycle, "draft");
    assert.equal(draft.configVersion, 2);
    const enabled = await store.enableSubject(key, draft.configVersion);
    assert.equal(enabled.lifecycle, "enabled");
    assert.equal(enabled.configVersion, 3);
    await assert.rejects(
      () => store.disableSubject(key, draft.configVersion),
      (error) => error.code === "VERSION_CONFLICT" && error.status === 409,
    );
    const disabled = await store.disableSubject(key, enabled.configVersion);
    assert.equal(disabled.lifecycle, "disabled");
    assert.equal(disabled.configVersion, 4);
    assert.equal(database.database.prepare("SELECT COUNT(*) AS count FROM feishu_subject_versions").get().count, 4);
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

