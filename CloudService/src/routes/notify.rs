use crate::auth::DeviceAuth;
use crate::error::AppResult;
use crate::AppState;
use axum::{extract::State, http::StatusCode, Json};
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotifyRequest {
    pub session_id: String,
}

pub async fn notify(
    State(state): State<AppState>,
    DeviceAuth(device): DeviceAuth,
    Json(req): Json<NotifyRequest>,
) -> AppResult<StatusCode> {
    if let Some(token) = state
        .phones
        .expo_push_token_for_device(&device.id)
        .await
        .map_err(crate::error::AppError::Internal)?
    {
        // Best-effort: never fail the desktop's call on a push error.
        let _ = state
            .expo
            .send_push(
                &token,
                "AbeonCloud",
                "Sesja czeka na Ciebie",
                serde_json::json!({ "sessionId": req.session_id }),
            )
            .await;
    }
    Ok(StatusCode::OK)
}
