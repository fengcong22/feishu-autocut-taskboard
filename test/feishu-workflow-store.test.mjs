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
    assert.equal(subjectProjectId("bas_demo:tbl_demo"), "feishu-a20370a3de0f8d3b");
    assert.equal(database.database.prepare("SELECT COUNT(*) AS count FROM feishu_bases").get().count, 1);
    assert.equal(database.database.prepare("SELECT COUNT(*) AS count FROM feishu_subjects").get().count, 1);
    const again = await store.listCatalog();
    assert.deepEqual(again, [catalog]);
    const projectId = subjectProjectId("bas_demo:tbl_math");
    assert.equal(database.getProject(projectId).source, "feishu");
    database.database.prepare("UPDATE projects SET source = 'local' WHERE id = ?").run(projectId);
    await store.upsertBasePreview(preview());
    assert.equal(database.getProject(projectId).source, "feishu");
    assert.throws(
      () => database.setProjectArchived(projectId, true),
      (error) => error.code === "PROJECT_ARCHIVE_FORBIDDEN",
    );
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("catalog preview strips source URL credentials and fragments before persistence", async () => {
  const { directory, database, store } = await fixture();
  try {
    const catalog = await store.upsertBasePreview({
      ...preview(),
      sourceUrlLabel: "https://user:secret@example.test/base/bas_demo?token=secret#fragment",
    });
    assert.equal(catalog.sourceUrlLabel, "https://example.test/base/bas_demo");
    const stored = database.database
      .prepare("SELECT source_url_label FROM feishu_bases WHERE base_token = ?")
      .get("bas_demo");
    assert.equal(stored.source_url_label, "https://example.test/base/bas_demo");
    const listed = await store.listCatalog();
    assert.equal(listed[0].sourceUrlLabel, "https://example.test/base/bas_demo");
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("catalog reads sanitize legacy source URL labels before returning them", async () => {
  const { directory, database, store } = await fixture();
  try {
    await store.upsertBasePreview(preview());
    database.database.prepare("UPDATE feishu_bases SET source_url_label = ? WHERE base_token = ?")
      .run("https://user:secret@example.test/base/bas_demo?token=secret#fragment", "bas_demo");

    const listed = await store.listCatalog();
    assert.equal(listed[0].sourceUrlLabel, "https://example.test/base/bas_demo");
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("catalog preview rejects malformed Base and table identifiers even without subjects", async () => {
  const { directory, database, store } = await fixture();
  try {
    await assert.rejects(
      () => store.upsertBasePreview({
        ...preview(),
        baseToken: "bas:secret",
        tables: [],
      }),
      (error) => error.code === "INVALID_FIELD" && error.status === 400,
    );
    await assert.rejects(
      () => store.upsertBasePreview({
        ...preview(),
        tables: [{ tableId: "tbl:secret", tableName: "数学", fields: [] }],
      }),
      (error) => error.code === "INVALID_FIELD" && error.status === 400,
    );
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("refreshing existing metadata validates and versions changed subject display data", async () => {
  const { directory, database, store } = await fixture();
  try {
    const first = await store.upsertBasePreview(preview());
    const before = first.subjects[0];
    const refreshed = await store.upsertBasePreview({
      ...preview(),
      baseName: "学科 Base 2",
      metadataRefreshedAt: 1710000001000,
      tables: [{
        ...preview().tables[0],
        tableName: "数学（更新）",
        fields: [{ fieldId: "fld_status", fieldName: "待制作", type: 3, uiType: "SingleSelect", options: [{ id: "opt_ready", name: "待制作" }, { id: "opt_done", name: "已完成" }] }],
      }],
    });
    const after = refreshed.subjects[0];
    assert.equal(after.baseName, "学科 Base 2");
    assert.equal(after.tableName, "数学（更新）");
    assert.equal(after.configVersion, before.configVersion + 1);
    assert.equal(database.database.prepare("SELECT COUNT(*) AS count FROM feishu_subject_versions WHERE subject_key = ?").get(after.subjectKey).count, 2);
    const stable = await store.upsertBasePreview({
      ...preview(),
      baseName: "学科 Base 2",
      metadataRefreshedAt: 1710000001000,
      tables: [{
        ...preview().tables[0],
        tableName: "数学（更新）",
        fields: [{ fieldId: "fld_status", fieldName: "待制作", type: 3, uiType: "SingleSelect", options: [{ id: "opt_ready", name: "待制作" }, { id: "opt_done", name: "已完成" }] }],
      }],
    });
    assert.equal(stable.subjects[0].configVersion, after.configVersion);
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("refreshing an enabled subject demotes it to draft until it is re-enabled", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-feishu-refresh-enabled-"));
  const database = new TaskboardDatabase(path.join(directory, "taskboard.sqlite"));
  const calls = [];
  const store = createFeishuWorkflowStore({
    database,
    packageAliases: async () => ["Auto-cut-A"],
    syncSubject: async (subject, options) => calls.push({ subject, options }),
  });
  try {
    await store.upsertBasePreview(preview());
    const draft = await store.saveSubjectDraft("bas_demo:tbl_math", subjectPatch());
    const enabled = await store.enableSubject("bas_demo:tbl_math", draft.configVersion);
    assert.equal(enabled.lifecycle, "enabled");

    const refreshed = await store.upsertBasePreview({
      ...preview(),
      baseName: "学科 Base refreshed",
      tables: [{
        ...preview().tables[0],
        tableName: "数学（刷新）",
        fields: [
          ...preview().tables[0].fields,
          { fieldId: "fld_title", fieldName: "标题", type: 1, uiType: "Text", options: [] },
        ],
      }],
    });
    const next = refreshed.subjects[0];
    assert.equal(next.lifecycle, "draft");
    assert.equal(next.configVersion, enabled.configVersion + 1);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.lifecycle, "enabled");
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("database Feishu archive reports a missing task as TASK_NOT_FOUND", async () => {
  const { directory, database } = await fixture();
  try {
    assert.throws(
      () => database.archiveFeishuTask("missing-task", 1, { type: "system", id: "test", name: "test" }),
      (error) => error.code === "TASK_NOT_FOUND" && error.status === 404,
    );
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

test("subject draft accepts a human-readable upload target alias", async () => {
  const { directory, database, store } = await fixture();
  try {
    await store.upsertBasePreview(preview());
    const draft = await store.saveSubjectDraft("bas_demo:tbl_math", {
      ...subjectPatch(),
      upload: {
        ...subjectPatch().upload,
        targetId: "0901上传测试",
        targetPath: "W:\\[剪映草稿]\\高中历史\\01初版草稿",
      },
    });
    assert.equal(draft.upload.targetId, "0901上传测试");
    assert.equal(draft.upload.targetPath, "W:\\[剪映草稿]\\高中历史\\01初版草稿");
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("enabling rejects trigger fields and select options missing from refreshed Base metadata", async () => {
  const { directory, database, store } = await fixture();
  try {
    await store.upsertBasePreview(preview());
    const missingField = await store.saveSubjectDraft("bas_demo:tbl_math", {
      ...subjectPatch(),
      trigger: { fieldId: "fld_missing", fieldName: "不存在", startValue: "待制作", optionId: null },
    });
    await assert.rejects(
      () => store.enableSubject(missingField.subjectKey, missingField.configVersion),
      (error) => error.code === "TRIGGER_FIELD_NOT_FOUND" && error.status === 409,
    );

    const missingOption = await store.saveSubjectDraft("bas_demo:tbl_math", {
      ...subjectPatch(),
      expectedVersion: missingField.configVersion,
      trigger: { fieldId: "fld_status", fieldName: "待制作", startValue: "不存在", optionId: "opt_missing" },
    });
    await assert.rejects(
      () => store.enableSubject(missingOption.subjectKey, missingOption.configVersion),
      (error) => error.code === "TRIGGER_OPTION_NOT_FOUND" && error.status === 409,
    );
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("display visibility toggles independently without changing lifecycle or config version", async () => {
  const { directory, database, store } = await fixture();
  try {
    await store.upsertBasePreview(preview());
    const key = "bas_demo:tbl_math";
    const before = await store.getSubject(key);
    assert.equal(before.displayEnabled, false);
    assert.equal(before.lifecycle, "draft");
    const shown = await store.setSubjectDisplayEnabled(key, true);
    assert.equal(shown.displayEnabled, true);
    assert.equal(shown.lifecycle, "draft");
    assert.equal(shown.configVersion, before.configVersion);
    const enabled = await store.saveSubjectDraft(key, subjectPatch());
    const hidden = await store.setSubjectDisplayEnabled(key, false);
    assert.equal(hidden.displayEnabled, false);
    assert.equal(hidden.lifecycle, enabled.lifecycle);
    assert.equal(hidden.configVersion, enabled.configVersion);
    assert.equal(database.database.prepare("SELECT COUNT(*) AS count FROM feishu_subject_versions").get().count, 2);
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("lifecycle transition synchronizes with Bridge before committing locally", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-feishu-sync-"));
  const database = new TaskboardDatabase(path.join(directory, "taskboard.sqlite"));
  const calls = [];
  const store = createFeishuWorkflowStore({
    database,
    packageAliases: async () => ["Auto-cut-A"],
    syncSubject: async (subject, options) => {
      calls.push({ subject, options });
      if (options.lifecycle === "disabled") throw new Error("bridge unavailable");
    },
  });
  try {
    await store.upsertBasePreview(preview());
    const draft = await store.saveSubjectDraft("bas_demo:tbl_math", subjectPatch());
    const enabled = await store.enableSubject("bas_demo:tbl_math", draft.configVersion);
    assert.equal(enabled.lifecycle, "enabled");
    assert.equal(calls[0].options.lifecycle, "enabled");
    await assert.rejects(
      () => store.disableSubject("bas_demo:tbl_math", enabled.configVersion),
      /bridge unavailable/,
    );
    assert.equal((await store.getSubject("bas_demo:tbl_math")).lifecycle, "enabled");
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});
