use crate::crypto::{generate_secret, now_unix, sha256_hex};
use crate::error::AppResult;
use crate::store::Device;
use crate::AppState;
use axum::extract::State;
use axum::Json;
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisterResponse {
    pub device_id: String,
    pub device_secret: String,
}

/// Unauthenticated first-boot registration. Returns the device's id and the
/// plaintext secret ONCE; only the hash is stored.
pub async fn register(State(state): State<AppState>) -> AppResult<Json<RegisterResponse>> {
    let device_id = uuid::Uuid::new_v4().to_string();
    let device_secret = generate_secret();
    let device = Device {
        id: device_id.clone(),
        device_secret_hash: sha256_hex(&device_secret),
        label: None,
        created_at: now_unix(),
        last_seen_at: None,
    };
    state.devices.create(&device).await?;
    Ok(Json(RegisterResponse { device_id, device_secret }))
}
