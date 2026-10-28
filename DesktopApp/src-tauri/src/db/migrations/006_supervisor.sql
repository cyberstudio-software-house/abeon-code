CREATE TABLE IF NOT EXISTS supervisor_decisions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER NOT NULL,
  session_id TEXT,
  kind       TEXT NOT NULL,
  question   TEXT NOT NULL,
  decision   TEXT NOT NULL,
  rationale  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_supervisor_decisions_created
  ON supervisor_decisions(created_at DESC);

INSERT OR IGNORE INTO schema_version(version) VALUES (6);
