use serde::Deserialize;
use ts_rs::TS;
use tauri::{AppHandle, State};
use base64::Engine;
use crate::error::{AppError, AppResult};
use crate::state::AppState;
use crate::db::{projects_repo, actions_repo};

#[derive(Deserialize, TS)]
#[ts(export, export_to = "../../src/types/")]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum PtyKind {
    Claude {
        session_id: String,
    },
    Action {
        #[ts(type = "number")]
        action_id: i64,
    },
}

#[tauri::command]
pub fn spawn_pty(
    app: AppHandle,
    state: State<AppState>,
    project_id: i64,
    kind: PtyKind,
    cols: u16,
    rows: u16,
) -> AppResult<String> {
    let c = state.db.get()?;
    let proj = projects_repo::get(&c, project_id)?;
    let cwd = std::path::PathBuf::from(&proj.path);

    let (program, args_owned) = match &kind {
        PtyKind::Claude { session_id } => (
            "bash".to_string(),
            vec![
                "-lc".to_string(),
                format!("claude --resume {session_id}"),
            ],
        ),
        PtyKind::Action { action_id } => {
            let action = actions_repo::get(&c, *action_id)?;
            (
                "bash".to_string(),
                vec!["-lc".to_string(), action.command.clone()],
            )
        }
    };

    let args_ref: Vec<&str> = args_owned.iter().map(|s| s.as_str()).collect();
    state.pty.spawn(app, &program, &args_ref, &cwd, cols, rows)
}

#[tauri::command]
pub fn pty_write(state: State<AppState>, pty_id: String, data: String) -> AppResult<()> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data.as_bytes())
        .map_err(|e| AppError::Other(format!("base64: {e}")))?;
    state.pty.write(&pty_id, &bytes)
}

#[tauri::command]
pub fn pty_resize(state: State<AppState>, pty_id: String, cols: u16, rows: u16) -> AppResult<()> {
    state.pty.resize(&pty_id, cols, rows)
}

#[tauri::command]
pub fn pty_kill(state: State<AppState>, pty_id: String) -> AppResult<()> {
    state.pty.kill(&pty_id)
}
