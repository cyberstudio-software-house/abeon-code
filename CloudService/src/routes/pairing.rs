use crate::auth::DeviceAuth;
use crate::crypto::{generate_pairing_code, generate_secret, now_unix, sha256_hex};
use crate::error::{AppError, AppResult};
use crate::store::{PairingCode, PhoneToken};
use crate::AppState;
use axum::extract::State;
use axum::Json;
use serde::{Deserialize, Serialize};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairStartResponse {
    pub code: String,
    pub expires_in_secs: i64,
}

/// Desktop-authenticated: mint a one-time pairing code bound to this device.
pub async fn start(
    State(state): State<AppState>,
    DeviceAuth(device): DeviceAuth,
) -> AppResult<Json<PairStartResponse>> {
    let code = generate_pairing_code();
    let ttl = state.config.pairing_ttl_secs;
    let now = now_unix();
    let row = PairingCode {
        code_hash: sha256_hex(&code),
        device_id: device.id,
        expires_at: now + ttl,
        created_at: now,
    };
    state.pairing.create(&row).await?;
    Ok(Json(PairStartResponse { code, expires_in_secs: ttl }))
}

#[derive(Deserialize)]
pub struct PairClaimRequest {
    pub code: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairClaimResponse {
    pub phone_token: String,
    pub device_id: String,
}

/// Unauthenticated: redeem a pairing code for a long-lived phone token bound to
/// the code's device. The code is single-use and expiry-checked by the store.
pub async fn claim(
    State(state): State<AppState>,
    Json(req): Json<PairClaimRequest>,
) -> AppResult<Json<PairClaimResponse>> {
    let row = state
        .pairing
        .take(&sha256_hex(&req.code), now_unix())
        .await?
        .ok_or_else(|| AppError::BadRequest("invalid or expired pairing code".into()))?;

    let phone_token = generate_secret();
    let token = PhoneToken {
        id: uuid::Uuid::new_v4().to_string(),
        device_id: row.device_id.clone(),
        token_hash: sha256_hex(&phone_token),
        created_at: now_unix(),
        last_used_at: None,
    };
    state.phones.create(&token).await?;
    Ok(Json(PairClaimResponse { phone_token, device_id: row.device_id }))
}
