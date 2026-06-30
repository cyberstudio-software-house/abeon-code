use tauri::State;
use crate::clickup::ClickUpClient;
use crate::db::settings_repo;
use crate::domain::clickup::{ClickUpConnectionStatus, ClickUpWorkspace};
use crate::error::{AppError, AppResult};
use crate::state::AppState;

const TOKEN_KEY: &str = "clickupApiToken";

fn status_from_token(token: &Option<String>) -> ClickUpConnectionStatus {
    match token {
        Some(t) if !t.trim().is_empty() => ClickUpConnectionStatus::Configured,
        _ => ClickUpConnectionStatus::Absent,
    }
}

pub fn load_client(state: &AppState) -> AppResult<ClickUpClient> {
    let c = state.db.get()?;
    let token = settings_repo::get(&c, TOKEN_KEY)?
        .filter(|t| !t.trim().is_empty())
        .ok_or_else(|| AppError::Other("ClickUp: brak tokenu".into()))?;
    Ok(ClickUpClient::new(token))
}

#[tauri::command]
pub fn clickup_set_token(state: State<AppState>, token: String) -> AppResult<()> {
    let c = state.db.get()?;
    settings_repo::set(&c, TOKEN_KEY, token.trim())?;
    Ok(())
}

#[tauri::command]
pub fn clickup_clear_token(state: State<AppState>) -> AppResult<()> {
    let c = state.db.get()?;
    settings_repo::delete(&c, TOKEN_KEY)?;
    Ok(())
}

#[tauri::command]
pub async fn clickup_connection_status(state: State<'_, AppState>) -> AppResult<ClickUpConnectionStatus> {
    let token = {
        let c = state.db.get()?;
        settings_repo::get(&c, TOKEN_KEY)?
    };
    if status_from_token(&token) == ClickUpConnectionStatus::Absent {
        return Ok(ClickUpConnectionStatus::Absent);
    }
    let client = ClickUpClient::new(token.unwrap());
    match client.get_user().await {
        Ok(()) => Ok(ClickUpConnectionStatus::Configured),
        Err(crate::clickup::ClickUpError::InvalidToken) => Ok(ClickUpConnectionStatus::Invalid),
        Err(e) => Err(AppError::Other(e.to_string())),
    }
}

#[tauri::command]
pub async fn clickup_list_workspaces(state: State<'_, AppState>) -> AppResult<Vec<ClickUpWorkspace>> {
    let client = load_client(&state)?;
    client.list_workspaces().await.map_err(|e| AppError::Other(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{init_pool, settings_repo};
    use tempfile::NamedTempFile;

    #[test]
    fn status_reflects_token_presence() {
        let f = NamedTempFile::new().unwrap();
        let pool = init_pool(&f.path().to_path_buf()).unwrap();
        let c = pool.get().unwrap();
        assert_eq!(status_from_token(&token_in(&c)), ClickUpConnectionStatus::Absent);
        settings_repo::set(&c, TOKEN_KEY, "pk_x").unwrap();
        assert_eq!(status_from_token(&token_in(&c)), ClickUpConnectionStatus::Configured);
    }

    fn token_in(c: &rusqlite::Connection) -> Option<String> {
        settings_repo::get(c, TOKEN_KEY).unwrap()
    }
}
