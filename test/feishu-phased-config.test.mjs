import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { TaskboardDatabase } from "../server/database.mjs";
import {
  STAGE_IDS,
  createFeishuWorkflowStore,
  normalizeStage,
  subjectProjectId,
  validateSubjectConfig,
} from "../server/feishu-workflow-store.mjs";

const subjectKey = "bas_phase:tbl_subject";

function metadata() {
  return {
    fields: [
      {
        fieldId: "fld_status",
        fieldName: "流程",
        type: 3,
        uiType: "SingleSelect",
        options: [
          { id: "opt_initial", name: "初稿" },
          { id: "opt_review", name: "初审修改" },
          { id: "opt_final", name: "终审修改" },
        ],
      },
      { fieldId: "fld_document", fieldName: "素材文档", type: 1, uiType: "Text", options: [] },
      { fieldId: "fld_name", fieldName: "命名", type: 1, uiType: "Text", options: [] },
      { fieldId: "fld_audio", fieldName: "音频", type: 17, uiType: "Attachment", options: [] },
    ],
  };
}

function stage(id, optionId, value, overrides = {}) {
  return {
    enabled: true,
    trigger: { fieldId: "fld_status", optionId, value },
    videoSource: { kind: "docx_section", anchorText: "录屏" },
    reviewSource: { kind: "docx_section", anchorText: "修改意见" },
    audio: { mode: "video_original" },
    artifactTargetPath: `C:\\approved\\${id}`,
    nameSuffix: `_${value}`,
    ...overrides,
  };
}

function subject() {
  return {
    subjectKey,
    baseToken: "bas_phase",
    baseName: "阶段 Base",
    tableId: "tbl_subject",
    tableName: "学科",
    projectId: subjectProjectId(subjectKey),
    displayEnabled: true,
    lifecycle: "draft",
    configVersion: 1,
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
    execution: { mode: "manual", concurrencyGroup: "autocut", maxConcurrent: 1, resourceGroups: [] },
    packageRoute: { routeMode: "fixed", packageAlias: "Auto-cut-A", subjectCodeFieldId: null, branchMap: null },
    upload: { enqueueMode: "manual", artifactSourceMode: "driver_report", artifactSourcePath: "C:\\artifacts", targetId: null, targetPath: null, uploadConcurrency: 1 },
    metadata: metadata(),
  };
}

test("normalizes the three fixed phases and rejects duplicate enabled options", () => {
  assert.deepEqual([...STAGE_IDS], ["initial", "first_review", "final_review"]);
  const value = subject();
  const normalized = validateSubjectConfig(value);
  assert.deepEqual(Object.keys(normalized.stages), [...STAGE_IDS]);
  assert.equal(normalized.stages.initial.trigger.optionId, "opt_initial");

  const duplicate = structuredClone(value);
  duplicate.stages.final_review.trigger.optionId = "opt_initial";
  assert.throws(() => validateSubjectConfig(duplicate), /enabled stage trigger options must be unique/i);
});

test("requires an audio source only when replacing the video's original audio", () => {
  const value = subject();
  value.stages.initial.audio = {
    mode: "replace_original",
    source: null,
    durationToleranceSeconds: 3,
  };
  assert.throws(() => validateSubjectConfig(value), /audio source is required/i);

  value.stages.initial.audio = { mode: "video_original" };
  assert.equal(validateSubjectConfig(value).stages.initial.audio.mode, "video_original");
});

test("normalizes a stage against the selected status field metadata", () => {
  const normalized = normalizeStage(stage("initial", "opt_initial", "初稿"), metadata(), "initial");
  assert.equal(normalized.trigger.fieldId, "fld_status");
  assert.equal(normalized.trigger.value, "初稿");
  assert.equal(normalized.audio.mode, "video_original");
});

test("stores and returns a phased subject through the existing workflow store", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-phased-config-"));
  const database = new TaskboardDatabase(path.join(directory, "taskboard.sqlite"));
  const store = createFeishuWorkflowStore({ database, packageAliases: async () => ["Auto-cut-A"] });
  try {
    await store.upsertBasePreview({
      baseToken: "bas_phase",
      baseName: "阶段 Base",
      tables: [{ tableId: "tbl_subject", tableName: "学科", fields: metadata().fields }],
    });
    const configured = subject();
    const saved = await store.saveSubjectDraft(subjectKey, {
      displayEnabled: configured.displayEnabled,
      statusField: configured.statusField,
      documentField: configured.documentField,
      namingField: configured.namingField,
      stages: configured.stages,
      trigger: configured.trigger,
      title: configured.title,
      execution: configured.execution,
      packageRoute: configured.packageRoute,
      upload: configured.upload,
    });
    assert.equal(saved.stages.final_review.nameSuffix, "_终审修改");
    assert.equal((await store.getSubject(subjectKey)).documentField.fieldId, "fld_document");
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});
