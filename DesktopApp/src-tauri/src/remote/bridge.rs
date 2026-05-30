use crate::error::AppResult;
use crate::remote::dispatch::{command_to_action, PtyAction};
use crate::remote::protocol::{RemoteEnvelope, RemoteEvent};
use crate::remote::registry::SessionPtyRegistry;

/// Side-effecting PTY operations the bridge needs. Isolated as a trait so the
/// command handler is testable without spawning real processes. The production
/// impl (2b-β) wraps `PtyManager` and the Tauri spawn path.
pub trait PtyActuator: Send + Sync {
    fn write(&self, pty_id: &str, bytes: &[u8]) -> AppResult<()>;
    fn kill(&self, pty_id: &str) -> AppResult<()>;
    /// Spawn `claude --resume <session_id>` for `project_id`; returns the new pty id.
    fn spawn_resume(&self, session_id: &str, project_id: i64) -> AppResult<String>;
}

/// Translates inbound remote commands into PTY effects and acknowledgements.
pub struct RemoteBridge {
    registry: SessionPtyRegistry,
    allow_spawn: bool,
}

impl RemoteBridge {
    pub fn new(registry: SessionPtyRegistry, allow_spawn: bool) -> Self {
        Self { registry, allow_spawn }
    }

    pub fn registry(&self) -> &SessionPtyRegistry {
        &self.registry
    }

    /// Resolve one command to its effect, run it, and return the ack event.
    pub fn handle_envelope(&self, env: RemoteEnvelope, actuator: &dyn PtyActuator) -> RemoteEvent {
        let result = self.execute(command_to_action(&env.command, &self.registry, self.allow_spawn), actuator);
        match result {
            Ok(()) => RemoteEvent::CmdResult { command_id: env.command_id, ok: true, error: None },
            Err(e) => RemoteEvent::CmdResult { command_id: env.command_id, ok: false, error: Some(e) },
        }
    }

    fn execute(&self, action: PtyAction, actuator: &dyn PtyActuator) -> Result<(), String> {
        match action {
            PtyAction::Write { pty_id, bytes } => {
                actuator.write(&pty_id, &bytes).map_err(|e| e.to_string())
            }
            PtyAction::Kill { pty_id } => actuator.kill(&pty_id).map_err(|e| e.to_string()),
            PtyAction::Spawn { session_id, project_id } => {
                let pty_id = actuator.spawn_resume(&session_id, project_id).map_err(|e| e.to_string())?;
                self.registry.bind(&session_id, &pty_id);
                Ok(())
            }
            PtyAction::Reject { reason } => Err(reason),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::remote::protocol::RemoteCommand;
    use parking_lot::Mutex;

    #[derive(Default)]
    struct FakePtyActuator {
        writes: Mutex<Vec<(String, Vec<u8>)>>,
        kills: Mutex<Vec<String>>,
        spawns: Mutex<Vec<(String, i64)>>,
    }

    impl PtyActuator for FakePtyActuator {
        fn write(&self, pty_id: &str, bytes: &[u8]) -> AppResult<()> {
            self.writes.lock().push((pty_id.into(), bytes.to_vec()));
            Ok(())
        }
        fn kill(&self, pty_id: &str) -> AppResult<()> {
            self.kills.lock().push(pty_id.into());
            Ok(())
        }
        fn spawn_resume(&self, session_id: &str, project_id: i64) -> AppResult<String> {
            self.spawns.lock().push((session_id.into(), project_id));
            Ok(format!("pty-for-{session_id}"))
        }
    }

    fn envelope(id: &str, cmd: RemoteCommand) -> RemoteEnvelope {
        RemoteEnvelope { command_id: id.into(), command: cmd }
    }

    #[test]
    fn send_prompt_writes_and_acks_ok() {
        let reg = SessionPtyRegistry::new();
        reg.bind("s1", "pty-a");
        let act = FakePtyActuator::default();
        let bridge = RemoteBridge::new(reg, false);

        let ev = bridge.handle_envelope(envelope("c1", RemoteCommand::SendPrompt { session_id: "s1".into(), text: "hi".into() }), &act);

        assert_eq!(ev, RemoteEvent::CmdResult { command_id: "c1".into(), ok: true, error: None });
        assert_eq!(act.writes.lock().clone(), vec![("pty-a".to_string(), b"hi\r".to_vec())]);
    }

    #[test]
    fn unknown_session_acks_error_and_does_nothing() {
        let bridge = RemoteBridge::new(SessionPtyRegistry::new(), false);
        let act = FakePtyActuator::default();

        let ev = bridge.handle_envelope(envelope("c2", RemoteCommand::StopSession { session_id: "ghost".into() }), &act);

        match ev {
            RemoteEvent::CmdResult { command_id, ok, error } => {
                assert_eq!(command_id, "c2");
                assert!(!ok);
                assert!(error.is_some());
            }
        }
        assert!(act.kills.lock().is_empty());
    }

    #[test]
    fn resume_disabled_acks_error() {
        let bridge = RemoteBridge::new(SessionPtyRegistry::new(), false);
        let act = FakePtyActuator::default();
        let ev = bridge.handle_envelope(envelope("c3", RemoteCommand::ResumeSession { session_id: "s1".into(), project_id: 7 }), &act);
        assert!(matches!(ev, RemoteEvent::CmdResult { ok: false, .. }));
        assert!(act.spawns.lock().is_empty());
    }

    #[test]
    fn resume_enabled_spawns_and_binds_registry() {
        let bridge = RemoteBridge::new(SessionPtyRegistry::new(), true);
        let act = FakePtyActuator::default();
        let ev = bridge.handle_envelope(envelope("c4", RemoteCommand::ResumeSession { session_id: "s1".into(), project_id: 7 }), &act);

        assert_eq!(ev, RemoteEvent::CmdResult { command_id: "c4".into(), ok: true, error: None });
        assert_eq!(act.spawns.lock().clone(), vec![("s1".to_string(), 7)]);
        assert_eq!(bridge.registry().pty_for("s1"), Some("pty-for-s1".to_string()));
    }
}
