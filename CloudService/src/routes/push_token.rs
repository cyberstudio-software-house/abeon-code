use crate::auth::PhoneAuth;
use crate::error::AppResult;
use crate::AppState;
use axum::{extract::State, http::StatusCode, Json};
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PushTokenRequest {
    pub expo_token: String,
}

pub async fn register(
    State(state): State<AppState>,
    PhoneAuth(phone): PhoneAuth,
    Json(req): Json<PushTokenRequest>,
) -> AppResult<StatusCode> {
    state
        .phones
        .set_expo_push_token(&phone.id, &req.expo_token)
        .await
        .map_err(crate::error::AppError::Internal)?;
    Ok(StatusCode::OK)
}
