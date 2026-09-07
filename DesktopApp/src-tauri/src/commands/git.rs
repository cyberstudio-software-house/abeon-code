use std::path::PathBuf;
use tauri::State;
use crate::domain::{DiffResult, GitBranch, GitCommit, GitCommitDetail, GitStatus};
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
    let repo_path = resolve_repo_path(&state, project_id, &repo_label)?;
    crate::git::diff_file(&repo_path, &file_path)
}

#[tauri::command]
pub fn git_branches(
    state: State<AppState>,
    project_id: i64,
    repo_label: String,
) -> AppResult<Vec<GitBranch>> {
    let repo_path = resolve_repo_path(&state, project_id, &repo_label)?;
    crate::git::history::list_branches(&repo_path)
}

#[tauri::command]
pub fn git_log(
    state: State<AppState>,
    project_id: i64,
    repo_label: String,
    branch: String,
    skip: usize,
    limit: usize,
) -> AppResult<Vec<GitCommit>> {
    let repo_path = resolve_repo_path(&state, project_id, &repo_label)?;
    crate::git::history::log(&repo_path, &branch, skip, limit)
}

#[tauri::command]
pub fn git_commit_detail(
    state: State<AppState>,
    project_id: i64,
    repo_label: String,
    hash: String,
) -> AppResult<GitCommitDetail> {
    let repo_path = resolve_repo_path(&state, project_id, &repo_label)?;
    crate::git::history::commit_detail(&repo_path, &hash)
}

#[tauri::command]
pub fn git_diff_commit_file(
    state: State<AppState>,
    project_id: i64,
    repo_label: String,
    hash: String,
    file_path: String,
) -> AppResult<DiffResult> {
    let repo_path = resolve_repo_path(&state, project_id, &repo_label)?;
    crate::git::history::diff_commit_file(&repo_path, &hash, &file_path)
}

fn resolve_repo_path(state: &State<AppState>, project_id: i64, repo_label: &str) -> AppResult<PathBuf> {
    let c = state.db.get()?;
    let proj = projects_repo::get(&c, project_id)?;
    let root = PathBuf::from(&proj.path);
    Ok(if repo_label == "." { root } else { root.join(repo_label) })
}
