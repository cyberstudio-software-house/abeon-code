use crate::crypto::sha256_hex;
use crate::error::AppError;
use crate::store::{Device, PhoneToken};
use crate::AppState;
use axum::extract::FromRequestParts;
use axum::http::request::Parts;

/// Pull a `Bearer <token>` value from the Authorization header.
fn bearer(parts: &Parts) -> Result<String, AppError> {
    let header = parts
        .headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .ok_or(AppError::Unauthorized)?;
    let token = header.strip_prefix("Bearer ").ok_or(AppError::Unauthorized)?;
    if token.is_empty() {
        return Err(AppError::Unauthorized);
    }
    Ok(token.to_string())
}

/// Authenticated desktop (a row in `devices`).
pub struct DeviceAuth(pub Device);

impl FromRequestParts<AppState> for DeviceAuth {
    type Rejection = AppError;
    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, AppError> {
        let token = bearer(parts)?;
        let device = state
            .devices
            .find_by_secret_hash(&sha256_hex(&token))
            .await
            .map_err(AppError::Internal)?
            .ok_or(AppError::Unauthorized)?;
        Ok(DeviceAuth(device))
    }
}

/// Authenticated phone (a row in `phone_tokens`, bound to a device).
pub struct PhoneAuth(pub PhoneToken);

impl FromRequestParts<AppState> for PhoneAuth {
    type Rejection = AppError;
    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, AppError> {
        let token = bearer(parts)?;
        let phone = state
            .phones
            .find_by_hash(&sha256_hex(&token))
            .await
            .map_err(AppError::Internal)?
            .ok_or(AppError::Unauthorized)?;
        Ok(PhoneAuth(phone))
    }
}

/// Either kind of principal — used by `/v1/token`, which both serve.
pub enum Principal {
    Device(Device),
    Phone(PhoneToken),
}

impl FromRequestParts<AppState> for Principal {
    type Rejection = AppError;
    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, AppError> {
        let token = bearer(parts)?;
        let hash = sha256_hex(&token);
        if let Some(d) = state.devices.find_by_secret_hash(&hash).await.map_err(AppError::Internal)? {
            return Ok(Principal::Device(d));
        }
        if let Some(p) = state.phones.find_by_hash(&hash).await.map_err(AppError::Internal)? {
            return Ok(Principal::Phone(p));
        }
        Err(AppError::Unauthorized)
    }
}
