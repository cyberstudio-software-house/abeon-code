use serde::Deserialize;
use ts_rs::TS;
use tauri::{AppHandle, State};
use base64::Engine;
use uuid::Uuid;
use crate::error::{AppError, AppResult};
use crate::state::AppState;
use crate::db::{projects_repo, actions_repo};
use crate::remote::dispatch::session_to_bind;

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
        #[serde(default)]
        fresh: bool,
    },
    Action {
        #[ts(type = "number")]
        action_id: i64,
    },
    Shell,
}

// A fresh session forces its id up-front via `--session-id` so the tab's id equals the
// real session id from the start (no placeholder linking). Resuming uses `--resume`.
fn build_claude_command(
    session_id: Option<&str>,
    model: Option<&str>,
    skip_permissions: bool,
    fresh: bool,
) -> String {
    let mut cmd = String::from("claude");
    match session_id {
        Some(id) if fresh => {
            cmd.push_str(&format!(" --session-id {id}"));
            if let Some(m) = model {
                cmd.push_str(&format!(" --model {m}"));
            }
        }
        Some(id) => cmd.push_str(&format!(" --resume {id}")),
        None => {
            if let Some(m) = model {
                cmd.push_str(&format!(" --model {m}"));
            }
        }
    }
    if skip_permissions {
        cmd.push_str(" --dangerously-skip-permissions");
    }
    cmd
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
        PtyKind::Claude { session_id, model, skip_permissions, fresh } => {
            // Untrusted in the remote-bridge path (session_id can originate from a
            // mobile `resumeSession`). Validate before it reaches `bash -c` so the
            // shell can never reinterpret it; the allowlist also blocks flag smuggling.
            if let Some(id) = session_id {
                crate::validation::validate_session_id(id)?;
            }
            if let Some(m) = model {
                crate::validation::validate_model(m)?;
            }
            let cmd = build_claude_command(
                session_id.as_deref(),
                model.as_deref(),
                *skip_permissions,
                *fresh,
            );
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
            let pre = action.pre_command.as_deref().unwrap_or("")
                .trim_end_matches(|c: char| c == '&' || c == ';' || c.is_whitespace())
                .trim();
            if pre.is_empty() {
                (
                    "bash".to_string(),
                    vec!["-c".to_string(), action.command.clone()],
                )
            } else {
                // pre_command often uses shell functions (nvm/fnm) defined only in the
                // user's interactive rcfile (~/.zshrc, ~/.bashrc). Run in the chosen shell
                // with -i so that rcfile is sourced and the function is available.
                (
                    crate::commands::settings::resolve_shell(&c),
                    vec!["-ic".to_string(), format!("{} && {}", pre, action.command)],
                )
            }
        }
        PtyKind::Shell => (
            crate::commands::settings::resolve_shell(&c),
            vec!["-l".to_string()],
        ),
    };

    let args_ref: Vec<&str> = args_owned.iter().map(|s| s.as_str()).collect();
    let shell = crate::commands::settings::resolve_shell(&c);
    let env = crate::commands::settings::ensure_shell_env(&state, &shell);
    let pty_id = state.pty.spawn(app, &program, &args_ref, &cwd, cols, rows, &env)?;
    if let Some(session_id) = session_to_bind(&kind) {
        state.session_pty.bind(&session_id, &pty_id);
    }
    Ok(pty_id)
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

fn cleanup_clipboard_images(state: &AppState, pty_id: &str) {
    if let Some(paths) = state.clipboard_images.lock().remove(pty_id) {
        for path in paths {
            let _ = std::fs::remove_file(path);
        }
    }
}

