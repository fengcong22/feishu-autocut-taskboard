import assert from "node:assert/strict";
import { test } from "node:test";

import { REAL_UNIFIED_WORKFLOW_STAGES } from "../shared/unified-workflow-stages.mjs";
import {
  canDropUnifiedWorkflowTask,
  hasUnifiedWorkflowDragType,
} from "../web/src/unifiedWorkflowDropGuard.mjs";

function feishuTask(projectId, subjectKey, status = "todo", overrides = {}) {
  return {
    id: `${projectId}:${subjectKey}:${status}`,
    projectId,
    status,
    archivedAt: null,
    feishuOrigin: {
      source: "feishu-base",
      subjectKey,
    },
    ...overrides,
  };
}

function ordinaryTask(projectId) {
  return {
    id: `${projectId}:ordinary`,
    projectId,
    status: "todo",
    archivedAt: null,
    feishuOrigin: null,
  };
}

test("only current-subject real tasks can move to visible real stages", () => {
  const base = {
    projectId: "p",
    subjectKey: "b:t",
    visibleStageIds: ["todo", "in_progress"],
    sourceSurface: "unified-board",
  };

  assert.equal(canDropUnifiedWorkflowTask({
    ...base,
    task: feishuTask("p", "b:t"),
    targetStage: "in_progress",
  }), true);
  assert.equal(canDropUnifiedWorkflowTask({
    ...base,
    task: feishuTask("p", "other:t"),
    targetStage: "in_progress",
  }), false);
  assert.equal(canDropUnifiedWorkflowTask({
    ...base,
    task: ordinaryTask("p"),
    targetStage: "in_progress",
  }), false);
  assert.equal(canDropUnifiedWorkflowTask({
    ...base,
    task: feishuTask("p", "b:t"),
    targetStage: "uploaded",
  }), false);
  assert.equal(canDropUnifiedWorkflowTask({
    ...base,
    task: feishuTask("p", "b:t"),
    targetStage: "todo",
    sourceSurface: "other-tasks-panel",
  }), false);
});

test("the unified drop guard rejects archived, canceled, and invalid stages", () => {
  const base = {
    projectId: "p",
    subjectKey: "b:t",
    visibleStageIds: [...REAL_UNIFIED_WORKFLOW_STAGES],
    sourceSurface: "unified-board",
    targetStage: "todo",
  };

  assert.equal(canDropUnifiedWorkflowTask({
    ...base,
    task: feishuTask("p", "b:t", "canceled"),
  }), false);
  assert.equal(canDropUnifiedWorkflowTask({
    ...base,
    task: feishuTask("p", "b:t", "todo", { archivedAt: "2026-09-03T00:00:00.000Z" }),
  }), false);
  assert.equal(canDropUnifiedWorkflowTask({
    ...base,
    task: feishuTask("other", "b:t"),
  }), false);
  assert.equal(canDropUnifiedWorkflowTask({
    ...base,
    task: feishuTask("p", "b:t"),
    visibleStageIds: ["todo"],
    targetStage: "in_progress",
  }), false);
  assert.equal(canDropUnifiedWorkflowTask({
    ...base,
    task: feishuTask("p", "b:t"),
    targetStage: "not-a-stage",
  }), false);
});

test("the unified drag marker is detectable before protected drag data is readable", () => {
  assert.equal(hasUnifiedWorkflowDragType([
    "text/plain",
    "application/x-taskboard-task",
    "application/x-taskboard-unified-workflow-source",
  ]), true);
  assert.equal(hasUnifiedWorkflowDragType(["text/plain"]), false);
  assert.equal(hasUnifiedWorkflowDragType(null), false);
});
