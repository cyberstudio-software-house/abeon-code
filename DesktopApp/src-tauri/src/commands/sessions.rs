use std::panic;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, State};
use crate::domain::{Project, Provider, SessionMeta, SessionHistory};
use crate::error::{AppError, AppResult};
use crate::sessions::encoding::encode_project_path;
use crate::sessions::{codex, reader};
use crate::sessions::reader::session_file;
use crate::state::AppState;
use crate::db::{projects_repo, session_titles_repo};
use crate::domain::roster::RosterEntry;

const ROSTER_SESSIONS_PER_PROJECT: usize = 30;

fn claude_root() -> AppResult<PathBuf> {
    let home = dirs::home_dir().ok_or_else(|| AppError::Other("no home".into()))?;
    Ok(home.join(".claude").join("projects"))
}

/// Resolves the project's session directory under `~/.claude/projects/` by deriving the
/// encoded name from the project's real path — `claude_dir` stored in the DB is not trusted,
/// so a stale value can never point the reader at the wrong (or a nonexistent) directory.
fn session_dir(proj: &Project) -> AppResult<PathBuf> {
    Ok(claude_root()?.join(encode_project_path(Path::new(&proj.path))))
}

fn catch<T, F: FnOnce() -> AppResult<T> + panic::UnwindSafe>(f: F) -> AppResult<T> {
    match panic::catch_unwind(f) {
        Ok(result) => result,
        Err(e) => {
            let msg = e.downcast_ref::<String>().map(|s| s.as_str())
                .or_else(|| e.downcast_ref::<&str>().copied())
                .unwrap_or("unknown panic");
            Err(AppError::Other(format!("internal error: {msg}")))
        }
    }
}

#[tauri::command]
pub fn list_sessions(
    state: State<AppState>,
    project_id: i64,
    limit: usize,
    offset: usize,
) -> AppResult<Vec<SessionMeta>> {
    let c = state.db.get()?;
    let proj = projects_repo::get(&c, project_id)?;
    let dir = session_dir(&proj)?;
    let window = offset + limit;
    let claude = catch(move || reader::list_sessions(project_id, &dir, window, 0))?;
    let codex_dir = codex::reader::codex_root()?;
    let proj_path = proj.path.clone();
    let codex_list = catch(move || Ok(codex::reader::list_for_cwd(&codex_dir, &proj_path, project_id, window)))?;
    let mut sessions = merge_session_lists(claude, codex_list, limit, offset);
    let titles = session_titles_repo::get_all(&c, project_id);
    for s in &mut sessions {
        if let Some(t) = titles.get(&s.id) {
            s.title = t.clone();
        }
    }
    Ok(sessions)
}

#[tauri::command]
pub fn read_session_history(
    state: State<AppState>,
    project_id: i64,
    session_id: String,
    provider: Option<Provider>,
    limit: Option<usize>,
    before_uuid: Option<String>,
) -> AppResult<SessionHistory> {
    let c = state.db.get()?;
    let mut history = match provider.unwrap_or(Provider::Claude) {
        Provider::Claude => {
            let proj = projects_repo::get(&c, project_id)?;
            let dir = session_dir(&proj)?;
            let sid = session_id.clone();
            catch(move || reader::read_history(project_id, &dir, &sid, limit, before_uuid.as_deref()))?
        }
        Provider::Codex => {
            let codex_dir = codex::reader::codex_root()?;
            let sid = session_id.clone();
            catch(move || codex::reader::read_history(&codex_dir, project_id, &sid, limit, before_uuid.as_deref()))?
        }
    };
    if let Some(t) = session_titles_repo::get(&c, project_id, &session_id) {
        history.meta.title = t;
    }
    Ok(history)
}

#[tauri::command]
pub fn open_session_watch(
    app: AppHandle,
    state: State<AppState>,
    project_id: i64,
    session_id: String,
    provider: Option<Provider>,
) -> AppResult<()> {
    let prov = provider.unwrap_or(Provider::Claude);
    let path = match prov {
        Provider::Claude => {
            let c = state.db.get()?;
            let proj = projects_repo::get(&c, project_id)?;
            let dir = session_dir(&proj)?;
            session_file(&dir, &session_id)?
        }
        Provider::Codex => {
            let codex_dir = codex::reader::codex_root()?;
            codex::reader::find_session(&codex_dir, &session_id)
                .ok_or_else(|| AppError::NotFound(session_id.clone()))?
        }
    };
    state.session_watchers.open(app, &session_id, path, prov)
}

