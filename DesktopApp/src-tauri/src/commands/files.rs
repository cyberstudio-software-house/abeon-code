use std::path::PathBuf;

use tauri::{Manager, State, WebviewWindow};

use crate::db::projects_repo;
use crate::domain::files::{FileContent, FileEntry, FileSearchResponse};
use crate::error::{AppError, AppResult};
use crate::files::paths::{resolve_existing, resolve_for_write};
use crate::files::{content, listing, search, write, MAX_TEXT_BYTES, SEARCH_LIMIT, SEARCH_VISIT_CAP};
use crate::state::AppState;

fn project_root(state: &AppState, project_id: i64) -> AppResult<PathBuf> {
    let conn = state.db.get()?;
    Ok(PathBuf::from(projects_repo::get(&conn, project_id)?.path))
}

fn ensure_text_size(content: &str) -> AppResult<()> {
    if content.len() as u64 > MAX_TEXT_BYTES {
        return Err(AppError::InvalidInput(format!(
            "content exceeds {MAX_TEXT_BYTES} bytes"
        )));
    }
    Ok(())
}

#[tauri::command(async)]
pub fn list_project_dir(
    state: State<AppState>,
    project_id: i64,
    rel_path: String,
) -> AppResult<Vec<FileEntry>> {
    let root = project_root(&state, project_id)?;
    listing::list_dir(&root, &rel_path)
}

#[tauri::command(async)]
pub fn search_project_files(
    state: State<AppState>,
    project_id: i64,
    query: String,
) -> AppResult<FileSearchResponse> {
    let root = project_root(&state, project_id)?;
    search::search_files(&root, &query, SEARCH_LIMIT, SEARCH_VISIT_CAP)
}

#[tauri::command(async)]
pub fn read_project_file(
    state: State<AppState>,
    project_id: i64,
    rel_path: String,
) -> AppResult<FileContent> {
    let root = project_root(&state, project_id)?;
    let path = resolve_existing(&root, &rel_path)?;
    content::read_file(&path)
}

#[tauri::command(async)]
pub fn project_file_version(
    state: State<AppState>,
    project_id: i64,
    rel_path: String,
) -> AppResult<Option<String>> {
    let root = project_root(&state, project_id)?;
    let path = resolve_for_write(&root, &rel_path)?;
    content::file_version(&path)
}

#[tauri::command(async)]
pub fn write_project_file(
    state: State<AppState>,
    project_id: i64,
    rel_path: String,
    content: String,
    expected_version: Option<String>,
    force: bool,
) -> AppResult<String> {
    ensure_text_size(&content)?;
    let root = project_root(&state, project_id)?;
    let path = resolve_for_write(&root, &rel_path)?;
    write::write_file(&path, &content, expected_version.as_deref(), force)
}

#[tauri::command(async)]
pub fn watch_project_dir(
    window: WebviewWindow,
    state: State<AppState>,
    project_id: i64,
    rel_path: String,
) -> AppResult<()> {
    let root = project_root(&state, project_id)?;
    let abs_dir = resolve_existing(&root, &rel_path)?;
    state.file_watches.watch(
        window.app_handle(),
        window.label(),
        project_id,
        &rel_path,
        abs_dir,
    )
}

#[tauri::command(async)]
pub fn unwatch_project_dir(
    window: WebviewWindow,
    state: State<AppState>,
    project_id: i64,
    rel_path: String,
) {
    state
        .file_watches
        .unwatch(window.label(), project_id, &rel_path);
}

#[tauri::command(async)]
pub fn set_dirty_file_count(window: WebviewWindow, state: State<AppState>, count: u32) {
    state.file_watches.set_dirty(window.label(), count);
}

#[tauri::command(async)]
pub fn dirty_files_in_other_windows(window: WebviewWindow, state: State<AppState>) -> u32 {
    state.file_watches.dirty_elsewhere(window.label())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_size_limit_counts_bytes_not_characters() {
        let at_limit = "a".repeat(MAX_TEXT_BYTES as usize);
        assert!(ensure_text_size(&at_limit).is_ok());
        let over_limit = "a".repeat(MAX_TEXT_BYTES as usize + 1);
        assert!(matches!(ensure_text_size(&over_limit), Err(AppError::InvalidInput(_))));
        let multibyte = "ł".repeat(MAX_TEXT_BYTES as usize / 2 + 1);
        assert!(matches!(ensure_text_size(&multibyte), Err(AppError::InvalidInput(_))));
    }
}
