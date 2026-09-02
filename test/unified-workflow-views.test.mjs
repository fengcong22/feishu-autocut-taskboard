import assert from "node:assert/strict";
import { test } from "node:test";

import {
  REAL_UNIFIED_WORKFLOW_STAGES,
  UNIFIED_WORKFLOW_STAGES,
  UPLOAD_UNIFIED_WORKFLOW_STAGES,
} from "../shared/unified-workflow-stages.mjs";
import {
  MAX_UNIFIED_WORKFLOW_VIEW_NAME_LENGTH,
  SYSTEM_UNIFIED_VIEW_ID,
  createUnifiedWorkflowView,
  normalizeUnifiedWorkflowViews,
  stageIdsInBoardOrder,
  validateUnifiedWorkflowViewInput,
} from "../web/src/unifiedWorkflowViews.mjs";
import {
  UNIFIED_WORKFLOW_STAGES as BOARD_UNIFIED_WORKFLOW_STAGES,
} from "../web/src/unifiedWorkflow.mjs";

const SUBJECT_A = "base-a:table-a";
const SUBJECT_B = "base-a:table-b";
const CREATED_AT = "2026-09-02T08:00:00.000Z";

test("the shared workflow stage registry has one frozen nine-stage order", () => {
  assert.equal(BOARD_UNIFIED_WORKFLOW_STAGES, UNIFIED_WORKFLOW_STAGES);
  assert.deepEqual(UNIFIED_WORKFLOW_STAGES, [
    "todo",
    "queued",
    "in_progress",
    "blocked",
    "in_review",
    "completed_editing",
    "upload_queue",
    "uploading",
    "uploaded",
  ]);
  assert.deepEqual(REAL_UNIFIED_WORKFLOW_STAGES, [
    "todo",
    "queued",
    "in_progress",
    "blocked",
    "in_review",
  ]);
  assert.deepEqual(UPLOAD_UNIFIED_WORKFLOW_STAGES, [
    "completed_editing",
    "upload_queue",
    "uploading",
    "uploaded",
  ]);
  assert.equal(Object.isFrozen(UNIFIED_WORKFLOW_STAGES), true);
  assert.equal(Object.isFrozen(REAL_UNIFIED_WORKFLOW_STAGES), true);
  assert.equal(Object.isFrozen(UPLOAD_UNIFIED_WORKFLOW_STAGES), true);
});

test("first read creates only the all-stages system view", () => {
  const state = normalizeUnifiedWorkflowViews(null, SUBJECT_A);

  assert.equal(state.schemaVersion, 1);
  assert.equal(state.subjectKey, SUBJECT_A);
  assert.equal(state.revision, 0);
  assert.equal(state.defaultViewId, SYSTEM_UNIFIED_VIEW_ID);
  assert.equal(state.activeViewId, SYSTEM_UNIFIED_VIEW_ID);
  assert.equal(state.readOnly, false);
  assert.deepEqual(state.views.map((view) => view.id), [SYSTEM_UNIFIED_VIEW_ID]);
  assert.equal(state.views[0].subjectKey, SUBJECT_A);
  assert.equal(state.views[0].name, "全部流程");
  assert.equal(state.views[0].isSystem, true);
  assert.deepEqual(state.views[0].stageIds, UNIFIED_WORKFLOW_STAGES);
});

test("normalization preserves valid custom view data and collection revision", () => {
  const state = normalizeUnifiedWorkflowViews({
    schemaVersion: 1,
    subjectKey: SUBJECT_A,
    revision: 8,
    defaultViewId: "view-a",
    activeViewId: "view-a",
    readOnly: true,
    views: [
      {
        id: "view-a",
        subjectKey: SUBJECT_A,
        name: "  My workflow  ",
        stageIds: ["uploaded", "todo"],
        isSystem: false,
        revision: 3,
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
      },
    ],
  }, SUBJECT_A);

  assert.equal(state.revision, 8);
  assert.equal(state.defaultViewId, "view-a");
  assert.equal(state.activeViewId, "view-a");
  assert.equal(state.readOnly, true);
  assert.deepEqual(state.views.map((view) => view.id), [SYSTEM_UNIFIED_VIEW_ID, "view-a"]);
  assert.deepEqual(state.views[1], {
    id: "view-a",
    subjectKey: SUBJECT_A,
    name: "My workflow",
    stageIds: ["uploaded", "todo"],
    isSystem: false,
    revision: 3,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  });
});

test("damaged and foreign persisted definitions fall back without business presets", () => {
  const damaged = normalizeUnifiedWorkflowViews({
    schemaVersion: 1,
    subjectKey: SUBJECT_A,
    revision: 4,
    activeViewId: "bad",
    defaultViewId: "missing",
    views: [
      {
        id: "bad",
        subjectKey: SUBJECT_A,
        name: "Broken",
        stageIds: ["in_progress", "unknown", "in_progress"],
        isSystem: false,
        revision: 1,
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
      },
      {
        id: "foreign",
        subjectKey: SUBJECT_B,
        name: "Foreign",
        stageIds: ["todo"],
        isSystem: false,
        revision: 1,
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
      },
    ],
  }, SUBJECT_A);
  const foreignCollection = normalizeUnifiedWorkflowViews({
    schemaVersion: 1,
    subjectKey: SUBJECT_B,
    revision: 9,
    activeViewId: "view-b",
    defaultViewId: "view-b",
    views: [{
      id: "view-b",
      subjectKey: SUBJECT_B,
      name: "Subject B",
      stageIds: ["todo"],
      isSystem: false,
      revision: 1,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    }],
  }, SUBJECT_A);

  assert.deepEqual(damaged.views.map((view) => view.id), [SYSTEM_UNIFIED_VIEW_ID]);
  assert.equal(damaged.revision, 4);
  assert.equal(damaged.defaultViewId, SYSTEM_UNIFIED_VIEW_ID);
  assert.equal(damaged.activeViewId, SYSTEM_UNIFIED_VIEW_ID);
  assert.deepEqual(foreignCollection.views.map((view) => view.id), [SYSTEM_UNIFIED_VIEW_ID]);
  assert.equal(foreignCollection.subjectKey, SUBJECT_A);
  assert.equal(foreignCollection.revision, 9);
});

