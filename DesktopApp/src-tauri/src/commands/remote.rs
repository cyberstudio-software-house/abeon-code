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

    // Ensure we have a device secret (register on first use).
    let device_secret = {
        let conn = state.db.get().map_err(|e| AppError::Other(e.to_string()))?;
        crate::db::settings_repo::get(&conn, "remoteDeviceSecret").ok().flatten().filter(|s| !s.is_empty())
    };
    let device_secret = match device_secret {
        Some(s) => s,
        None => {
            let (id, secret) = client.register().await.map_err(|e| AppError::Other(e.to_string()))?;
            let conn = state.db.get().map_err(|e| AppError::Other(e.to_string()))?;
            crate::db::settings_repo::set(&conn, "remoteDeviceId", &id)?;
            crate::db::settings_repo::set(&conn, "remoteDeviceSecret", &secret)?;
            secret
        }
    };

    let pc = client.pair_start(&device_secret).await.map_err(|e| AppError::Other(e.to_string()))?;
    Ok(PairCodeDto { code: pc.code, expires_in_secs: pc.expires_in_secs })
}
