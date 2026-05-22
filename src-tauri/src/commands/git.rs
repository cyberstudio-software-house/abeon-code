use std::path::PathBuf;
use tauri::State;
use crate::domain::GitStatus;
use crate::error::AppResult;
use crate::state::AppState;
use crate::db::projects_repo;

#[tauri::command]
pub fn git_status(state: State<AppState>, project_id: i64) -> AppResult<GitStatus> {
    let c = state.db.get()?;
    let proj = projects_repo::get(&c, project_id)?;
    crate::git::status(&PathBuf::from(&proj.path))
}
