//! Network-input validation now lives in the shared `abeon-remote-core` crate.
//! These thin adapters preserve the desktop's `AppResult<()>` contract by mapping
//! `ValidationError` to `AppError::InvalidInput`.
use crate::error::{AppError, AppResult};

fn adapt(r: abeon_remote_core::validation::ValidationResult) -> AppResult<()> {
    r.map_err(|e| AppError::InvalidInput(e.0))
}

pub fn validate_session_id(id: &str) -> AppResult<()> {
    adapt(abeon_remote_core::validation::validate_session_id(id))
}

pub fn validate_model(model: &str) -> AppResult<()> {
    adapt(abeon_remote_core::validation::validate_model(model))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_invalid_session_id_to_invalid_input() {
        let err = validate_session_id("../etc/passwd").unwrap_err();
        assert!(matches!(err, AppError::InvalidInput(_)));
    }

    #[test]
    fn accepts_valid_inputs() {
        assert!(validate_session_id("550e8400-e29b-41d4-a716-446655440000").is_ok());
        assert!(validate_model("claude-opus-4-8").is_ok());
    }
}
