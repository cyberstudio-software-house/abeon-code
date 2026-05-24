use std::panic;
use std::path::PathBuf;
use tauri::{AppHandle, State};
use crate::domain::{SessionMeta, SessionHistory};
use crate::error::{AppError, AppResult};
use crate::sessions::reader;
use crate::sessions::reader::session_file;
use crate::state::AppState;
use crate::db::{projects_repo, session_titles_repo};

fn claude_root() -> AppResult<PathBuf> {
    let home = dirs::home_dir().ok_or_else(|| AppError::Other("no home".into()))?;
    Ok(home.join(".claude").join("projects"))
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
    let dir = claude_root()?.join(&proj.claude_dir);
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
    let dir = claude_root()?.join(&proj.claude_dir);
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
    let dir = claude_root()?.join(&proj.claude_dir);
    let path = session_file(&dir, &session_id);
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
    let dir = claude_root()?.join(&proj.claude_dir);
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
    let dir = claude_root()?.join(&proj.claude_dir);
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
    let (proj_path, claude_dir) = {
        let c = state.db.get()?;
        let proj = projects_repo::get(&c, project_id)?;
        (proj.path.clone(), claude_root()?.join(&proj.claude_dir))
    };
    let path = reader::session_file(&claude_dir, &session_id);

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
