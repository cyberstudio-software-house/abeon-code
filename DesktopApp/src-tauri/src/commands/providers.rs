use crate::domain::Provider;
use crate::error::AppResult;
use crate::state::AppState;
use serde::Serialize;
use std::collections::HashSet;
use std::time::Duration;
use tauri::State;
use ts_rs::TS;

#[derive(Serialize, TS)]
#[ts(export, export_to = "../../src/types/")]
#[serde(rename_all = "camelCase")]
pub struct ProviderInfo {
    pub provider: Provider,
    pub available: bool,
}

#[tauri::command]
pub fn detect_codex_models() -> Vec<String> {
    match crate::sessions::codex::reader::codex_root() {
        Ok(root) => crate::sessions::codex::reader::detect_models(&root),
        Err(_) => vec![],
    }
}

pub(crate) fn parse_opencode_models(output: &str) -> Vec<String> {
    let mut seen = HashSet::new();
    output
        .lines()
        .map(str::trim)
        .filter(|model| !model.is_empty())
        .filter(|model| seen.insert((*model).to_string()))
        .map(str::to_string)
        .collect()
}

#[tauri::command]
pub async fn detect_opencode_models(state: State<'_, AppState>) -> AppResult<Vec<String>> {
    let Some(binary) = crate::commands::models::locate_binary(&state, "opencode") else {
        return Ok(Vec::new());
    };
    let connection = match state.db.get() {
        Ok(connection) => connection,
        Err(_) => return Ok(Vec::new()),
    };
    let shell = crate::commands::settings::resolve_shell(&connection);
    let environment = crate::commands::settings::ensure_shell_env(&state, &shell);
    let mut command = tokio::process::Command::new(binary);
    command.arg("models").envs(environment).kill_on_drop(true);
    Ok(tokio::time::timeout(Duration::from_secs(15), command.output())
        .await
        .ok()
        .and_then(Result::ok)
        .filter(|output| output.status.success())
        .map(|output| parse_opencode_models(&String::from_utf8_lossy(&output.stdout)))
        .unwrap_or_default())
}

#[tauri::command]
pub fn detect_providers(state: State<AppState>) -> Vec<ProviderInfo> {
    [Provider::Claude, Provider::Codex, Provider::Opencode]
        .into_iter()
        .map(|p| ProviderInfo {
            provider: p,
            available: crate::commands::models::locate_binary(&state, p.id()).is_some(),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_opencode_models_by_line() {
        assert_eq!(
            parse_opencode_models(
                "anthropic/claude-sonnet-4-5\nopenai/gpt-5.4\nanthropic/claude-sonnet-4-5\n"
            ),
            vec!["anthropic/claude-sonnet-4-5", "openai/gpt-5.4"]
        );
    }
}
