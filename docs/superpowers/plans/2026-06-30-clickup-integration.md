# ClickUp Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a ClickUp integration to the AbeonCode DesktopApp: connect via a personal token, link tasks per project, read task content via a gitignored file handle, generate a work summary posted as a ClickUp comment, and (final phase) write a work-time estimate to the task.

**Architecture:** All ClickUp REST calls live Rust-side in a `ClickUpClient` (reqwest, bearer token) behind a `commands/clickup.rs` IPC surface; the token is stored in the SQLite `settings` table and never crosses to JS. Per-project state (scope config + linked tasks) lives in two new SQLite tables. The React renderer adds a settings tab, a right-panel section, and four dialogs, talking only through typed `tauri.clickup*` wrappers.

**Tech Stack:** Rust (Tauri 2, rusqlite, reqwest 0.12 rustls, tokio, ts-rs, wiremock), TypeScript/React 19, Zustand 5, Tailwind 4, Vitest.

## Global Constraints

- **Identifiers in English only; user-facing UI text in Polish** (project rule).
- **No code comments unless WHY is non-obvious** — match surrounding code.
- **Commits**: Conventional Commits 1.0.0, scope `clickup` (e.g. `feat(clickup): ...`). No co-author trailer.
- **Secrets never reach JS**: the ClickUp token is read/written only by Rust via `settings_repo`; its key `clickupApiToken` is NOT added to `PERSISTED_KEYS` and NOT added to `settingsSlice`.
- **IPC contract**: every Rust `#[tauri::command]` is registered in `lib.rs` `generate_handler!` AND gets a typed wrapper in `src/lib/tauri.ts` (args camelCase).
- **ts-rs types**: `#[derive(TS)] #[ts(export, export_to = "../../src/types/")] #[serde(rename_all = "camelCase")]`; `i64` fields need `#[ts(type = "number")]`. Run `cargo test` once after adding to materialize `src/types/*.ts`.
- **Network commands** are `pub async fn (state: State<'_, AppState>, ...) -> AppResult<T>`.
- **ClickUp REST base**: `https://api.clickup.com/api/v2`. Auth header: `Authorization: <token>` (ClickUp personal tokens are sent as the raw `Authorization` value, NOT `Bearer`).
- **Lint must be clean**: `npm run lint` (= `tsc -b --noEmit`) reports zero errors. Backend: `npm run test:rust`; frontend: `npm test`.
- Run all `npm`/`cargo` commands from `DesktopApp/`.

---

## Phase 1 — Connection foundation

Outcome: configure a ClickUp token in settings, verify the connection, and have the data layer (migration + repos + types) in place.

### Task 1: SQLite migration 004 + project-config repo

**Files:**
- Create: `DesktopApp/src-tauri/src/db/migrations/004_clickup.sql`
- Create: `DesktopApp/src-tauri/src/db/clickup_config_repo.rs`
- Modify: `DesktopApp/src-tauri/src/db/mod.rs:8-15` (add `pub mod` + `MIGRATION_004` + gate)
- Test: inline `#[cfg(test)]` in `clickup_config_repo.rs`

**Interfaces:**
- Produces: `clickup_config_repo::{get(conn, project_id) -> AppResult<Option<ClickUpProjectConfig>>, set(conn, project_id, workspace_id, space_id, list_id) -> AppResult<()>}` where `space_id`/`list_id` are `Option<&str>`. Depends on `domain::clickup::ClickUpProjectConfig` from Task 3 — define the repo to build that struct (create Task 3's type first if implementing strictly in order, or use a local tuple until Task 3; this plan assumes Task 3's type exists, so do Task 3 before wiring the repo's return type).

> Implementation note: Task 3 (domain types) and this task are mutually referenced. Implement Task 3's `ClickUpProjectConfig` struct first (it is pure data), then this repo. The steps below assume `crate::domain::clickup::ClickUpProjectConfig` exists.

- [ ] **Step 1: Write the migration SQL**

Create `DesktopApp/src-tauri/src/db/migrations/004_clickup.sql`:

```sql
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
```

- [ ] **Step 2: Wire the migration in `db/mod.rs`**

In `DesktopApp/src-tauri/src/db/mod.rs`, add to the `pub mod` block (after line 11):

```rust
pub mod clickup_config_repo;
pub mod clickup_links_repo;
```

Add after line 15:

```rust
const MIGRATION_004: &str = include_str!("migrations/004_clickup.sql");
```

In `run_migrations`, after the `if v < 3` line:

```rust
    if v < 4 { conn.execute_batch(MIGRATION_004)?; }
```

- [ ] **Step 3: Write the failing repo test**

Create `DesktopApp/src-tauri/src/db/clickup_config_repo.rs` with ONLY the test module first:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{init_pool, projects_repo};
    use tempfile::NamedTempFile;

    #[test]
    fn config_upsert_round_trip() {
        let f = NamedTempFile::new().unwrap();
        let pool = init_pool(&f.path().to_path_buf()).unwrap();
        let c = pool.get().unwrap();
        let p = projects_repo::insert(&c, "X", "/x", "-x", None).unwrap();

        assert!(get(&c, p.id).unwrap().is_none());

        set(&c, p.id, "ws1", Some("sp1"), None).unwrap();
        let cfg = get(&c, p.id).unwrap().unwrap();
        assert_eq!(cfg.workspace_id, "ws1");
        assert_eq!(cfg.space_id.as_deref(), Some("sp1"));
        assert_eq!(cfg.list_id, None);

        set(&c, p.id, "ws1", Some("sp1"), Some("li9")).unwrap();
        assert_eq!(get(&c, p.id).unwrap().unwrap().list_id.as_deref(), Some("li9"));
    }
}
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `cd DesktopApp && cargo test --manifest-path src-tauri/Cargo.toml clickup_config_repo`
Expected: FAIL — `get`/`set` not found (and `clickup_links_repo` module missing; create an empty `clickup_links_repo.rs` placeholder file to compile, replaced in Task 2).

- [ ] **Step 5: Implement the repo**

Prepend to `clickup_config_repo.rs` (above the test module):

```rust
use rusqlite::{params, Connection};
use crate::domain::clickup::ClickUpProjectConfig;
use crate::error::AppResult;

pub fn get(conn: &Connection, project_id: i64) -> AppResult<Option<ClickUpProjectConfig>> {
    let mut stmt = conn.prepare(
        "SELECT project_id, workspace_id, space_id, list_id
         FROM clickup_project_config WHERE project_id = ?",
    )?;
    let mut rows = stmt.query(params![project_id])?;
    match rows.next()? {
        Some(r) => Ok(Some(ClickUpProjectConfig {
            project_id: r.get(0)?,
            workspace_id: r.get(1)?,
            space_id: r.get(2)?,
            list_id: r.get(3)?,
        })),
        None => Ok(None),
    }
}

pub fn set(
    conn: &Connection,
    project_id: i64,
    workspace_id: &str,
    space_id: Option<&str>,
    list_id: Option<&str>,
) -> AppResult<()> {
    conn.execute(
        "INSERT INTO clickup_project_config(project_id, workspace_id, space_id, list_id)
         VALUES(?,?,?,?)
         ON CONFLICT(project_id) DO UPDATE SET
           workspace_id = excluded.workspace_id,
           space_id     = excluded.space_id,
           list_id      = excluded.list_id",
        params![project_id, workspace_id, space_id, list_id],
    )?;
    Ok(())
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd DesktopApp && cargo test --manifest-path src-tauri/Cargo.toml clickup_config_repo`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add DesktopApp/src-tauri/src/db/migrations/004_clickup.sql DesktopApp/src-tauri/src/db/mod.rs DesktopApp/src-tauri/src/db/clickup_config_repo.rs DesktopApp/src-tauri/src/db/clickup_links_repo.rs
git commit -m "feat(clickup): add migration 004 and project-config repo"
```

### Task 2: Linked-tasks repo

**Files:**
- Modify: `DesktopApp/src-tauri/src/db/clickup_links_repo.rs` (replace placeholder)
- Test: inline `#[cfg(test)]`

**Interfaces:**
- Consumes: `domain::clickup::ClickUpLink` (Task 3).
- Produces: `clickup_links_repo::{list(conn, project_id) -> AppResult<Vec<ClickUpLink>>, get(conn, project_id, task_id) -> AppResult<Option<ClickUpLink>>, upsert(conn, &ClickUpLink) -> AppResult<()>, delete(conn, project_id, task_id) -> AppResult<()>}`.

- [ ] **Step 1: Write the failing test**