#[tauri::command]
pub fn close_session_watch(state: State<AppState>, session_id: String) -> AppResult<()> {
    state.session_watchers.close(&session_id);
    Ok(())
}

#[tauri::command]
pub fn count_sessions(
    state: State<AppState>,
    project_id: i64,
) -> AppResult<usize> {
    let c = state.db.get()?;
    let proj = projects_repo::get(&c, project_id)?;
    let dir = session_dir(&proj)?;
    let claude_count = if !dir.exists() {
        0
    } else {
        std::fs::read_dir(&dir)?
            .filter_map(|e| e.ok())
            .filter(|e| e.path().extension().map(|x| x == "jsonl").unwrap_or(false))
            .count()
    };
    let codex_count = codex::reader::codex_root()
        .map(|root| codex::reader::count_for_cwd(&root, &proj.path))
        .unwrap_or(0);
    Ok(claude_count + codex_count)
}

#[tauri::command]
pub fn export_session(
    state: State<AppState>,
    project_id: i64,
    session_id: String,
    format: String,
    provider: Option<Provider>,
) -> AppResult<String> {
    let c = state.db.get()?;
    let history = match provider.unwrap_or(Provider::Claude) {
        Provider::Claude => {
            let proj = projects_repo::get(&c, project_id)?;
            let dir = session_dir(&proj)?;
            let sid = session_id.clone();
            catch(move || reader::read_history(project_id, &dir, &sid, None, None))?
        }
        Provider::Codex => {
            let codex_dir = codex::reader::codex_root()?;
            let sid = session_id.clone();
            catch(move || codex::reader::read_history(&codex_dir, project_id, &sid, None, None))?
        }
    };
    match format.as_str() {
        "json" => Ok(serde_json::to_string_pretty(&history)?),
        _ => Ok(render_markdown(&history)),
    }
}

#[tauri::command]
pub fn rename_session(
    state: State<AppState>,
    project_id: i64,
    session_id: String,
    title: String,
) -> AppResult<()> {
    let c = state.db.get()?;
    session_titles_repo::set(&c, project_id, &session_id, &title);
    Ok(())
}

fn clean_title(raw: &str) -> String {
    let first_line = raw.lines().find(|l| !l.trim().is_empty()).unwrap_or("");
    first_line
        .trim()
        .trim_matches(|c: char| c == '"' || c == '\'' || c == '`')
        .trim()
        .chars()
        .take(80)
        .collect()
}

