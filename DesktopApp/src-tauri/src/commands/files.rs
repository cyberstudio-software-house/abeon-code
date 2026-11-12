use std::collections::HashSet;
use std::path::{Path, PathBuf};

use tauri::{Manager, State, WebviewWindow};

use crate::db::projects_repo;
use crate::domain::files::{FileEntry, FileReadResponse, FileSearchResponse};
use crate::error::{AppError, AppResult};
use crate::files::paths::{resolve_existing, resolve_for_write, watch_dir_of};
use crate::files::{
    content, listing, search, write, MAX_TEXT_BYTES, SEARCH_LIMIT, SEARCH_VISIT_CAP,
};
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

fn read_with_watch_dir(root: &Path, rel_path: &str) -> AppResult<FileReadResponse> {
    let path = resolve_existing(root, rel_path)?;
    let content = content::read_file(&path)?;
    Ok(FileReadResponse {
        content,
        watch_dir: watch_dir_of(root, rel_path, &path),
    })
}

#[tauri::command(async)]
pub fn read_project_file(
    state: State<AppState>,
    project_id: i64,
    rel_path: String,
) -> AppResult<FileReadResponse> {
    let root = project_root(&state, project_id)?;
    read_with_watch_dir(&root, &rel_path)
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
    if !abs_dir.is_dir() {
        return Err(AppError::InvalidPath {
            path: rel_path,
            reason: "not a directory".to_string(),
        });
    }
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
    let live_labels: HashSet<String> = window.app_handle().webview_windows().into_keys().collect();
    state
        .file_watches
        .dirty_elsewhere(window.label(), &live_labels)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::files::FileContent;

    #[test]
    fn text_size_limit_counts_bytes_not_characters() {
        let at_limit = "a".repeat(MAX_TEXT_BYTES as usize);
        assert!(ensure_text_size(&at_limit).is_ok());
        let over_limit = "a".repeat(MAX_TEXT_BYTES as usize + 1);
        assert!(matches!(
            ensure_text_size(&over_limit),
            Err(AppError::InvalidInput(_))
        ));
        let multibyte = "ł".repeat(MAX_TEXT_BYTES as usize / 2 + 1);
        assert!(matches!(
            ensure_text_size(&multibyte),
            Err(AppError::InvalidInput(_))
        ));
    }

    #[cfg(unix)]
    #[test]
    fn read_reports_the_directory_of_the_link_target() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join("config")).unwrap();
        std::fs::write(root.path().join("config/real.env"), "A=1\n").unwrap();
        std::os::unix::fs::symlink("config/real.env", root.path().join(".env")).unwrap();
        let read = read_with_watch_dir(root.path(), ".env").unwrap();
        assert_eq!(read.watch_dir, "config");
        assert!(
            matches!(read.content, FileContent::Text { ref content, .. } if content == "A=1\n")
        );
    }

    #[test]
    fn read_of_a_missing_file_is_not_found() {
        let root = tempfile::tempdir().unwrap();
        let error = read_with_watch_dir(root.path(), "nope.txt").unwrap_err();
        assert!(matches!(error, AppError::NotFound(_)), "{error:?}");
    }

    #[test]
    fn read_response_is_the_file_content_plus_watch_dir() {
        let response = FileReadResponse {
            content: FileContent::Binary {
                version: "5-2".to_string(),
                size: 2,
            },
            watch_dir: "bin".to_string(),
        };
        assert_eq!(
            serde_json::to_value(&response).unwrap(),
            serde_json::json!({ "kind": "binary", "version": "5-2", "size": 2, "watch_dir": "bin" })
        );
    }
}
