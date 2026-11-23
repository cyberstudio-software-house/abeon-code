CREATE TABLE IF NOT EXISTS deploy_flows (
  repo_path         TEXT PRIMARY KEY,
  enabled           INTEGER NOT NULL DEFAULT 1,
  remote            TEXT NOT NULL,
  build             TEXT NOT NULL,
  build_repo        TEXT NOT NULL,
  production_branch TEXT NOT NULL,
  delivery          TEXT NOT NULL,
  namespace         TEXT NOT NULL,
  workloads         TEXT NOT NULL,
  kube_context      TEXT,
  updated_at        INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS deploy_trackings (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_path   TEXT NOT NULL,
  commit_sha  TEXT NOT NULL,
  state       TEXT NOT NULL,
  started_at  INTEGER NOT NULL,
  finished_at INTEGER,
  dismissed   INTEGER NOT NULL DEFAULT 0,
  body        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_deploy_trackings_repo
  ON deploy_trackings(repo_path);

CREATE TABLE IF NOT EXISTS deploy_flow_proposals (
  id         TEXT PRIMARY KEY,
  repo_path  TEXT NOT NULL UNIQUE,
  body       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO schema_version(version) VALUES (8);
