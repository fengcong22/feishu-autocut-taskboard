import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classifyUnifiedStage,
  groupUnifiedWorkflowItems,
  matchesUnifiedWorkflowMetadataSearch,
  summarizeUnifiedWorkflowArtifacts,
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

test("uploading wins when uploading, failed, and uploaded records coexist", () => {
  assert.equal(classifyUnifiedStage(task("done"), [
    upload("uploaded"),
    upload("failed"),
    upload("uploading"),
  ]), "uploading");
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
  assert.equal(classifyUnifiedStage({
    ...task("done"),
    archivedAt: "2026-09-01T08:00:00.000Z",
  }, [upload("uploading")]), null);
});

test("grouping returns one item in one stage and ignores uploads for other tasks", () => {
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

test("grouping associates verified ZIP summaries only with tasks in the current input scope", () => {
  const currentTask = {
    ...task("done"),
    title: "当前学科视频",
    identifier: "SUB-1",
    feishuOrigin: {
      ...task("done").feishuOrigin,
      packageAlias: "Auto-cut-lite",
    },
  };
  const summaries = [
    {
      id: "artifact-current",
      taskId: currentTask.id,
      filename: "当前学科草稿.zip",
      validationStatus: "verified",
      createdAt: "2026-09-01T08:00:00.000Z",
      updatedAt: "2026-09-01T08:00:00.000Z",
    },
    {
      id: "artifact-other-project",
      taskId: "task-from-another-project",
      filename: "其他学科草稿.zip",
      validationStatus: "verified",
      createdAt: "2026-09-01T08:00:00.000Z",
      updatedAt: "2026-09-01T08:00:00.000Z",
    },
  ];

  const groups = groupUnifiedWorkflowItems([currentTask], [], summaries);
  assert.deepEqual(groups.completed_editing[0].artifacts, [summaries[0]]);
  assert.equal(groups.completed_editing.length, 1);
});

test("metadata search matches verified ZIP filenames and package aliases", () => {
  const currentTask = {
    ...task("done"),
    title: "当前学科视频",
    identifier: "SUB-1",
    feishuOrigin: {
      ...task("done").feishuOrigin,
      packageAlias: "Auto-cut-lite",
    },
  };
  const groups = groupUnifiedWorkflowItems([currentTask], [], [{
    id: "artifact-current",
    taskId: currentTask.id,
    filename: "语文第一课草稿.zip",
    validationStatus: "verified",
    createdAt: "2026-09-01T08:00:00.000Z",
    updatedAt: "2026-09-01T08:00:00.000Z",
  }]);
  const item = groups.completed_editing[0];

  assert.equal(matchesUnifiedWorkflowMetadataSearch(item, "第一课草稿"), true);
  assert.equal(matchesUnifiedWorkflowMetadataSearch(item, "AUTO-CUT-LITE"), true);
  assert.equal(matchesUnifiedWorkflowMetadataSearch(item, "不存在的文件"), false);
});

test("artifact summaries retain unqueued ZIPs when another ZIP is uploaded", () => {
  const artifacts = [
    {
      id: "artifact-uploaded",
      taskId: "task-1",
      filename: "已上传.zip",
      validationStatus: "verified",
      updatedAt: "2026-09-01T08:00:00.000Z",
    },
    {
      id: "artifact-unqueued",
      taskId: "task-1",
      filename: "待上传.zip",
      validationStatus: "verified",
      updatedAt: "2026-09-01T08:01:00.000Z",
    },
  ];
  const groups = groupUnifiedWorkflowItems(
    [task("done")],
    [{ upload: { ...upload("uploaded"), artifactId: "artifact-uploaded" } }],
    artifacts,
  );

  const summary = summarizeUnifiedWorkflowArtifacts(groups.uploaded[0]);
  assert.equal(summary.zipCount, 2);
  assert.deepEqual(summary.unqueuedArtifacts, [artifacts[1]]);
});

test("grouping displays one upload row per artifact using status priority then recency", () => {
  const sharedUpload = (id, status, updatedAt) => ({
    upload: {
      id,
      taskId: "task-1",
      artifactId: "artifact-shared",
      filename: "同一草稿.zip",
      status,
      updatedAt,
    },
  });
  const groups = groupUnifiedWorkflowItems([task("done")], [
    sharedUpload("uploaded-latest", "uploaded", "2026-09-01T08:05:00.000Z"),
    sharedUpload("failed-older", "failed", "2026-09-01T08:01:00.000Z"),
    sharedUpload("failed-newer", "failed", "2026-09-01T08:02:00.000Z"),
    sharedUpload("queued-latest", "queued", "2026-09-01T08:06:00.000Z"),
    {
      upload: {
        id: "other-upload",
        taskId: "task-1",
        artifactId: "artifact-other",
        filename: "另一个草稿.zip",
        status: "uploaded",
        updatedAt: "2026-09-01T08:03:00.000Z",
      },
    },
  ]);

  assert.equal(groups.upload_queue.length, 1);
  assert.deepEqual(
    groups.upload_queue[0].uploads.map((candidate) => candidate.id),
    ["failed-newer", "other-upload"],
  );
  assert.equal(summarizeUnifiedWorkflowArtifacts(groups.upload_queue[0]).zipCount, 2);
});
