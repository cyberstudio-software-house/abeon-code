use crate::commands::pty::PtyKind;
use crate::domain::Provider;
use crate::remote::protocol::RemoteCommand;
use crate::remote::registry::SessionPtyRegistry;

/// Concrete effect a remote command resolves to. Kept separate from execution
/// so the decision logic is pure and unit-testable without a real PTY.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PtyAction {
    Write { pty_id: String, bytes: Vec<u8> },
    Kill { pty_id: String },
    Spawn { session_id: String, project_id: i64 },
    Reject { reason: String },
}

/// Key sequence sent to the Claude TUI to accept a permission prompt.
/// `\r` selects the highlighted (default "Yes") option.
pub const APPROVE_KEYS: &str = "\r";
/// Key sequence sent to cancel/reject a permission prompt. `\x1b` is Esc.
pub const DENY_KEYS: &str = "\x1b";

/// Resolve to a `Write` against the session's live PTY, or `Reject` if none.
fn write_to_session(reg: &SessionPtyRegistry, session_id: &str, bytes: Vec<u8>) -> PtyAction {
    match reg.pty_for(session_id) {
        Some(pty_id) => PtyAction::Write { pty_id, bytes },
        None => PtyAction::Reject { reason: format!("no live pty for session {session_id}") },
    }
}

/// Turn a remote command plus current registry state into a concrete PtyAction.
///
/// TODO(user contribution): implement the mapping. Decisions to make:
///   - SendPrompt: write the prompt text to the session's PTY (Claude reads a
///     line, so the text needs a trailing carriage return). Reject if no live PTY.
///   - ApprovePermission / DenyPermission: write APPROVE_KEYS / DENY_KEYS to the
///     session's PTY. Reject if no live PTY.
///   - StopSession: Kill the session's PTY. Reject if no live PTY.
///   - ResumeSession: this is the sensitive remote-spawn op. Only return
///     Spawn { session_id, project_id } when `allow_spawn` is true; otherwise
///     Reject. (No PTY lookup needed — the session is, by definition, not running.)
/// The `write_to_session` helper above handles the lookup-or-reject pattern.
pub fn command_to_action(
    cmd: &RemoteCommand,
    reg: &SessionPtyRegistry,
    allow_spawn: bool,
) -> PtyAction {
    match cmd {
        RemoteCommand::SendPrompt { session_id, text } => {
            write_to_session(reg, session_id, format!("{text}\r").into_bytes())
        }
        RemoteCommand::ApprovePermission { session_id } => {
            write_to_session(reg, session_id, APPROVE_KEYS.as_bytes().to_vec())
        }
        RemoteCommand::DenyPermission { session_id } => {
            write_to_session(reg, session_id, DENY_KEYS.as_bytes().to_vec())
        }
        RemoteCommand::StopSession { session_id } => match reg.pty_for(session_id) {
            Some(pty_id) => PtyAction::Kill { pty_id },
            None => PtyAction::Reject { reason: format!("no live pty for session {session_id}") },
        },
        RemoteCommand::ResumeSession { session_id, project_id } => {
            if allow_spawn {
                PtyAction::Spawn { session_id: session_id.clone(), project_id: *project_id }
            } else {
                PtyAction::Reject { reason: "remote spawn disabled".into() }
            }
        }
        RemoteCommand::RequestRoster => {
            PtyAction::Reject { reason: "requestRoster has no pty effect".into() }
        }
    }
}

/// The session id (if any) that a freshly spawned PTY should be bound to in the
/// `SessionPtyRegistry`. Only Claude PTYs with a known session id qualify.
pub fn session_to_bind(kind: &PtyKind) -> Option<String> {
    match kind {
        PtyKind::Agent { provider: Provider::Claude, session_id: Some(id), .. } => Some(id.clone()),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reg_with(session: &str, pty: &str) -> SessionPtyRegistry {
        let r = SessionPtyRegistry::new();
        r.bind(session, pty);
        r
    }

    #[test]
    fn send_prompt_writes_text_with_carriage_return() {
        let reg = reg_with("s1", "pty-a");
        let cmd = RemoteCommand::SendPrompt { session_id: "s1".into(), text: "hi".into() };
        assert_eq!(
            command_to_action(&cmd, &reg, false),
            PtyAction::Write { pty_id: "pty-a".into(), bytes: b"hi\r".to_vec() }
        );
    }

    #[test]
    fn send_prompt_unknown_session_is_rejected() {
        let reg = SessionPtyRegistry::new();
        let cmd = RemoteCommand::SendPrompt { session_id: "ghost".into(), text: "hi".into() };
        assert!(matches!(command_to_action(&cmd, &reg, false), PtyAction::Reject { .. }));
    }

    #[test]
    fn approve_writes_approve_keys() {
        let reg = reg_with("s1", "pty-a");
        let cmd = RemoteCommand::ApprovePermission { session_id: "s1".into() };
        assert_eq!(
            command_to_action(&cmd, &reg, false),
            PtyAction::Write { pty_id: "pty-a".into(), bytes: APPROVE_KEYS.as_bytes().to_vec() }
        );
    }

    #[test]
    fn deny_writes_deny_keys() {
        let reg = reg_with("s1", "pty-a");
        let cmd = RemoteCommand::DenyPermission { session_id: "s1".into() };
        assert_eq!(
            command_to_action(&cmd, &reg, false),
            PtyAction::Write { pty_id: "pty-a".into(), bytes: DENY_KEYS.as_bytes().to_vec() }
        );
    }

    #[test]
    fn stop_kills_the_pty() {
        let reg = reg_with("s1", "pty-a");
        let cmd = RemoteCommand::StopSession { session_id: "s1".into() };
        assert_eq!(
            command_to_action(&cmd, &reg, false),
            PtyAction::Kill { pty_id: "pty-a".into() }
        );
    }

    #[test]
    fn resume_spawns_only_when_allowed() {
        let reg = SessionPtyRegistry::new();
        let cmd = RemoteCommand::ResumeSession { session_id: "s1".into(), project_id: 7 };
        assert_eq!(
            command_to_action(&cmd, &reg, true),
            PtyAction::Spawn { session_id: "s1".into(), project_id: 7 }
        );
        assert!(matches!(command_to_action(&cmd, &reg, false), PtyAction::Reject { .. }));
    }

    #[test]
    fn session_to_bind_only_for_claude_with_id() {
        assert_eq!(
            session_to_bind(&PtyKind::Agent {
                provider: Provider::Claude,
                session_id: Some("s1".into()), model: None, skip_permissions: false, fresh: true,
            }),
            Some("s1".to_string())
        );
        assert_eq!(
            session_to_bind(&PtyKind::Agent {
                provider: Provider::Claude,
                session_id: None, model: None, skip_permissions: false, fresh: false,
            }),
            None
        );
        assert_eq!(session_to_bind(&PtyKind::Shell), None);
        assert_eq!(session_to_bind(&PtyKind::Action { action_id: 1 }), None);
    }

    #[test]
    fn session_to_bind_none_for_codex() {
        assert_eq!(
            session_to_bind(&PtyKind::Agent {
                provider: Provider::Codex,
                session_id: Some("s1".into()), model: None, skip_permissions: false, fresh: true,
            }),
            None
        );
    }
}
