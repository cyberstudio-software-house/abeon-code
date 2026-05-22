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
