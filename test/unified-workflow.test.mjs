import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classifyUnifiedStage,
  groupUnifiedWorkflowItems,
  UNIFIED_WORKFLOW_STAGES,
} from "../web/src/unifiedWorkflow.mjs";

const task = (status = "done", id = "task-1") => ({
  id,
  status,
  feishuOrigin: { source: "feishu-base", executionMode: "manual" },
});

const upload = (status, taskId = "task-1") => ({
  id: `${status}-${taskId}`,
  taskId,
  artifactId: `${status}-artifact`,
  status,
});

test("upload activity takes precedence over the underlying task status", () => {
  assert.equal(classifyUnifiedStage(task("done"), [upload("uploading")]), "uploading");
  assert.equal(classifyUnifiedStage(task("done"), [upload("queued")]), "upload_queue");
  assert.equal(classifyUnifiedStage(task("done"), [upload("failed")]), "upload_queue");
  assert.equal(classifyUnifiedStage(task("done"), [upload("uploaded")]), "uploaded");
  assert.equal(classifyUnifiedStage(task("done"), []), "completed_editing");
});

test("ordinary active Feishu statuses keep their own stage", () => {
  assert.equal(classifyUnifiedStage(task("todo"), []), "todo");
  assert.equal(classifyUnifiedStage(task("queued"), []), "queued");
  assert.equal(classifyUnifiedStage(task("in_progress"), []), "in_progress");
  assert.equal(classifyUnifiedStage(task("in_review"), []), "in_review");
  assert.equal(classifyUnifiedStage(task("blocked"), []), "blocked");
});

test("non-Feishu and secondary tasks are excluded", () => {
  assert.equal(classifyUnifiedStage({ id: "local", status: "todo" }, []), null);
  assert.equal(classifyUnifiedStage(task("canceled"), []), null);
  assert.equal(classifyUnifiedStage(task("backlog"), []), null);
});

test("grouping returns one item in one stage and ignores uploads for other tasks", () => {
  const groups = groupUnifiedWorkflowItems(
    [task("done"), task("todo", "task-2")],
    [
      { upload: upload("uploaded") },
      { upload: upload("queued", "task-2") },
      { upload: upload("uploading", "not-in-task-list") },
    ],
  );

  assert.deepEqual(Object.keys(groups), UNIFIED_WORKFLOW_STAGES);
  assert.equal(groups.completed_editing.length, 0);
  assert.equal(groups.uploaded.length, 1);
  assert.equal(groups.upload_queue.length, 1);
  assert.equal(groups.todo.length, 0);
  assert.equal(groups.uploaded[0].task.id, "task-1");
  assert.equal(groups.upload_queue[0].task.id, "task-2");
  assert.deepEqual(groups.uploaded[0].uploads, [upload("uploaded")]);
});

test("grouping tolerates malformed upload rows without leaking them into task stages", () => {
  const groups = groupUnifiedWorkflowItems(
    [task("done")],
    [null, {}, { upload: null }, { upload: { taskId: "", status: "uploaded" } }],
  );

  assert.equal(groups.completed_editing.length, 1);
  assert.equal(groups.uploaded.length, 0);
  assert.deepEqual(groups.completed_editing[0].uploads, []);
});
