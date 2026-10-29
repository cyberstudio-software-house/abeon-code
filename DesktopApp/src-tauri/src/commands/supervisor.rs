use tauri::{AppHandle, State};

use crate::domain::supervisor::SupervisorSnapshot;
use crate::error::{AppError, AppResult};
use crate::state::AppState;
use crate::supervisor::runtime;

async fn run_blocking(app: AppHandle, operation: fn(&AppHandle) -> AppResult<()>) -> AppResult<()> {
    tauri::async_runtime::spawn_blocking(move || operation(&app))
        .await
        .map_err(|error| AppError::Other(error.to_string()))?
}

#[tauri::command]
pub fn supervisor_snapshot(state: State<AppState>) -> SupervisorSnapshot {
    let core = state.supervisor.lock().clone();
    core.map(|core| core.snapshot()).unwrap_or_default()
}

#[tauri::command]
pub async fn supervisor_new_conversation(app: AppHandle) -> AppResult<()> {
    run_blocking(app, runtime::new_conversation).await
}

#[tauri::command]
pub async fn supervisor_restart(app: AppHandle) -> AppResult<()> {
    run_blocking(app, runtime::restart_supervisor).await
}
