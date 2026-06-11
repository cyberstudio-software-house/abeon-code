use serde::Serialize;
use tauri::State;
use ts_rs::TS;
use crate::domain::Provider;
use crate::state::AppState;

#[derive(Serialize, TS)]
#[ts(export, export_to = "../../src/types/")]
#[serde(rename_all = "camelCase")]
pub struct ProviderInfo {
    pub provider: Provider,
    pub available: bool,
}

#[tauri::command]
pub fn detect_providers(state: State<AppState>) -> Vec<ProviderInfo> {
    [Provider::Claude, Provider::Codex]
        .into_iter()
        .map(|p| ProviderInfo {
            provider: p,
            available: crate::commands::models::locate_binary(&state, p.id()).is_some(),
        })
        .collect()
}
