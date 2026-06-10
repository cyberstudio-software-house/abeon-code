use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{broadcast, mpsc};
use tauri::{AppHandle, Manager};

use crate::domain::roster::RosterEntry;
use crate::domain::session::SessionActivity;
use crate::domain::session_event::SessionEvent;
use crate::error::AppResult;
use crate::remote::bus::SessionBusEvent;
use crate::remote::client::CentrifugoClient;
use crate::remote::cloud_client::CloudClient;
use crate::remote::dispatch::{command_to_action, PtyAction};
use crate::remote::protocol::{RemoteEnvelope, RemoteEvent};
use crate::remote::registry::SessionPtyRegistry;
use crate::state::AppState;

/// How often the bridge re-publishes the full roster snapshot to the device channel, so
/// a phone connecting to an already-running desktop populates its list within one interval
/// without needing the command path (RequestRoster) or Centrifugo channel history.
const ROSTER_REPUBLISH_SECS: u64 = 25;

/// How many history blocks per SessionAppend publish during a RequestHistory backfill.
/// Keeps individual Centrifugo messages well under the server's max size.
const HISTORY_CHUNK_BLOCKS: usize = 20;

/// Notify only on a transition INTO `WaitingUser` (not while it stays `WaitingUser`).
pub fn should_notify(prev: Option<SessionActivity>, next: SessionActivity) -> bool {
    next == SessionActivity::WaitingUser && prev != Some(SessionActivity::WaitingUser)
}

/// Side-effecting PTY operations the bridge needs. Isolated as a trait so the
/// command handler is testable without spawning real processes. The production
/// impl (2b-β) wraps `PtyManager` and the Tauri spawn path.
pub trait PtyActuator: Send + Sync {
    fn write(&self, pty_id: &str, bytes: &[u8]) -> AppResult<()>;
    fn kill(&self, pty_id: &str) -> AppResult<()>;
    /// Spawn `claude --resume <session_id>` for `project_id`; returns the new pty id.
    fn spawn_resume(&self, session_id: &str, project_id: i64) -> AppResult<String>;
}

/// Supplies the current session roster for RequestRoster + the startup snapshot.
/// Isolated as a trait so the run loop is testable without a DB.
pub trait RosterProvider: Send + Sync {
    fn snapshot(&self) -> Vec<RosterEntry>;
}

