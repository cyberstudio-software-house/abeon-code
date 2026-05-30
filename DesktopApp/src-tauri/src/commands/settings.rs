use serde::Serialize;
use std::collections::HashMap;
use tauri::State;
use ts_rs::TS;
use crate::db::settings_repo;
use crate::domain::ShellInfo;
use crate::error::AppResult;
use crate::state::AppState;

#[derive(Serialize, TS)]
#[ts(export, export_to = "../../src/types/")]
#[serde(rename_all = "camelCase")]
pub struct GitUser {
    pub name: String,
    pub initials: String,
    pub email: String,
}

#[tauri::command]
pub fn get_git_user() -> AppResult<GitUser> {
    let name = read_git_config("user.name").unwrap_or_else(|| "Developer".into());
    let email = read_git_config("user.email").unwrap_or_default();
    let initials = name.split_whitespace()
        .filter_map(|w| w.chars().next())
        .take(2)
        .collect::<String>()
        .to_uppercase();
    let initials = if initials.is_empty() { "D".into() } else { initials };
    Ok(GitUser { name, initials, email })
}

fn read_git_config(key: &str) -> Option<String> {
    std::process::Command::new("git")
        .args(["config", "--global", key])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty())
}

pub fn detect_default_shell_impl() -> Option<String> {
    let raw = std::env::var("SHELL").ok()?;
    if raw.is_empty() {
        return None;
    }
    if !std::path::Path::new(&raw).exists() {
        return None;
    }
    Some(raw)
}

#[tauri::command]
pub fn detect_default_shell() -> Option<String> {
    detect_default_shell_impl()
}

const KNOWN_SHELLS: &[&str] = &["bash", "zsh", "fish", "sh"];

fn which(name: &str) -> Option<String> {
    std::process::Command::new("which")
        .arg(name)
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty())
}

#[tauri::command]
pub fn list_available_shells() -> Vec<ShellInfo> {
    KNOWN_SHELLS.iter()
        .filter_map(|name| which(name).map(|path| ShellInfo {
            name: name.to_string(),
            path,
        }))
        .collect()
}

// Resolves the shell program to spawn for an interactive terminal (PtyKind::Shell).
// Fallback chain: settings.shellPath -> $SHELL -> "bash".
// An empty string in settings is treated as "not set" and falls through to $SHELL.
// A DB error reading settings is logged and treated as "not set".
pub fn resolve_shell(conn: &rusqlite::Connection) -> String {
    match settings_repo::get(conn, "shellPath") {
        Ok(Some(s)) if !s.is_empty() => return s,
        Err(e) => eprintln!("[resolve_shell] settings_repo::get failed: {e}"),
        _ => {}
    }
    detect_default_shell_impl().unwrap_or_else(|| "bash".to_string())
}

// Returns the cached shell env, populating it on first access.
// On load failure the cache is filled with the inherited process env so we don't
// retry on every PTY spawn and we still spawn with sensible defaults.
pub fn ensure_shell_env(state: &AppState, shell: &str) -> HashMap<String, String> {
    let mut guard = state.shell_env.lock();
    if guard.is_none() {
        let env = load_shell_env(shell)
            .unwrap_or_else(|| std::env::vars().collect());
        *guard = Some(env);
    }
    guard.as_ref().unwrap().clone()
}

pub fn invalidate_shell_env(state: &AppState) {
    *state.shell_env.lock() = None;
}

