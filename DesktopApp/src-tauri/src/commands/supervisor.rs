use std::collections::HashMap;
use std::sync::Arc;

use tauri::{AppHandle, Manager, State};

use crate::commands::settings::{ensure_shell_env, resolve_shell};
use crate::db::{settings_repo, supervisor_decisions_repo};
use crate::domain::supervisor::{DiscordSetupStatus, SupervisorLevel, SupervisorSnapshot};
use crate::domain::DecisionEntry;
use crate::error::{AppError, AppResult};
use crate::sessions::reader::now_ms;
use crate::state::AppState;
use crate::supervisor::core::{ApprovalSource, SupervisorCore};
use crate::supervisor::discord::client::DiscordClient;
use crate::supervisor::discord::files::{disable_global_plugin, validate_token, DiscordFiles};
use crate::supervisor::discord::preflight::resolve_bun;
use crate::supervisor::discord::status::setup_status;
use crate::supervisor::process::claude_home;
use crate::supervisor::runtime;
use crate::supervisor::settings::{SupervisorSettings, DISCORD_CHAT_ID_KEY};

const ERROR_SUPERVISOR_NOT_RUNNING: &str = "supervisor is not running";
const ERROR_NO_HOME: &str = "Nie znaleziono katalogu domowego";
const ERROR_SAVE_TOKEN: &str = "Nie udało się zapisać tokenu";
const ERROR_DISABLE_PLUGIN: &str = "Nie udało się wyłączyć wtyczki Discord";

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
        .resolve_approval(&approval_id, approve, ApprovalSource::App)
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

struct StatusInputs {
    claude_home: std::path::PathBuf,
    bun: Option<std::path::PathBuf>,
    chat_linked: bool,
    token: Option<String>,
}

fn require_claude_home() -> AppResult<std::path::PathBuf> {
    claude_home().ok_or_else(|| AppError::Other(ERROR_NO_HOME.to_string()))
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> AppResult<T> + Send + 'static,
) -> AppResult<T> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|error| AppError::Other(error.to_string()))?
}

fn restart_when_discord_active(app: &AppHandle, settings: &SupervisorSettings) -> AppResult<()> {
    if settings.discord_enabled && settings.level != SupervisorLevel::Off {
        runtime::restart_supervisor(app)?;
    }
    Ok(())
}

fn gather_status_inputs(app: &AppHandle) -> AppResult<StatusInputs> {
    let state = app.state::<AppState>();
    let (settings, shell) = {
        let conn = state.db.get()?;
        (SupervisorSettings::load(&conn), resolve_shell(&conn))
    };
    let claude_home = require_claude_home()?;
    let home = dirs::home_dir().ok_or_else(|| AppError::Other(ERROR_NO_HOME.to_string()))?;
    let env = ensure_shell_env(&state, &shell);
    Ok(StatusInputs {
        bun: resolve_bun(&env, &home),
        chat_linked: settings.discord_chat_id.is_some(),
        token: DiscordFiles::for_claude_home(&claude_home).token(),
        claude_home,
    })
}

#[tauri::command(async)]
pub async fn supervisor_discord_status(app: AppHandle) -> AppResult<DiscordSetupStatus> {
    let gather_app = app.clone();
    let inputs = blocking(move || gather_status_inputs(&gather_app)).await?;
    let bot = match inputs.token.clone() {
        Some(token) => Some(DiscordClient::new(token).bot().await),
        None => None,
    };
    let link = runtime::discord_link(&app);
    blocking(move || {
        let files = DiscordFiles::for_claude_home(&inputs.claude_home);
        Ok(setup_status(
            &files,
            &inputs.claude_home,
            inputs.bun,
            bot,
            inputs.chat_linked,
            &link,
        ))
    })
    .await
}

fn save_token_blocking(app: &AppHandle, token: &str) -> AppResult<()> {
    let token = validate_token(token).map_err(|reason| AppError::Other(reason.to_string()))?;
    let files = DiscordFiles::for_claude_home(&require_claude_home()?);
    let previous = files.token();
    files
        .save_token(&token)
        .map_err(|error| AppError::Other(format!("{ERROR_SAVE_TOKEN}: {error}")))?;
    let state = app.state::<AppState>();
    let conn = state.db.get()?;
    if previous.as_deref() != Some(token.as_str()) {
        settings_repo::set(&conn, DISCORD_CHAT_ID_KEY, "")?;
    }
    Ok(())
}

#[tauri::command(async)]
pub async fn supervisor_discord_save_token(app: AppHandle, token: String) -> AppResult<()> {
    let save_app = app.clone();
    blocking(move || save_token_blocking(&save_app, &token)).await?;
    runtime::link_discord_chat(&app);
    blocking(move || {
        let settings = {
            let conn = app.state::<AppState>().db.get()?;
            SupervisorSettings::load(&conn)
        };
        restart_when_discord_active(&app, &settings)
    })
    .await
}

fn pair_blocking(app: &AppHandle, code: &str) -> AppResult<()> {
    let files = DiscordFiles::for_claude_home(&require_claude_home()?);
    let paired = files
        .pair(code.trim(), now_ms())
        .map_err(|error| AppError::Other(error.to_string()))?;
    let settings = {
        let conn = app.state::<AppState>().db.get()?;
        settings_repo::set(&conn, DISCORD_CHAT_ID_KEY, &paired.chat_id)?;
        SupervisorSettings::load(&conn)
    };
    restart_when_discord_active(app, &settings)
}

#[tauri::command(async)]
pub async fn supervisor_discord_pair(app: AppHandle, code: String) -> AppResult<()> {
    blocking(move || pair_blocking(&app, &code)).await
}

#[tauri::command(async)]
pub async fn supervisor_discord_disable_global_plugin() -> AppResult<()> {
    blocking(|| {
        let claude_home = require_claude_home()?;
        disable_global_plugin(&claude_home)
            .map(|_| ())
            .map_err(|error| AppError::Other(format!("{ERROR_DISABLE_PLUGIN}: {error}")))
    })
    .await
}
