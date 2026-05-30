use crate::AppState;
use axum::extract::State;
use axum::http::StatusCode;

/// Liveness — process is up.
pub async fn healthz() -> &'static str {
    "ok"
}

/// Readiness — dependencies reachable (DB ping). Returns 503 if not ready.
pub async fn readyz(State(state): State<AppState>) -> StatusCode {
    match state.devices.ping().await {
        Ok(()) => StatusCode::OK,
        Err(_) => StatusCode::SERVICE_UNAVAILABLE,
    }
}
