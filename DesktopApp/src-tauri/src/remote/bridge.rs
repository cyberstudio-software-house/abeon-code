use std::sync::Arc;
use tokio::sync::{broadcast, mpsc};
use tauri::{AppHandle, Manager};

use crate::error::AppResult;
use crate::remote::bus::SessionBusEvent;
use crate::remote::client::CentrifugoClient;
use crate::remote::dispatch::{command_to_action, PtyAction};
use crate::remote::protocol::{RemoteEnvelope, RemoteEvent};
use crate::remote::registry::SessionPtyRegistry;
use crate::state::AppState;

/// Side-effecting PTY operations the bridge needs. Isolated as a trait so the
/// command handler is testable without spawning real processes. The production
/// impl (2b-β) wraps `PtyManager` and the Tauri spawn path.
pub trait PtyActuator: Send + Sync {
    fn write(&self, pty_id: &str, bytes: &[u8]) -> AppResult<()>;
    fn kill(&self, pty_id: &str) -> AppResult<()>;
    /// Spawn `claude --resume <session_id>` for `project_id`; returns the new pty id.
    fn spawn_resume(&self, session_id: &str, project_id: i64) -> AppResult<String>;
}

/// Production `PtyActuator` backed by the live app: writes/kills via `PtyManager`
/// and resume-spawns via `commands::pty::spawn_claude_resume`. Holds an `AppHandle`
/// to reach managed `AppState` from the bridge's async task.
pub struct AppPtyActuator {
    app: AppHandle,
}

impl AppPtyActuator {
    pub fn new(app: AppHandle) -> Self { Self { app } }
}

impl PtyActuator for AppPtyActuator {
    fn write(&self, pty_id: &str, bytes: &[u8]) -> AppResult<()> {
        self.app.state::<AppState>().pty.write(pty_id, bytes)
    }
    fn kill(&self, pty_id: &str) -> AppResult<()> {
        let state = self.app.state::<AppState>();
        state.session_pty.unbind_pty(pty_id);
        state.pty.kill(pty_id)
    }
    fn spawn_resume(&self, session_id: &str, project_id: i64) -> AppResult<String> {
        crate::commands::pty::spawn_claude_resume(&self.app, project_id, session_id)
    }
}

pub fn cmd_channel(device_id: &str) -> String { format!("abeon-cloud-cmd:{device_id}") }
pub fn result_channel(device_id: &str) -> String { format!("abeon-cloud-dev:{device_id}") }
pub fn session_channel(session_id: &str) -> String { format!("abeon-cloud-sess:{session_id}") }

fn encode_bus_event(event: SessionBusEvent) -> (String, serde_json::Value) {
    match event {
        SessionBusEvent::Append { session_id, blocks } => (
            session_channel(&session_id),
            serde_json::json!({ "type": "sessionAppend", "sessionId": session_id, "blocks": blocks }),
        ),
        SessionBusEvent::Activity { session_id, activity } => (
            session_channel(&session_id),
            serde_json::json!({ "type": "sessionActivity", "sessionId": session_id, "activity": activity }),
        ),
        SessionBusEvent::Title { session_id, title } => (
            session_channel(&session_id),
            serde_json::json!({ "type": "sessionTitle", "sessionId": session_id, "title": title }),
        ),
        SessionBusEvent::Usage { session_id, summary } => (
            session_channel(&session_id),
            serde_json::json!({ "type": "sessionUsage", "sessionId": session_id, "summary": summary }),
        ),
    }
}

/// Translates inbound remote commands into PTY effects and acknowledgements.
pub struct RemoteBridge {
    registry: Arc<SessionPtyRegistry>,
    allow_spawn: bool,
}

impl RemoteBridge {
    pub fn new(registry: Arc<SessionPtyRegistry>, allow_spawn: bool) -> Self {
        Self { registry, allow_spawn }
    }

