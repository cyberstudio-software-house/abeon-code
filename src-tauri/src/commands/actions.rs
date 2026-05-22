use std::path::PathBuf;
use tauri::State;
use crate::domain::{Action, ActionInput, ActionPatch};
use crate::detectors::{detect_all, DetectedScript};
use crate::error::AppResult;
use crate::state::AppState;
use crate::db::actions_repo as repo;

#[tauri::command]
pub fn list_actions(state: State<AppState>, project_id: i64) -> AppResult<Vec<Action>> {
    let c = state.db.get()?;
    repo::list(&c, project_id)
}

#[tauri::command]
pub fn detect_scripts(project_path: String) -> AppResult<Vec<DetectedScript>> {
    Ok(detect_all(&PathBuf::from(project_path)))
}

#[tauri::command]
pub fn add_action(state: State<AppState>, input: ActionInput) -> AppResult<Action> {
    let c = state.db.get()?;
    repo::insert(
        &c, input.project_id, &input.label, &input.command,
        input.working_dir.as_deref(), input.source.as_deref(),
    )
}

#[tauri::command]
pub fn update_action(state: State<AppState>, id: i64, patch: ActionPatch) -> AppResult<Action> {
    let c = state.db.get()?;
    repo::update(&c, id, patch.label.as_deref(), patch.command.as_deref(), patch.working_dir.as_deref())
}

#[tauri::command]
pub fn remove_action(state: State<AppState>, id: i64) -> AppResult<()> {
    let c = state.db.get()?;
    repo::delete(&c, id)
}