// Loads the environment exported by the user's login shell.
// Runs `<shell> -lc 'env -0'` which sources the shell's rc/profile files and
// dumps the resulting environment as null-separated KEY=VALUE pairs.
// Returns None on subprocess failure, non-zero exit, or invalid UTF-8.
pub fn load_shell_env(shell: &str) -> Option<HashMap<String, String>> {
    let output = std::process::Command::new(shell)
        .args(["-lc", "env -0"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let mut map = HashMap::new();
    for chunk in output.stdout.split(|&b| b == 0) {
        if chunk.is_empty() {
            continue;
        }
        let s = std::str::from_utf8(chunk).ok()?;
        if let Some(eq) = s.find('=') {
            let (k, rest) = s.split_at(eq);
            map.insert(k.to_string(), rest[1..].to_string());
        }
    }
    Some(map)
}

const EDITORS: &[(&str, &[&str])] = &[
    ("code", &["--goto"]),
    ("cursor", &["--goto"]),
    ("zed", &[]),
];

const KNOWN_EDITORS: &[&str] = &[
    "code", "cursor", "zed", "subl", "idea", "webstorm", "nvim", "vim",
];

#[tauri::command]
pub fn list_available_editors() -> Vec<crate::domain::EditorInfo> {
    KNOWN_EDITORS.iter()
        .filter_map(|name| which(name).map(|path| crate::domain::EditorInfo {
            name: name.to_string(),
            path,
        }))
        .collect()
}

#[tauri::command]
pub async fn open_project_in_editor(
    state: State<'_, AppState>,
    project_path: String,
) -> Result<(), String> {
    let editor = {
        let conn = state.db.get().map_err(|e| e.to_string())?;
        settings_repo::get(&conn, "editorPath")
            .map_err(|e| e.to_string())?
            .filter(|s| !s.is_empty())
    };

    if let Some(ed) = editor {
        let mut cmd = tokio::process::Command::new(&ed);
        cmd.arg(&project_path);
        match cmd.status().await {
            Ok(status) if status.success() => return Ok(()),
            Ok(status) => return Err(format!("{ed} exited with {status}")),
            Err(e) => return Err(format!("Failed to run {ed}: {e}")),
        }
    }

    for &name in KNOWN_EDITORS.iter().take(5) {
        if which(name).is_none() { continue; }
        let mut cmd = tokio::process::Command::new(name);
        cmd.arg(&project_path);
        match cmd.status().await {
            Ok(status) if status.success() => return Ok(()),
            _ => continue,
        }
    }

    Err("No editor found".into())
}

#[tauri::command]
pub async fn open_in_editor(
    project_path: String,
    file_path: String,
    line: Option<u32>,
    col: Option<u32>,
) -> Result<(), String> {
    let resolved = if std::path::Path::new(&file_path).is_absolute() {
        std::path::PathBuf::from(&file_path)
    } else {
        std::path::PathBuf::from(&project_path).join(&file_path)
    };

    if !resolved.exists() {
        return Err(format!("File not found: {}", resolved.display()));
    }

    let abs = resolved.to_string_lossy().to_string();
    let location = format!(
        "{}:{}:{}",
        abs,
        line.unwrap_or(1),
        col.unwrap_or(1)
    );

    for &(editor, flags) in EDITORS {
        let mut cmd = tokio::process::Command::new(editor);
        for flag in flags {
            cmd.arg(flag);
        }
        cmd.arg(&location);
        match cmd.status().await {
            Ok(status) if status.success() => return Ok(()),
            _ => continue,
        }
    }

    tokio::process::Command::new("xdg-open")
        .arg(&abs)
        .status()
        .await
        .map_err(|e| format!("No editor found: {e}"))?;

    Ok(())
}

#[tauri::command]
pub fn get_setting(state: State<AppState>, key: String) -> AppResult<Option<String>> {
    let c = state.db.get()?;
    settings_repo::get(&c, &key)
}

#[tauri::command]
pub fn get_all_settings(state: State<AppState>) -> AppResult<HashMap<String, String>> {
    let c = state.db.get()?;
    settings_repo::get_all(&c)
}

#[tauri::command]
pub fn set_setting(state: State<AppState>, key: String, value: String) -> AppResult<()> {
    let c = state.db.get()?;
    settings_repo::set(&c, &key, &value)?;
    if key == "shellPath" {
        invalidate_shell_env(&state);
    }
    Ok(())
}

#[tauri::command]
pub fn delete_setting(state: State<AppState>, key: String) -> AppResult<()> {
    let c = state.db.get()?;
    settings_repo::delete(&c, &key)
}

#[cfg(test)]
static TEST_ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[cfg(test)]
mod detect_tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn returns_some_when_shell_env_points_to_existing_file() {
        let _guard = TEST_ENV_LOCK.lock().unwrap();
        let td = TempDir::new().unwrap();
        let fake_shell = td.path().join("zsh");
        std::fs::write(&fake_shell, "").unwrap();
        std::env::set_var("SHELL", &fake_shell);
        let got = detect_default_shell_impl();
        assert_eq!(got, Some(fake_shell.to_string_lossy().to_string()));
    }

    #[test]
    fn returns_none_when_shell_env_missing() {
        let _guard = TEST_ENV_LOCK.lock().unwrap();
        std::env::remove_var("SHELL");
        assert_eq!(detect_default_shell_impl(), None);
    }

    #[test]
    fn returns_none_when_shell_path_missing() {
        let _guard = TEST_ENV_LOCK.lock().unwrap();
        std::env::set_var("SHELL", "/nonexistent/zsh");
        assert_eq!(detect_default_shell_impl(), None);
    }
}

#[cfg(test)]
mod list_tests {
    use super::*;

    #[test]
    fn returns_at_least_one_shell() {
        let shells = list_available_shells();
        assert!(!shells.is_empty(), "expected at least one shell (bash) on PATH");
        assert!(shells.iter().any(|s| s.name == "bash"));
    }
}

#[cfg(test)]
mod load_env_tests {
    use super::*;

    #[test]
    fn returns_env_from_bash_with_path() {
        let env = load_shell_env("bash").expect("bash should be available in CI");
        assert!(env.contains_key("PATH"), "expected PATH in shell env");
        assert!(!env.get("PATH").unwrap().is_empty());
    }

    #[test]
    fn returns_none_for_nonexistent_shell() {
        assert!(load_shell_env("/nonexistent/shell").is_none());
    }
}

#[cfg(test)]
mod resolve_tests {
    use super::*;
    use crate::db::{init_pool, DbPool};
    use tempfile::NamedTempFile;

    fn fresh_pool() -> DbPool {
        let f = NamedTempFile::new().unwrap();
        let path = f.path().to_path_buf();
        std::mem::forget(f);
        init_pool(&path).unwrap()
    }

    #[test]
    fn uses_settings_value_when_present() {
        let _guard = TEST_ENV_LOCK.lock().unwrap();
        let pool = fresh_pool();
        let conn = pool.get().unwrap();
        settings_repo::set(&conn, "shellPath", "/usr/bin/zsh").unwrap();
        assert_eq!(resolve_shell(&conn), "/usr/bin/zsh");
    }

    #[test]
    fn empty_settings_value_falls_through_to_env() {
        let _guard = TEST_ENV_LOCK.lock().unwrap();
        let pool = fresh_pool();
        let conn = pool.get().unwrap();
        settings_repo::set(&conn, "shellPath", "").unwrap();
        let td = tempfile::TempDir::new().unwrap();
        let fake = td.path().join("zsh");
        std::fs::write(&fake, "").unwrap();
        std::env::set_var("SHELL", &fake);
        assert_eq!(resolve_shell(&conn), fake.to_string_lossy().to_string());
    }

    #[test]
    fn falls_back_to_bash_when_nothing_set() {
        let _guard = TEST_ENV_LOCK.lock().unwrap();
        std::env::remove_var("SHELL");
        let pool = fresh_pool();
        let conn = pool.get().unwrap();
        assert_eq!(resolve_shell(&conn), "bash");
    }

    #[test]
    fn falls_back_to_env_when_settings_unset() {
        let _guard = TEST_ENV_LOCK.lock().unwrap();
        let pool = fresh_pool();
        let conn = pool.get().unwrap();
        let td = tempfile::TempDir::new().unwrap();
        let fake = td.path().join("zsh");
        std::fs::write(&fake, "").unwrap();
        std::env::set_var("SHELL", &fake);
        assert_eq!(resolve_shell(&conn), fake.to_string_lossy().to_string());
    }
}
