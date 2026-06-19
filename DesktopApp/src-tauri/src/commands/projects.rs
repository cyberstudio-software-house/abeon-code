use std::path::PathBuf;
use tauri::State;
use crate::domain::Project;
use crate::error::{AppError, AppResult};
use crate::sessions::encoding::encode_project_path;
use crate::state::AppState;
use crate::db::projects_repo as repo;

#[tauri::command]
pub fn list_projects(state: State<AppState>) -> AppResult<Vec<Project>> {
    let c = state.db.get()?;
    repo::list(&c)
}

#[tauri::command]
pub fn add_project(state: State<AppState>, name: String, path: String) -> AppResult<Project> {
    let p = PathBuf::from(&path);
    if !p.is_dir() {
        return Err(AppError::InvalidPath {
            path: path.clone(),
            reason: "katalog nie istnieje".into(),
        });
    }
    let claude_dir = encode_project_path(&p);
    let c = state.db.get()?;
    repo::insert(&c, &name, &path, &claude_dir, None)
}

#[tauri::command]
pub fn update_project(
    state: State<AppState>, id: i64,
    name: Option<String>, color: Option<String>,
) -> AppResult<Project> {
    let c = state.db.get()?;
    repo::update(&c, id, name.as_deref(), color.as_deref())
}

#[tauri::command]
pub fn remove_project(state: State<AppState>, id: i64) -> AppResult<()> {
    let c = state.db.get()?;
    repo::delete(&c, id)
}

#[tauri::command]
pub fn reorder_projects(state: State<AppState>, ids: Vec<i64>) -> AppResult<()> {
    let c = state.db.get()?;
    repo::reorder(&c, &ids)
}

pub fn find_or_create(conn: &rusqlite::Connection, input: &str) -> AppResult<Project> {
    let canonical = std::fs::canonicalize(input).map_err(|_| AppError::InvalidPath {
        path: input.to_string(),
        reason: "ścieżka nie istnieje".into(),
    })?;
    if !canonical.is_dir() {
        return Err(AppError::InvalidPath {
            path: input.to_string(),
            reason: "to nie jest katalog".into(),
        });
    }
    let canonical_str = canonical.to_string_lossy().to_string();
    if let Some(existing) = repo::get_by_path(conn, &canonical_str)? {
        return Ok(existing);
    }
    if canonical_str != input {
        if let Some(existing) = repo::get_by_path(conn, input)? {
            return Ok(existing);
        }
    }
    let name = canonical
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| canonical_str.clone());
    let claude_dir = encode_project_path(&canonical);
    repo::insert(conn, &name, &canonical_str, &claude_dir, None)
}

#[tauri::command]
pub fn find_or_create_project(state: State<AppState>, path: String) -> AppResult<Project> {
    let c = state.db.get()?;
    find_or_create(&c, &path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_pool;
    use tempfile::{NamedTempFile, tempdir};

    fn conn() -> r2d2::PooledConnection<r2d2_sqlite::SqliteConnectionManager> {
        let f = NamedTempFile::new().unwrap();
        let path = f.path().to_path_buf();
        std::mem::forget(f);
        init_pool(&path).unwrap().get().unwrap()
    }

    #[test]
    fn creates_then_reuses_project() {
        let c = conn();
        let dir = tempdir().unwrap();
        let path = dir.path().to_string_lossy().to_string();

        let a = find_or_create(&c, &path).unwrap();
        assert_eq!(a.name, dir.path().file_name().unwrap().to_string_lossy());

        let b = find_or_create(&c, &path).unwrap();
        assert_eq!(a.id, b.id);
        assert_eq!(repo::list(&c).unwrap().len(), 1);
    }

    #[test]
    fn rejects_missing_and_file() {
        let c = conn();
        assert!(find_or_create(&c, "/definitely/not/here/xyz").is_err());

        let dir = tempdir().unwrap();
        let file = dir.path().join("a.txt");
        std::fs::write(&file, "x").unwrap();
        assert!(find_or_create(&c, &file.to_string_lossy()).is_err());
    }
}