test("normalization restores the protected system view and valid pointers only", () => {
  const state = normalizeUnifiedWorkflowViews({
    schemaVersion: 1,
    subjectKey: SUBJECT_A,
    revision: 2,
    defaultViewId: "missing",
    activeViewId: "missing",
    views: [{
      id: SYSTEM_UNIFIED_VIEW_ID,
      subjectKey: SUBJECT_A,
      name: "Renamed",
      stageIds: ["todo"],
      isSystem: false,
      revision: 17,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    }],
  }, SUBJECT_A);

  assert.deepEqual(state.views.map((view) => view.id), [SYSTEM_UNIFIED_VIEW_ID]);
  assert.equal(state.views[0].name, "全部流程");
  assert.equal(state.views[0].isSystem, true);
  assert.deepEqual(state.views[0].stageIds, UNIFIED_WORKFLOW_STAGES);
  assert.equal(state.defaultViewId, SYSTEM_UNIFIED_VIEW_ID);
  assert.equal(state.activeViewId, SYSTEM_UNIFIED_VIEW_ID);
});

test("custom view validation trims names and preserves explicit stage order", () => {
  const result = validateUnifiedWorkflowViewInput({
    subjectKey: `  ${SUBJECT_A}  `,
    name: "  Editing and upload  ",
    stageIds: ["uploaded", "todo", "in_progress"],
  });

  assert.deepEqual(result, {
    subjectKey: SUBJECT_A,
    name: "Editing and upload",
    stageIds: ["uploaded", "todo", "in_progress"],
  });
});

test("custom view validation enforces names, stages, and subject-local uniqueness", () => {
  assert.equal(MAX_UNIFIED_WORKFLOW_VIEW_NAME_LENGTH, 64);
  assert.throws(
    () => validateUnifiedWorkflowViewInput({ subjectKey: SUBJECT_A, name: "   ", stageIds: ["todo"] }),
    /name is required/,
  );
  assert.throws(
    () => validateUnifiedWorkflowViewInput({
      subjectKey: SUBJECT_A,
      name: "x".repeat(MAX_UNIFIED_WORKFLOW_VIEW_NAME_LENGTH + 1),
      stageIds: ["todo"],
    }),
    /at most 64 characters/,
  );
  assert.throws(
    () => validateUnifiedWorkflowViewInput({ subjectKey: SUBJECT_A, name: "Empty", stageIds: [] }),
    /at least one stage/,
  );
  assert.throws(
    () => validateUnifiedWorkflowViewInput({ subjectKey: SUBJECT_A, name: "Unknown", stageIds: ["unknown"] }),
    /unknown stage/,
  );
  assert.throws(
    () => validateUnifiedWorkflowViewInput({ subjectKey: SUBJECT_A, name: "Duplicate", stageIds: ["todo", "todo"] }),
    /duplicate stage/,
  );

  const existingViews = [
    { id: "view-a", subjectKey: SUBJECT_A, name: "Editing" },
    { id: "view-b", subjectKey: SUBJECT_B, name: "Shared name" },
  ];
  assert.throws(
    () => validateUnifiedWorkflowViewInput({
      subjectKey: SUBJECT_A,
      name: " Editing ",
      stageIds: ["todo"],
    }, existingViews),
    /name already exists/,
  );
  assert.doesNotThrow(() => validateUnifiedWorkflowViewInput({
    id: "view-a",
    subjectKey: SUBJECT_A,
    name: "Editing",
    stageIds: ["todo"],
  }, existingViews));
  assert.doesNotThrow(() => validateUnifiedWorkflowViewInput({
    subjectKey: SUBJECT_A,
    name: "Shared name",
    stageIds: ["todo"],
  }, existingViews));
});

test("new custom view drafts start with no selected stages", () => {
  const draft = createUnifiedWorkflowView({
    id: "draft-a",
    subjectKey: `  ${SUBJECT_A}  `,
    name: "  New view  ",
    stageIds: ["todo", "queued"],
    revision: 99,
    isSystem: true,
  }, CREATED_AT);

  assert.deepEqual(draft, {
    id: "draft-a",
    subjectKey: SUBJECT_A,
    name: "New view",
    stageIds: [],
    isSystem: false,
    revision: 0,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  });
});

test("stageIdsInBoardOrder deduplicates in the fixed order and rejects unknown stages", () => {
  assert.deepEqual(
    stageIdsInBoardOrder(["uploaded", "todo", "in_review", "uploaded", "queued"]),
    ["todo", "queued", "in_review", "uploaded"],
  );
  assert.throws(() => stageIdsInBoardOrder(["todo", "unknown"]), /unknown stage/);
});
