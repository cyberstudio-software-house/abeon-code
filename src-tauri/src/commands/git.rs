use std::path::PathBuf;
use tauri::State;
use crate::domain::{DiffResult, GitStatus};
use crate::error::AppResult;
use crate::state::AppState;
use crate::db::projects_repo;

#[tauri::command]
pub fn git_status(state: State<AppState>, project_id: i64) -> AppResult<GitStatus> {
    let c = state.db.get()?;
    let proj = projects_repo::get(&c, project_id)?;
    crate::git::status(&PathBuf::from(&proj.path))
}

#[tauri::command]
pub fn git_diff_file(
    state: State<AppState>,
    project_id: i64,
    repo_label: String,
    file_path: String,
) -> AppResult<DiffResult> {
    let c = state.db.get()?;
    let proj = projects_repo::get(&c, project_id)?;
    let root = PathBuf::from(&proj.path);
    let repo_path = if repo_label == "." { root } else { root.join(&repo_label) };
    crate::git::diff_file(&repo_path, &file_path)
}
