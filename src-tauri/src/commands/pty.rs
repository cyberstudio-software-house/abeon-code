use serde::Deserialize;
use ts_rs::TS;
use tauri::{AppHandle, State};
use base64::Engine;
use uuid::Uuid;
use crate::error::{AppError, AppResult};
use crate::state::AppState;
use crate::db::{projects_repo, actions_repo};

#[derive(Deserialize, TS)]
#[ts(export, export_to = "../../src/types/")]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum PtyKind {
    Claude {
        #[serde(default)]
        session_id: Option<String>,
        #[serde(default)]
        model: Option<String>,
        #[serde(default)]
        skip_permissions: bool,
    },
    Action {
        #[ts(type = "number")]
        action_id: i64,
    },
    Shell,
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
    let mut cwd = std::path::PathBuf::from(&proj.path);

    let (program, args_owned) = match &kind {
        PtyKind::Claude { session_id, model, skip_permissions } => {
            let mut cmd = match (session_id, model) {
                (Some(id), _) => format!("claude --resume {id}"),
                (None, Some(m)) => format!("claude --model {m}"),
                (None, None) => "claude".to_string(),
            };
            if *skip_permissions {
                cmd.push_str(" --dangerously-skip-permissions");
            }
            (
                "bash".to_string(),
                vec!["-c".to_string(), cmd],
            )
        }
        PtyKind::Action { action_id } => {
            let action = actions_repo::get(&c, *action_id)?;
            if let Some(ref wd) = action.working_dir {
                let resolved = cwd.join(wd);
                if resolved.is_dir() {
                    cwd = resolved;
                }
            }
            (
                "bash".to_string(),
                vec!["-c".to_string(), action.command.clone()],
            )
        }
        PtyKind::Shell => (
            crate::commands::settings::resolve_shell(&c),
            vec!["-l".to_string()],
        ),
    };

    let args_ref: Vec<&str> = args_owned.iter().map(|s| s.as_str()).collect();
    let shell = crate::commands::settings::resolve_shell(&c);
    let env = crate::commands::settings::ensure_shell_env(&state, &shell);
    state.pty.spawn(app, &program, &args_ref, &cwd, cols, rows, &env)
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

fn save_clipboard_image_inner(
    state: &AppState,
    pty_id: String,
    data: String,
) -> AppResult<String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data.as_bytes())
        .map_err(|e| AppError::Other(format!("base64: {e}")))?;

    let dir = std::env::temp_dir().join("abeoncode-images");
    std::fs::create_dir_all(&dir)?;

    let filename = format!("{}.png", Uuid::new_v4());
    let path = dir.join(&filename);
    std::fs::write(&path, &bytes)?;

    let path_str = path.to_string_lossy().to_string();
    state
        .clipboard_images
        .lock()
        .entry(pty_id)
        .or_default()
        .push(path.clone());

    Ok(path_str)
}

#[tauri::command]
pub fn save_clipboard_image(
    state: State<AppState>,
    pty_id: String,
    data: String,
) -> AppResult<String> {
    save_clipboard_image_inner(&state, pty_id, data)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn save_clipboard_image_creates_file() {
        let state = crate::state::AppState::new(
            crate::db::init_pool(&std::path::PathBuf::from(":memory:")).expect("in-memory db"),
        );
        let pty_id = "test-pty-img".to_string();

        // 1x1 red PNG as base64
        let png_b64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==";

        let result = save_clipboard_image_inner(&state, pty_id.clone(), png_b64.to_string());
        assert!(result.is_ok(), "save failed: {:?}", result.err());

        let path_str = result.unwrap();
        let path = Path::new(&path_str);
        assert!(path.exists(), "file should exist at {path_str}");
        assert!(path_str.contains("abeoncode-images"));
        assert!(path_str.ends_with(".png"));

        // Verify tracked in state
        let map = state.clipboard_images.lock();
        let tracked = map.get(&pty_id).unwrap();
        assert_eq!(tracked.len(), 1);
        assert_eq!(tracked[0].to_string_lossy(), path_str);

        // Cleanup
        drop(map);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn save_clipboard_image_invalid_base64() {
        let state = crate::state::AppState::new(
            crate::db::init_pool(&std::path::PathBuf::from(":memory:")).expect("in-memory db"),
        );
        let result = save_clipboard_image_inner(&state, "pty".into(), "not-valid-b64!!!".into());
        assert!(result.is_err());
    }
}