    pub fn registry(&self) -> &SessionPtyRegistry {
        self.registry.as_ref()
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

    /// Pump inbound commands and outbound session events until the inbound channel
    /// closes. Commands are handled via `handle_envelope` and their `cmdResult` is
    /// published to `result_channel(device_id)`; session-bus events are forwarded
    /// to `session_channel(session_id)`.
    pub async fn run(
        self: Arc<Self>,
        device_id: String,
        mut inbound: mpsc::Receiver<RemoteEnvelope>,
        mut bus: broadcast::Receiver<SessionBusEvent>,
        client: Arc<dyn CentrifugoClient>,
        actuator: Arc<dyn PtyActuator>,
    ) {
        let results = result_channel(&device_id);
        loop {
            tokio::select! {
                maybe_env = inbound.recv() => {
                    match maybe_env {
                        Some(env) => {
                            let ev = self.handle_envelope(env, actuator.as_ref());
                            if let Ok(data) = serde_json::to_value(&ev) {
                                let _ = client.publish(&results, data).await;
                            }
                        }
                        None => break,
                    }
                }
                ev = bus.recv() => {
                    match ev {
                        Ok(event) => {
                            let (channel, data) = encode_bus_event(event);
                            let _ = client.publish(&channel, data).await;
                        }
                        Err(broadcast::error::RecvError::Lagged(_)) => continue,
                        Err(broadcast::error::RecvError::Closed) => break,
                    }
                }
            }
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
        let bridge = RemoteBridge::new(std::sync::Arc::new(reg), false);

        let ev = bridge.handle_envelope(envelope("c1", RemoteCommand::SendPrompt { session_id: "s1".into(), text: "hi".into() }), &act);

        assert_eq!(ev, RemoteEvent::CmdResult { command_id: "c1".into(), ok: true, error: None });
        assert_eq!(act.writes.lock().clone(), vec![("pty-a".to_string(), b"hi\r".to_vec())]);
    }

    #[test]
    fn unknown_session_acks_error_and_does_nothing() {
        let bridge = RemoteBridge::new(std::sync::Arc::new(SessionPtyRegistry::new()), false);
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
        let bridge = RemoteBridge::new(std::sync::Arc::new(SessionPtyRegistry::new()), false);
        let act = FakePtyActuator::default();
        let ev = bridge.handle_envelope(envelope("c3", RemoteCommand::ResumeSession { session_id: "s1".into(), project_id: 7 }), &act);
        assert!(matches!(ev, RemoteEvent::CmdResult { ok: false, .. }));
        assert!(act.spawns.lock().is_empty());
    }

    #[test]
    fn resume_enabled_spawns_and_binds_registry() {
        let bridge = RemoteBridge::new(std::sync::Arc::new(SessionPtyRegistry::new()), true);
        let act = FakePtyActuator::default();
        let ev = bridge.handle_envelope(envelope("c4", RemoteCommand::ResumeSession { session_id: "s1".into(), project_id: 7 }), &act);

        assert_eq!(ev, RemoteEvent::CmdResult { command_id: "c4".into(), ok: true, error: None });
        assert_eq!(act.spawns.lock().clone(), vec![("s1".to_string(), 7)]);
        assert_eq!(bridge.registry().pty_for("s1"), Some("pty-for-s1".to_string()));
    }

    #[tokio::test]
    async fn run_publishes_cmd_result_for_inbound_command() {
        use crate::remote::client::FakeCentrifugoClient;
        let reg = SessionPtyRegistry::new();
        reg.bind("s1", "pty-a");
        let bridge = std::sync::Arc::new(RemoteBridge::new(std::sync::Arc::new(reg), false));
        let client = std::sync::Arc::new(FakeCentrifugoClient::new());
        let actuator: std::sync::Arc<dyn PtyActuator> = std::sync::Arc::new(FakePtyActuator::default());

        let (tx, rx) = tokio::sync::mpsc::channel(8);
        let bus = crate::remote::bus::RemoteEventBus::new();
        let client_for_run = client.clone();
        let handle = tokio::spawn(bridge.run("dev-1".into(), rx, bus.subscribe(), client_for_run, actuator));

        tx.send(RemoteEnvelope { command_id: "c1".into(), command: crate::remote::protocol::RemoteCommand::SendPrompt { session_id: "s1".into(), text: "hi".into() } }).await.unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;

        let published = client.published();
        assert_eq!(published.len(), 1);
        assert_eq!(published[0].0, "abeon-cloud-dev:dev-1");
        assert_eq!(published[0].1["type"], "cmdResult");
        assert_eq!(published[0].1["ok"], true);

        drop(tx); // close inbound → loop ends
        let _ = handle.await;
        // keep `bus` alive until here so the broadcast branch stays pending
        drop(bus);
    }

    #[tokio::test]
    async fn run_forwards_bus_event_to_session_channel() {
        use crate::remote::client::FakeCentrifugoClient;
        let bridge = std::sync::Arc::new(RemoteBridge::new(std::sync::Arc::new(SessionPtyRegistry::new()), false));
        let client = std::sync::Arc::new(FakeCentrifugoClient::new());
        let actuator: std::sync::Arc<dyn PtyActuator> = std::sync::Arc::new(FakePtyActuator::default());

        let (tx, rx) = tokio::sync::mpsc::channel(8);
        let bus = crate::remote::bus::RemoteEventBus::new();
        let client_for_run = client.clone();
        let handle = tokio::spawn(bridge.run("dev-1".into(), rx, bus.subscribe(), client_for_run, actuator));

        bus.publish(crate::remote::bus::SessionBusEvent::Title { session_id: "s1".into(), title: "Hello".into() });
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;

        let published = client.published();
        assert_eq!(published.len(), 1);
        assert_eq!(published[0].0, "abeon-cloud-sess:s1");
        assert_eq!(published[0].1["type"], "sessionTitle");
        assert_eq!(published[0].1["title"], "Hello");

        drop(tx);
        let _ = handle.await;
        drop(bus);
    }
}