/// Supplies the full history blocks for a session, used to answer RequestHistory.
/// Isolated as a trait so the run loop is testable without a DB/filesystem.
pub trait HistoryProvider: Send + Sync {
    fn history(&self, session_id: &str) -> Vec<crate::domain::session::HistoryBlock>;
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

/// Production `RosterProvider` backed by the live app: reads a pooled connection
/// from `AppState` and enumerates the roster via `commands::sessions::roster_snapshot`.
pub struct AppRosterProvider {
    app: AppHandle,
}

impl AppRosterProvider {
    pub fn new(app: AppHandle) -> Self { Self { app } }
}

impl RosterProvider for AppRosterProvider {
    fn snapshot(&self) -> Vec<RosterEntry> {
        let state = self.app.state::<AppState>();
        let conn = match state.db.get() { Ok(c) => c, Err(_) => return Vec::new() };
        crate::commands::sessions::roster_snapshot(&conn).unwrap_or_default()
    }
}

/// Production `HistoryProvider` backed by the live app: reads a pooled connection
/// and resolves the session's blocks via `commands::sessions::history_blocks_for_session`.
pub struct AppHistoryProvider {
    app: AppHandle,
}

impl AppHistoryProvider {
    pub fn new(app: AppHandle) -> Self { Self { app } }
}

impl HistoryProvider for AppHistoryProvider {
    fn history(&self, session_id: &str) -> Vec<crate::domain::session::HistoryBlock> {
        let state = self.app.state::<AppState>();
        let conn = match state.db.get() { Ok(c) => c, Err(_) => return Vec::new() };
        crate::commands::sessions::history_blocks_for_session(&conn, session_id)
    }
}

pub use abeon_remote_core::channels::{cmd_channel, result_channel, session_channel};

fn encode_bus_event(event: &SessionBusEvent) -> (String, serde_json::Value) {
    let (session_id, ev) = match event.clone() {
        SessionBusEvent::Append { session_id, blocks } =>
            (session_id.clone(), SessionEvent::SessionAppend { session_id, blocks }),
        SessionBusEvent::Activity { session_id, activity } =>
            (session_id.clone(), SessionEvent::SessionActivity { session_id, activity }),
        SessionBusEvent::Title { session_id, title } =>
            (session_id.clone(), SessionEvent::SessionTitle { session_id, title }),
        SessionBusEvent::Usage { session_id, summary } =>
            (session_id.clone(), SessionEvent::SessionUsage { session_id, summary }),
    };
    (session_channel(&session_id), serde_json::to_value(ev).expect("SessionEvent serializes"))
}

fn encode_roster(entries: Vec<RosterEntry>) -> serde_json::Value {
    serde_json::to_value(SessionEvent::SessionRoster { entries }).expect("SessionRoster serializes")
}

/// Returns Some(value) for the lightweight metadata events that should ALSO be
/// mirrored to the device channel; None for Append (too heavy — per-session only).
fn device_mirror(event: &SessionBusEvent) -> Option<serde_json::Value> {
    match event {
        SessionBusEvent::Append { .. } => None,
        other => Some(encode_bus_event(other).1),
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
    /// to `session_channel(session_id)`. A `SessionRoster` snapshot is published to
    /// the device channel on startup and again in answer to `RequestRoster`, and
    /// lightweight metadata bus events are mirrored to the device channel.
    pub async fn run(
        self: Arc<Self>,
        device_id: String,
        mut inbound: mpsc::Receiver<RemoteEnvelope>,
        mut bus: broadcast::Receiver<SessionBusEvent>,
        client: Arc<dyn CentrifugoClient>,
        actuator: Arc<dyn PtyActuator>,
        roster: Arc<dyn RosterProvider>,
        history: Arc<dyn HistoryProvider>,
        cloud: Option<Arc<CloudClient>>,
        device_secret: Option<String>,
    ) {
        let dev_channel = result_channel(&device_id);
        let _ = client.publish(&dev_channel, encode_roster(roster.snapshot())).await;
        // Re-publish the roster periodically so a phone connecting to an already-running
        // desktop populates within one interval, independent of the command path or
        // channel history. The interval's first tick is immediate — consume it here since
        // the startup snapshot above already covered t=0.
        let mut roster_tick = tokio::time::interval(std::time::Duration::from_secs(ROSTER_REPUBLISH_SECS));
        roster_tick.tick().await;
        let mut last_activity: HashMap<String, SessionActivity> = HashMap::new();
        loop {
            tokio::select! {
                _ = roster_tick.tick() => {
                    let _ = client.publish(&dev_channel, encode_roster(roster.snapshot())).await;
                }
                maybe_env = inbound.recv() => {
                    match maybe_env {
                        Some(env) => {
                            use crate::remote::protocol::RemoteCommand as RC;
                            if matches!(env.command, RC::RequestRoster) {
                                let _ = client.publish(&dev_channel, encode_roster(roster.snapshot())).await;
                                let ack = RemoteEvent::CmdResult { command_id: env.command_id, ok: true, error: None };
                                if let Ok(data) = serde_json::to_value(&ack) {
                                    let _ = client.publish(&dev_channel, data).await;
                                }
                            } else if let RC::RequestHistory { session_id } = env.command.clone() {
                                let blocks = history.history(&session_id);
                                let channel = session_channel(&session_id);
                                for chunk in blocks.chunks(HISTORY_CHUNK_BLOCKS) {
                                    let ev = SessionEvent::SessionAppend {
                                        session_id: session_id.clone(),
                                        blocks: chunk.to_vec(),
                                    };
                                    if let Ok(data) = serde_json::to_value(&ev) {
                                        let _ = client.publish(&channel, data).await;
                                    }
                                }
                                let ack = RemoteEvent::CmdResult { command_id: env.command_id, ok: true, error: None };
                                if let Ok(data) = serde_json::to_value(&ack) {
                                    let _ = client.publish(&dev_channel, data).await;
                                }
                            } else {
                                let ev = self.handle_envelope(env, actuator.as_ref());
                                if let Ok(data) = serde_json::to_value(&ev) {
                                    let _ = client.publish(&dev_channel, data).await;
                                }
                            }
                        }
                        None => break,
                    }
                }
                ev = bus.recv() => {
                    match ev {
                        Ok(event) => {
                            if let SessionBusEvent::Activity { ref session_id, activity } = event {
                                let prev = last_activity.insert(session_id.clone(), activity);
                                if should_notify(prev, activity) {
                                    if let (Some(cloud), Some(secret)) = (cloud.as_ref(), device_secret.as_ref()) {
                                        let cloud = cloud.clone();
                                        let secret = secret.clone();
                                        let sid = session_id.clone();
                                        tokio::spawn(async move {
                                            let _ = cloud.notify_permission(&secret, &sid).await;
                                        });
                                    }
                                }
                            }
                            let (channel, data) = encode_bus_event(&event);
                            let _ = client.publish(&channel, data).await;
                            if let Some(mirror) = device_mirror(&event) {
                                let _ = client.publish(&dev_channel, mirror).await;
                            }
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

    #[derive(Default)]
    struct FakeRosterProvider {
        entries: Vec<RosterEntry>,
    }

    impl RosterProvider for FakeRosterProvider {
        fn snapshot(&self) -> Vec<RosterEntry> { self.entries.clone() }
    }

    #[derive(Default)]
    struct FakeHistoryProvider {
        blocks: Vec<crate::domain::session::HistoryBlock>,
    }

    impl HistoryProvider for FakeHistoryProvider {
        fn history(&self, _session_id: &str) -> Vec<crate::domain::session::HistoryBlock> {
            self.blocks.clone()
        }
    }

    fn envelope(id: &str, cmd: RemoteCommand) -> RemoteEnvelope {
        RemoteEnvelope { command_id: id.into(), command: cmd }
    }

    #[test]
    fn should_notify_on_transition_into_waiting_user() {
        assert!(should_notify(None, SessionActivity::WaitingUser));
        assert!(should_notify(Some(SessionActivity::Running), SessionActivity::WaitingUser));
    }

    #[test]
    fn should_not_notify_when_already_waiting_or_leaving() {
        assert!(!should_notify(Some(SessionActivity::WaitingUser), SessionActivity::WaitingUser));
        assert!(!should_notify(Some(SessionActivity::WaitingUser), SessionActivity::Running));
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

        let roster: std::sync::Arc<dyn RosterProvider> = std::sync::Arc::new(FakeRosterProvider::default());
        let (tx, rx) = tokio::sync::mpsc::channel(8);
        let bus = crate::remote::bus::RemoteEventBus::new();
        let client_for_run = client.clone();
        let history: std::sync::Arc<dyn HistoryProvider> = std::sync::Arc::new(FakeHistoryProvider::default());
        let handle = tokio::spawn(bridge.run("dev-1".into(), rx, bus.subscribe(), client_for_run, actuator, roster, history, None, None));

        tx.send(RemoteEnvelope { command_id: "c1".into(), command: crate::remote::protocol::RemoteCommand::SendPrompt { session_id: "s1".into(), text: "hi".into() } }).await.unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;

        let published = client.published();
        // [0] = startup sessionRoster snapshot, [1] = cmdResult for the inbound command.
        assert!(published.iter().any(|(ch, d)| ch == "abeon-cloud-dev:dev-1" && d["type"] == "sessionRoster"));
        assert!(published.iter().any(|(ch, d)| ch == "abeon-cloud-dev:dev-1" && d["type"] == "cmdResult" && d["ok"] == true));

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

        let roster: std::sync::Arc<dyn RosterProvider> = std::sync::Arc::new(FakeRosterProvider::default());
        let (tx, rx) = tokio::sync::mpsc::channel(8);
        let bus = crate::remote::bus::RemoteEventBus::new();
        let client_for_run = client.clone();
        let history: std::sync::Arc<dyn HistoryProvider> = std::sync::Arc::new(FakeHistoryProvider::default());
        let handle = tokio::spawn(bridge.run("dev-1".into(), rx, bus.subscribe(), client_for_run, actuator, roster, history, None, None));

        bus.publish(crate::remote::bus::SessionBusEvent::Title { session_id: "s1".into(), title: "Hello".into() });
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;

        let published = client.published();
        // The startup sessionRoster snapshot is also published to the device channel.
        assert!(published.iter().any(|(ch, d)| ch == "abeon-cloud-sess:s1" && d["type"] == "sessionTitle" && d["title"] == "Hello"));
        assert!(published.iter().any(|(ch, d)| ch == "abeon-cloud-dev:dev-1" && d["type"] == "sessionTitle" && d["title"] == "Hello"));

        drop(tx);
        let _ = handle.await;
        drop(bus);
    }

    #[tokio::test]
    async fn request_roster_publishes_snapshot_and_ack() {
        use crate::remote::client::FakeCentrifugoClient;
        use crate::remote::protocol::RemoteCommand;
        let bridge = std::sync::Arc::new(RemoteBridge::new(std::sync::Arc::new(SessionPtyRegistry::new()), false));
        let client = std::sync::Arc::new(FakeCentrifugoClient::new());
        let actuator: std::sync::Arc<dyn PtyActuator> = std::sync::Arc::new(FakePtyActuator::default());
        let roster: std::sync::Arc<dyn RosterProvider> = std::sync::Arc::new(FakeRosterProvider {
            entries: vec![RosterEntry { session_id: "s1".into(), project_id: 1, project_name: "p".into(), title: "t".into(), activity: crate::domain::session::SessionActivity::Idle, last_modified: 1 }],
        });
        let (tx, rx) = tokio::sync::mpsc::channel(8);
        let bus = crate::remote::bus::RemoteEventBus::new();
        let history: std::sync::Arc<dyn HistoryProvider> = std::sync::Arc::new(FakeHistoryProvider::default());
        let handle = tokio::spawn(bridge.run("dev-1".into(), rx, bus.subscribe(), client.clone(), actuator, roster, history, None, None));

        tx.send(RemoteEnvelope { command_id: "c1".into(), command: RemoteCommand::RequestRoster }).await.unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;

        let pubs = client.published();
        // [0] = startup snapshot, [1] = requested snapshot, [2] = cmdResult ack
        assert!(pubs.iter().any(|(ch, d)| ch == "abeon-cloud-dev:dev-1" && d["type"] == "sessionRoster" && d["entries"][0]["sessionId"] == "s1"));
        assert!(pubs.iter().any(|(ch, d)| ch == "abeon-cloud-dev:dev-1" && d["type"] == "cmdResult" && d["ok"] == true));
        drop(tx); let _ = handle.await; drop(bus);
    }

    #[tokio::test]
    async fn activity_bus_event_is_mirrored_to_device_channel() {
        use crate::remote::client::FakeCentrifugoClient;
        let bridge = std::sync::Arc::new(RemoteBridge::new(std::sync::Arc::new(SessionPtyRegistry::new()), false));
        let client = std::sync::Arc::new(FakeCentrifugoClient::new());
        let actuator: std::sync::Arc<dyn PtyActuator> = std::sync::Arc::new(FakePtyActuator::default());
        let roster: std::sync::Arc<dyn RosterProvider> = std::sync::Arc::new(FakeRosterProvider::default());
        let (tx, rx) = tokio::sync::mpsc::channel(8);
        let bus = crate::remote::bus::RemoteEventBus::new();
        let history: std::sync::Arc<dyn HistoryProvider> = std::sync::Arc::new(FakeHistoryProvider::default());
        let handle = tokio::spawn(bridge.run("dev-1".into(), rx, bus.subscribe(), client.clone(), actuator, roster, history, None, None));

        bus.publish(crate::remote::bus::SessionBusEvent::Activity { session_id: "s1".into(), activity: crate::domain::session::SessionActivity::WaitingUser });
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;

        let pubs = client.published();
        assert!(pubs.iter().any(|(ch, d)| ch == "abeon-cloud-sess:s1" && d["type"] == "sessionActivity"));
        assert!(pubs.iter().any(|(ch, d)| ch == "abeon-cloud-dev:dev-1" && d["type"] == "sessionActivity"));
        drop(tx); let _ = handle.await; drop(bus);
    }

    #[tokio::test]
    async fn request_history_publishes_append_chunks_to_session_channel() {
        use crate::remote::client::FakeCentrifugoClient;
        use crate::remote::protocol::RemoteCommand;
        use crate::domain::session::HistoryBlock;

        let bridge = std::sync::Arc::new(RemoteBridge::new(std::sync::Arc::new(SessionPtyRegistry::new()), false));
        let client = std::sync::Arc::new(FakeCentrifugoClient::new());
        let actuator: std::sync::Arc<dyn PtyActuator> = std::sync::Arc::new(FakePtyActuator::default());
        let roster: std::sync::Arc<dyn RosterProvider> = std::sync::Arc::new(FakeRosterProvider::default());
        let history: std::sync::Arc<dyn HistoryProvider> = std::sync::Arc::new(FakeHistoryProvider {
            blocks: vec![HistoryBlock::System {
                uuid: "b1".into(), timestamp: 1, subtype: "info".into(), message: "hi".into(),
            }],
        });
        let (tx, rx) = tokio::sync::mpsc::channel(8);
        let bus = crate::remote::bus::RemoteEventBus::new();
        let handle = tokio::spawn(bridge.run("dev-1".into(), rx, bus.subscribe(), client.clone(), actuator, roster, history, None, None));

        tx.send(RemoteEnvelope { command_id: "c1".into(), command: RemoteCommand::RequestHistory { session_id: "s1".into() } }).await.unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;

        let pubs = client.published();
        assert!(pubs.iter().any(|(ch, d)| ch == "abeon-cloud-sess:s1" && d["type"] == "sessionAppend"));
        assert!(pubs.iter().any(|(ch, d)| ch == "abeon-cloud-dev:dev-1" && d["type"] == "cmdResult" && d["ok"] == true));
        drop(tx); let _ = handle.await; drop(bus);
    }
}
