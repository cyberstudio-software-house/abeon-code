use serde::Serialize;
use ts_rs::TS;
use crate::error::AppResult;

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
