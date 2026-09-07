import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { TaskboardDatabase } from "../server/database.mjs";

const actor = {
  type: "user",
  id: "local-user",
  name: "Local User",
  avatarUrl: null,
};

async function createFixture(prefix) {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  const filename = path.join(directory, "taskboard.sqlite");
  const database = new TaskboardDatabase(filename);
  return {
    database,
    directory,
    filename,
    async close() {
      this.database.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

function createTask(database, projectId, { feishuOrigin } = {}) {
  return database.createTask({
    projectId,
    title: "Auto-Cut artifact fixture",
    description: "fixture",
    status: "todo",
    priority: "none",
    labels: feishuOrigin ? ["feishu"] : [],
    actor,
    assignee: actor,
    workflowId: null,
    developmentContext: null,
    startDate: null,
    dueDate: null,
    recurrence: null,
    feishuOrigin,
  });
}

function artifactInput(overrides = {}) {
  return {
    id: "artifact-manual",
    storageKey: "private/artifact-manual.zip",
    filename: "draft.zip",
    contentType: "application/zip",
    size: 128,
    sha256: "a".repeat(64),
    sourceMode: "manual_select",
    validationStatus: "verified",
    entryCount: 2,
    draftRoot: "draft",
    createdAt: "2026-09-05T08:00:00.000Z",
    updatedAt: "2026-09-05T08:00:00.000Z",
    actor,
    ...overrides,
  };
}

function createSubject(database, {
  projectId,
  subjectKey = "base-artifact:table-artifact",
  config = {},
}) {
  const [baseToken, tableId] = subjectKey.split(":");
  const timestamp = "2026-09-05T08:00:00.000Z";
  database.database.prepare(`
    INSERT INTO feishu_bases (
      base_token, base_name, source_url_label, metadata_refreshed_at, created_at, updated_at
    ) VALUES (?, ?, NULL, NULL, ?, ?)
  `).run(baseToken, "Artifact Base", timestamp, timestamp);
  database.database.prepare(`
    INSERT INTO feishu_subjects (
      subject_key, base_token, table_id, table_name, project_id, display_enabled,
      lifecycle, config_version, config_json, metadata_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 1, 'enabled', 1, ?, '{}', ?, ?)
  `).run(
    subjectKey,
    baseToken,
    tableId,
    "Artifact Subject",
    projectId,
    JSON.stringify(config),
    timestamp,
    timestamp,
  );
  database.database.prepare(`
    INSERT INTO feishu_subject_versions (subject_key, version, snapshot_json, created_at)
    VALUES (?, 1, ?, ?)
  `).run(subjectKey, JSON.stringify(config), timestamp);
  return { baseToken, tableId, subjectKey };
}

function replaceTaskArtifactsWithLegacySchema(filename) {
  const database = new DatabaseSync(filename);
  try {
    database.exec(`
      PRAGMA foreign_keys = OFF;
      BEGIN IMMEDIATE;

      DROP INDEX IF EXISTS task_artifacts_run;

      CREATE TABLE task_artifacts_legacy (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        storage_key TEXT NOT NULL UNIQUE,
        filename TEXT NOT NULL,
        content_type TEXT NOT NULL,
        size INTEGER NOT NULL CHECK (size >= 0),
        sha256 TEXT NOT NULL,
        source_mode TEXT NOT NULL CHECK (source_mode = 'manual_select'),
        validation_status TEXT NOT NULL CHECK (validation_status = 'verified'),
        entry_count INTEGER NOT NULL CHECK (entry_count > 0),
        draft_root TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      INSERT INTO task_artifacts_legacy (
        id, task_id, storage_key, filename, content_type, size, sha256, source_mode,
        validation_status, entry_count, draft_root, created_at, updated_at
      )
      SELECT
        id, task_id, storage_key, filename, content_type, size, sha256, source_mode,
        validation_status, entry_count, draft_root, created_at, updated_at
      FROM task_artifacts;

      DROP TABLE task_artifacts;
      ALTER TABLE task_artifacts_legacy RENAME TO task_artifacts;
      CREATE INDEX task_artifacts_task_created
        ON task_artifacts(task_id, created_at, id);

      COMMIT;
      PRAGMA foreign_keys = ON;
    `);
  } finally {
    database.close();
  }
}

test("migrates legacy task artifacts without losing manual artifacts or upload references", async () => {
  const fixture = await createFixture("taskboard-artifact-migration-");
  try {
    fixture.database.createProject({
      id: "artifact-project",
      name: "Artifact Project",
      workspacePath: fixture.directory,
    });
    const subject = createSubject(fixture.database, {
      projectId: "artifact-project",
    });
    const task = createTask(fixture.database, "artifact-project");
    const artifact = fixture.database.createTaskArtifact(task.id, artifactInput());
    const upload = fixture.database.createArtifactUpload({
      taskId: task.id,
      artifactId: artifact.id,
      subjectKey: subject.subjectKey,
      storageKey: "private/artifact-manual.zip",
      targetId: "target-1",
      targetPath: path.join(fixture.directory, "uploads"),
      filename: artifact.filename,
      sha256: artifact.sha256,
      uploadConcurrency: 1,
    });

    fixture.database.close();
    replaceTaskArtifactsWithLegacySchema(fixture.filename);
    fixture.database = new TaskboardDatabase(fixture.filename);

    assert.deepEqual(
      fixture.database.listTaskArtifacts(task.id).map(({ sourceMode, runId }) => ({ sourceMode, runId })),
      [{ sourceMode: "manual_select", runId: null }],
    );
    assert.equal(fixture.database.getArtifactUpload(upload.id).artifactId, artifact.id);
    assert.equal(fixture.database.database.prepare("PRAGMA foreign_key_check").get(), undefined);
    assert.match(fixture.database.database.prepare(
      "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'task_artifacts'",
    ).get().sql, /driver_report/u);
    assert.ok(fixture.database.database.prepare("PRAGMA table_info(task_artifacts)").all()
      .some(({ name }) => name === "run_id"));
    assert.ok(fixture.database.database.prepare(
      "SELECT 1 FROM sqlite_schema WHERE type = 'index' AND name = 'task_artifacts_run'",
    ).get());
  } finally {
    await fixture.close();
  }
});

test("binds one idempotent driver-report artifact to an active task run", async () => {
  const fixture = await createFixture("taskboard-run-artifact-");
  try {
    fixture.database.createProject({
      id: "auto-cut-project",
      name: "Auto-Cut Project",
      workspacePath: fixture.directory,
    });
    const task = createTask(fixture.database, "auto-cut-project", {
      feishuOrigin: {
        version: 1,
        source: "feishu-base",
        eventId: "event-artifact",
        baseToken: "base-artifact",
        tableId: "table-artifact",
        subjectKey: "base-artifact:table-artifact",
        recordId: "record-artifact",
        mode: "automatic",
        executionMode: "automatic",
      },
    });
    const thread = fixture.database.createAiChatThread({
      id: "thread-artifact",
      title: "Auto-Cut run",
      status: "idle",
      origin: {
        projectId: task.projectId,
        projectName: "Auto-Cut Project",
        workspacePath: fixture.directory,
        issueId: task.id,
        issueIdentifier: task.identifier,
      },
      codexThreadId: null,
      model: "gpt-test",
      reasoningEffort: "medium",
      sandbox: "workspace-write",
    });
    const claimed = fixture.database.claimTaskForAiStart(task.id, task.version, actor);
    fixture.database.bindTaskAiStart(
      task.id,
      claimed.claimToken,
      claimed.version,
      thread.id,
      actor,
    );
    const run = fixture.database.createAiChatRun({
      id: "run-artifact",
      threadId: thread.id,
      status: "running",
    });
    fixture.database.bindTaskAiStartRun(task.id, claimed.claimToken, thread.id, run.id);

    assert.deepEqual(
      fixture.database.getTaskAiStartForArtifactReport(task.id, run.id),
      {
        taskId: task.id,
        threadId: thread.id,
        runId: run.id,
        claimToken: claimed.claimToken,
      },
    );

    const report = artifactInput({
      id: "artifact-driver",
      storageKey: "private/artifact-driver.zip",
      sourceMode: "driver_report",
      runId: run.id,
      requiredRunClaim: { runId: run.id, claimToken: claimed.claimToken },
      requiredTaskStatus: "in_progress",
      completedTaskStatus: null,
    });
    const artifact = fixture.database.createTaskArtifact(task.id, report);
    assert.equal(artifact.runId, run.id);
    assert.deepEqual(fixture.database.getTaskArtifactForRun(task.id, run.id), artifact);

    const duplicate = fixture.database.createTaskArtifact(task.id, {
      ...report,
      id: "artifact-driver-duplicate",
      storageKey: "private/artifact-driver-duplicate.zip",
    });
    assert.equal(duplicate.id, artifact.id);
    assert.equal(fixture.database.listTaskArtifacts(task.id).length, 1);

    assert.throws(
      () => fixture.database.createTaskArtifact(task.id, {
        ...report,
        id: "artifact-driver-conflict",
        storageKey: "private/artifact-driver-conflict.zip",
        sha256: "b".repeat(64),
      }),
      (error) => error?.code === "ARTIFACT_RUN_CONFLICT",
    );
    assert.throws(
      () => fixture.database.createTaskArtifact(task.id, {
        ...report,
        id: "artifact-driver-wrong-claim",
        storageKey: "private/artifact-driver-wrong-claim.zip",
        requiredRunClaim: { runId: run.id, claimToken: "wrong-claim" },
      }),
      (error) => error?.code === "TASK_START_STATE_CHANGED",
    );
  } finally {
    await fixture.close();
  }
});

test("returns the snapshotted artifact source policy from every subject upload reader", async () => {
  const fixture = await createFixture("taskboard-artifact-policy-");
  try {
    fixture.database.createProject({
      id: "subject-project",
      name: "Subject Project",
      workspacePath: fixture.directory,
    });
    const sourcePath = path.join(fixture.directory, "accepted-zips");
    const config = {
      upload: {
        enqueueMode: "automatic",
        artifactSourceMode: "driver_report",
        artifactSourcePath: `  ${sourcePath}  `,
        targetId: "target-1",
        targetPath: path.join(fixture.directory, "uploads"),
        uploadConcurrency: 2,
      },
    };
    const subject = createSubject(fixture.database, {
      projectId: "subject-project",
      config,
    });
    const expected = {
      subjectKey: subject.subjectKey,
      enqueueMode: "automatic",
      artifactSourceMode: "driver_report",
      artifactSourcePath: sourcePath,
      targetId: "target-1",
      targetPath: path.join(fixture.directory, "uploads"),
      uploadConcurrency: 2,
    };

    assert.deepEqual(fixture.database.getFeishuSubjectUploadTarget("subject-project"), expected);
    assert.deepEqual(
      fixture.database.getFeishuSubjectUploadTargetByOrigin(subject.baseToken, subject.tableId),
      expected,
    );
    assert.deepEqual(
      fixture.database.getFeishuSubjectUploadTargetByVersion(subject.subjectKey, 1),
      expected,
    );
  } finally {
    await fixture.close();
  }
});
