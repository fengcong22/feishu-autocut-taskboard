import assert from "node:assert/strict";
import { test } from "node:test";
import {
  artifactIdentity,
  filterVerifiedUnifiedArtifacts,
  groupUnifiedWorkflowItems,
  projectUnifiedWorkflowGroups,
  summarizeHiddenUnifiedWorkflow,
  summarizeUnifiedWorkflowArtifacts,
  unifiedWorkflowZipEntries,
} from "../web/src/unifiedWorkflow.mjs";

function feishuTask(id, status = "todo", subjectKey = "base-a:table-a") {
  return {
    id,
    identifier: id,
    projectId: `feishu-${subjectKey}`,
    title: id,
    description: "",
    status,
    priority: "none",
    labels: [],
    conversationRefs: [],
    archivedAt: null,
    feishuOrigin: {
      source: "feishu-base",
      subjectKey,
      eventId: `event-${id}`,
      baseToken: subjectKey.split(":")[0],
      tableId: subjectKey.split(":")[1],
      recordId: `record-${id}`,
    },
  };
}

function item(stage, id, { failed = false, subjectKey = "base-a:table-a" } = {}) {
  const task = feishuTask(id, stage === "completed_editing" ? "done" : "todo", subjectKey);
  const upload = stage === "uploading"
    ? { id: `${id}-uploading`, taskId: task.id, artifactId: `${id}-artifact`, status: "uploading", updatedAt: "2026-01-02T00:00:00.000Z" }
    : stage === "upload_queue"
      ? { id: `${id}-queue`, taskId: task.id, artifactId: `${id}-artifact`, status: failed ? "failed" : "queued", updatedAt: "2026-01-02T00:00:00.000Z" }
      : stage === "uploaded"
        ? { id: `${id}-uploaded`, taskId: task.id, artifactId: `${id}-artifact`, status: "uploaded", updatedAt: "2026-01-02T00:00:00.000Z" }
        : null;
  return {
    task,
    uploads: upload ? [upload] : [],
    artifacts: upload ? [{ id: `${id}-artifact`, taskId: task.id, filename: `${id}.zip`, validationStatus: "verified", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }] : [],
    stage,
  };
}

function groupsFor(items) {
  return Object.fromEntries([
    "todo",
    "queued",
    "in_progress",
    "blocked",
    "in_review",
    "completed_editing",
    "upload_queue",
    "uploading",
    "uploaded",
  ].map((stage) => [stage, items.filter((entry) => entry.stage === stage)]));
}

test("projects only valid configured workflow stages in requested order", () => {
  const groups = {
    todo: [{ id: "ready" }],
    in_progress: [{ id: "running" }],
    uploaded: [{ id: "finished" }],
  };

  const projected = projectUnifiedWorkflowGroups(
    groups,
    ["uploaded", "unknown", "todo", "uploaded"],
  );

  assert.deepEqual(Object.keys(projected), ["uploaded", "todo"]);
  assert.deepEqual(projected.uploaded, groups.uploaded);
  assert.deepEqual(projected.todo, groups.todo);
  assert.equal(projected.in_progress, undefined);
});

test("hidden summaries are computed after task filters and before view projection", () => {
  const groups = groupsFor([
    item("in_progress", "task-visible"),
    item("uploading", "task-hidden"),
    item("upload_queue", "task-hidden-2", { failed: true }),
  ]);
  assert.deepEqual(summarizeHiddenUnifiedWorkflow(groups, ["in_progress"]), {
    taskCount: 2,
    zipCount: 2,
    failedUploadCount: 1,
    status: "ready",
  });
});

test("hidden summaries report syncing instead of inventing zeroes while data is unavailable", () => {
  const groups = groupsFor([]);
  assert.deepEqual(summarizeHiddenUnifiedWorkflow(groups, ["in_progress"], { loading: true }), {
    taskCount: 0,
    zipCount: 0,
    failedUploadCount: 0,
    status: "syncing",
  });
  assert.deepEqual(summarizeHiddenUnifiedWorkflow(groups, ["in_progress"], { error: { code: "NETWORK" } }), {
    taskCount: 0,
    zipCount: 0,
    failedUploadCount: 0,
    status: "syncing",
  });
  assert.equal(
    summarizeHiddenUnifiedWorkflow(groups, ["in_progress"], { uploadLoading: true }).status,
    "syncing",
  );
  assert.equal(
    summarizeHiddenUnifiedWorkflow(groups, ["in_progress"], { uploadError: "UPLOAD_COPY_FAILED" }).status,
    "syncing",
  );
});

