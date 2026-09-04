CREATE TABLE IF NOT EXISTS workflow_workspaces (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  workspace TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS workflow_workspaces_revision_insert
AFTER INSERT ON workflow_workspaces
BEGIN
  UPDATE global_revision SET revision = revision + 1 WHERE singleton = 1;
END;

CREATE TRIGGER IF NOT EXISTS workflow_workspaces_revision_update
AFTER UPDATE ON workflow_workspaces
BEGIN
  UPDATE global_revision SET revision = revision + 1 WHERE singleton = 1;
END;

CREATE TRIGGER IF NOT EXISTS workflow_workspaces_revision_delete
AFTER DELETE ON workflow_workspaces
BEGIN
  UPDATE global_revision SET revision = revision + 1 WHERE singleton = 1;
END;
