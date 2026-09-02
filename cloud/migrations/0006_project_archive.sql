ALTER TABLE projects ADD COLUMN archived_at TEXT;
ALTER TABLE projects ADD COLUMN source TEXT NOT NULL DEFAULT 'local' CHECK (source IN ('global', 'local', 'feishu'));
UPDATE projects SET source = 'global' WHERE id = 'local';
CREATE INDEX IF NOT EXISTS projects_archived_created
  ON projects(archived_at, created_at, id);
