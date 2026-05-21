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
