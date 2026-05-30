//! Network-input allowlists. This is the trust boundary for remote
//! (mobile-originated) input: `session_id` is used both as a `claude` CLI
//! argument and as a `<id>.jsonl` filename stem; `model` is passed to
//! `claude --model`. The allowlists make those values safe on every surface.

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct ValidationError(pub String);

pub type ValidationResult = Result<(), ValidationError>;

/// Claude session ids are UUIDs (36 chars); allow some headroom.
const MAX_SESSION_ID_LEN: usize = 64;
const MAX_MODEL_LEN: usize = 128;

/// Allowlist `[A-Za-z0-9_-]`, non-empty, bounded, no leading `-`. Cannot contain
/// shell metacharacters, whitespace, quotes, a flag-style `-` prefix, or `/`/`.`
/// (so `join`-based path traversal is impossible).
pub fn validate_session_id(id: &str) -> ValidationResult {
    if id.is_empty() || id.len() > MAX_SESSION_ID_LEN {
        return Err(ValidationError(format!(
            "session id length out of range (1..={MAX_SESSION_ID_LEN})"
        )));
    }
    if id.starts_with('-') {
        return Err(ValidationError("session id must not start with '-'".into()));
    }
    if !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err(ValidationError(
            "session id may contain only [A-Za-z0-9_-]".into(),
        ));
    }
    Ok(())
}

/// Validate a model identifier passed to `claude --model`. Allowlist
/// `[A-Za-z0-9._/\[\]-]`, non-empty, bounded, no leading `-`.
pub fn validate_model(model: &str) -> ValidationResult {
    if model.is_empty() || model.len() > MAX_MODEL_LEN {
        return Err(ValidationError("model length out of range".into()));
    }
    if model.starts_with('-') {
        return Err(ValidationError("model must not start with '-'".into()));
    }
    if !model
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '/' | '[' | ']' | '-'))
    {
        return Err(ValidationError("model contains invalid characters".into()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_uuid_session_id() {
        assert!(validate_session_id("550e8400-e29b-41d4-a716-446655440000").is_ok());
        assert!(validate_session_id("new_session-1").is_ok());
    }

    #[test]
    fn rejects_path_traversal_session_id() {
        assert!(validate_session_id("../../../../etc/passwd").is_err());
        assert!(validate_session_id("..").is_err());
        assert!(validate_session_id("a/b").is_err());
        assert!(validate_session_id("/etc/shadow").is_err());
    }

    #[test]
    fn rejects_shell_metacharacters_session_id() {
        assert!(validate_session_id("s1; rm -rf /").is_err());
        assert!(validate_session_id("$(whoami)").is_err());
        assert!(validate_session_id("a`b`").is_err());
        assert!(validate_session_id("a b").is_err());
    }

    #[test]
    fn rejects_leading_dash_and_empty_and_overlong() {
        assert!(validate_session_id("-rf").is_err());
        assert!(validate_session_id("").is_err());
        assert!(validate_session_id(&"a".repeat(65)).is_err());
    }

    #[test]
    fn model_accepts_known_shapes() {
        assert!(validate_model("opus").is_ok());
        assert!(validate_model("claude-opus-4-8").is_ok());
        assert!(validate_model("claude-sonnet-4-6").is_ok());
    }

    #[test]
    fn model_rejects_injection_and_flag_smuggling() {
        assert!(validate_model("opus; rm -rf /").is_err());
        assert!(validate_model("$(id)").is_err());
        assert!(validate_model("--dangerously-skip-permissions").is_err());
        assert!(validate_model("").is_err());
    }
}
