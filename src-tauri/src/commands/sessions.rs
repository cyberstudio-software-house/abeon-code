use std::path::PathBuf;
use tauri::{AppHandle, State};
use crate::domain::{SessionMeta, SessionHistory};
use crate::error::{AppError, AppResult};
use crate::sessions::reader;
use crate::sessions::reader::session_file;
use crate::state::AppState;
use crate::db::projects_repo;

fn claude_root() -> AppResult<PathBuf> {
    let home = dirs::home_dir().ok_or_else(|| AppError::Other("no home".into()))?;
    Ok(home.join(".claude").join("projects"))
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
    reader::list_sessions(project_id, &dir, limit, offset)
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
    reader::read_history(project_id, &dir, &session_id, limit, before_uuid.as_deref())
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
    let history = reader::read_history(project_id, &dir, &session_id, None, None)?;

    match format.as_str() {
        "json" => Ok(serde_json::to_string_pretty(&history)?),
        "md" | _ => Ok(render_markdown(&history)),
    }
}

fn render_markdown(h: &crate::domain::SessionHistory) -> String {
    use crate::domain::HistoryBlock;
    let mut out = String::new();
    out.push_str(&format!("# {}\n\n", h.meta.title));
    out.push_str(&format!(
        "Session: {} | {} messages | {}\n\n---\n\n",
        h.meta.id,
        h.meta.message_count,
        h.meta.git_branch.as_deref().unwrap_or("no branch"),
    ));
    for block in &h.blocks {
        match block {
            HistoryBlock::UserText { text, .. } => {
                out.push_str(&format!("**You:**\n\n{}\n\n", text));
            }
            HistoryBlock::AssistantText { text, .. } => {
                out.push_str(&format!("**Claude:**\n\n{}\n\n", text));
            }
            HistoryBlock::AssistantThinking { text, .. } => {
                out.push_str(&format!(
                    "<details><summary>Thinking</summary>\n\n{}\n\n</details>\n\n",
                    text
                ));
            }
            HistoryBlock::ToolUse {
                name, input_summary, ..
            } => {
                out.push_str(&format!("> **{}** > {}\n\n", name, input_summary));
            }
            HistoryBlock::ToolResult {
                content, is_error, ..
            } => {
                if *is_error {
                    out.push_str(&format!(
                        "```\n[ERROR] {}\n```\n\n",
                        &content[..content.len().min(500)]
                    ));
                }
            }
            HistoryBlock::Attachment {
                attachment_kind,
                name,
                ..
            } => {
                out.push_str(&format!("Attachment: {} - {}\n\n", attachment_kind, name));
            }
            HistoryBlock::System { subtype, .. } => {
                out.push_str(&format!("*[system: {}]*\n\n", subtype));
            }
        }
    }
    out
}