Replace `clickup_links_repo.rs` test module with:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{init_pool, projects_repo};
    use crate::domain::clickup::ClickUpLink;
    use tempfile::NamedTempFile;

    fn link(project_id: i64, task_id: &str, name: &str) -> ClickUpLink {
        ClickUpLink {
            project_id,
            task_id: task_id.into(),
            custom_id: Some("CU-1".into()),
            name: name.into(),
            status: Some("open".into()),
            url: "https://app.clickup.com/t/abc".into(),
            linked_at: 1_700_000_000_000,
        }
    }

    #[test]
    fn links_crud() {
        let f = NamedTempFile::new().unwrap();
        let pool = init_pool(&f.path().to_path_buf()).unwrap();
        let c = pool.get().unwrap();
        let p = projects_repo::insert(&c, "X", "/x", "-x", None).unwrap();

        assert_eq!(list(&c, p.id).unwrap().len(), 0);
        upsert(&c, &link(p.id, "abc", "Task A")).unwrap();
        upsert(&c, &link(p.id, "abc", "Task A renamed")).unwrap();
        assert_eq!(list(&c, p.id).unwrap().len(), 1);
        assert_eq!(get(&c, p.id, "abc").unwrap().unwrap().name, "Task A renamed");

        delete(&c, p.id, "abc").unwrap();
        assert_eq!(list(&c, p.id).unwrap().len(), 0);
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd DesktopApp && cargo test --manifest-path src-tauri/Cargo.toml clickup_links_repo`
Expected: FAIL — functions not found.

- [ ] **Step 3: Implement the repo**

Prepend to `clickup_links_repo.rs`:

```rust
use rusqlite::{params, Connection};
use crate::domain::clickup::ClickUpLink;
use crate::error::AppResult;

fn row(r: &rusqlite::Row) -> rusqlite::Result<ClickUpLink> {
    Ok(ClickUpLink {
        project_id: r.get(0)?,
        task_id: r.get(1)?,
        custom_id: r.get(2)?,
        name: r.get(3)?,
        status: r.get(4)?,
        url: r.get(5)?,
        linked_at: r.get(6)?,
    })
}

pub fn list(conn: &Connection, project_id: i64) -> AppResult<Vec<ClickUpLink>> {
    let mut s = conn.prepare(
        "SELECT project_id,task_id,custom_id,name,status,url,linked_at
         FROM clickup_links WHERE project_id=? ORDER BY linked_at DESC",
    )?;
    let rows = s.query_map(params![project_id], row)?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

pub fn get(conn: &Connection, project_id: i64, task_id: &str) -> AppResult<Option<ClickUpLink>> {
    let mut s = conn.prepare(
        "SELECT project_id,task_id,custom_id,name,status,url,linked_at
         FROM clickup_links WHERE project_id=? AND task_id=?",
    )?;
    let mut rows = s.query(params![project_id, task_id])?;
    match rows.next()? {
        Some(r) => Ok(Some(row(r)?)),
        None => Ok(None),
    }
}

pub fn upsert(conn: &Connection, l: &ClickUpLink) -> AppResult<()> {
    conn.execute(
        "INSERT INTO clickup_links(project_id,task_id,custom_id,name,status,url,linked_at)
         VALUES(?,?,?,?,?,?,?)
         ON CONFLICT(project_id,task_id) DO UPDATE SET
           custom_id=excluded.custom_id, name=excluded.name,
           status=excluded.status, url=excluded.url",
        params![l.project_id, l.task_id, l.custom_id, l.name, l.status, l.url, l.linked_at],
    )?;
    Ok(())
}

pub fn delete(conn: &Connection, project_id: i64, task_id: &str) -> AppResult<()> {
    conn.execute(
        "DELETE FROM clickup_links WHERE project_id=? AND task_id=?",
        params![project_id, task_id],
    )?;
    Ok(())
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd DesktopApp && cargo test --manifest-path src-tauri/Cargo.toml clickup_links_repo`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add DesktopApp/src-tauri/src/db/clickup_links_repo.rs
git commit -m "feat(clickup): add linked-tasks repo"
```

### Task 3: Domain types (ts-rs)

**Files:**
- Create: `DesktopApp/src-tauri/src/domain/clickup.rs`
- Modify: `DesktopApp/src-tauri/src/domain/mod.rs` (add `pub mod clickup;` and re-exports if the module re-exports types)
- Generated: `DesktopApp/src/types/*.ts` (via `cargo test`)

**Interfaces:**
- Produces (all `pub`): `ClickUpConnectionStatus` (enum), `ClickUpWorkspace`, `ClickUpSpace`, `ClickUpList`, `ClickUpTaskRef`, `ClickUpAttachment`, `ClickUpComment`, `ClickUpTaskDetail`, `ClickUpLink`, `ClickUpProjectConfig`, `TimeEstimate`.

- [ ] **Step 1: Write the types**

Create `DesktopApp/src-tauri/src/domain/clickup.rs`:

```rust
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/types/")]
#[serde(rename_all = "camelCase")]
pub enum ClickUpConnectionStatus {
    Configured,
    Invalid,
    Absent,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/types/")]
#[serde(rename_all = "camelCase")]
pub struct ClickUpWorkspace { pub id: String, pub name: String }

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/types/")]
#[serde(rename_all = "camelCase")]
pub struct ClickUpSpace { pub id: String, pub name: String }

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/types/")]
#[serde(rename_all = "camelCase")]
pub struct ClickUpList { pub id: String, pub name: String }

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/types/")]
#[serde(rename_all = "camelCase")]
pub struct ClickUpTaskRef {
    pub id: String,
    pub custom_id: Option<String>,
    pub name: String,
    pub status: Option<String>,
    pub url: String,
    pub list_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/types/")]
#[serde(rename_all = "camelCase")]
pub struct ClickUpAttachment { pub id: String, pub title: String, pub url: String }

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/types/")]
#[serde(rename_all = "camelCase")]
pub struct ClickUpComment {
    pub id: String,
    pub user: String,
    pub text: String,
    #[ts(type = "number")] pub date: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/types/")]
#[serde(rename_all = "camelCase")]
pub struct ClickUpTaskDetail {
    pub id: String,
    pub custom_id: Option<String>,
    pub name: String,
    pub description: String,
    pub status: Option<String>,
    pub url: String,
    pub attachments: Vec<ClickUpAttachment>,
    pub comments: Vec<ClickUpComment>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/types/")]
#[serde(rename_all = "camelCase")]
pub struct ClickUpLink {
    #[ts(type = "number")] pub project_id: i64,
    pub task_id: String,
    pub custom_id: Option<String>,
    pub name: String,
    pub status: Option<String>,
    pub url: String,
    #[ts(type = "number")] pub linked_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/types/")]
#[serde(rename_all = "camelCase")]
pub struct ClickUpProjectConfig {
    #[ts(type = "number")] pub project_id: i64,
    pub workspace_id: String,
    pub space_id: Option<String>,
    pub list_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/types/")]
#[serde(rename_all = "camelCase")]
pub struct TimeEstimate {
    #[ts(type = "number")] pub session_ms: i64,
    #[ts(type = "number")] pub dev_estimate_ms: i64,
}
```

- [ ] **Step 2: Register the module**

In `DesktopApp/src-tauri/src/domain/mod.rs`, add `pub mod clickup;` alongside the other `pub mod` lines. (Do NOT add blanket re-exports unless the file already re-exports every type; reference these as `crate::domain::clickup::TypeName`.)

- [ ] **Step 3: Materialize the TS types**

Run: `cd DesktopApp && cargo test --manifest-path src-tauri/Cargo.toml clickup 2>/dev/null; ls src/types/ClickUp*.ts src/types/TimeEstimate.ts`
Expected: the files `ClickUpConnectionStatus.ts`, `ClickUpWorkspace.ts`, …, `ClickUpLink.ts`, `ClickUpProjectConfig.ts`, `TimeEstimate.ts` exist.

- [ ] **Step 4: Verify backend still compiles**

Run: `cd DesktopApp && cargo build --manifest-path src-tauri/Cargo.toml`
Expected: builds (Tasks 1–2 repos now resolve `ClickUpProjectConfig`/`ClickUpLink`).

- [ ] **Step 5: Commit**

```bash
git add DesktopApp/src-tauri/src/domain/clickup.rs DesktopApp/src-tauri/src/domain/mod.rs DesktopApp/src/types/
git commit -m "feat(clickup): add domain types and ts-rs exports"
```

### Task 4: ClickUpClient — connection test + workspaces

**Files:**
- Create: `DesktopApp/src-tauri/src/clickup/mod.rs`
- Modify: `DesktopApp/src-tauri/src/lib.rs:1-13` (add `pub mod clickup;`)
- Test: inline `#[cfg(test)]` with wiremock

**Interfaces:**
- Produces: `clickup::{ClickUpClient, ClickUpError}`.
  - `ClickUpClient::new(token: impl Into<String>) -> Self` (base = production).
  - `ClickUpClient::with_base(token, base) -> Self` (tests).
  - `async fn get_user(&self) -> Result<(), ClickUpError>`.
  - `async fn list_workspaces(&self) -> Result<Vec<ClickUpWorkspace>, ClickUpError>`.
  - `ClickUpError` variants: `InvalidToken`, `RateLimited`, `Offline`, `Api { status: u16, message: String }`.

- [ ] **Step 1: Write the failing tests**

Create `DesktopApp/src-tauri/src/clickup/mod.rs` with the test module first:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[tokio::test]
    async fn get_user_ok_sends_authorization_header() {
        let server = MockServer::start().await;
        Mock::given(method("GET")).and(path("/user"))
            .and(header("authorization", "pk_test"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "user": { "id": 1, "username": "u" }
            })))
            .mount(&server).await;
        let client = ClickUpClient::with_base("pk_test", server.uri());
        client.get_user().await.unwrap();
    }

    #[tokio::test]
    async fn get_user_401_maps_invalid_token() {
        let server = MockServer::start().await;
        Mock::given(method("GET")).and(path("/user"))
            .respond_with(ResponseTemplate::new(401))
            .mount(&server).await;
        let client = ClickUpClient::with_base("bad", server.uri());
        assert!(matches!(client.get_user().await.unwrap_err(), ClickUpError::InvalidToken));
    }

    #[tokio::test]
    async fn list_workspaces_parses_teams() {
        let server = MockServer::start().await;
        Mock::given(method("GET")).and(path("/team"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "teams": [ { "id": "111", "name": "Acme" }, { "id": "222", "name": "Beta" } ]
            })))
            .mount(&server).await;
        let client = ClickUpClient::with_base("pk_test", server.uri());
        let ws = client.list_workspaces().await.unwrap();
        assert_eq!(ws.len(), 2);
        assert_eq!(ws[0].id, "111");
        assert_eq!(ws[0].name, "Acme");
    }

    #[tokio::test]
    async fn rate_limit_maps_429() {
        let server = MockServer::start().await;
        Mock::given(method("GET")).and(path("/team"))
            .respond_with(ResponseTemplate::new(429))
            .mount(&server).await;
        let client = ClickUpClient::with_base("pk_test", server.uri());
        assert!(matches!(client.list_workspaces().await.unwrap_err(), ClickUpError::RateLimited));
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd DesktopApp && cargo test --manifest-path src-tauri/Cargo.toml clickup::tests`
Expected: FAIL — `ClickUpClient` undefined. (Add `pub mod clickup;` to `lib.rs` first so the module is compiled — without it the test file is not even built.)

- [ ] **Step 3: Implement the client core**

Prepend to `clickup/mod.rs`:

```rust
use serde::Deserialize;
use crate::domain::clickup::ClickUpWorkspace;

const DEFAULT_BASE: &str = "https://api.clickup.com/api/v2";

#[derive(Debug, thiserror::Error)]
pub enum ClickUpError {
    #[error("clickup token invalid or expired")]
    InvalidToken,
    #[error("clickup rate limit exceeded")]
    RateLimited,
    #[error("clickup unreachable: {0}")]
    Offline(String),
    #[error("clickup api error {status}: {message}")]
    Api { status: u16, message: String },
}

pub struct ClickUpClient {
    http: reqwest::Client,
    token: String,
    base: String,
}

#[derive(Deserialize)]
struct TeamsResponse { teams: Vec<Team> }
#[derive(Deserialize)]
struct Team { id: String, name: String }

impl ClickUpClient {
    pub fn new(token: impl Into<String>) -> Self {
        Self::with_base(token, DEFAULT_BASE)
    }

    pub fn with_base(token: impl Into<String>, base: impl Into<String>) -> Self {
        Self { http: reqwest::Client::new(), token: token.into(), base: base.into() }
    }

    fn url(&self, path: &str) -> String {
        format!("{}{}", self.base.trim_end_matches('/'), path)
    }

    async fn get_json<T: serde::de::DeserializeOwned>(&self, path: &str) -> Result<T, ClickUpError> {
        let resp = self.http
            .get(self.url(path))
            .header("Authorization", &self.token)
            .send().await
            .map_err(|e| ClickUpError::Offline(e.to_string()))?;
        Self::ok(resp).await?.json().await
            .map_err(|e| ClickUpError::Offline(e.to_string()))
    }

    async fn ok(resp: reqwest::Response) -> Result<reqwest::Response, ClickUpError> {
        match resp.status().as_u16() {
            200..=299 => Ok(resp),
            401 | 403 => Err(ClickUpError::InvalidToken),
            429 => Err(ClickUpError::RateLimited),
            status => {
                let message = resp.text().await.unwrap_or_default();
                Err(ClickUpError::Api { status, message })
            }
        }
    }

    pub async fn get_user(&self) -> Result<(), ClickUpError> {
        let resp = self.http
            .get(self.url("/user"))
            .header("Authorization", &self.token)
            .send().await
            .map_err(|e| ClickUpError::Offline(e.to_string()))?;
        Self::ok(resp).await.map(|_| ())
    }

    pub async fn list_workspaces(&self) -> Result<Vec<ClickUpWorkspace>, ClickUpError> {
        let r: TeamsResponse = self.get_json("/team").await?;
        Ok(r.teams.into_iter().map(|t| ClickUpWorkspace { id: t.id, name: t.name }).collect())
    }
}
```

Add to `DesktopApp/src-tauri/src/lib.rs` (with the other `pub mod` lines): `pub mod clickup;`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd DesktopApp && cargo test --manifest-path src-tauri/Cargo.toml clickup::tests`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add DesktopApp/src-tauri/src/clickup/mod.rs DesktopApp/src-tauri/src/lib.rs
git commit -m "feat(clickup): add ClickUpClient with connection test and workspaces"
```

### Task 5: Token commands + connection status

**Files:**
- Create: `DesktopApp/src-tauri/src/commands/clickup.rs`
- Modify: `DesktopApp/src-tauri/src/commands/mod.rs` (add `pub mod clickup;`)
- Modify: `DesktopApp/src-tauri/src/lib.rs:65-118` (register commands)
- Modify: `DesktopApp/src/lib/tauri.ts` (wrappers)
- Test: inline `#[cfg(test)]` for the token-status helper

**Interfaces:**
- Produces commands: `clickup_set_token(token)`, `clickup_clear_token()`, `clickup_connection_status() -> ClickUpConnectionStatus`, `clickup_list_workspaces() -> Vec<ClickUpWorkspace>`.
- Produces helper: `fn load_client(state: &AppState) -> AppResult<ClickUpClient>` (reads `clickupApiToken`, errors `AppError::Other("ClickUp: brak tokenu")` if absent) — reused by all later network commands.
- Token settings key constant: `const TOKEN_KEY: &str = "clickupApiToken";`.

- [ ] **Step 1: Write the failing test**

Create `DesktopApp/src-tauri/src/commands/clickup.rs` test module:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{init_pool, settings_repo};
    use tempfile::NamedTempFile;

    #[test]
    fn status_reflects_token_presence() {
        let f = NamedTempFile::new().unwrap();
        let pool = init_pool(&f.path().to_path_buf()).unwrap();
        let c = pool.get().unwrap();
        assert_eq!(status_from_token(&token_in(&c)), ClickUpConnectionStatus::Absent);
        settings_repo::set(&c, TOKEN_KEY, "pk_x").unwrap();
        assert_eq!(status_from_token(&token_in(&c)), ClickUpConnectionStatus::Configured);
    }

    fn token_in(c: &rusqlite::Connection) -> Option<String> {
        settings_repo::get(c, TOKEN_KEY).unwrap()
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd DesktopApp && cargo test --manifest-path src-tauri/Cargo.toml commands::clickup`
Expected: FAIL — `status_from_token`/`TOKEN_KEY` undefined. (Add `pub mod clickup;` to `commands/mod.rs` first.)

- [ ] **Step 3: Implement commands**

Prepend to `commands/clickup.rs`:

```rust
use tauri::State;
use crate::clickup::ClickUpClient;
use crate::db::settings_repo;
use crate::domain::clickup::{ClickUpConnectionStatus, ClickUpWorkspace};
use crate::error::{AppError, AppResult};
use crate::state::AppState;

const TOKEN_KEY: &str = "clickupApiToken";

fn status_from_token(token: &Option<String>) -> ClickUpConnectionStatus {
    match token {
        Some(t) if !t.trim().is_empty() => ClickUpConnectionStatus::Configured,
        _ => ClickUpConnectionStatus::Absent,
    }
}

pub fn load_client(state: &AppState) -> AppResult<ClickUpClient> {
    let c = state.db.get()?;
    let token = settings_repo::get(&c, TOKEN_KEY)?
        .filter(|t| !t.trim().is_empty())
        .ok_or_else(|| AppError::Other("ClickUp: brak tokenu".into()))?;
    Ok(ClickUpClient::new(token))
}

#[tauri::command]
pub fn clickup_set_token(state: State<AppState>, token: String) -> AppResult<()> {
    let c = state.db.get()?;
    settings_repo::set(&c, TOKEN_KEY, token.trim())?;
    Ok(())
}

#[tauri::command]
pub fn clickup_clear_token(state: State<AppState>) -> AppResult<()> {
    let c = state.db.get()?;
    settings_repo::delete(&c, TOKEN_KEY)?;
    Ok(())
}

#[tauri::command]
pub async fn clickup_connection_status(state: State<'_, AppState>) -> AppResult<ClickUpConnectionStatus> {
    let token = { settings_repo::get(&state.db.get()?, TOKEN_KEY)? };
    if status_from_token(&token) == ClickUpConnectionStatus::Absent {
        return Ok(ClickUpConnectionStatus::Absent);
    }
    let client = ClickUpClient::new(token.unwrap());
    match client.get_user().await {
        Ok(()) => Ok(ClickUpConnectionStatus::Configured),
        Err(crate::clickup::ClickUpError::InvalidToken) => Ok(ClickUpConnectionStatus::Invalid),
        Err(e) => Err(AppError::Other(e.to_string())),
    }
}

#[tauri::command]
pub async fn clickup_list_workspaces(state: State<'_, AppState>) -> AppResult<Vec<ClickUpWorkspace>> {
    let client = load_client(&state)?;
    client.list_workspaces().await.map_err(|e| AppError::Other(e.to_string()))
}
```

Add `pub mod clickup;` to `commands/mod.rs`.

- [ ] **Step 4: Register the commands in `lib.rs`**

Add inside `tauri::generate_handler![ ... ]` (after the `commands::remote::remote_pair_start` line):

```rust
            commands::clickup::clickup_set_token,
            commands::clickup::clickup_clear_token,
            commands::clickup::clickup_connection_status,
            commands::clickup::clickup_list_workspaces,
```

- [ ] **Step 5: Add the typed wrappers**

In `DesktopApp/src/lib/tauri.ts`, inside the `tauri` object, add (import the types at the top of the file alongside existing type imports):

```ts
  clickupSetToken: (token: string) => invoke<void>('clickup_set_token', { token }),
  clickupClearToken: () => invoke<void>('clickup_clear_token'),
  clickupConnectionStatus: () =>
    invoke<ClickUpConnectionStatus>('clickup_connection_status'),
  clickupListWorkspaces: () => invoke<ClickUpWorkspace[]>('clickup_list_workspaces'),
```

Type imports (top of `tauri.ts`):

```ts
import type { ClickUpConnectionStatus } from '../types/ClickUpConnectionStatus';
import type { ClickUpWorkspace } from '../types/ClickUpWorkspace';
```

- [ ] **Step 6: Run backend test + lint**

Run: `cd DesktopApp && cargo test --manifest-path src-tauri/Cargo.toml commands::clickup && npm run lint`
Expected: Rust PASS; lint zero errors.

- [ ] **Step 7: Commit**

```bash
git add DesktopApp/src-tauri/src/commands/clickup.rs DesktopApp/src-tauri/src/commands/mod.rs DesktopApp/src-tauri/src/lib.rs DesktopApp/src/lib/tauri.ts
git commit -m "feat(clickup): add token storage and connection-status commands"
```

### Task 6: Settings "ClickUp" tab

**Files:**
- Modify: `DesktopApp/src/components/dialogs/SettingsDialog.tsx` (tab union + button + body + `ClickUpTab` component)
- Test: `DesktopApp/src/components/dialogs/__tests__/ClickUpTab.test.tsx` (create; follow the repo's existing vitest dialog test layout — if none exists under `__tests__`, place it next to the component as `SettingsDialog.clickup.test.tsx`)

**Interfaces:**
- Consumes: `tauri.clickupSetToken`, `tauri.clickupClearToken`, `tauri.clickupConnectionStatus`.
- Produces: a reachable `'clickup'` tab rendering a masked token input, "Testuj połączenie" button, status line, "Usuń token" button.

- [ ] **Step 1: Write the failing test**

Create the test (mock `tauri`):

```tsx
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ClickUpTab } from '../SettingsDialog';

vi.mock('../../../lib/tauri', () => ({
  tauri: {
    clickupConnectionStatus: vi.fn().mockResolvedValue('absent'),
    clickupSetToken: vi.fn().mockResolvedValue(undefined),
    clickupClearToken: vi.fn().mockResolvedValue(undefined),
  },
}));
import { tauri } from '../../../lib/tauri';

describe('ClickUpTab', () => {
  beforeEach(() => vi.clearAllMocks());

  it('saves the token via clickupSetToken', async () => {
    render(<ClickUpTab />);
    fireEvent.change(screen.getByPlaceholderText('pk_...'), { target: { value: 'pk_abc' } });
    fireEvent.click(screen.getByText('Zapisz token'));
    await waitFor(() => expect(tauri.clickupSetToken).toHaveBeenCalledWith('pk_abc'));
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd DesktopApp && npm test -- ClickUpTab`
Expected: FAIL — `ClickUpTab` is not exported.

- [ ] **Step 3: Extend the tab union and strip**

In `SettingsDialog.tsx`: change the `SettingsTab` union (line ~28) to include `'clickup'`:

```ts
type SettingsTab = 'general' | 'cli' | 'models' | 'shortcuts' | 'cloud' | 'clickup';
```

Add to the tab strip (next to the other `<TabButton>`s):

```tsx
<TabButton active={tab === 'clickup'} onClick={() => setTab('clickup')}>ClickUp</TabButton>
```

Add to the body switch:

```tsx
{tab === 'clickup' && <ClickUpTab />}
```

- [ ] **Step 4: Implement `ClickUpTab` (exported)**

Add this component in `SettingsDialog.tsx` (co-located with the other tab components), and `export` it so the test can import it:

```tsx
export function ClickUpTab() {
  const [token, setToken] = useState('');
  const [status, setStatus] = useState<ClickUpConnectionStatus>('absent');
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setStatus(await tauri.clickupConnectionStatus());
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  const save = async () => {
    setBusy(true);
    try { await tauri.clickupSetToken(token); setToken(''); await refresh(); }
    finally { setBusy(false); }
  };
  const clear = async () => {
    setBusy(true);
    try { await tauri.clickupClearToken(); await refresh(); }
    finally { setBusy(false); }
  };

  const label =
    status === 'configured' ? 'Połączono' :
    status === 'invalid' ? 'Token nieprawidłowy' : 'Brak tokenu';

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between mb-3">
        <span className="text-[10px] text-muted font-medium uppercase tracking-wider">CLICKUP</span>
        <span className="text-[11px] text-fg-secondary">{label}</span>
      </div>
      <input
        type="password"
        value={token}
        onChange={e => setToken(e.target.value)}
        placeholder="pk_..."
        className="w-full bg-bg border border-border px-3 py-1.5 text-[13px] font-mono placeholder:text-muted/60"
      />
      <div className="flex gap-2">
        <button disabled={busy || !token.trim()} onClick={save}
          className="px-3 py-1.5 bg-fg text-bg text-[12px] font-medium disabled:opacity-50">Zapisz token</button>
        <button disabled={busy} onClick={refresh}
          className="px-3 py-1.5 border border-border text-[12px] text-fg-secondary hover:text-fg">Testuj połączenie</button>
        <button disabled={busy} onClick={clear}
          className="px-3 py-1.5 border border-border text-[12px] text-fg-secondary hover:text-fg">Usuń token</button>
      </div>
      <p className="text-[11px] text-muted">Token wygenerujesz w ClickUp: Settings → Apps → API Token.</p>
    </section>
  );
}
```

Ensure `useState`, `useEffect`, `useCallback` are imported, `tauri` is imported, and add `import type { ClickUpConnectionStatus } from '../../types/ClickUpConnectionStatus';`.

- [ ] **Step 5: Run the test + lint**

Run: `cd DesktopApp && npm test -- ClickUpTab && npm run lint`
Expected: PASS; lint clean.

- [ ] **Step 6: Commit**

```bash
git add DesktopApp/src/components/dialogs/SettingsDialog.tsx DesktopApp/src/components/dialogs/__tests__/ClickUpTab.test.tsx
git commit -m "feat(clickup): add ClickUp settings tab with token management"
```

**Phase 1 gate:** `cd DesktopApp && npm run test:rust && npm test && npm run lint` all green. The app can store a token and report connection status.

---

## Phase 2 — Tasks in project

Outcome: per-project scope config, the right-panel section, linking by ID/URL or name, a task detail popup, and the gitignored file handle with copy/inject.

### Task 7: ClickUpClient — spaces, lists, task detail, comments

**Files:**
- Modify: `DesktopApp/src-tauri/src/clickup/mod.rs`
- Test: inline `#[cfg(test)]`

**Interfaces:**
- Produces:
  - `async fn list_spaces(&self, workspace_id: &str) -> Result<Vec<ClickUpSpace>, ClickUpError>`
  - `async fn list_lists(&self, space_id: &str) -> Result<Vec<ClickUpList>, ClickUpError>`
  - `async fn get_task_detail(&self, id: &str, custom: bool, team_id: Option<&str>) -> Result<ClickUpTaskDetail, ClickUpError>`
  - `pub fn parse_task_input(input: &str) -> TaskInputRef` where `pub struct TaskInputRef { pub id: String, pub custom: bool }`.

- [ ] **Step 1: Write failing tests**

Add to the `tests` module in `clickup/mod.rs`:

```rust
    #[test]
    fn parse_plain_id() {
        let r = parse_task_input("868abc12");
        assert_eq!(r.id, "868abc12");
        assert!(!r.custom);
    }
    #[test]
    fn parse_custom_id() {
        let r = parse_task_input("CU-123");
        assert_eq!(r.id, "CU-123");
        assert!(r.custom);
    }
    #[test]
    fn parse_url_with_team_and_custom() {
        let r = parse_task_input("https://app.clickup.com/t/9008/CU-123");
        assert_eq!(r.id, "CU-123");
        assert!(r.custom);
    }
    #[test]
    fn parse_url_plain() {
        let r = parse_task_input("https://app.clickup.com/t/868abc12");
        assert_eq!(r.id, "868abc12");
        assert!(!r.custom);
    }

    #[tokio::test]
    async fn list_spaces_parses() {
        let server = MockServer::start().await;
        Mock::given(method("GET")).and(path("/team/111/space"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "spaces": [ { "id": "s1", "name": "Space 1" } ]
            }))).mount(&server).await;
        let c = ClickUpClient::with_base("pk", server.uri());
        let s = c.list_spaces("111").await.unwrap();
        assert_eq!(s[0].name, "Space 1");
    }

    #[tokio::test]
    async fn get_task_detail_maps_description_status_attachments_and_comments() {
        let server = MockServer::start().await;
        Mock::given(method("GET")).and(path("/task/868abc12"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": "868abc12", "custom_id": "CU-9", "name": "Fix bug",
                "markdown_description": "## do it",
                "status": { "status": "in progress" },
                "url": "https://app.clickup.com/t/868abc12",
                "attachments": [ { "id": "a1", "title": "log.txt", "url": "https://files/a1" } ]
            }))).mount(&server).await;
        Mock::given(method("GET")).and(path("/task/868abc12/comment"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "comments": [ { "id": "c1", "comment_text": "hi", "user": { "username": "ann" }, "date": "1700000000000" } ]
            }))).mount(&server).await;
        let c = ClickUpClient::with_base("pk", server.uri());
        let d = c.get_task_detail("868abc12", false, None).await.unwrap();
        assert_eq!(d.name, "Fix bug");
        assert_eq!(d.description, "## do it");
        assert_eq!(d.status.as_deref(), Some("in progress"));
        assert_eq!(d.attachments[0].title, "log.txt");
        assert_eq!(d.comments[0].user, "ann");
        assert_eq!(d.comments[0].date, 1_700_000_000_000);
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd DesktopApp && cargo test --manifest-path src-tauri/Cargo.toml clickup::tests`
Expected: FAIL — new fns undefined.

- [ ] **Step 3: Implement**

Add to `clickup/mod.rs` (imports: extend the `use crate::domain::clickup::...` line to include `ClickUpSpace, ClickUpList, ClickUpTaskDetail, ClickUpAttachment, ClickUpComment`):

```rust
pub struct TaskInputRef { pub id: String, pub custom: bool }

fn looks_custom(s: &str) -> bool {
    s.contains('-') && s.chars().next().map_or(false, |c| c.is_ascii_alphabetic())
}

pub fn parse_task_input(input: &str) -> TaskInputRef {
    let t = input.trim();
    if let Some(idx) = t.find("/t/") {
        let rest = &t[idx + 3..];
        let seg: Vec<&str> = rest.split('/').filter(|s| !s.is_empty()).collect();
        if seg.len() >= 2 {
            return TaskInputRef { id: seg[1].to_string(), custom: true };
        }
        if let Some(one) = seg.first() {
            return TaskInputRef { id: (*one).to_string(), custom: looks_custom(one) };
        }
    }
    TaskInputRef { id: t.to_string(), custom: looks_custom(t) }
}

#[derive(Deserialize)] struct NamedDto { id: String, name: String }
#[derive(Deserialize)] struct SpacesResponse { spaces: Vec<NamedDto> }
#[derive(Deserialize)] struct ListsResponse { lists: Vec<NamedDto> }
#[derive(Deserialize)] struct FoldersResponse { folders: Vec<FolderDto> }
#[derive(Deserialize)] struct FolderDto { lists: Vec<NamedDto> }

#[derive(Deserialize)] struct StatusDto { status: String }
#[derive(Deserialize)] struct AttachmentDto { id: String, #[serde(default)] title: Option<String>, #[serde(default)] url: Option<String> }
#[derive(Deserialize)]
struct TaskDto {
    id: String,
    #[serde(default)] custom_id: Option<String>,
    name: String,
    #[serde(default)] description: Option<String>,
    #[serde(default)] markdown_description: Option<String>,
    #[serde(default)] text_content: Option<String>,
    #[serde(default)] status: Option<StatusDto>,
    #[serde(default)] url: Option<String>,
    #[serde(default)] attachments: Vec<AttachmentDto>,
}
#[derive(Deserialize)] struct CommentsResponse { comments: Vec<CommentDto> }
#[derive(Deserialize)] struct CommentDto {
    id: String,
    #[serde(default)] comment_text: String,
    #[serde(default)] user: Option<UserDto>,
    #[serde(default)] date: Option<String>,
}
#[derive(Deserialize)] struct UserDto { #[serde(default)] username: Option<String> }

impl ClickUpClient {
    pub async fn list_spaces(&self, workspace_id: &str) -> Result<Vec<ClickUpSpace>, ClickUpError> {
        let r: SpacesResponse = self.get_json(&format!("/team/{workspace_id}/space")).await?;
        Ok(r.spaces.into_iter().map(|s| ClickUpSpace { id: s.id, name: s.name }).collect())
    }

    pub async fn list_lists(&self, space_id: &str) -> Result<Vec<ClickUpList>, ClickUpError> {
        let mut out: Vec<ClickUpList> = Vec::new();
        let folderless: ListsResponse = self.get_json(&format!("/space/{space_id}/list")).await?;
        out.extend(folderless.lists.into_iter().map(|l| ClickUpList { id: l.id, name: l.name }));
        let folders: FoldersResponse = self.get_json(&format!("/space/{space_id}/folder")).await?;
        for f in folders.folders {
            out.extend(f.lists.into_iter().map(|l| ClickUpList { id: l.id, name: l.name }));
        }
        Ok(out)
    }

    pub async fn get_task_detail(&self, id: &str, custom: bool, team_id: Option<&str>)
        -> Result<ClickUpTaskDetail, ClickUpError>
    {
        let q = if custom {
            format!("?custom_task_ids=true&team_id={}", team_id.unwrap_or(""))
        } else { String::new() };
        let t: TaskDto = self.get_json(&format!("/task/{id}{q}")).await?;
        let comments: CommentsResponse = self.get_json(&format!("/task/{id}/comment{q}")).await?;
        let description = t.markdown_description
            .filter(|s| !s.is_empty())
            .or(t.description)
            .or(t.text_content)
            .unwrap_or_default();
        Ok(ClickUpTaskDetail {
            id: t.id,
            custom_id: t.custom_id,
            name: t.name,
            description,
            status: t.status.map(|s| s.status),
            url: t.url.unwrap_or_default(),
            attachments: t.attachments.into_iter().map(|a| ClickUpAttachment {
                id: a.id,
                title: a.title.unwrap_or_else(|| "(załącznik)".into()),
                url: a.url.unwrap_or_default(),
            }).collect(),
            comments: comments.comments.into_iter().map(|c| ClickUpComment {
                id: c.id,
                user: c.user.and_then(|u| u.username).unwrap_or_else(|| "?".into()),
                text: c.comment_text,
                date: c.date.and_then(|d| d.parse().ok()).unwrap_or(0),
            }).collect(),
        })
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd DesktopApp && cargo test --manifest-path src-tauri/Cargo.toml clickup::tests`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add DesktopApp/src-tauri/src/clickup/mod.rs
git commit -m "feat(clickup): client methods for spaces, lists, task detail, comments"
```

### Task 8: ClickUpClient — task search within scope

**Files:**
- Modify: `DesktopApp/src-tauri/src/clickup/mod.rs`
- Test: inline `#[cfg(test)]`

**Interfaces:**
- Produces:
  - `async fn list_tasks_in_list(&self, list_id: &str) -> Result<Vec<ClickUpTaskRef>, ClickUpError>`
  - `async fn list_tasks_in_space(&self, team_id: &str, space_id: &str) -> Result<Vec<ClickUpTaskRef>, ClickUpError>`
  - `pub fn classify_query(q: &str) -> QueryKind` where `pub enum QueryKind { Id, Name }`.

- [ ] **Step 1: Write failing tests**

Add to the `tests` module:

```rust
    #[test]
    fn classify_query_distinguishes_id_and_name() {
        assert!(matches!(classify_query("CU-123"), QueryKind::Id));
        assert!(matches!(classify_query("868abc12"), QueryKind::Id));
        assert!(matches!(classify_query("https://app.clickup.com/t/868abc12"), QueryKind::Id));
        assert!(matches!(classify_query("fix login bug"), QueryKind::Name));
        assert!(matches!(classify_query("logowanie"), QueryKind::Name));
    }

    #[tokio::test]
    async fn list_tasks_in_list_maps_refs() {
        let server = MockServer::start().await;
        Mock::given(method("GET")).and(path("/list/li9/task"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "tasks": [ { "id": "t1", "name": "Alpha", "status": { "status": "open" },
                             "url": "https://app.clickup.com/t/t1" } ]
            }))).mount(&server).await;
        let c = ClickUpClient::with_base("pk", server.uri());
        let r = c.list_tasks_in_list("li9").await.unwrap();
        assert_eq!(r[0].id, "t1");
        assert_eq!(r[0].name, "Alpha");
        assert_eq!(r[0].status.as_deref(), Some("open"));
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd DesktopApp && cargo test --manifest-path src-tauri/Cargo.toml clickup::tests`
Expected: FAIL.

- [ ] **Step 3: Implement**

Add to `clickup/mod.rs` (extend the domain import with `ClickUpTaskRef`):

```rust
pub enum QueryKind { Id, Name }

pub fn classify_query(q: &str) -> QueryKind {
    let t = q.trim();
    let no_space = !t.chars().any(char::is_whitespace);
    if no_space && (t.starts_with("http") || looks_custom(t) || t.chars().all(|c| c.is_ascii_alphanumeric())) {
        QueryKind::Id
    } else {
        QueryKind::Name
    }
}

#[derive(Deserialize)] struct TasksResponse { tasks: Vec<TaskDto> }

impl ClickUpClient {
    fn task_ref(t: TaskDto) -> ClickUpTaskRef {
        ClickUpTaskRef {
            id: t.id,
            custom_id: t.custom_id,
            name: t.name,
            status: t.status.map(|s| s.status),
            url: t.url.unwrap_or_default(),
            list_name: None,
        }
    }

    pub async fn list_tasks_in_list(&self, list_id: &str) -> Result<Vec<ClickUpTaskRef>, ClickUpError> {
        let r: TasksResponse = self.get_json(&format!("/list/{list_id}/task")).await?;
        Ok(r.tasks.into_iter().map(Self::task_ref).collect())
    }

    pub async fn list_tasks_in_space(&self, team_id: &str, space_id: &str)
        -> Result<Vec<ClickUpTaskRef>, ClickUpError>
    {
        let r: TasksResponse = self
            .get_json(&format!("/team/{team_id}/task?space_ids[]={space_id}"))
            .await?;
        Ok(r.tasks.into_iter().map(Self::task_ref).collect())
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd DesktopApp && cargo test --manifest-path src-tauri/Cargo.toml clickup::tests`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add DesktopApp/src-tauri/src/clickup/mod.rs
git commit -m "feat(clickup): client task search within list/space scope"
```

### Task 9: Project-scope + linking + task commands

**Files:**
- Modify: `DesktopApp/src-tauri/src/commands/clickup.rs`
- Modify: `DesktopApp/src-tauri/src/lib.rs` (register)
- Modify: `DesktopApp/src/lib/tauri.ts` (wrappers + type imports)
- Test: inline `#[cfg(test)]` for `clickup_set_config`/`get_config` round-trip via repo (command bodies are thin)

**Interfaces:**
- Consumes: `clickup_config_repo`, `clickup_links_repo`, `clickup::{ClickUpClient, parse_task_input, classify_query, QueryKind}`, `projects_repo::get`.
- Produces commands: `clickup_list_spaces(workspaceId)`, `clickup_list_lists(spaceId)`, `clickup_get_config(projectId) -> Option<ClickUpProjectConfig>`, `clickup_set_config(projectId, workspaceId, spaceId?, listId?)`, `clickup_search_tasks(projectId, query) -> Vec<ClickUpTaskRef>`, `clickup_link_task(projectId, taskId) -> ClickUpLink`, `clickup_unlink_task(projectId, taskId)`, `clickup_list_links(projectId) -> Vec<ClickUpLink>`, `clickup_get_task(taskId) -> ClickUpTaskDetail`.

- [ ] **Step 1: Write the failing test**

Add to the `tests` module in `commands/clickup.rs`:

```rust
    #[test]
    fn config_command_helpers_round_trip() {
        use crate::db::clickup_config_repo;
        let f = NamedTempFile::new().unwrap();
        let pool = init_pool(&f.path().to_path_buf()).unwrap();
        let c = pool.get().unwrap();
        let p = crate::db::projects_repo::insert(&c, "X", "/x", "-x", None).unwrap();
        clickup_config_repo::set(&c, p.id, "ws1", Some("sp1"), None).unwrap();
        assert_eq!(clickup_config_repo::get(&c, p.id).unwrap().unwrap().workspace_id, "ws1");
    }
```

- [ ] **Step 2: Run test to verify it fails / passes minimally**

Run: `cd DesktopApp && cargo test --manifest-path src-tauri/Cargo.toml commands::clickup`
Expected: this repo-level test passes once imports compile; it guards regressions. The real verification of commands is the lint + manual run. Proceed to implement the commands.

- [ ] **Step 3: Implement the commands**

Append to `commands/clickup.rs` (extend the top `use` lines to add `clickup_config_repo, clickup_links_repo, projects_repo`, `parse_task_input, classify_query, QueryKind`, and the domain types `ClickUpSpace, ClickUpList, ClickUpProjectConfig, ClickUpTaskRef, ClickUpLink, ClickUpTaskDetail`):

```rust
#[tauri::command]
pub async fn clickup_list_spaces(state: State<'_, AppState>, workspace_id: String)
    -> AppResult<Vec<ClickUpSpace>>
{
    load_client(&state)?.list_spaces(&workspace_id).await.map_err(|e| AppError::Other(e.to_string()))
}

#[tauri::command]
pub async fn clickup_list_lists(state: State<'_, AppState>, space_id: String)
    -> AppResult<Vec<ClickUpList>>
{
    load_client(&state)?.list_lists(&space_id).await.map_err(|e| AppError::Other(e.to_string()))
}

#[tauri::command]
pub fn clickup_get_config(state: State<AppState>, project_id: i64)
    -> AppResult<Option<ClickUpProjectConfig>>
{
    clickup_config_repo::get(&state.db.get()?, project_id)
}

#[tauri::command]
pub fn clickup_set_config(
    state: State<AppState>, project_id: i64,
    workspace_id: String, space_id: Option<String>, list_id: Option<String>,
) -> AppResult<()> {
    clickup_config_repo::set(&state.db.get()?, project_id, &workspace_id, space_id.as_deref(), list_id.as_deref())
}

#[tauri::command]
pub fn clickup_list_links(state: State<AppState>, project_id: i64) -> AppResult<Vec<ClickUpLink>> {
    clickup_links_repo::list(&state.db.get()?, project_id)
}

#[tauri::command]
pub fn clickup_unlink_task(state: State<AppState>, project_id: i64, task_id: String) -> AppResult<()> {
    clickup_links_repo::delete(&state.db.get()?, project_id, &task_id)
}

#[tauri::command]
pub async fn clickup_get_task(state: State<'_, AppState>, task_id: String) -> AppResult<ClickUpTaskDetail> {
    load_client(&state)?
        .get_task_detail(&task_id, false, None).await
        .map_err(|e| AppError::Other(e.to_string()))
}

#[tauri::command]
pub async fn clickup_search_tasks(state: State<'_, AppState>, project_id: i64, query: String)
    -> AppResult<Vec<ClickUpTaskRef>>
{
    let config = {
        let c = state.db.get()?;
        clickup_config_repo::get(&c, project_id)?
            .ok_or_else(|| AppError::Other("ClickUp: brak skonfigurowanego zakresu projektu".into()))?
    };
    let client = load_client(&state)?;
    match classify_query(&query) {
        QueryKind::Id => {
            let r = parse_task_input(&query);
            let detail = client
                .get_task_detail(&r.id, r.custom, Some(&config.workspace_id)).await
                .map_err(|e| AppError::Other(e.to_string()))?;
            Ok(vec![ClickUpTaskRef {
                id: detail.id, custom_id: detail.custom_id, name: detail.name,
                status: detail.status, url: detail.url, list_name: None,
            }])
        }
        QueryKind::Name => {
            let mut tasks = if let Some(list_id) = &config.list_id {
                client.list_tasks_in_list(list_id).await
            } else if let Some(space_id) = &config.space_id {
                client.list_tasks_in_space(&config.workspace_id, space_id).await
            } else {
                return Err(AppError::Other("ClickUp: ustaw Space lub Listę dla wyszukiwania po nazwie".into()));
            }.map_err(|e| AppError::Other(e.to_string()))?;
            let needle = query.to_lowercase();
            tasks.retain(|t| t.name.to_lowercase().contains(&needle));
            tasks.truncate(50);
            Ok(tasks)
        }
    }
}

#[tauri::command]
pub async fn clickup_link_task(state: State<'_, AppState>, project_id: i64, task_id: String)
    -> AppResult<ClickUpLink>
{
    let detail = load_client(&state)?
        .get_task_detail(&task_id, false, None).await
        .map_err(|e| AppError::Other(e.to_string()))?;
    let link = ClickUpLink {
        project_id,
        task_id: detail.id.clone(),
        custom_id: detail.custom_id.clone(),
        name: detail.name.clone(),
        status: detail.status.clone(),
        url: detail.url.clone(),
        linked_at: now_ms(),
    };
    let c = state.db.get()?;
    clickup_links_repo::upsert(&c, &link)?;
    Ok(link)
}

fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}
```

> `clickup_link_task` takes the `task_id` already resolved by `clickup_search_tasks` (the search result's `id` is always the canonical ClickUp task id), so a plain `get_task_detail(.., false, None)` is correct here.

- [ ] **Step 4: Register the commands in `lib.rs`**

Add to `generate_handler!`:

```rust
            commands::clickup::clickup_list_spaces,
            commands::clickup::clickup_list_lists,
            commands::clickup::clickup_get_config,
            commands::clickup::clickup_set_config,
            commands::clickup::clickup_list_links,
            commands::clickup::clickup_unlink_task,
            commands::clickup::clickup_get_task,
            commands::clickup::clickup_search_tasks,
            commands::clickup::clickup_link_task,
```

- [ ] **Step 5: Add the typed wrappers**

In `src/lib/tauri.ts` add (and import the new types):

```ts
  clickupListSpaces: (workspaceId: string) =>
    invoke<ClickUpSpace[]>('clickup_list_spaces', { workspaceId }),
  clickupListLists: (spaceId: string) =>
    invoke<ClickUpList[]>('clickup_list_lists', { spaceId }),
  clickupGetConfig: (projectId: number) =>
    invoke<ClickUpProjectConfig | null>('clickup_get_config', { projectId }),
  clickupSetConfig: (projectId: number, workspaceId: string, spaceId: string | null, listId: string | null) =>
    invoke<void>('clickup_set_config', { projectId, workspaceId, spaceId, listId }),
  clickupListLinks: (projectId: number) =>
    invoke<ClickUpLink[]>('clickup_list_links', { projectId }),
  clickupUnlinkTask: (projectId: number, taskId: string) =>
    invoke<void>('clickup_unlink_task', { projectId, taskId }),
  clickupGetTask: (taskId: string) => invoke<ClickUpTaskDetail>('clickup_get_task', { taskId }),
  clickupSearchTasks: (projectId: number, query: string) =>
    invoke<ClickUpTaskRef[]>('clickup_search_tasks', { projectId, query }),
  clickupLinkTask: (projectId: number, taskId: string) =>
    invoke<ClickUpLink>('clickup_link_task', { projectId, taskId }),
```

Type imports:

```ts
import type { ClickUpSpace } from '../types/ClickUpSpace';
import type { ClickUpList } from '../types/ClickUpList';
import type { ClickUpProjectConfig } from '../types/ClickUpProjectConfig';
import type { ClickUpLink } from '../types/ClickUpLink';
import type { ClickUpTaskRef } from '../types/ClickUpTaskRef';
import type { ClickUpTaskDetail } from '../types/ClickUpTaskDetail';
```

- [ ] **Step 6: Run backend tests + lint**

Run: `cd DesktopApp && cargo test --manifest-path src-tauri/Cargo.toml commands::clickup && npm run lint`
Expected: PASS; lint clean.

- [ ] **Step 7: Commit**

```bash
git add DesktopApp/src-tauri/src/commands/clickup.rs DesktopApp/src-tauri/src/lib.rs DesktopApp/src/lib/tauri.ts
git commit -m "feat(clickup): scope-config, search, link, and task-detail commands"
```

### Task 10: clickupSlice (Zustand)

**Files:**
- Create: `DesktopApp/src/store/clickupSlice.ts`
- Modify: `DesktopApp/src/store/index.ts` (compose the slice into the store, like `gitSlice`/`actionsSlice`)
- Test: `DesktopApp/src/store/clickupSlice.test.ts`

**Interfaces:**
- Produces `ClickUpSlice`: state `linksByProject: Record<number, ClickUpLink[]>`, `configByProject: Record<number, ClickUpProjectConfig | null>`, `connectionStatus: ClickUpConnectionStatus`; actions `loadLinks(projectId)`, `loadConfig(projectId)`, `linkTask(projectId, taskId)`, `unlinkTask(projectId, taskId)`, `loadConnectionStatus()`.

- [ ] **Step 1: Write the failing test**

Create `clickupSlice.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { create } from 'zustand';
import { createClickUpSlice, type ClickUpSlice } from './clickupSlice';

vi.mock('../lib/tauri', () => ({
  tauri: {
    clickupListLinks: vi.fn().mockResolvedValue([
      { projectId: 1, taskId: 't1', customId: 'CU-1', name: 'A', status: 'open', url: 'u', linkedAt: 1 },
    ]),
    clickupLinkTask: vi.fn().mockResolvedValue(
      { projectId: 1, taskId: 't2', customId: null, name: 'B', status: null, url: 'u2', linkedAt: 2 }),
    clickupUnlinkTask: vi.fn().mockResolvedValue(undefined),
  },
}));

const makeStore = () => create<ClickUpSlice>()((...a) => createClickUpSlice(...a));

describe('clickupSlice', () => {
  beforeEach(() => vi.clearAllMocks());

  it('loads links for a project', async () => {
    const s = makeStore();
    await s.getState().loadLinks(1);
    expect(s.getState().linksByProject[1]).toHaveLength(1);
    expect(s.getState().linksByProject[1][0].name).toBe('A');
  });

  it('appends a linked task', async () => {
    const s = makeStore();
    await s.getState().loadLinks(1);
    await s.getState().linkTask(1, 't2');
    expect(s.getState().linksByProject[1].map(l => l.taskId)).toContain('t2');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd DesktopApp && npm test -- clickupSlice`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the slice**

Create `clickupSlice.ts` (match the `StateCreator` signature used by the other slices in `store/index.ts`):

```ts
import type { StateCreator } from 'zustand';
import { tauri } from '../lib/tauri';
import type { ClickUpLink } from '../types/ClickUpLink';
import type { ClickUpProjectConfig } from '../types/ClickUpProjectConfig';
import type { ClickUpConnectionStatus } from '../types/ClickUpConnectionStatus';

export interface ClickUpSlice {
  linksByProject: Record<number, ClickUpLink[]>;
  configByProject: Record<number, ClickUpProjectConfig | null>;
  connectionStatus: ClickUpConnectionStatus;
  loadConnectionStatus: () => Promise<void>;
  loadLinks: (projectId: number) => Promise<void>;
  loadConfig: (projectId: number) => Promise<void>;
  linkTask: (projectId: number, taskId: string) => Promise<void>;
  unlinkTask: (projectId: number, taskId: string) => Promise<void>;
}

export const createClickUpSlice: StateCreator<ClickUpSlice, [], [], ClickUpSlice> = (set, get) => ({
  linksByProject: {},
  configByProject: {},
  connectionStatus: 'absent',

  loadConnectionStatus: async () => {
    set({ connectionStatus: await tauri.clickupConnectionStatus() });
  },
  loadLinks: async (projectId) => {
    const links = await tauri.clickupListLinks(projectId);
    set({ linksByProject: { ...get().linksByProject, [projectId]: links } });
  },
  loadConfig: async (projectId) => {
    const config = await tauri.clickupGetConfig(projectId);
    set({ configByProject: { ...get().configByProject, [projectId]: config } });
  },
  linkTask: async (projectId, taskId) => {
    const link = await tauri.clickupLinkTask(projectId, taskId);
    const existing = get().linksByProject[projectId] ?? [];
    const next = [link, ...existing.filter(l => l.taskId !== link.taskId)];
    set({ linksByProject: { ...get().linksByProject, [projectId]: next } });
  },
  unlinkTask: async (projectId, taskId) => {
    await tauri.clickupUnlinkTask(projectId, taskId);
    const existing = get().linksByProject[projectId] ?? [];
    set({ linksByProject: { ...get().linksByProject, [projectId]: existing.filter(l => l.taskId !== taskId) } });
  },
});
```

In `store/index.ts`, import `createClickUpSlice` and `ClickUpSlice`, add `ClickUpSlice` to the combined store type, and spread `...createClickUpSlice(...a)` where the other slices are composed. Do NOT add any ClickUp key to `PERSISTED_KEYS`.

- [ ] **Step 4: Run the test + lint**

Run: `cd DesktopApp && npm test -- clickupSlice && npm run lint`
Expected: PASS; lint clean.

- [ ] **Step 5: Commit**

```bash
git add DesktopApp/src/store/clickupSlice.ts DesktopApp/src/store/clickupSlice.test.ts DesktopApp/src/store/index.ts
git commit -m "feat(clickup): add clickupSlice for links, config, status"
```

### Task 11: Right-panel ClickUp section + scope config

**Files:**
- Create: `DesktopApp/src/components/right/ClickUpSection.tsx`
- Create: `DesktopApp/src/components/right/ClickUpScopeDialog.tsx`
- Modify: `DesktopApp/src/components/right/RightPanel.tsx` (insert section + divider between Actions and Git)
- Test: `DesktopApp/src/components/right/ClickUpSection.test.tsx`

**Interfaces:**
- Consumes: store (`linksByProject`, `loadLinks`, `connectionStatus`, `loadConnectionStatus`, `configByProject`, `loadConfig`), active project id from `tabs`/`activeTabId` (same access pattern as `ActionsSection.tsx`).
- Produces: a section listing linked tasks; `onOpenTask(taskId)` opens the detail dialog (Task 13); a `+ powiąż zadania` button opening the link dialog (Task 12); a scope gear opening `ClickUpScopeDialog`.

- [ ] **Step 1: Write the failing test**

Create `ClickUpSection.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { ClickUpSection } from './ClickUpSection';

vi.mock('../../store', () => ({
  useStore: (sel: any) => sel({
    activeProjectId: 1,
    connectionStatus: 'configured',
    linksByProject: { 1: [{ projectId: 1, taskId: 't1', customId: 'CU-1', name: 'Alpha', status: 'open', url: 'u', linkedAt: 1 }] },
    configByProject: { 1: { projectId: 1, workspaceId: 'w', spaceId: 's', listId: null } },
    loadLinks: vi.fn(), loadConnectionStatus: vi.fn(), loadConfig: vi.fn(),
  }),
}));

describe('ClickUpSection', () => {
  it('renders linked task names', () => {
    render(<ClickUpSection />);
    expect(screen.getByText('Alpha')).toBeInTheDocument();
  });
});
```

> Match how `ActionsSection.tsx` actually reads the active project id; if it derives it from `tabs`/`activeTabId` rather than a single `activeProjectId` selector, mirror that exactly in both the component and this test's mock.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd DesktopApp && npm test -- ClickUpSection`
Expected: FAIL — component not found.

- [ ] **Step 3: Implement `ClickUpScopeDialog`**

Create `ClickUpScopeDialog.tsx` — a standard overlay (`fixed inset-0 bg-black/50 grid place-items-center z-50`) with three dependent selects (workspace → space → list) populated via `tauri.clickupListWorkspaces/listSpaces/listLists`, saved with `tauri.clickupSetConfig(projectId, workspaceId, spaceId, listId)`:

```tsx
import { useEffect, useState } from 'react';
import { tauri } from '../../lib/tauri';
import type { ClickUpWorkspace } from '../../types/ClickUpWorkspace';
import type { ClickUpSpace } from '../../types/ClickUpSpace';
import type { ClickUpList } from '../../types/ClickUpList';

export function ClickUpScopeDialog({ projectId, onClose }: { projectId: number; onClose: () => void }) {
  const [workspaces, setWorkspaces] = useState<ClickUpWorkspace[]>([]);
  const [spaces, setSpaces] = useState<ClickUpSpace[]>([]);
  const [lists, setLists] = useState<ClickUpList[]>([]);
  const [ws, setWs] = useState(''); const [sp, setSp] = useState(''); const [li, setLi] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => { tauri.clickupListWorkspaces().then(setWorkspaces).catch(() => setWorkspaces([])); }, []);
  useEffect(() => { if (ws) tauri.clickupListSpaces(ws).then(setSpaces).catch(() => setSpaces([])); }, [ws]);
  useEffect(() => { if (sp) tauri.clickupListLists(sp).then(setLists).catch(() => setLists([])); }, [sp]);

  const save = async () => {
    setBusy(true);
    try { await tauri.clickupSetConfig(projectId, ws, sp || null, li || null); onClose(); }
    finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 bg-black/50 grid place-items-center z-50" onClick={onClose}>
      <div className="bg-bg-elev border border-border w-[420px] p-4 space-y-3" onClick={e => e.stopPropagation()}>
        <span className="text-[10px] text-muted font-medium uppercase tracking-wider">ZAKRES CLICKUP</span>
        <select className="w-full bg-bg border border-border px-2 py-1.5 text-[13px]" value={ws} onChange={e => setWs(e.target.value)}>
          <option value="">— Workspace —</option>
          {workspaces.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
        </select>
        <select className="w-full bg-bg border border-border px-2 py-1.5 text-[13px]" value={sp} onChange={e => setSp(e.target.value)}>
          <option value="">— Space —</option>
          {spaces.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <select className="w-full bg-bg border border-border px-2 py-1.5 text-[13px]" value={li} onChange={e => setLi(e.target.value)}>
          <option value="">— Lista (opcjonalnie) —</option>
          {lists.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
        <div className="flex justify-end gap-2">
          <button className="px-3 py-1.5 border border-border text-[12px] text-fg-secondary hover:text-fg" onClick={onClose}>Anuluj</button>
          <button disabled={busy || !ws} className="px-3 py-1.5 bg-fg text-bg text-[12px] font-medium disabled:opacity-50" onClick={save}>Zapisz</button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Implement `ClickUpSection`**

Create `ClickUpSection.tsx`. Read the active project id with the SAME pattern `ActionsSection.tsx` uses. Render the standard section header, the linked-task list, and the two dialogs via local state:

```tsx
import { useEffect, useState } from 'react';
import { useStore } from '../../store';
import { LinkClickUpTaskDialog } from '../dialogs/LinkClickUpTaskDialog';
import { ClickUpTaskDialog } from '../dialogs/ClickUpTaskDialog';
import { ClickUpScopeDialog } from './ClickUpScopeDialog';
import { Icon } from '../shared/Icon';

export function ClickUpSection() {
  const activeProjectId = useStore(s => s.activeProjectId);
  const connectionStatus = useStore(s => s.connectionStatus);
  const links = useStore(s => (activeProjectId ? s.linksByProject[activeProjectId] : undefined));
  const config = useStore(s => (activeProjectId ? s.configByProject[activeProjectId] : undefined));
  const loadLinks = useStore(s => s.loadLinks);
  const loadConfig = useStore(s => s.loadConfig);
  const loadConnectionStatus = useStore(s => s.loadConnectionStatus);

  const [linkOpen, setLinkOpen] = useState(false);
  const [scopeOpen, setScopeOpen] = useState(false);
  const [openTaskId, setOpenTaskId] = useState<string | null>(null);

  useEffect(() => { void loadConnectionStatus(); }, [loadConnectionStatus]);
  useEffect(() => { if (activeProjectId) { void loadLinks(activeProjectId); void loadConfig(activeProjectId); } }, [activeProjectId, loadLinks, loadConfig]);

  if (!activeProjectId) return null;

  const list = links ?? [];

  return (
    <section className="shrink-0">
      <div className="flex items-center justify-between mb-3">
        <span className="text-[10px] text-muted font-medium uppercase tracking-wider">ZADANIA CLICKUP</span>
        <button className="text-muted hover:text-fg" title="Zakres" onClick={() => setScopeOpen(true)}>
          <Icon name="settings" className="w-[13px] h-[13px]" />
        </button>
      </div>

      {connectionStatus !== 'configured' ? (
        <p className="text-[11px] text-muted">Skonfiguruj ClickUp w ustawieniach.</p>
      ) : !config ? (
        <p className="text-[11px] text-muted">Ustaw zakres (workspace/space) ikoną powyżej.</p>
      ) : (
        <>
          <div className="space-y-0.5">
            {list.map(l => (
              <button key={l.taskId} onClick={() => setOpenTaskId(l.taskId)}
                className="w-full text-left px-2 py-1 hover:bg-bg-elev-2 text-[11px] flex items-center gap-2">
                <span className="text-muted font-mono">{l.customId ?? l.taskId.slice(0, 6)}</span>
                <span className="flex-1 truncate text-fg">{l.name}</span>
                {l.status && <span className="text-[10px] text-fg-secondary">{l.status}</span>}
              </button>
            ))}
            {list.length === 0 && <p className="text-[11px] text-muted px-2 py-1">Brak powiązanych zadań.</p>}
          </div>
          <button className="mt-2 text-[11px] text-accent hover:underline" onClick={() => setLinkOpen(true)}>+ powiąż zadania</button>
        </>
      )}

      {linkOpen && <LinkClickUpTaskDialog projectId={activeProjectId} onClose={() => setLinkOpen(false)} />}
      {scopeOpen && <ClickUpScopeDialog projectId={activeProjectId} onClose={() => setScopeOpen(false)} />}
      {openTaskId && <ClickUpTaskDialog projectId={activeProjectId} taskId={openTaskId} onClose={() => setOpenTaskId(null)} />}
    </section>
  );
}
```

> If the store has no `activeProjectId` selector, add a small derived selector or compute it from `tabs`/`activeTabId` exactly as `ActionsSection.tsx` does, and use that here and in the test. Keep one source of truth.

- [ ] **Step 5: Insert into `RightPanel.tsx`**

Edit `RightPanel.tsx` to insert the section + a divider between `<ActionsSection />` and `<GitSection />`:

```tsx
<aside className="h-full bg-bg p-4 text-[13px] flex flex-col gap-4">
  <ActionsSection />
  <div className="border-t border-border" />
  <ClickUpSection />
  <div className="border-t border-border" />
  <GitSection />
  <div className="border-t border-border" />
  <UsageSection />
</aside>
```

Add `import { ClickUpSection } from './ClickUpSection';` at the top.

- [ ] **Step 6: Run the test + lint**

Run: `cd DesktopApp && npm test -- ClickUpSection && npm run lint`
Expected: PASS; lint clean. (The test imports `ClickUpSection`, which imports the two dialogs; create empty stub exports for `LinkClickUpTaskDialog`/`ClickUpTaskDialog` returning `null` first if implementing strictly in order, replaced in Tasks 12–13.)

- [ ] **Step 7: Commit**

```bash
git add DesktopApp/src/components/right/ClickUpSection.tsx DesktopApp/src/components/right/ClickUpScopeDialog.tsx DesktopApp/src/components/right/RightPanel.tsx DesktopApp/src/components/right/ClickUpSection.test.tsx
git commit -m "feat(clickup): right-panel section and scope config dialog"
```

### Task 12: Link-task search dialog

**Files:**
- Create: `DesktopApp/src/components/dialogs/LinkClickUpTaskDialog.tsx`
- Test: `DesktopApp/src/components/dialogs/LinkClickUpTaskDialog.test.tsx`

**Interfaces:**
- Consumes: `tauri.clickupSearchTasks`, store `linkTask`, existing `linksByProject` (to mark already-linked).
- Props: `{ projectId: number; onClose: () => void }`.

- [ ] **Step 1: Write the failing test**

```tsx
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LinkClickUpTaskDialog } from './LinkClickUpTaskDialog';

const linkTask = vi.fn().mockResolvedValue(undefined);
vi.mock('../../store', () => ({ useStore: (sel: any) => sel({ linkTask, linksByProject: { 1: [] } }) }));
vi.mock('../../lib/tauri', () => ({ tauri: {
  clickupSearchTasks: vi.fn().mockResolvedValue([{ id: 't9', customId: 'CU-9', name: 'Found', status: 'open', url: 'u', listName: null }]),
}}));

describe('LinkClickUpTaskDialog', () => {
  beforeEach(() => vi.clearAllMocks());
  it('searches and links a task', async () => {
    render(<LinkClickUpTaskDialog projectId={1} onClose={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText('Szukaj po nazwie lub wklej ID/URL…'), { target: { value: 'Found' } });
    await waitFor(() => expect(screen.getByText('Found')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Found'));
    await waitFor(() => expect(linkTask).toHaveBeenCalledWith(1, 't9'));
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd DesktopApp && npm test -- LinkClickUpTaskDialog`
Expected: FAIL.

- [ ] **Step 3: Implement the dialog**

```tsx
import { useEffect, useState } from 'react';
import { useStore } from '../../store';
import { tauri } from '../../lib/tauri';
import type { ClickUpTaskRef } from '../../types/ClickUpTaskRef';
import { Icon } from '../shared/Icon';

export function LinkClickUpTaskDialog({ projectId, onClose }: { projectId: number; onClose: () => void }) {
  const linkTask = useStore(s => s.linkTask);
  const linked = useStore(s => s.linksByProject[projectId] ?? []);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<ClickUpTaskRef[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) { setResults([]); return; }
    let cancelled = false;
    const t = setTimeout(async () => {
      setBusy(true); setError(null);
      try {
        const r = await tauri.clickupSearchTasks(projectId, q);
        if (!cancelled) setResults(r);
      } catch (e) {
        if (!cancelled) { setResults([]); setError(String(e)); }
      } finally { if (!cancelled) setBusy(false); }
    }, 300);
    return () => { cancelled = true; clearTimeout(t); };
  }, [query, projectId]);

  const isLinked = (id: string) => linked.some(l => l.taskId === id);
  const onPick = async (id: string) => { await linkTask(projectId, id); onClose(); };

  return (
    <div className="fixed inset-0 bg-black/50 grid place-items-center z-50" onClick={onClose}>
      <div className="bg-bg-elev border border-border w-[560px] max-h-[70vh] flex flex-col p-4" onClick={e => e.stopPropagation()}>
        <div className="flex items-center gap-2 px-2.5 py-[7px] bg-bg border border-border rounded-md mb-3">
          <Icon name="search" className="w-[13px] h-[13px] text-muted" />
          <input autoFocus value={query} onChange={e => setQuery(e.target.value)}
            placeholder="Szukaj po nazwie lub wklej ID/URL…"
            className="bg-transparent outline-none text-[12px] text-fg flex-1 placeholder:text-muted" />
        </div>
        {busy && <p className="text-[11px] text-muted px-2">Szukam…</p>}
        {error && <p className="text-[11px] text-danger px-2">{error}</p>}
        <div className="space-y-0.5 overflow-auto">
          {results.map(t => (
            <button key={t.id} disabled={isLinked(t.id)} onClick={() => onPick(t.id)}
              className="w-full text-left px-2 py-1 hover:bg-bg-elev-2 text-[11px] flex items-center gap-2 disabled:opacity-40">
              <span className="text-muted font-mono">{t.customId ?? t.id.slice(0, 6)}</span>
              <span className="flex-1 truncate text-fg">{t.name}</span>
              {isLinked(t.id) && <span className="text-[10px] text-fg-secondary">powiązane</span>}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run the test + lint**

Run: `cd DesktopApp && npm test -- LinkClickUpTaskDialog && npm run lint`
Expected: PASS; lint clean.

- [ ] **Step 5: Commit**

```bash
git add DesktopApp/src/components/dialogs/LinkClickUpTaskDialog.tsx DesktopApp/src/components/dialogs/LinkClickUpTaskDialog.test.tsx
git commit -m "feat(clickup): link-task search dialog"
```

### Task 13: Task detail popup + file handle (copy/inject)

**Files:**
- Modify: `DesktopApp/src-tauri/src/commands/clickup.rs` (`clickup_write_task_file` + `render_task_markdown` + `ensure_gitignore`)
- Modify: `DesktopApp/src-tauri/src/lib.rs` (register)
- Modify: `DesktopApp/src/lib/tauri.ts` (wrapper)
- Modify: `DesktopApp/src/store/<terminal-pty-slice>` and `DesktopApp/src/components/terminal/TerminalView.tsx` (expose the focused agent PTY id)
- Create: `DesktopApp/src/components/dialogs/ClickUpTaskDialog.tsx`
- Test: inline Rust `#[cfg(test)]` for `render_task_markdown`; `DesktopApp/src/components/dialogs/ClickUpTaskDialog.test.tsx`

**Interfaces:**
- Produces command `clickup_write_task_file(projectId, taskId) -> String` (relative path).
- Produces store field `activeAgentPtyId: string | null` + `setActiveAgentPtyId(id | null)`.
- Props: `{ projectId: number; taskId: string; onClose: () => void }`.

- [ ] **Step 1: Write the failing Rust test for markdown**

Add to the `tests` module in `commands/clickup.rs`:

```rust
    #[test]
    fn render_task_markdown_includes_name_description_comments() {
        use crate::domain::clickup::{ClickUpTaskDetail, ClickUpComment, ClickUpAttachment};
        let d = ClickUpTaskDetail {
            id: "t1".into(), custom_id: Some("CU-1".into()), name: "Fix".into(),
            description: "Body".into(), status: Some("open".into()),
            url: "https://app.clickup.com/t/t1".into(),
            attachments: vec![ClickUpAttachment { id: "a".into(), title: "log".into(), url: "https://f/a".into() }],
            comments: vec![ClickUpComment { id: "c".into(), user: "ann".into(), text: "hi".into(), date: 0 }],
        };
        let md = render_task_markdown(&d);
        assert!(md.contains("# CU-1 Fix"));
        assert!(md.contains("Body"));
        assert!(md.contains("ann"));
        assert!(md.contains("log"));
    }
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd DesktopApp && cargo test --manifest-path src-tauri/Cargo.toml commands::clickup`
Expected: FAIL — `render_task_markdown` undefined.

- [ ] **Step 3: Implement the file command**

Append to `commands/clickup.rs` (add `use std::io::Write;` near the top):

```rust
fn render_task_markdown(d: &crate::domain::clickup::ClickUpTaskDetail) -> String {
    let title = match &d.custom_id { Some(c) => format!("{c} {}", d.name), None => d.name.clone() };
    let mut out = format!("# {title}\n\n");
    if let Some(s) = &d.status { out.push_str(&format!("**Status:** {s}\n\n")); }
    out.push_str(&format!("**URL:** {}\n\n## Opis\n\n{}\n\n", d.url, d.description));
    if !d.attachments.is_empty() {
        out.push_str("## Załączniki\n\n");
        for a in &d.attachments { out.push_str(&format!("- [{}]({})\n", a.title, a.url)); }
        out.push('\n');
    }
    if !d.comments.is_empty() {
        out.push_str("## Komentarze\n\n");
        for c in &d.comments { out.push_str(&format!("**{}:** {}\n\n", c.user, c.text)); }
    }
    out
}

fn ensure_gitignore(project_path: &str) -> std::io::Result<()> {
    let path = std::path::Path::new(project_path).join(".gitignore");
    let existing = std::fs::read_to_string(&path).unwrap_or_default();
    if existing.lines().any(|l| l.trim() == ".abeon/") { return Ok(()); }
    let mut f = std::fs::OpenOptions::new().create(true).append(true).open(&path)?;
    let prefix = if existing.is_empty() || existing.ends_with('\n') { "" } else { "\n" };
    write!(f, "{prefix}.abeon/\n")?;
    Ok(())
}

#[tauri::command]
pub async fn clickup_write_task_file(state: State<'_, AppState>, project_id: i64, task_id: String)
    -> AppResult<String>
{
    let project_path = {
        let c = state.db.get()?;
        projects_repo::get(&c, project_id)?.path
    };
    let detail = load_client(&state)?
        .get_task_detail(&task_id, false, None).await
        .map_err(|e| AppError::Other(e.to_string()))?;
    let rel = format!(".abeon/clickup/{task_id}.md");
    let abs = std::path::Path::new(&project_path).join(&rel);
    if let Some(dir) = abs.parent() { std::fs::create_dir_all(dir)?; }
    std::fs::write(&abs, render_task_markdown(&detail))?;
    ensure_gitignore(&project_path)?;
    Ok(rel)
}
```

Register `commands::clickup::clickup_write_task_file` in `lib.rs`. Add the wrapper to `tauri.ts`:

```ts
  clickupWriteTaskFile: (projectId: number, taskId: string) =>
    invoke<string>('clickup_write_task_file', { projectId, taskId }),
```

- [ ] **Step 4: Run the Rust test + expose the active agent PTY id**

Run: `cd DesktopApp && cargo test --manifest-path src-tauri/Cargo.toml commands::clickup`
Expected: PASS.

Add a tiny store field for the focused agent PTY (put it in the slice that already holds terminal/tab UI state, e.g. `tabsSlice`, mirroring how `runningActions[*].ptyId` is tracked):

```ts
activeAgentPtyId: null as string | null,
setActiveAgentPtyId: (id: string | null) => set({ activeAgentPtyId: id }),
```

In `TerminalView.tsx`, for the **agent** PTY kind only, call `setActiveAgentPtyId(id)` when the view becomes visible/focused and `setActiveAgentPtyId(null)` on cleanup — reuse the existing visibility effect; do NOT call `term.dispose()` (webkit crash). This mirrors the existing Ctrl+V image-paste injection target.

- [ ] **Step 5: Write the failing dialog test**

Create `ClickUpTaskDialog.test.tsx`:

```tsx
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ClickUpTaskDialog } from './ClickUpTaskDialog';

vi.mock('../../store', () => ({ useStore: (sel: any) => sel({ activeAgentPtyId: 'pty-1', unlinkTask: vi.fn() }) }));
vi.mock('../../lib/tauri', () => ({ tauri: {
  clickupGetTask: vi.fn().mockResolvedValue({ id: 't1', customId: 'CU-1', name: 'Fix', description: 'Body', status: 'open', url: 'u', attachments: [], comments: [] }),
  clickupWriteTaskFile: vi.fn().mockResolvedValue('.abeon/clickup/t1.md'),
  writeClipboardText: vi.fn().mockResolvedValue(undefined),
}}));
import { tauri } from '../../lib/tauri';

describe('ClickUpTaskDialog', () => {
  beforeEach(() => vi.clearAllMocks());
  it('copies the handle after regenerating the file', async () => {
    render(<ClickUpTaskDialog projectId={1} taskId="t1" onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText('Fix')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Kopiuj uchwyt'));
    await waitFor(() => expect(tauri.clickupWriteTaskFile).toHaveBeenCalledWith(1, 't1'));
    await waitFor(() => expect(tauri.writeClipboardText).toHaveBeenCalledWith('@.abeon/clickup/t1.md'));
  });
});
```

If `tauri.writeClipboardText` does not yet exist, add the wrapper for the existing `write_clipboard_text` command: `writeClipboardText: (text: string) => invoke<void>('write_clipboard_text', { text }),`.

- [ ] **Step 6: Run the dialog test to verify it fails**

Run: `cd DesktopApp && npm test -- ClickUpTaskDialog`
Expected: FAIL — component not found.

- [ ] **Step 7: Implement `ClickUpTaskDialog`**

```tsx
import { useEffect, useState } from 'react';
import { useStore } from '../../store';
import { tauri } from '../../lib/tauri';
import type { ClickUpTaskDetail } from '../../types/ClickUpTaskDetail';
import { Icon } from '../shared/Icon';

export function ClickUpTaskDialog({ projectId, taskId, onClose }: { projectId: number; taskId: string; onClose: () => void }) {
  const activeAgentPtyId = useStore(s => s.activeAgentPtyId);
  const unlinkTask = useStore(s => s.unlinkTask);
  const [detail, setDetail] = useState<ClickUpTaskDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setError(null);
    try { setDetail(await tauri.clickupGetTask(taskId)); }
    catch (e) { setError(String(e)); }
  };
  useEffect(() => { let c = false; (async () => { try { const d = await tauri.clickupGetTask(taskId); if (!c) setDetail(d); } catch (e) { if (!c) setError(String(e)); } })(); return () => { c = true; }; }, [taskId]);

  const handle = async () => {
    setBusy(true);
    try { const rel = await tauri.clickupWriteTaskFile(projectId, taskId); return `@${rel}`; }
    finally { setBusy(false); }
  };
  const onCopy = async () => { await tauri.writeClipboardText(await handle()); };
  const onInject = async () => {
    if (!activeAgentPtyId) return;
    const text = await handle();
    const enc = btoa(unescape(encodeURIComponent(text)));
    await tauri.ptyWrite(activeAgentPtyId, enc);
  };
  const onUnlink = async () => { await unlinkTask(projectId, taskId); onClose(); };

  return (
    <div className="fixed inset-0 bg-black/50 grid place-items-center z-50" onClick={onClose}>
      <div className="bg-bg-elev border border-border w-[640px] max-h-[85vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3 border-b border-border">
          <span className="text-[13px] text-fg truncate">{detail ? `${detail.customId ?? ''} ${detail.name}`.trim() : 'Ładowanie…'}</span>
          <button onClick={onClose}><Icon name="close" className="w-[14px] h-[14px] text-muted hover:text-fg" /></button>
        </div>
        <div className="flex-1 min-h-0 overflow-auto p-5 text-[12px] text-fg">
          {error && <p className="text-danger">{error}</p>}
          {detail && (
            <>
              {detail.status && <p className="text-fg-secondary mb-2">Status: {detail.status}</p>}
              <pre className="whitespace-pre-wrap font-sans mb-4">{detail.description || '(brak opisu)'}</pre>
              {detail.attachments.length > 0 && (
                <div className="mb-4">
                  <p className="text-muted uppercase text-[10px] tracking-wider mb-1">Załączniki</p>
                  {detail.attachments.map(a => <a key={a.id} href={a.url} target="_blank" rel="noreferrer" className="block text-accent hover:underline">{a.title}</a>)}
                </div>
              )}
              {detail.comments.length > 0 && (
                <div>
                  <p className="text-muted uppercase text-[10px] tracking-wider mb-1">Komentarze</p>
                  {detail.comments.map(c => <p key={c.id} className="mb-2"><span className="text-fg-secondary">{c.user}:</span> {c.text}</p>)}
                </div>
              )}
            </>
          )}
        </div>
        <div className="flex items-center gap-2 px-5 py-3 border-t border-border">
          <button disabled={busy} onClick={onCopy} className="px-3 py-1.5 border border-border text-[12px] text-fg-secondary hover:text-fg">Kopiuj uchwyt</button>
          <button disabled={busy || !activeAgentPtyId} onClick={onInject} title={activeAgentPtyId ? '' : 'Brak aktywnej sesji'} className="px-3 py-1.5 border border-border text-[12px] text-fg-secondary hover:text-fg disabled:opacity-40">Wstaw do aktywnej sesji</button>
          <button disabled={busy} onClick={load} className="px-3 py-1.5 border border-border text-[12px] text-fg-secondary hover:text-fg">Odśwież</button>
          <div className="flex-1" />
          <button onClick={onUnlink} className="px-3 py-1.5 border border-border text-[12px] text-danger hover:text-danger">Odepnij</button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 8: Run the dialog test + lint**

Run: `cd DesktopApp && npm test -- ClickUpTaskDialog && npm run lint`
Expected: PASS; lint clean.

- [ ] **Step 9: Commit**

```bash
git add DesktopApp/src-tauri/src/commands/clickup.rs DesktopApp/src-tauri/src/lib.rs DesktopApp/src/lib/tauri.ts DesktopApp/src/store DesktopApp/src/components/terminal/TerminalView.tsx DesktopApp/src/components/dialogs/ClickUpTaskDialog.tsx DesktopApp/src/components/dialogs/ClickUpTaskDialog.test.tsx
git commit -m "feat(clickup): task detail popup with file handle copy and inject"
```

**Phase 2 gate:** `cd DesktopApp && npm run test:rust && npm test && npm run lint` all green. You can set scope, link tasks (ID/URL or name), view details, and paste the handle into a session.

---

## Phase 3 — Work summary → comment

Outcome: generate a concise work summary from the active session, edit it, and post it as a comment on the viewed task.

### Task 14: Extract reusable model-prompt helper

**Files:**
- Modify: `DesktopApp/src-tauri/src/commands/sessions.rs` (extract `run_agent_prompt`, refactor `generate_session_title` to use it — no behavior change)

**Interfaces:**
- Produces: `pub(crate) async fn run_agent_prompt(provider: Provider, model: Option<String>, prompt: String, cwd: std::path::PathBuf) -> AppResult<String>` returning the model's raw stdout (Claude) / output-file contents (Codex), with the existing 60s/90s timeouts and `kill_on_drop`.

- [ ] **Step 1: Add `run_agent_prompt`**

In `commands/sessions.rs`, extract the provider `match` body currently inside `generate_session_title` (lines ~236-294) into:

```rust
pub(crate) async fn run_agent_prompt(
    provider: Provider,
    model: Option<String>,
    prompt: String,
    cwd: std::path::PathBuf,
) -> AppResult<String> {
    match provider {
        Provider::Claude => {
            let mut cmd = tokio::process::Command::new("claude");
            cmd.arg("-p").arg("--no-session-persistence").arg(&prompt);
            if let Some(m) = &model {
                if !m.is_empty() { cmd.arg("--model").arg(m); }
            }
            cmd.current_dir(&cwd);
            cmd.kill_on_drop(true);
            let timeout = std::time::Duration::from_secs(60);
            let output = tokio::time::timeout(timeout, cmd.output()).await
                .map_err(|_| AppError::Other("Wywołanie claude -p przekroczyło limit 60s".into()))?
                .map_err(|e| AppError::Other(format!("claude -p: {e}")))?;
            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr);
                return Err(AppError::Other(format!("claude -p failed: {}", stderr.trim())));
            }
            Ok(String::from_utf8_lossy(&output.stdout).to_string())
        }
        Provider::Codex => {
            let out_file = std::env::temp_dir().join(format!("abeoncode-prompt-{}.txt", uuid::Uuid::new_v4()));
            let mut cmd = tokio::process::Command::new("codex");
            cmd.arg("exec").arg("--ephemeral").arg("--skip-git-repo-check")
                .arg("--color").arg("never").arg("-o").arg(&out_file);
            if let Some(m) = &model {
                if !m.is_empty() { cmd.arg("-m").arg(m); }
            }
            cmd.arg(&prompt);
            cmd.current_dir(std::env::temp_dir());
            cmd.kill_on_drop(true);
            let timeout = std::time::Duration::from_secs(90);
            let output = tokio::time::timeout(timeout, cmd.output()).await
                .map_err(|_| AppError::Other("Wywołanie codex exec przekroczyło limit 90s".into()))?
                .map_err(|e| AppError::Other(format!("codex exec: {e}")))?;
            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr);
                return Err(AppError::Other(format!("codex exec failed: {}", stderr.trim())));
            }
            let raw = std::fs::read_to_string(&out_file);
            let _ = std::fs::remove_file(&out_file);
            raw.map_err(|e| AppError::Other(format!("codex exec: nie można odczytać pliku wyjściowego: {e}")))
        }
    }
}
```

- [ ] **Step 2: Refactor `generate_session_title` to call it**

Replace the `match prov { ... }` tail of `generate_session_title` with:

```rust
    let raw = run_agent_prompt(prov, model, prompt, std::path::PathBuf::from(proj_path)).await?;
    let cleaned = clean_title(&raw);
    if cleaned.is_empty() {
        return Err(AppError::Other("Pusta odpowiedź modelu".into()));
    }
    Ok(cleaned)
```

- [ ] **Step 3: Verify no behavior change**

Run: `cd DesktopApp && cargo build --manifest-path src-tauri/Cargo.toml && cargo test --manifest-path src-tauri/Cargo.toml sessions`
Expected: builds; existing session tests still pass.

- [ ] **Step 4: Commit**

```bash
git add DesktopApp/src-tauri/src/commands/sessions.rs
git commit -m "refactor(clickup): extract run_agent_prompt helper from title generation"
```

### Task 15: Summary generation command

**Files:**
- Modify: `DesktopApp/src-tauri/src/commands/clickup.rs` (`build_summary_prompt` + `clickup_generate_summary`)
- Modify: `DesktopApp/src-tauri/src/lib.rs` (register)
- Modify: `DesktopApp/src/lib/tauri.ts` (wrapper)
- Test: inline `#[cfg(test)]` for `build_summary_prompt`

**Interfaces:**
- Consumes: `commands::sessions::{history_blocks_for_session, run_agent_prompt}` (confirm `history_blocks_for_session` is `pub(crate)`; if it is private, widen it to `pub(crate)`), `domain::{Provider, HistoryBlock}`.
- Produces command `clickup_generate_summary(projectId, sessionId, provider?) -> String`.

- [ ] **Step 1: Write the failing test**

Add to the `tests` module in `commands/clickup.rs`:

```rust
    #[test]
    fn build_summary_prompt_embeds_transcript_and_instruction() {
        use crate::domain::HistoryBlock;
        let blocks = vec![
            HistoryBlock::UserText { uuid: "1".into(), timestamp: 1, text: "dodaj logowanie".into() },
            HistoryBlock::AssistantText { uuid: "2".into(), timestamp: 2, text: "zrobione".into() },
        ];
        let p = build_summary_prompt(&blocks);
        assert!(p.contains("dodaj logowanie"));
        assert!(p.to_lowercase().contains("podsumowanie"));
    }
```

> Match the EXACT field set of `HistoryBlock::UserText`/`AssistantText` from `domain/session.rs` when constructing the test blocks (field names/order). Adjust if the variants carry more fields.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd DesktopApp && cargo test --manifest-path src-tauri/Cargo.toml commands::clickup`
Expected: FAIL — `build_summary_prompt` undefined.

- [ ] **Step 3: Implement**

Append to `commands/clickup.rs` (add imports `use crate::domain::{Provider, HistoryBlock};`):

```rust
fn build_summary_prompt(blocks: &[HistoryBlock]) -> String {
    let mut t = String::new();
    for b in blocks {
        match b {
            HistoryBlock::UserText { text, .. } => t.push_str(&format!("UŻYTKOWNIK: {text}\n")),
            HistoryBlock::AssistantText { text, .. } => t.push_str(&format!("ASYSTENT: {text}\n")),
            HistoryBlock::ToolUse { name, input_summary, .. } => t.push_str(&format!("NARZĘDZIE {name}: {input_summary}\n")),
            _ => {}
        }
    }
    let transcript: String = t.chars().take(12000).collect();
    format!(
        "Na podstawie poniższego zapisu sesji programistycznej przygotuj ZWIĘZŁE podsumowanie zrealizowanych prac do wklejenia w zadaniu ClickUp.\n\n\
        Pisz po polsku, rzeczowo, w punktach (3–7 punktów). Skup się na tym, co zostało ZROBIONE i zmienione; pomiń dygresje.\n\n\
        Odpowiedz wyłącznie treścią podsumowania — bez nagłówków i komentarza.\n\n\
        Zapis sesji:\n<<<\n{transcript}\n>>>"
    )
}

#[tauri::command]
pub async fn clickup_generate_summary(
    state: State<'_, AppState>, project_id: i64, session_id: String, provider: Option<Provider>,
) -> AppResult<String> {
    let prov = provider.unwrap_or(Provider::Claude);
    let (proj_path, blocks) = {
        let c = state.db.get()?;
        let path = projects_repo::get(&c, project_id)?.path;
        let blocks = crate::commands::sessions::history_blocks_for_session(&c, &session_id)?;
        (path, blocks)
    };
    if blocks.is_empty() {
        return Err(AppError::Other("Sesja nie zawiera historii".into()));
    }
    let prompt = build_summary_prompt(&blocks);
    let raw = crate::commands::sessions::run_agent_prompt(prov, None, prompt, std::path::PathBuf::from(proj_path)).await?;
    let trimmed = raw.trim().to_string();
    if trimmed.is_empty() {
        return Err(AppError::Other("Pusta odpowiedź modelu".into()));
    }
    Ok(trimmed)
}
```

Register `commands::clickup::clickup_generate_summary` in `lib.rs`. Add the wrapper to `tauri.ts` (import `Provider` type):

```ts
  clickupGenerateSummary: (projectId: number, sessionId: string, provider?: Provider) =>
    invoke<string>('clickup_generate_summary', { projectId, sessionId, provider }),
```

- [ ] **Step 4: Run the test + build**

Run: `cd DesktopApp && cargo test --manifest-path src-tauri/Cargo.toml commands::clickup && npm run lint`
Expected: PASS; lint clean.

- [ ] **Step 5: Commit**

```bash
git add DesktopApp/src-tauri/src/commands/clickup.rs DesktopApp/src-tauri/src/lib.rs DesktopApp/src/lib/tauri.ts
git commit -m "feat(clickup): generate work summary from session via the model"
```

### Task 16: Post-comment command + summary dialog

**Files:**
- Modify: `DesktopApp/src-tauri/src/clickup/mod.rs` (`post_comment`)
- Modify: `DesktopApp/src-tauri/src/commands/clickup.rs` (`clickup_post_comment`)
- Modify: `DesktopApp/src-tauri/src/lib.rs` (register)
- Modify: `DesktopApp/src/lib/tauri.ts` (wrapper)
- Create: `DesktopApp/src/components/dialogs/ClickUpSummaryDialog.tsx`
- Modify: `DesktopApp/src/components/dialogs/ClickUpTaskDialog.tsx` (add "Generuj podsumowanie" trigger)
- Test: inline wiremock test for `post_comment`; `DesktopApp/src/components/dialogs/ClickUpSummaryDialog.test.tsx`

**Interfaces:**
- Consumes: `tauri.clickupGenerateSummary`, `tauri.clickupPostComment`, an active-session selector `selectActiveSession(state) -> { sessionId: string; provider: Provider } | null` (derive from `tabsSlice`/`activeTabId`; session tabs already carry `sessionId` + `provider`).
- Produces command `clickup_post_comment(taskId, text)`; component `ClickUpSummaryDialog`.

- [ ] **Step 1: Write the failing wiremock test for `post_comment`**

Add to the `tests` module in `clickup/mod.rs`:

```rust
    #[tokio::test]
    async fn post_comment_sends_body() {
        let server = MockServer::start().await;
        Mock::given(method("POST")).and(path("/task/t1/comment"))
            .and(wiremock::matchers::body_json(serde_json::json!({ "comment_text": "done" })))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({ "id": "c1" })))
            .mount(&server).await;
        let c = ClickUpClient::with_base("pk", server.uri());
        c.post_comment("t1", "done").await.unwrap();
    }
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd DesktopApp && cargo test --manifest-path src-tauri/Cargo.toml clickup::tests::post_comment_sends_body`
Expected: FAIL — `post_comment` undefined.

- [ ] **Step 3: Implement `post_comment` + command**

Add to `clickup/mod.rs` `impl ClickUpClient`:

```rust
    pub async fn post_comment(&self, task_id: &str, text: &str) -> Result<(), ClickUpError> {
        let resp = self.http
            .post(self.url(&format!("/task/{task_id}/comment")))
            .header("Authorization", &self.token)
            .json(&serde_json::json!({ "comment_text": text }))
            .send().await
            .map_err(|e| ClickUpError::Offline(e.to_string()))?;
        Self::ok(resp).await.map(|_| ())
    }
```

Add to `commands/clickup.rs`:

```rust
#[tauri::command]
pub async fn clickup_post_comment(state: State<'_, AppState>, task_id: String, text: String) -> AppResult<()> {
    load_client(&state)?.post_comment(&task_id, &text).await.map_err(|e| AppError::Other(e.to_string()))
}
```

Register `commands::clickup::clickup_post_comment` in `lib.rs`. Add wrapper:

```ts
  clickupPostComment: (taskId: string, text: string) =>
    invoke<void>('clickup_post_comment', { taskId, text }),
```

- [ ] **Step 4: Run the Rust test**

Run: `cd DesktopApp && cargo test --manifest-path src-tauri/Cargo.toml clickup::tests::post_comment_sends_body`
Expected: PASS.

- [ ] **Step 5: Write the failing dialog test**

Create `ClickUpSummaryDialog.test.tsx`:

```tsx
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ClickUpSummaryDialog } from './ClickUpSummaryDialog';

vi.mock('../../store', () => ({
  useStore: (sel: any) => sel({ activeSession: { sessionId: 's1', provider: 'claude' } }),
}));
vi.mock('../../lib/tauri', () => ({ tauri: {
  clickupGenerateSummary: vi.fn().mockResolvedValue('- zrobiono X'),
  clickupPostComment: vi.fn().mockResolvedValue(undefined),
}}));
import { tauri } from '../../lib/tauri';

describe('ClickUpSummaryDialog', () => {
  beforeEach(() => vi.clearAllMocks());
  it('generates then posts the summary as a comment', async () => {
    render(<ClickUpSummaryDialog projectId={1} taskId="t1" onClose={() => {}} />);
    await waitFor(() => expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toContain('zrobiono X'));
    fireEvent.click(screen.getByText('Wyślij jako komentarz'));
    await waitFor(() => expect(tauri.clickupPostComment).toHaveBeenCalledWith('t1', '- zrobiono X'));
  });
});
```

> The mock exposes the active session as a single `activeSession` selector. Implement `selectActiveSession` (or an `activeSession` store getter) and read it the same way in the component and test.

- [ ] **Step 6: Run the dialog test to verify it fails**

Run: `cd DesktopApp && npm test -- ClickUpSummaryDialog`
Expected: FAIL — component not found.

- [ ] **Step 7: Implement `ClickUpSummaryDialog`**

```tsx
import { useEffect, useState } from 'react';
import { useStore } from '../../store';
import { tauri } from '../../lib/tauri';

export function ClickUpSummaryDialog({ projectId, taskId, onClose }: { projectId: number; taskId: string; onClose: () => void }) {
  const activeSession = useStore(s => s.activeSession);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!activeSession) { setError('Brak aktywnej sesji.'); return; }
    let cancelled = false;
    setBusy(true);
    tauri.clickupGenerateSummary(projectId, activeSession.sessionId, activeSession.provider)
      .then(s => { if (!cancelled) setText(s); })
      .catch(e => { if (!cancelled) setError(String(e)); })
      .finally(() => { if (!cancelled) setBusy(false); });
    return () => { cancelled = true; };
  }, [projectId, activeSession]);

  const post = async () => {
    setBusy(true);
    try { await tauri.clickupPostComment(taskId, text); onClose(); }
    catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 bg-black/50 grid place-items-center z-50" onClick={onClose}>
      <div className="bg-bg-elev border border-border w-[640px] max-h-[80vh] flex flex-col p-4 gap-3" onClick={e => e.stopPropagation()}>
        <span className="text-[10px] text-muted font-medium uppercase tracking-wider">PODSUMOWANIE PRAC</span>
        {error && <p className="text-[11px] text-danger">{error}</p>}
        {busy && !text && <p className="text-[11px] text-muted">Generuję podsumowanie…</p>}
        <textarea value={text} onChange={e => setText(e.target.value)} rows={12}
          className="w-full bg-bg border border-border px-3 py-2 text-[12px] font-mono resize-none" />
        <div className="flex justify-end gap-2">
          <button className="px-3 py-1.5 border border-border text-[12px] text-fg-secondary hover:text-fg" onClick={onClose}>Anuluj</button>
          <button disabled={busy || !text.trim()} onClick={post}
            className="px-3 py-1.5 bg-fg text-bg text-[12px] font-medium disabled:opacity-50">Wyślij jako komentarz</button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 8: Wire the trigger into `ClickUpTaskDialog`**

In `ClickUpTaskDialog.tsx`, add local state `const [summaryOpen, setSummaryOpen] = useState(false);`, a footer button before "Odepnij":

```tsx
<button disabled={busy} onClick={() => setSummaryOpen(true)} className="px-3 py-1.5 border border-border text-[12px] text-fg-secondary hover:text-fg">Generuj podsumowanie</button>
```

and render at the end of the panel:

```tsx
{summaryOpen && <ClickUpSummaryDialog projectId={projectId} taskId={taskId} onClose={() => setSummaryOpen(false)} />}
```

Add `import { ClickUpSummaryDialog } from './ClickUpSummaryDialog';`.

- [ ] **Step 9: Run tests + lint**

Run: `cd DesktopApp && npm test -- ClickUpSummaryDialog && npm run lint`
Expected: PASS; lint clean.

- [ ] **Step 10: Commit**

```bash
git add DesktopApp/src-tauri/src/clickup/mod.rs DesktopApp/src-tauri/src/commands/clickup.rs DesktopApp/src-tauri/src/lib.rs DesktopApp/src/lib/tauri.ts DesktopApp/src/components/dialogs/ClickUpSummaryDialog.tsx DesktopApp/src/components/dialogs/ClickUpSummaryDialog.test.tsx DesktopApp/src/components/dialogs/ClickUpTaskDialog.tsx
git commit -m "feat(clickup): post work summary as a task comment"
```

**Phase 3 gate:** `cd DesktopApp && npm run test:rust && npm test && npm run lint` all green. From a task you can generate a session summary and post it as a ClickUp comment.

---

## Phase 4 — Time tracking (final)

Outcome: estimate work time from the active session (idle-trimmed) plus a model dev-time estimate, blend with a slider, and write a time entry to the task.

### Task 17: Time-estimate command

**Files:**
- Modify: `DesktopApp/src-tauri/src/commands/clickup.rs` (`block_ts`, `active_session_ms`, `parse_minutes`, `build_time_prompt`, `clickup_estimate_time`)
- Modify: `DesktopApp/src-tauri/src/lib.rs` (register)
- Modify: `DesktopApp/src/lib/tauri.ts` (wrapper)
- Test: inline `#[cfg(test)]` for `active_session_ms` and `parse_minutes`

**Interfaces:**
- Produces command `clickup_estimate_time(projectId, sessionId, provider?) -> TimeEstimate` (`{ sessionMs, devEstimateMs }`).
- Constant: `const IDLE_CAP_MS: i64 = 5 * 60 * 1000;`.

- [ ] **Step 1: Write the failing tests**

Add to the `tests` module in `commands/clickup.rs`:

```rust
    #[test]
    fn active_session_ms_caps_idle_gaps() {
        use crate::domain::HistoryBlock;
        let b = |ts: i64| HistoryBlock::UserText { uuid: ts.to_string(), timestamp: ts, text: "x".into() };
        // deltas: 60s, then 1h (capped to 5min)
        let blocks = vec![b(0), b(60_000), b(60_000 + 3_600_000)];
        assert_eq!(active_session_ms(&blocks, 5 * 60 * 1000), 60_000 + 5 * 60 * 1000);
    }

    #[test]
    fn parse_minutes_reads_first_integer() {
        assert_eq!(parse_minutes("Około 90 minut"), Some(90));
        assert_eq!(parse_minutes("120"), Some(120));
        assert_eq!(parse_minutes("brak"), None);
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd DesktopApp && cargo test --manifest-path src-tauri/Cargo.toml commands::clickup`
Expected: FAIL — fns undefined.

- [ ] **Step 3: Implement**

Append to `commands/clickup.rs` (add `use crate::domain::clickup::TimeEstimate;`):

```rust
const IDLE_CAP_MS: i64 = 5 * 60 * 1000;

fn block_ts(b: &HistoryBlock) -> i64 {
    match b {
        HistoryBlock::UserText { timestamp, .. }
        | HistoryBlock::AssistantText { timestamp, .. }
        | HistoryBlock::AssistantThinking { timestamp, .. }
        | HistoryBlock::ToolUse { timestamp, .. }
        | HistoryBlock::ToolResult { timestamp, .. }
        | HistoryBlock::Attachment { timestamp, .. }
        | HistoryBlock::System { timestamp, .. } => *timestamp,
    }
}

fn active_session_ms(blocks: &[HistoryBlock], idle_cap_ms: i64) -> i64 {
    let mut ts: Vec<i64> = blocks.iter().map(block_ts).collect();
    ts.sort_unstable();
    ts.windows(2).map(|w| (w[1] - w[0]).clamp(0, idle_cap_ms)).sum()
}

fn parse_minutes(raw: &str) -> Option<i64> {
    let mut digits = String::new();
    for ch in raw.chars() {
        if ch.is_ascii_digit() { digits.push(ch); }
        else if !digits.is_empty() { break; }
    }
    digits.parse().ok()
}

fn build_time_prompt(blocks: &[HistoryBlock]) -> String {
    let prompt_body = build_summary_prompt(blocks);
    format!(
        "Poniżej zapis sesji programistycznej (w sekcji 'Zapis sesji'). Oszacuj, ile MINUT zajęłoby wykonanie tej pracy RĘCZNIE doświadczonemu programiście (bez asystenta AI).\n\
        Odpowiedz wyłącznie liczbą całkowitą minut — bez słów, bez jednostek.\n\n{prompt_body}"
    )
}

#[tauri::command]
pub async fn clickup_estimate_time(
    state: State<'_, AppState>, project_id: i64, session_id: String, provider: Option<Provider>,
) -> AppResult<TimeEstimate> {
    let prov = provider.unwrap_or(Provider::Claude);
    let (proj_path, blocks) = {
        let c = state.db.get()?;
        let path = projects_repo::get(&c, project_id)?.path;
        let blocks = crate::commands::sessions::history_blocks_for_session(&c, &session_id)?;
        (path, blocks)
    };
    if blocks.is_empty() {
        return Err(AppError::Other("Sesja nie zawiera historii".into()));
    }
    let session_ms = active_session_ms(&blocks, IDLE_CAP_MS);
    let prompt = build_time_prompt(&blocks);
    let raw = crate::commands::sessions::run_agent_prompt(prov, None, prompt, std::path::PathBuf::from(proj_path)).await?;
    let dev_minutes = parse_minutes(&raw).unwrap_or((session_ms / 60_000).max(1));
    Ok(TimeEstimate { session_ms, dev_estimate_ms: dev_minutes * 60_000 })
}
```

Register `commands::clickup::clickup_estimate_time` in `lib.rs`. Add wrapper (import `TimeEstimate` type):

```ts
  clickupEstimateTime: (projectId: number, sessionId: string, provider?: Provider) =>
    invoke<TimeEstimate>('clickup_estimate_time', { projectId, sessionId, provider }),
```

- [ ] **Step 4: Run the tests + lint**

Run: `cd DesktopApp && cargo test --manifest-path src-tauri/Cargo.toml commands::clickup && npm run lint`
Expected: PASS; lint clean.

- [ ] **Step 5: Commit**

```bash
git add DesktopApp/src-tauri/src/commands/clickup.rs DesktopApp/src-tauri/src/lib.rs DesktopApp/src/lib/tauri.ts
git commit -m "feat(clickup): estimate session and dev work time"
```

### Task 18: Log-time command + time dialog

**Files:**
- Modify: `DesktopApp/src-tauri/src/clickup/mod.rs` (`create_time_entry`)
- Modify: `DesktopApp/src-tauri/src/commands/clickup.rs` (`clickup_log_time`)
- Modify: `DesktopApp/src-tauri/src/lib.rs` (register)
- Modify: `DesktopApp/src/lib/tauri.ts` (wrapper)
- Create: `DesktopApp/src/components/dialogs/ClickUpTimeDialog.tsx`
- Modify: `DesktopApp/src/components/dialogs/ClickUpTaskDialog.tsx` (add "Czas pracy" trigger)
- Test: inline wiremock test for `create_time_entry`; `DesktopApp/src/components/dialogs/ClickUpTimeDialog.test.tsx`

**Interfaces:**
- Produces: `async fn create_time_entry(&self, team_id: &str, task_id: &str, start_ms: i64, duration_ms: i64, description: &str) -> Result<(), ClickUpError>`; command `clickup_log_time(projectId, taskId, durationMs, description?)`.

- [ ] **Step 1: Write the failing wiremock test**

Add to the `tests` module in `clickup/mod.rs`:

```rust
    #[tokio::test]
    async fn create_time_entry_posts_to_team() {
        let server = MockServer::start().await;
        Mock::given(method("POST")).and(path("/team/111/time_entries"))
            .and(wiremock::matchers::body_json(serde_json::json!({
                "tid": "t1", "start": 1000, "duration": 600000, "description": "praca"
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({ "data": {} })))
            .mount(&server).await;
        let c = ClickUpClient::with_base("pk", server.uri());
        c.create_time_entry("111", "t1", 1000, 600_000, "praca").await.unwrap();
    }
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd DesktopApp && cargo test --manifest-path src-tauri/Cargo.toml clickup::tests::create_time_entry_posts_to_team`
Expected: FAIL — `create_time_entry` undefined.

- [ ] **Step 3: Implement client + command**

Add to `clickup/mod.rs` `impl ClickUpClient`:

```rust
    pub async fn create_time_entry(&self, team_id: &str, task_id: &str, start_ms: i64, duration_ms: i64, description: &str)
        -> Result<(), ClickUpError>
    {
        let resp = self.http
            .post(self.url(&format!("/team/{team_id}/time_entries")))
            .header("Authorization", &self.token)
            .json(&serde_json::json!({ "tid": task_id, "start": start_ms, "duration": duration_ms, "description": description }))
            .send().await
            .map_err(|e| ClickUpError::Offline(e.to_string()))?;
        Self::ok(resp).await.map(|_| ())
    }
```

Add to `commands/clickup.rs`:

```rust
#[tauri::command]
pub async fn clickup_log_time(
    state: State<'_, AppState>, project_id: i64, task_id: String, duration_ms: i64, description: Option<String>,
) -> AppResult<()> {
    let team_id = {
        let c = state.db.get()?;
        clickup_config_repo::get(&c, project_id)?
            .ok_or_else(|| AppError::Other("ClickUp: brak skonfigurowanego workspace".into()))?
            .workspace_id
    };
    let start = now_ms() - duration_ms;
    load_client(&state)?
        .create_time_entry(&team_id, &task_id, start, duration_ms, description.as_deref().unwrap_or("")).await
        .map_err(|e| AppError::Other(e.to_string()))
}
```

Register `commands::clickup::clickup_log_time` in `lib.rs`. Add wrapper:

```ts
  clickupLogTime: (projectId: number, taskId: string, durationMs: number, description?: string) =>
    invoke<void>('clickup_log_time', { projectId, taskId, durationMs, description }),
```

- [ ] **Step 4: Run the Rust test**

Run: `cd DesktopApp && cargo test --manifest-path src-tauri/Cargo.toml clickup::tests::create_time_entry_posts_to_team`
Expected: PASS.

- [ ] **Step 5: Write the failing dialog test**

Create `ClickUpTimeDialog.test.tsx`:

```tsx
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ClickUpTimeDialog } from './ClickUpTimeDialog';

vi.mock('../../store', () => ({
  useStore: (sel: any) => sel({ activeSession: { sessionId: 's1', provider: 'claude' } }),
}));
vi.mock('../../lib/tauri', () => ({ tauri: {
  clickupEstimateTime: vi.fn().mockResolvedValue({ sessionMs: 1_800_000, devEstimateMs: 5_400_000 }),
  clickupLogTime: vi.fn().mockResolvedValue(undefined),
}}));
import { tauri } from '../../lib/tauri';

describe('ClickUpTimeDialog', () => {
  beforeEach(() => vi.clearAllMocks());
  it('logs the proposed time', async () => {
    render(<ClickUpTimeDialog projectId={1} taskId="t1" onClose={() => {}} />);
    await waitFor(() => expect(tauri.clickupEstimateTime).toHaveBeenCalled());
    fireEvent.click(await screen.findByText('Zapisz czas'));
    await waitFor(() => expect(tauri.clickupLogTime).toHaveBeenCalled());
    const [, , durationMs] = (tauri.clickupLogTime as any).mock.calls[0];
    expect(durationMs).toBeGreaterThanOrEqual(1_800_000);
    expect(durationMs).toBeLessThanOrEqual(5_400_000);
  });
});
```

- [ ] **Step 6: Run the dialog test to verify it fails**

Run: `cd DesktopApp && npm test -- ClickUpTimeDialog`
Expected: FAIL — component not found.

- [ ] **Step 7: Implement `ClickUpTimeDialog`**

```tsx
import { useEffect, useState } from 'react';
import { useStore } from '../../store';
import { tauri } from '../../lib/tauri';
import type { TimeEstimate } from '../../types/TimeEstimate';

const fmt = (ms: number) => {
  const m = Math.round(ms / 60000);
  return `${Math.floor(m / 60)}h ${m % 60}m`;
};

export function ClickUpTimeDialog({ projectId, taskId, onClose }: { projectId: number; taskId: string; onClose: () => void }) {
  const activeSession = useStore(s => s.activeSession);
  const [est, setEst] = useState<TimeEstimate | null>(null);
  const [blend, setBlend] = useState(0.5);
  const [overrideMin, setOverrideMin] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!activeSession) { setError('Brak aktywnej sesji.'); return; }
    let cancelled = false;
    tauri.clickupEstimateTime(projectId, activeSession.sessionId, activeSession.provider)
      .then(e => { if (!cancelled) setEst(e); })
      .catch(e => { if (!cancelled) setError(String(e)); });
    return () => { cancelled = true; };
  }, [projectId, activeSession]);

  const proposedMs = est ? Math.round(est.sessionMs + blend * (est.devEstimateMs - est.sessionMs)) : 0;
  const finalMs = overrideMin.trim() ? Math.round(Number(overrideMin) * 60000) : proposedMs;

  const save = async () => {
    setBusy(true);
    try { await tauri.clickupLogTime(projectId, taskId, finalMs, 'Czas pracy (AbeonCode)'); onClose(); }
    catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 bg-black/50 grid place-items-center z-50" onClick={onClose}>
      <div className="bg-bg-elev border border-border w-[480px] p-4 space-y-3" onClick={e => e.stopPropagation()}>
        <span className="text-[10px] text-muted font-medium uppercase tracking-wider">CZAS PRACY</span>
        {error && <p className="text-[11px] text-danger">{error}</p>}
        {est && (
          <>
            <p className="text-[12px] text-fg-secondary">Czas sesji: <span className="text-fg">{fmt(est.sessionMs)}</span></p>
            <p className="text-[12px] text-fg-secondary">Szacunek dev: <span className="text-fg">{fmt(est.devEstimateMs)}</span></p>
            <label className="block text-[11px] text-muted">Blend (sesja ↔ dev)</label>
            <input type="range" min={0} max={1} step={0.05} value={blend} onChange={e => setBlend(Number(e.target.value))} className="w-full" />
            <p className="text-[12px] text-fg">Propozycja: <span className="font-medium">{fmt(proposedMs)}</span></p>
            <label className="block text-[11px] text-muted">Nadpisz (minuty, opcjonalnie)</label>
            <input value={overrideMin} onChange={e => setOverrideMin(e.target.value)} placeholder={String(Math.round(proposedMs / 60000))}
              className="w-full bg-bg border border-border px-3 py-1.5 text-[13px] font-mono" />
          </>
        )}
        <div className="flex justify-end gap-2">
          <button className="px-3 py-1.5 border border-border text-[12px] text-fg-secondary hover:text-fg" onClick={onClose}>Anuluj</button>
          <button disabled={busy || !est} onClick={save} className="px-3 py-1.5 bg-fg text-bg text-[12px] font-medium disabled:opacity-50">Zapisz czas</button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 8: Wire the trigger into `ClickUpTaskDialog`**

In `ClickUpTaskDialog.tsx`, add `const [timeOpen, setTimeOpen] = useState(false);`, a footer button:

```tsx
<button disabled={busy} onClick={() => setTimeOpen(true)} className="px-3 py-1.5 border border-border text-[12px] text-fg-secondary hover:text-fg">Czas pracy</button>
```

render at panel end:

```tsx
{timeOpen && <ClickUpTimeDialog projectId={projectId} taskId={taskId} onClose={() => setTimeOpen(false)} />}
```

Add `import { ClickUpTimeDialog } from './ClickUpTimeDialog';`.

- [ ] **Step 9: Run tests + lint**

Run: `cd DesktopApp && npm test -- ClickUpTimeDialog && npm run lint`
Expected: PASS; lint clean.

- [ ] **Step 10: Commit**

```bash
git add DesktopApp/src-tauri/src/clickup/mod.rs DesktopApp/src-tauri/src/commands/clickup.rs DesktopApp/src-tauri/src/lib.rs DesktopApp/src/lib/tauri.ts DesktopApp/src/components/dialogs/ClickUpTimeDialog.tsx DesktopApp/src/components/dialogs/ClickUpTimeDialog.test.tsx DesktopApp/src/components/dialogs/ClickUpTaskDialog.tsx
git commit -m "feat(clickup): work-time estimate dialog and time entry logging"
```

**Phase 4 gate:** `cd DesktopApp && npm run test:rust && npm test && npm run lint` all green. From a task you can estimate work time, blend it, and write a time entry to ClickUp.

---

## Final verification

- [ ] `cd DesktopApp && npm run test:rust` — all Rust tests pass.
- [ ] `cd DesktopApp && npm test` — all frontend tests pass.
- [ ] `cd DesktopApp && npm run lint` — zero errors.
- [ ] `git status DesktopApp/src/types` is clean except for intentionally added ClickUp type files (ts-rs regen produced no stray diffs).
- [ ] Manual smoke (`npm run tauri dev`): set a ClickUp token → status "Połączono"; set scope; link a task by name and by ID; open detail; copy + inject the handle; generate a summary and post a comment; estimate + log time.

## Notes for the implementer

- ClickUp personal tokens go in the raw `Authorization` header (NOT `Bearer`). The `ClickUpClient` already does this; keep it.
- Confirm `history_blocks_for_session` visibility is `pub(crate)` before Task 15; widen if needed.
- The `activeSession` / `activeAgentPtyId` store accessors are the only cross-cutting frontend additions — keep a single source of truth and reuse them in both components and tests.
- Never call `term.dispose()` in `TerminalView.tsx` (webkit crash); only set/clear `activeAgentPtyId` in the existing lifecycle effect.
- The component tests (Tasks 6, 11, 12, 13, 16, 18) use `@testing-library/react` + `@testing-library/jest-dom` rendering under `jsdom`. If these are not already dev-deps of `DesktopApp`, install them (`npm i -D @testing-library/react @testing-library/jest-dom`) and ensure `jest-dom` matchers are registered in the Vitest setup (`expect.extend` / `import '@testing-library/jest-dom'`). The slice test (Task 10) needs neither — only `zustand` + `vitest`. If the team prefers not to add the testing library, downgrade the component tests to logic-only assertions (call the handlers directly) but keep one render smoke test per dialog.
- `Provider` is the existing ts-rs-exported union (`src/types/Provider.ts`, values `'claude' | 'codex'`); import it where wrappers/dialogs reference it.