#[tauri::command]
pub async fn generate_session_title(
    state: State<'_, AppState>,
    project_id: i64,
    session_id: String,
    model: Option<String>,
    provider: Option<Provider>,
) -> AppResult<String> {
    let prov = provider.unwrap_or(Provider::Claude);
    let (proj_path, first) = {
        let c = state.db.get()?;
        let proj = projects_repo::get(&c, project_id)?;
        let first = match prov {
            Provider::Claude => {
                let dir = session_dir(&proj)?;
                let path = reader::session_file(&dir, &session_id)?;
                reader::first_user_prompt(&path)?
            }
            Provider::Codex => {
                let codex_dir = codex::reader::codex_root()?;
                let path = codex::reader::find_session(&codex_dir, &session_id)
                    .ok_or_else(|| AppError::NotFound(session_id.clone()))?;
                codex::reader::first_user_prompt(&path)?
            }
        };
        (proj.path.clone(), first)
    };

    let first = first
        .ok_or_else(|| AppError::Other("Sesja nie zawiera promptu użytkownika".into()))?;

    let truncated: String = first.chars().take(2000).collect();
    let prompt = format!(
        "Generate a short, concise title (max 60 characters) for a coding session that started with the user prompt below.\n\n\
        CRITICAL: Write the title in the SAME LANGUAGE as the user's prompt. If they wrote in Polish, respond in Polish. If English, respond in English. If German, respond in German. Match the language exactly.\n\n\
        Respond with ONLY the title — no quotes, no prefixes, no commentary, no markdown.\n\n\
        User's first prompt:\n<<<\n{truncated}\n>>>"
    );

    let raw = run_agent_prompt(prov, model, prompt, std::path::PathBuf::from(proj_path)).await?;
    let cleaned = clean_title(&raw);
    if cleaned.is_empty() {
        return Err(AppError::Other("Pusta odpowiedź modelu".into()));
    }
    Ok(cleaned)
}

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
                .map_err(|_| AppError::Other("Generowanie tytułu przekroczyło limit 60s".into()))?
                .map_err(|e| AppError::Other(format!("claude -p: {e}")))?;
            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr);
                return Err(AppError::Other(format!("claude -p failed: {}", stderr.trim())));
            }
            Ok(String::from_utf8_lossy(&output.stdout).to_string())
        }
        Provider::Codex => {
            let out_file = std::env::temp_dir().join(format!("abeoncode-title-{}.txt", uuid::Uuid::new_v4()));
            let mut cmd = tokio::process::Command::new("codex");
            cmd.arg("exec")
                .arg("--ephemeral")
                .arg("--skip-git-repo-check")
                .arg("--color").arg("never")
                .arg("-o").arg(&out_file);
            if let Some(m) = &model {
                if !m.is_empty() { cmd.arg("-m").arg(m); }
            }
            cmd.arg(&prompt);
            cmd.current_dir(std::env::temp_dir());
            cmd.kill_on_drop(true);

            let timeout = std::time::Duration::from_secs(90);
            let output = tokio::time::timeout(timeout, cmd.output()).await
                .map_err(|_| AppError::Other("Generowanie tytułu przekroczyło limit 90s".into()))?
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

fn merge_session_lists(
    claude: Vec<SessionMeta>,
    codex: Vec<SessionMeta>,
    limit: usize,
    offset: usize,
) -> Vec<SessionMeta> {
    let mut all: Vec<SessionMeta> = claude.into_iter().chain(codex).collect();
    all.sort_by(|a, b| b.last_modified.cmp(&a.last_modified));
    all.into_iter().skip(offset).take(limit).collect()
}

fn render_markdown(h: &SessionHistory) -> String {
    use crate::domain::HistoryBlock;
    let mut out = String::new();
    out.push_str(&format!("# {}\n\n", h.meta.title));
    out.push_str(&format!("Session: {} | {} messages | {}\n\n---\n\n",
        h.meta.id, h.meta.message_count,
        h.meta.git_branch.as_deref().unwrap_or("no branch"),
    ));
    for block in &h.blocks {
        match block {
            HistoryBlock::UserText { text, .. } => {
                out.push_str(&format!("**You:**\n\n{text}\n\n"));
            }
            HistoryBlock::AssistantText { text, .. } => {
                out.push_str(&format!("**Claude:**\n\n{text}\n\n"));
            }
            HistoryBlock::AssistantThinking { text, .. } => {
                out.push_str(&format!("<details><summary>Thinking</summary>\n\n{text}\n\n</details>\n\n"));
            }
            HistoryBlock::ToolUse { name, input_summary, .. } => {
                out.push_str(&format!("> **{name}** › {input_summary}\n\n"));
            }
            HistoryBlock::ToolResult { content, is_error, .. } => {
                if *is_error {
                    let preview = if content.len() > 500 { &content[..500] } else { content.as_str() };
                    out.push_str(&format!("```\n[ERROR] {preview}\n```\n\n"));
                }
            }
            HistoryBlock::Attachment { attachment_kind, name, .. } => {
                out.push_str(&format!("📎 {attachment_kind} — {name}\n\n"));
            }
            HistoryBlock::System { subtype, .. } => {
                out.push_str(&format!("*[system: {subtype}]*\n\n"));
            }
        }
    }
    out
}

/// Build a roster of the most-recent sessions across all projects. Used by the
/// remote bridge to answer RequestRoster. Failures for a single project are skipped
/// (a missing claude dir must not sink the whole roster).
pub fn roster_snapshot(conn: &r2d2::PooledConnection<r2d2_sqlite::SqliteConnectionManager>) -> AppResult<Vec<RosterEntry>> {
    let mut out = Vec::new();
    for proj in projects_repo::list(conn)? {
        let dir = match session_dir(&proj) { Ok(d) => d, Err(_) => continue };
        let project_id = proj.id;
        let project_name = proj.name.clone();
        let mut sessions = match catch(move || reader::list_sessions(project_id, &dir, ROSTER_SESSIONS_PER_PROJECT, 0)) {
            Ok(s) => s,
            Err(_) => continue,
        };
        let titles = session_titles_repo::get_all(conn, project_id);
        for s in &mut sessions {
            if let Some(t) = titles.get(&s.id) { s.title = t.clone(); }
            out.push(RosterEntry {
                session_id: s.id.clone(),
                project_id,
                project_name: project_name.clone(),
                title: s.title.clone(),
                activity: s.activity,
                last_modified: s.last_modified,
            });
        }
    }
    Ok(out)
}

/// Read the most-recent history blocks (chronological, capped by the reader at 500)
/// for a session, locating its project by scanning known projects for the matching
/// session file. Used by the remote bridge to answer RequestHistory. Returns empty
/// on any failure so a single bad project never sinks the backfill.
pub fn history_blocks_for_session(
    conn: &r2d2::PooledConnection<r2d2_sqlite::SqliteConnectionManager>,
    session_id: &str,
) -> Vec<crate::domain::HistoryBlock> {
    let projects = match projects_repo::list(conn) { Ok(p) => p, Err(_) => return Vec::new() };
    for proj in projects {
        let dir = match session_dir(&proj) { Ok(d) => d, Err(_) => continue };
        let exists = reader::session_file(&dir, session_id).map(|p| p.exists()).unwrap_or(false);
        if !exists { continue; }
        let pid = proj.id;
        let sid = session_id.to_string();
        if let Ok(h) = catch(move || reader::read_history(pid, &dir, &sid, Some(500), None)) {
            return h.blocks;
        }
    }
    Vec::new()
}

#[cfg(test)]
mod merge_tests {
    use super::*;
    use crate::domain::{Provider, SessionActivity, SessionMeta};

    fn meta(id: &str, provider: Provider, last_modified: i64) -> SessionMeta {
        SessionMeta {
            id: id.into(), project_id: 1, title: id.into(), message_count: 1,
            last_modified, git_branch: None, cwd: None,
            activity: SessionActivity::Idle, provider,
        }
    }

    #[test]
    fn merge_interleaves_by_mtime_desc_with_offset() {
        let claude = vec![meta("c1", Provider::Claude, 300), meta("c2", Provider::Claude, 100)];
        let codex = vec![meta("x1", Provider::Codex, 200)];
        let merged = merge_session_lists(claude.clone(), codex.clone(), 10, 0);
        let ids: Vec<&str> = merged.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids, vec!["c1", "x1", "c2"]);

        let page2 = merge_session_lists(claude, codex, 2, 1);
        let ids2: Vec<&str> = page2.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids2, vec!["x1", "c2"]);
    }
}

