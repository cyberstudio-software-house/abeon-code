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
    settings_repo::set(&c, &key, &value)
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
