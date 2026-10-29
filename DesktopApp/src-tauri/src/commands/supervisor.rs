use std::collections::HashMap;
use std::sync::Arc;

use tauri::{AppHandle, State};

use crate::db::supervisor_decisions_repo;
use crate::domain::supervisor::SupervisorSnapshot;
use crate::domain::DecisionEntry;
use crate::error::{AppError, AppResult};
use crate::state::AppState;
use crate::supervisor::core::SupervisorCore;
use crate::supervisor::runtime;

const ERROR_SUPERVISOR_NOT_RUNNING: &str = "supervisor is not running";

fn current_core(state: &State<AppState>) -> Option<Arc<SupervisorCore>> {
    state.supervisor.lock().clone()
}

fn require_core(state: &State<AppState>) -> AppResult<Arc<SupervisorCore>> {
    current_core(state).ok_or_else(|| AppError::Other(ERROR_SUPERVISOR_NOT_RUNNING.to_string()))
}

async fn run_blocking(app: AppHandle, operation: fn(&AppHandle) -> AppResult<()>) -> AppResult<()> {
    tauri::async_runtime::spawn_blocking(move || operation(&app))
        .await
        .map_err(|error| AppError::Other(error.to_string()))?
}

#[tauri::command]
pub fn supervisor_snapshot(state: State<AppState>) -> SupervisorSnapshot {
    current_core(&state).map(|core| core.snapshot()).unwrap_or_default()
}

#[tauri::command]
pub async fn supervisor_new_conversation(app: AppHandle) -> AppResult<()> {
    run_blocking(app, runtime::new_conversation).await
}

#[tauri::command]
pub async fn supervisor_restart(app: AppHandle) -> AppResult<()> {
    run_blocking(app, runtime::restart_supervisor).await
}

#[tauri::command]
pub fn supervisor_report_activity(state: State<AppState>, focused_session_id: Option<String>) {
    if let Some(core) = current_core(&state) {
        core.report_activity(focused_session_id);
    }
}

#[tauri::command]
pub fn supervisor_set_away(state: State<AppState>, away: bool) {
    if let Some(core) = current_core(&state) {
        core.set_away(away);
    }
}

#[tauri::command]
pub fn supervisor_answer_card(
    state: State<AppState>,
    question_id: String,
    answers: HashMap<String, String>,
) -> AppResult<()> {
    require_core(&state)?
        .answer_card(&question_id, answers)
        .map_err(AppError::InvalidInput)
}

#[tauri::command(async)]
pub fn supervisor_release_card(state: State<AppState>, question_id: String) -> AppResult<()> {
    require_core(&state)?
        .release_card(&question_id)
        .map_err(AppError::InvalidInput)
}

#[tauri::command(async)]
pub fn supervisor_resolve_approval(
    state: State<AppState>,
    approval_id: String,
    approve: bool,
) -> AppResult<()> {
    require_core(&state)?
        .resolve_approval(&approval_id, approve)
        .map_err(AppError::InvalidInput)
}

#[tauri::command]
pub fn supervisor_dismiss_escalation(state: State<AppState>, id: String) {
    if let Some(core) = current_core(&state) {
        core.dismiss_escalation(&id);
    }
}

#[tauri::command(async)]
pub fn supervisor_list_decisions(
    state: State<AppState>,
    limit: u32,
) -> AppResult<Vec<DecisionEntry>> {
    let conn = state.db.get()?;
    supervisor_decisions_repo::list(&conn, limit)
}
