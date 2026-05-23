CREATE TABLE IF NOT EXISTS session_titles (
  project_id  INTEGER NOT NULL,
  session_id  TEXT NOT NULL,
  title       TEXT NOT NULL,
  PRIMARY KEY (project_id, session_id)
);

INSERT OR IGNORE INTO schema_version(version) VALUES (2);
