use crate::auth::PhoneAuth;
use crate::error::{AppError, AppResult};
use crate::AppState;
use abeon_remote_core::channels::cmd_channel;
use abeon_remote_core::protocol::{RemoteCommand, RemoteEnvelope};
use abeon_remote_core::validation::validate_session_id;
use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;
use serde::Serialize;

#[derive(Serialize)]
pub struct CommandResponse {
    pub published: bool,
}

/// Session-scoped commands carry a `session_id`; `RequestRoster` is device-scoped (None).
fn command_session_id(c: &RemoteCommand) -> Option<&str> {
    match c {
        RemoteCommand::SendPrompt { session_id, .. }
        | RemoteCommand::ApprovePermission { session_id }
        | RemoteCommand::DenyPermission { session_id }
        | RemoteCommand::StopSession { session_id }
        | RemoteCommand::ResumeSession { session_id, .. } => Some(session_id),
        RemoteCommand::RequestRoster => None,
    }
}

/// Phone-authenticated. Validates the envelope, confirms the paired desktop is
/// online (presence), then publishes to `abeon-cloud-cmd:<deviceId>`.
pub async fn publish(
    State(state): State<AppState>,
    PhoneAuth(phone): PhoneAuth,
    Json(envelope): Json<RemoteEnvelope>,
) -> AppResult<(StatusCode, Json<CommandResponse>)> {
    // Trust boundary: same allowlist the desktop enforces on the session id. RequestRoster
    // is device-scoped (no session) so there is nothing to validate — it still goes through
    // the presence gate and is published to the device's command channel below.
    if let Some(session_id) = command_session_id(&envelope.command) {
        validate_session_id(session_id).map_err(|e| AppError::BadRequest(e.0))?;
    }

    let channel = cmd_channel(&phone.device_id);

    // Presence gate: do not publish into the void.
    let present = state
        .centrifugo
        .presence_count(&channel)
        .await
        .map_err(|e| AppError::Upstream(e.to_string()))?;
    if present == 0 {
        return Err(AppError::Conflict("desktop offline".into()));
    }

    let data = serde_json::to_value(&envelope).map_err(|e| AppError::Internal(e.into()))?;
    state
        .centrifugo
        .publish(&channel, data)
        .await
        .map_err(|e| AppError::Upstream(e.to_string()))?;

    Ok((StatusCode::ACCEPTED, Json(CommandResponse { published: true })))
}
