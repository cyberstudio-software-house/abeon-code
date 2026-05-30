use crate::auth::Principal;
use crate::crypto::now_unix;
use crate::error::{AppError, AppResult};
use crate::AppState;
use abeon_remote_core::token::mint_connection_token;
use axum::extract::State;
use axum::Json;
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenResponse {
    pub token: String,
    pub expires_in_secs: i64,
}

/// Mint a short-lived Centrifugo connection JWT. Desktops authenticate with their
/// `deviceSecret` (sub = deviceId); phones with their `phoneToken` (sub = phone:<id>).
pub async fn issue(
    State(state): State<AppState>,
    principal: Principal,
) -> AppResult<Json<TokenResponse>> {
    let (sub, touch_device) = match principal {
        Principal::Device(d) => (d.id.clone(), Some(d.id)),
        Principal::Phone(p) => (format!("phone:{}", p.id), None),
    };
    let ttl = state.config.token_ttl_secs;
    let token = mint_connection_token(
        &state.config.centrifugo_token_secret,
        &sub,
        now_unix() as usize,
        ttl as usize,
    )
    .map_err(AppError::Internal)?;

    if let Some(id) = touch_device {
        let _ = state.devices.touch_last_seen(&id, now_unix()).await;
    }
    Ok(Json(TokenResponse { token, expires_in_secs: ttl }))
}
