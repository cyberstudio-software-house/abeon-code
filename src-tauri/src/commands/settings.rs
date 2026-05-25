use serde::Serialize;
use std::collections::HashMap;
use tauri::State;
use ts_rs::TS;
use crate::db::settings_repo;
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
mod detect_tests {
    use super::*;
    use std::sync::Mutex;
    use tempfile::TempDir;

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn returns_some_when_shell_env_points_to_existing_file() {
        let _guard = ENV_LOCK.lock().unwrap();
        let td = TempDir::new().unwrap();
        let fake_shell = td.path().join("zsh");
        std::fs::write(&fake_shell, "").unwrap();
        std::env::set_var("SHELL", &fake_shell);
        let got = detect_default_shell_impl();
        assert_eq!(got, Some(fake_shell.to_string_lossy().to_string()));
    }

    #[test]
    fn returns_none_when_shell_env_missing() {
        let _guard = ENV_LOCK.lock().unwrap();
        std::env::remove_var("SHELL");
        assert_eq!(detect_default_shell_impl(), None);
    }

    #[test]
    fn returns_none_when_shell_path_missing() {
        let _guard = ENV_LOCK.lock().unwrap();
        std::env::set_var("SHELL", "/nonexistent/zsh");
        assert_eq!(detect_default_shell_impl(), None);
    }
}