#[tauri::command]
pub fn pty_kill(state: State<AppState>, pty_id: String) -> AppResult<()> {
    cleanup_clipboard_images(&state, &pty_id);
    state.session_pty.unbind_pty(&pty_id);
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

fn try_clipboard_image_subprocess() -> Option<Vec<u8>> {
    use std::process::Command;

    // Wayland: wl-paste
    if let Ok(types_out) = Command::new("wl-paste").args(["--list-types"]).output() {
        if types_out.status.success() {
            let types = String::from_utf8_lossy(&types_out.stdout);
            if types.lines().any(|t| t.starts_with("image/")) {
                if let Ok(img_out) = Command::new("wl-paste")
                    .args(["--type", "image/png", "--no-newline"])
                    .output()
                {
                    if img_out.status.success() && img_out.stdout.starts_with(&[0x89, b'P', b'N', b'G']) {
                        return Some(img_out.stdout);
                    }
                }
            }
        }
    }

    // X11: xclip
    if let Ok(types_out) = Command::new("xclip")
        .args(["-selection", "clipboard", "-t", "TARGETS", "-o"])
        .output()
    {
        if types_out.status.success() {
            let types = String::from_utf8_lossy(&types_out.stdout);
            if types.lines().any(|t| t.starts_with("image/")) {
                if let Ok(img_out) = Command::new("xclip")
                    .args(["-selection", "clipboard", "-t", "image/png", "-o"])
                    .output()
                {
                    if img_out.status.success() && img_out.stdout.starts_with(&[0x89, b'P', b'N', b'G']) {
                        return Some(img_out.stdout);
                    }
                }
            }
        }
    }

    None
}

fn read_clipboard_image_inner(state: &AppState, pty_id: String) -> AppResult<Option<String>> {
    let dir = std::env::temp_dir().join("abeoncode-images");
    std::fs::create_dir_all(&dir)?;
    let filename = format!("{}.png", Uuid::new_v4());
    let path = dir.join(&filename);

    if let Some(png_bytes) = try_clipboard_image_subprocess() {
        std::fs::write(&path, &png_bytes)?;
    } else {
        // Fallback: arboard (works on macOS/Windows, unreliable for images on Linux)
        let mut clipboard = arboard::Clipboard::new()
            .map_err(|e| AppError::Other(format!("clipboard: {e}")))?;
        let img = match clipboard.get_image() {
            Ok(img) => img,
            Err(_) => return Ok(None),
        };
        let file = std::fs::File::create(&path)?;
        let w = std::io::BufWriter::new(file);
        let mut encoder = png::Encoder::new(w, img.width as u32, img.height as u32);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder
            .write_header()
            .map_err(|e| AppError::Other(format!("png header: {e}")))?;
        writer
            .write_image_data(&img.bytes)
            .map_err(|e| AppError::Other(format!("png write: {e}")))?;
        drop(writer);
    }

    let path_str = path.to_string_lossy().to_string();
    state
        .clipboard_images
        .lock()
        .entry(pty_id)
        .or_default()
        .push(path.clone());

    Ok(Some(path_str))
}

#[tauri::command]
pub fn read_clipboard_image(
    state: State<AppState>,
    pty_id: String,
) -> AppResult<Option<String>> {
    read_clipboard_image_inner(&state, pty_id)
}

#[tauri::command]
pub fn write_clipboard_text(text: String) -> AppResult<()> {
    let mut clipboard = arboard::Clipboard::new()
        .map_err(|e| AppError::Other(format!("clipboard: {e}")))?;
    clipboard.set_text(text)
        .map_err(|e| AppError::Other(format!("clipboard: {e}")))?;
    Ok(())
}

#[tauri::command]
pub fn read_clipboard_text() -> AppResult<Option<String>> {
    let mut clipboard = arboard::Clipboard::new()
        .map_err(|e| AppError::Other(format!("clipboard: {e}")))?;
    match clipboard.get_text() {
        Ok(text) if !text.is_empty() => Ok(Some(text)),
        _ => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn claude_command_fresh_uses_session_id() {
        assert_eq!(
            build_claude_command(Some("uuid-1"), None, false, true),
            "claude --session-id uuid-1"
        );
    }

    #[test]
    fn claude_command_fresh_with_model() {
        assert_eq!(
            build_claude_command(Some("uuid-1"), Some("opus"), false, true),
            "claude --session-id uuid-1 --model opus"
        );
    }

    #[test]
    fn claude_command_resume_ignores_model() {
        assert_eq!(
            build_claude_command(Some("uuid-1"), Some("opus"), false, false),
            "claude --resume uuid-1"
        );
    }

    #[test]
    fn claude_command_no_id_with_model() {
        assert_eq!(
            build_claude_command(None, Some("opus"), false, false),
            "claude --model opus"
        );
    }

    #[test]
    fn claude_command_skip_permissions_appended_last() {
        assert_eq!(
            build_claude_command(Some("uuid-1"), None, true, true),
            "claude --session-id uuid-1 --dangerously-skip-permissions"
        );
    }

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

    #[test]
    fn cleanup_removes_tracked_files() {
        let state = crate::state::AppState::new(
            crate::db::init_pool(&std::path::PathBuf::from(":memory:")).expect("in-memory db"),
        );
        let pty_id = "cleanup-test".to_string();

        let dir = std::env::temp_dir().join("abeoncode-images");
        std::fs::create_dir_all(&dir).unwrap();
        let file1 = dir.join("cleanup1.png");
        let file2 = dir.join("cleanup2.png");
        std::fs::write(&file1, b"fake1").unwrap();
        std::fs::write(&file2, b"fake2").unwrap();

        {
            let mut map = state.clipboard_images.lock();
            map.insert(pty_id.clone(), vec![file1.clone(), file2.clone()]);
        }

        cleanup_clipboard_images(&state, &pty_id);

        assert!(!file1.exists(), "file1 should be deleted");
        assert!(!file2.exists(), "file2 should be deleted");
        assert!(state.clipboard_images.lock().get(&pty_id).is_none());
    }

    #[test]
    fn full_flow_save_then_cleanup() {
        let state = crate::state::AppState::new(
            crate::db::init_pool(&std::path::PathBuf::from(":memory:")).expect("in-memory db"),
        );
        let pty_id = "flow-test".to_string();

        // 1x1 red PNG
        let png_b64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==";

        // Save two images
        let path1 = save_clipboard_image_inner(&state, pty_id.clone(), png_b64.to_string()).unwrap();
        let path2 = save_clipboard_image_inner(&state, pty_id.clone(), png_b64.to_string()).unwrap();
        assert_ne!(path1, path2, "UUIDs should differ");
        assert!(Path::new(&path1).exists());
        assert!(Path::new(&path2).exists());

        // Verify both tracked
        assert_eq!(state.clipboard_images.lock().get(&pty_id).unwrap().len(), 2);

        // Cleanup
        cleanup_clipboard_images(&state, &pty_id);
        assert!(!Path::new(&path1).exists());
        assert!(!Path::new(&path2).exists());
        assert!(state.clipboard_images.lock().get(&pty_id).is_none());
    }
}