test("ZIP entries keep each verified ZIP independently addressable", () => {
  const entries = unifiedWorkflowZipEntries({
    artifacts: [
      { id: "artifact-one", filename: "one.zip", validationStatus: "verified" },
      { id: "artifact-two", filename: "two.zip", validationStatus: "verified" },
      { id: "invalid-artifact", filename: "invalid.zip", validationStatus: "invalid" },
    ],
    uploads: [
      { id: "upload-one", artifactId: "artifact-one", filename: "one.zip", status: "uploaded" },
      { id: "upload-standalone", filename: "standalone.zip", status: "queued" },
    ],
  });

  assert.deepEqual(entries.map((entry) => ({
    identity: entry.identity,
    artifactId: entry.artifact?.id ?? null,
    uploadId: entry.upload?.id ?? null,
  })), [
    { identity: "artifact:artifact-one", artifactId: "artifact-one", uploadId: "upload-one" },
    { identity: "artifact:artifact-two", artifactId: "artifact-two", uploadId: null },
    { identity: "upload:upload-standalone", artifactId: null, uploadId: "upload-standalone" },
  ]);
});

test("artifact identity uses the fixed fallback order", () => {
  assert.equal(artifactIdentity({
    artifactId: "a", id: "u", filename: "one.zip", createdAt: "2026-01-01",
  }), "artifact:a");
  assert.equal(artifactIdentity({
    id: "u", filename: "one.zip", createdAt: "2026-01-01",
  }), "upload:u");
  assert.equal(artifactIdentity({
    filename: " One.ZIP ", createdAt: "2026-01-01",
  }), "file:one.zip:2026-01-01");
});

test("unverified artifacts never contribute to upload counts", () => {
  const task = feishuTask("task-1", "done");
  const grouped = groupUnifiedWorkflowItems(
    [task],
    [],
    [{ id: "bad", taskId: task.id, filename: "bad.zip", validationStatus: "invalid", createdAt: "2026-01-01", updatedAt: "2026-01-01" }],
  );
  assert.equal(summarizeUnifiedWorkflowArtifacts(grouped.completed_editing[0]).zipCount, 0);
  assert.deepEqual(filterVerifiedUnifiedArtifacts(grouped.completed_editing[0].artifacts), []);
});

test("verified artifacts without a stable id do not inflate ZIP counts", () => {
  const task = feishuTask("task-without-artifact-id", "done");
  const grouped = groupUnifiedWorkflowItems(
    [task],
    [],
    [{ id: "", taskId: task.id, filename: "malformed.zip", validationStatus: "verified" }],
  );
  assert.equal(summarizeUnifiedWorkflowArtifacts(grouped.completed_editing[0]).zipCount, 0);
  assert.deepEqual(
    summarizeHiddenUnifiedWorkflow(grouped, []).zipCount,
    0,
  );
});

test("projection preserves requested order and never crosses subject groups", () => {
  const visibleTask = feishuTask("visible", "in_progress", "base-a:table-a");
  const foreignTask = feishuTask("other-subject", "todo", "base-b:table-b");
  const groups = groupUnifiedWorkflowItems(
    [visibleTask],
    [],
    [{
      id: "foreign-artifact",
      taskId: foreignTask.id,
      filename: "foreign.zip",
      validationStatus: "verified",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }],
  );
  const projected = projectUnifiedWorkflowGroups(groups, ["in_progress", "todo"]);
  assert.deepEqual(Object.keys(projected), ["in_progress", "todo"]);
  assert.deepEqual(projected.in_progress.map(({ task }) => task.id), ["visible"]);
  assert.deepEqual(projected.todo.map(({ task }) => task.id), []);
  assert.equal(projected.in_progress[0].artifacts.length, 0);
});
