import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { TaskboardDatabase } from "../server/database.mjs";

test("queued status migration preserves task identity and removes legacy workflow fields", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-status-migration-"));
  const filename = path.join(directory, "taskboard.sqlite");
  const legacy = new DatabaseSync(filename);
  legacy.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      workspace_path TEXT,
      next_task_number INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      identifier TEXT NOT NULL UNIQUE,
      project_id TEXT NOT NULL REFERENCES projects(id),
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL CHECK (status IN ('backlog', 'todo', 'in_progress', 'in_review', 'blocked', 'done', 'canceled')),
      priority TEXT NOT NULL CHECK (priority IN ('none', 'urgent', 'high', 'medium', 'low')),
      labels TEXT NOT NULL DEFAULT '[]',
      sort_order REAL NOT NULL,
      thread_id TEXT,
      creator_type TEXT NOT NULL,
      creator_id TEXT NOT NULL,
      creator_name TEXT NOT NULL,
      creator_avatar_url TEXT,
      assignee_type TEXT NOT NULL CHECK (assignee_type IN ('user', 'agent')),
      assignee_id TEXT NOT NULL,
      assignee_name TEXT NOT NULL,
      assignee_avatar_url TEXT,
      workflow_id TEXT,
      git_branch TEXT,
      worktree_path TEXT,
      worktree_branch TEXT,
      start_date TEXT,
      due_date TEXT,
      recurrence_interval INTEGER,
      recurrence_unit TEXT,
      archived_at TEXT,
      version INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO projects VALUES ('project-1', 'Project 1', NULL, 2, '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z');
    INSERT INTO tasks VALUES (
      'task-1', 'PROJECT-1', 'project-1', 'Preserve fields', '', 'todo', 'high', '["feishu"]', 1000,
      'thread-1', 'agent', 'creator-1', 'Original Creator', 'creator.png',
      'user', 'assignee-1', 'Original Assignee', 'assignee.png', 'workflow-1',
      'branch-1', '/workspace/project', 'branch-worktree', '2026-08-02', '2026-08-03',
      2, 'week', NULL, 4, '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z'
    );
  `);
  legacy.close();

  const database = new TaskboardDatabase(filename);
  try {
    const task = database.getTask("task-1");
    assert.equal(task.creatorType, "agent");
    assert.equal(task.creatorId, "creator-1");
    assert.equal(task.creatorName, "Original Creator");
    assert.equal(task.creatorAvatarUrl, "creator.png");
    assert.deepEqual(task.assignee, {
      type: "user",
      id: "assignee-1",
      name: "Original Assignee",
      avatarUrl: "assignee.png",
    });
    assert.equal(task.workflowId, undefined);
    assert.equal(
      database.database
        .prepare("SELECT 1 FROM pragma_table_info('tasks') WHERE name = 'workflow_id'")
        .get(),
      undefined,
    );
    assert.ok(
      database.database
        .prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'workflow_workspaces'")
        .get(),
    );
    assert.equal(database.database.prepare("SELECT status FROM tasks WHERE id = 'task-1'").get().status, "todo");
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});
