use std::panic;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, State};
use crate::domain::{Project, SessionMeta, SessionHistory};
use crate::error::{AppError, AppResult};
use crate::sessions::encoding::encode_project_path;
use crate::sessions::reader;
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
    let mut sessions = catch(move || reader::list_sessions(project_id, &dir, limit, offset))?;
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
    limit: Option<usize>,
    before_uuid: Option<String>,
) -> AppResult<SessionHistory> {
    let c = state.db.get()?;
    let proj = projects_repo::get(&c, project_id)?;
    let dir = session_dir(&proj)?;
    let sid = session_id.clone();
    let mut history = catch(move || reader::read_history(project_id, &dir, &sid, limit, before_uuid.as_deref()))?;
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
) -> AppResult<()> {
    let c = state.db.get()?;
    let proj = projects_repo::get(&c, project_id)?;
    let dir = session_dir(&proj)?;
    let path = session_file(&dir, &session_id)?;
    state.session_watchers.open(app, &session_id, path)
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
    if !dir.exists() { return Ok(0); }
    let count = std::fs::read_dir(&dir)?
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().map(|x| x == "jsonl").unwrap_or(false))
        .count();
    Ok(count)
}

#[tauri::command]
pub fn export_session(
    state: State<AppState>,
    project_id: i64,
    session_id: String,
    format: String,
) -> AppResult<String> {
    let c = state.db.get()?;
    let proj = projects_repo::get(&c, project_id)?;
    let dir = session_dir(&proj)?;
    catch(move || {
        let history = reader::read_history(project_id, &dir, &session_id, None, None)?;
        match format.as_str() {
            "json" => Ok(serde_json::to_string_pretty(&history)?),
            "md" | _ => Ok(render_markdown(&history)),
        }
    })
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

#[tauri::command]
pub async fn generate_session_title(
    state: State<'_, AppState>,
    project_id: i64,
    session_id: String,
    model: Option<String>,
) -> AppResult<String> {
    let (proj_path, dir) = {
        let c = state.db.get()?;
        let proj = projects_repo::get(&c, project_id)?;
        (proj.path.clone(), session_dir(&proj)?)
    };
    let path = reader::session_file(&dir, &session_id)?;

    let first = reader::first_user_prompt(&path)?
        .ok_or_else(|| AppError::Other("Sesja nie zawiera promptu użytkownika".into()))?;

    let truncated: String = first.chars().take(2000).collect();
    let prompt = format!(
        "Generate a short, concise title (max 60 characters) for a coding session that started with the user prompt below.\n\n\
        CRITICAL: Write the title in the SAME LANGUAGE as the user's prompt. If they wrote in Polish, respond in Polish. If English, respond in English. If German, respond in German. Match the language exactly.\n\n\
        Respond with ONLY the title — no quotes, no prefixes, no commentary, no markdown.\n\n\
        User's first prompt:\n<<<\n{truncated}\n>>>"
    );

    let mut cmd = tokio::process::Command::new("claude");
    cmd.arg("-p").arg("--no-session-persistence").arg(&prompt);
    if let Some(m) = &model {
        if !m.is_empty() { cmd.arg("--model").arg(m); }
    }
    cmd.current_dir(&proj_path);
    cmd.kill_on_drop(true);

    let timeout = std::time::Duration::from_secs(60);
    let output = tokio::time::timeout(timeout, cmd.output()).await
        .map_err(|_| AppError::Other("Generowanie tytułu przekroczyło limit 60s".into()))?
        .map_err(|e| AppError::Other(format!("claude -p: {e}")))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(AppError::Other(format!("claude -p failed: {}", stderr.trim())));
    }

    let raw = String::from_utf8_lossy(&output.stdout);
    let first_line = raw.lines().find(|l| !l.trim().is_empty()).unwrap_or("");
    let cleaned: String = first_line
        .trim()
        .trim_matches(|c: char| c == '"' || c == '\'' || c == '`')
        .trim()
        .chars()
        .take(80)
        .collect();
    if cleaned.is_empty() {
        return Err(AppError::Other("Pusta odpowiedź z claude -p".into()));
    }
    Ok(cleaned)
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
}
