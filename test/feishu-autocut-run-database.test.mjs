import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { TaskboardDatabase } from "../server/database.mjs";

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-autocut-runs-"));
  const database = new TaskboardDatabase(path.join(directory, "taskboard.sqlite"));
  const project = database.createProject({ id: "project-1", name: "测试项目", workspacePath: null });
  const task = database.createTask({
    id: "task-1",
    projectId: project.id,
    title: "Auto-Cut 测试任务",
    description: "",
    status: "todo",
    priority: "none",
    labels: [],
    actor: { type: "user", id: "tester", name: "测试者", avatarUrl: null },
    assignee: { type: "user", id: "tester", name: "测试者", avatarUrl: null },
    startDate: null,
    dueDate: null,
  });
  return { directory, database, task };
}

test("persists immutable Auto-Cut run bindings and ordered attempts", async () => {
  const { directory, database, task } = await fixture();
  try {
    const first = database.createFeishuAutoCutRun({
      runId: "run-1",
      taskId: task.id,
      subjectKey: "bas_demo:tbl_subject",
      configVersion: 7,
      stageId: "initial",
      eventId: "event-1",
      manifestPath: "C:\\private\\run-1\\source-manifest.json",
      manifestSha256: "a".repeat(64),
      executionInputPath: "C:\\private\\run-1\\execution_input.json",
      resultPath: "C:\\private\\run-1\\result.json",
      attempt: 1,
    });
    assert.equal(first.state, "preparing");
    assert.equal(first.attempt, 1);
    const second = database.createFeishuAutoCutRun({
      ...first,
      runId: "run-2",
      manifestPath: "C:\\private\\run-2\\source-manifest.json",
      executionInputPath: "C:\\private\\run-2\\execution_input.json",
      resultPath: "C:\\private\\run-2\\result.json",
      attempt: 2,
    });
    assert.deepEqual(database.listFeishuAutoCutRuns(task.id).map((entry) => entry.attempt), [1, 2]);
    const updated = database.updateFeishuAutoCutRun("run-1", {
      state: "blocked",
      errorCode: "docx_anchor_missing",
      errorMessage: "素材目录不存在",
    });
    assert.equal(updated.state, "blocked");
    assert.equal(database.getFeishuAutoCutRun("run-1").errorCode, "docx_anchor_missing");
    assert.equal(second.runId, "run-2");
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("run state updates reject a binding change", async () => {
  const { directory, database, task } = await fixture();
  try {
    database.createFeishuAutoCutRun({
      runId: "run-1",
      taskId: task.id,
      subjectKey: "bas_demo:tbl_subject",
      configVersion: 7,
      stageId: "initial",
      eventId: "event-1",
      manifestPath: "C:\\private\\run-1\\source-manifest.json",
      manifestSha256: "b".repeat(64),
      executionInputPath: "C:\\private\\run-1\\execution_input.json",
      resultPath: "C:\\private\\run-1\\result.json",
      attempt: 1,
    });
    assert.throws(
      () => database.updateFeishuAutoCutRun("run-1", { stageId: "final_review" }),
      /immutable|binding/i,
    );
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});
