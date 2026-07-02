use tauri::{AppHandle, Manager};
use crate::error::{AppError, AppResult};
use crate::notifications::hook_installer;

/// `<app_data_dir>/notifications` — where the Claude hook drops marker files.
pub fn markers_dir(app: &AppHandle) -> AppResult<std::path::PathBuf> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Other(format!("app_data_dir: {e}")))?;
    Ok(base.join("notifications"))
}

#[tauri::command]
pub fn install_attention_hook(app: AppHandle) -> AppResult<()> {
    let dir = markers_dir(&app)?;
    hook_installer::install(&dir)
}

#[tauri::command]
pub fn uninstall_attention_hook() -> AppResult<()> {
    hook_installer::uninstall()
}

#[tauri::command]
pub fn attention_hook_status() -> bool {
    hook_installer::status()
}

#[tauri::command]
pub fn show_attention_notification(app: AppHandle, session_id: String, title: String, body: String) {
    crate::notifications::desktop::show_attention_notification(&app, session_id, title, body);
}
