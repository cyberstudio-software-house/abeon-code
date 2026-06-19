use tauri::State;
use crate::error::{AppError, AppResult};
use crate::state::AppState;
use crate::cli::installer;

#[tauri::command]
pub fn take_pending_open_paths(state: State<AppState>) -> Vec<String> {
    *state.cli_frontend_ready.lock() = true;
    std::mem::take(&mut *state.pending_open_paths.lock())
}

#[tauri::command]
pub fn install_cli_command() -> AppResult<String> {
    let exe = std::env::current_exe().map_err(|e| AppError::Other(format!("current_exe: {e}")))?;
    let home = dirs::home_dir().ok_or_else(|| AppError::Other("no home dir".into()))?;
    let target = home.join(".local").join("bin");
    let dest = installer::install(&exe.to_string_lossy(), &target)?;
    Ok(dest.to_string_lossy().to_string())
}
