use tauri::State;
use crate::state::AppState;
use crate::error::{AppError, AppResult};
use crate::remote::cloud_client::CloudClient;

/// A pairing code to display (text + QR) to the user.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairCodeDto {
    pub code: String,
    pub expires_in_secs: i64,
}

/// Start phone pairing: ensure the device is registered with CloudService, then
/// request a one-time code. Requires `cloudServiceUrl` to be configured.
#[tauri::command]
pub async fn remote_pair_start(state: State<'_, AppState>) -> AppResult<PairCodeDto> {
    let base = {
        let conn = state.db.get().map_err(|e| AppError::Other(e.to_string()))?;
        crate::db::settings_repo::get(&conn, "cloudServiceUrl")
            .ok()
            .flatten()
            .filter(|s| !s.is_empty())
            .ok_or_else(|| AppError::InvalidInput("cloudServiceUrl is not configured".into()))?
    };
    let client = CloudClient::new(base);

    // Register on first use; if the persisted secret is stale (server returns
    // 401), re-register and retry once.
    let pc = crate::remote::identity::with_reregister_on_unauthorized(&state.db, &client, |secret| {
        let client = &client;
        async move { client.pair_start(&secret).await }
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))?;
    Ok(PairCodeDto { code: pc.code, expires_in_secs: pc.expires_in_secs })
}
