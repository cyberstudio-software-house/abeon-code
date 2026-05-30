CREATE TABLE IF NOT EXISTS projects (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  path        TEXT NOT NULL UNIQUE,
  claude_dir  TEXT NOT NULL,
  color       TEXT,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS actions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  label       TEXT NOT NULL,
  command     TEXT NOT NULL,
  working_dir TEXT,
  source      TEXT,
  sort_order  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_actions_project ON actions(project_id);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY);
INSERT OR IGNORE INTO schema_version(version) VALUES (1);
