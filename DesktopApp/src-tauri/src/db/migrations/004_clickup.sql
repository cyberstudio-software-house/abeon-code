CREATE TABLE IF NOT EXISTS clickup_project_config (
  project_id   INTEGER PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL,
  space_id     TEXT,
  list_id      TEXT
);

CREATE TABLE IF NOT EXISTS clickup_links (
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id    TEXT NOT NULL,
  custom_id  TEXT,
  name       TEXT NOT NULL,
  status     TEXT,
  url        TEXT NOT NULL,
  linked_at  INTEGER NOT NULL,
  PRIMARY KEY (project_id, task_id)
);
CREATE INDEX IF NOT EXISTS idx_clickup_links_project ON clickup_links(project_id);

INSERT OR IGNORE INTO schema_version(version) VALUES (4);