#[cfg(test)]
mod roster_tests {
    use super::*;
    use crate::db::init_pool;
    use tempfile::NamedTempFile;

    fn pool() -> crate::db::DbPool {
        let f = NamedTempFile::new().unwrap();
        let path = f.path().to_path_buf();
        std::mem::forget(f);
        init_pool(&path).unwrap()
    }

    #[test]
    fn roster_snapshot_empty_db_is_empty() {
        let p = pool();
        let c = p.get().unwrap();
        let entries = roster_snapshot(&c).unwrap();
        assert!(entries.is_empty());
    }

    #[test]
    fn history_blocks_for_unknown_session_is_empty() {
        let p = pool();
        let c = p.get().unwrap();
        let blocks = history_blocks_for_session(&c, "no-such-session");
        assert!(blocks.is_empty());
    }
}

#[cfg(test)]
mod title_tests {
    use super::*;

    #[test]
    fn clean_title_takes_first_line_trims_and_caps() {
        assert_eq!(clean_title("\n  \"Fix login bug\"  \nmore"), "Fix login bug");
        let long = "x".repeat(120);
        assert_eq!(clean_title(&long).chars().count(), 80);
        assert_eq!(clean_title("`tytuł`"), "tytuł");
        assert_eq!(clean_title("   \n  \n"), "");
    }
}
