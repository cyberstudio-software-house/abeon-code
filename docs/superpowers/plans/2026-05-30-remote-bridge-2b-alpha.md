# Remote Bridge 2b-α (Offline Core) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the offline, network-free core of the remote bridge: the Centrifugo JSON wire codec, the `CentrifugoClient` trait (+ a fake), the internal event bus tapped from `SessionWatchers`, and the `RemoteBridge` command handler — all fully unit-tested without a live server.

**Architecture:** New units under `DesktopApp/src-tauri/src/remote/`. The bridge consumes a `RemoteEnvelope` (parsed from a Centrifugo publication), runs the already-built pure `command_to_action`, executes the resulting `PtyAction` through a `PtyActuator` trait (so tests use a fake instead of real PTYs), and produces a `RemoteEvent::CmdResult`. Session events are tapped from `SessionWatchers` via a `tokio::sync::broadcast` bus and forwarded as `RemoteEvent`s. The real `tokio-tungstenite` client, the async run-loop wiring, app-startup connection, and the live integration test are explicitly deferred to plan **2b-β** (which needs Centrifugo deployment data).

**Tech Stack:** Rust, serde/serde_json, tokio (broadcast/mpsc), async-trait, parking_lot. `tokio-tungstenite` is added now (dep only; used in 2b-β).

**Builds on:** plan 2a (merged): `remote::protocol` (`RemoteCommand`/`RemoteEnvelope`/`RemoteEvent`), `remote::registry::SessionPtyRegistry`, `remote::dispatch::{command_to_action, PtyAction, session_to_bind}`.

**Working directory:** all paths are under `DesktopApp/`. Run cargo via `--manifest-path DesktopApp/src-tauri/Cargo.toml`; run npm from `DesktopApp/`.

---

## File Structure

- Modify `DesktopApp/src-tauri/Cargo.toml` — add `tokio-tungstenite`, `futures-util`, `async-trait`.
- Modify `DesktopApp/src-tauri/src/remote/mod.rs` — declare `wire`, `client`, `bus`, `bridge`.
- Create `DesktopApp/src-tauri/src/remote/wire.rs` — Centrifugo JSON command encoding + frame parsing.
- Create `DesktopApp/src-tauri/src/remote/client.rs` — `CentrifugoClient` trait + `FakeCentrifugoClient`.
- Create `DesktopApp/src-tauri/src/remote/bus.rs` — `RemoteEventBus`.
- Modify `DesktopApp/src-tauri/src/sessions/watcher.rs` — optional bus tap alongside `app.emit`.
- Create `DesktopApp/src-tauri/src/remote/bridge.rs` — `PtyActuator` trait, `FakePtyActuator`, `RemoteBridge::handle_envelope`.

---

### Task 1: Add dependencies

**Files:** Modify `DesktopApp/src-tauri/Cargo.toml`.

- [ ] **Step 1: Add the deps**

In `[dependencies]` of `DesktopApp/src-tauri/Cargo.toml`, add:

```toml
tokio-tungstenite = { version = "0.29", features = ["rustls-tls-webpki-roots"] }
futures-util = "0.3"
async-trait = "0.1"
```

- [ ] **Step 2: Verify it resolves and builds**

Run: `cargo build --manifest-path DesktopApp/src-tauri/Cargo.toml`
Expected: dependencies resolve and the crate builds (no code uses them yet; that's fine).

- [ ] **Step 3: Commit**

```bash
git add DesktopApp/src-tauri/Cargo.toml DesktopApp/src-tauri/Cargo.lock
git commit -m "build(remote): add tokio-tungstenite, futures-util, async-trait"
```

---

### Task 2: Centrifugo JSON wire codec (`wire.rs`)

**Files:** Create `DesktopApp/src-tauri/src/remote/wire.rs`; modify `remote/mod.rs`.

This is the protocol meat. Wire facts (from `docs/superpowers/research/2026-05-30-centrifugo-rust-client.md`): frames are newline-delimited JSON; a command is `{"id":N,"<key>":{...}}`; a server ping is a bare `{}`; a publication push is `{"push":{"channel":"...","pub":{"data":...,"offset":N}}}`; a command reply carries the matching `id` and either a result key or `{"error":{"code","message","temporary"}}`.

- [ ] **Step 1: Declare the module**

In `DesktopApp/src-tauri/src/remote/mod.rs` add (keep existing lines):

```rust
pub mod wire;
```

- [ ] **Step 2: Write the failing tests**

Create `DesktopApp/src-tauri/src/remote/wire.rs`:

```rust
use serde::Deserialize;

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn encodes_command_with_id_and_key() {
        assert_eq!(
            encode_command(1, "connect", json!({ "token": "JWT" })),
            r#"{"id":1,"connect":{"token":"JWT"}}"#
        );
    }

    #[test]
    fn encodes_batch_newline_delimited() {
        let frame = encode_batch(&[
            (1, "subscribe", json!({ "channel": "cmd:dev-1" })),
            (2, "subscribe", json!({ "channel": "sess:xyz" })),
        ]);
        assert_eq!(
            frame,
            "{\"id\":1,\"subscribe\":{\"channel\":\"cmd:dev-1\"}}\n{\"id\":2,\"subscribe\":{\"channel\":\"sess:xyz\"}}"
        );
    }

    #[test]
    fn pong_constant_is_empty_object() {
        assert_eq!(PONG, "{}");
    }

    #[test]
    fn parses_empty_frame_as_ping() {
        assert_eq!(parse_frame("{}"), vec![Frame::Ping]);
    }

    #[test]
    fn parses_publication_push() {
        let text = r#"{"push":{"channel":"cmd:dev-1","pub":{"data":{"commandId":"c1","command":{"type":"stopSession","sessionId":"s1"}},"offset":44}}}"#;
        assert_eq!(
            parse_frame(text),
            vec![Frame::Publication {
                channel: "cmd:dev-1".into(),
                data: serde_json::json!({
                    "commandId": "c1",
                    "command": { "type": "stopSession", "sessionId": "s1" }
                }),
            }]
        );
    }

    #[test]
    fn parses_publish_ack_success() {
        assert_eq!(
            parse_frame(r#"{"id":3,"publish":{}}"#),
            vec![Frame::Ack { id: 3, error: None }]
        );
    }

    #[test]
    fn parses_error_reply() {
        let text = r#"{"id":3,"error":{"code":103,"message":"permission denied","temporary":false}}"#;
        assert_eq!(
            parse_frame(text),
            vec![Frame::Ack {
                id: 3,
                error: Some(WireError { code: 103, message: "permission denied".into(), temporary: false }),
            }]
        );
    }

    #[test]
    fn parses_multiple_newline_delimited_frames() {
        let text = "{}\n{\"id\":1,\"connect\":{\"client\":\"abc\"}}";
        let frames = parse_frame(text);
        assert_eq!(frames.len(), 2);
        assert_eq!(frames[0], Frame::Ping);
        assert_eq!(frames[1], Frame::Ack { id: 1, error: None });
    }
}
```

- [ ] **Step 3: Run the tests, expect FAIL**

Run: `cargo test --manifest-path DesktopApp/src-tauri/Cargo.toml remote::wire`
Expected: FAIL — `encode_command` / `Frame` not found.

- [ ] **Step 4: Write the implementation**

Insert above the `#[cfg(test)]` block in `wire.rs`:

```rust
/// Encode a single Centrifugo command frame: `{"id":<id>,"<key>":<payload>}`.
/// NOTE: built with `format!` (not `serde_json::json!`) because serde_json's
/// default Map is a BTreeMap that sorts keys alphabetically — `json!` would emit
/// `{"connect":...,"id":1}` and break the id-first wire shape the tests assert.
/// `key` is always a controlled constant ("connect"/"subscribe"/"publish").
pub fn encode_command(id: u32, key: &str, payload: serde_json::Value) -> String {
    format!(r#"{{"id":{},"{}":{}}}"#, id, key, payload)
}

/// Encode several commands into one newline-delimited frame.
pub fn encode_batch(commands: &[(u32, &str, serde_json::Value)]) -> String {
    commands
        .iter()
        .map(|(id, key, payload)| encode_command(*id, key, payload.clone()))
        .collect::<Vec<_>>()
        .join("\n")
}

/// Pong reply to a server ping — an empty JSON object.
pub const PONG: &str = "{}";

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct WireError {
    pub code: u32,
    pub message: String,
    #[serde(default)]
    pub temporary: bool,
}

/// A decoded inbound line from a Centrifugo frame.
#[derive(Debug, Clone, PartialEq)]
pub enum Frame {
    /// Server keepalive ping (empty `{}`); reply with `PONG`.
    Ping,
    /// A publication on a subscribed channel.
    Publication { channel: String, data: serde_json::Value },
    /// A reply to a command we sent, identified by `id`. `error` set on failure.
    Ack { id: u32, error: Option<WireError> },
    /// Any other push/reply we don't act on (join/leave/disconnect/connect result, etc.).
    Other,
}

#[derive(Deserialize)]
struct RawReply {
    #[serde(default)]
    id: u32,
    #[serde(default)]
    error: Option<WireError>,
    #[serde(default)]
    push: Option<RawPush>,
}

#[derive(Deserialize)]
struct RawPush {
    #[serde(default)]
    channel: String,
    #[serde(default, rename = "pub")]
    publication: Option<RawPublication>,
}

#[derive(Deserialize)]
struct RawPublication {
    data: serde_json::Value,
}

/// Parse a WebSocket text frame (newline-delimited JSON) into classified frames.
/// Unparseable lines are skipped.
pub fn parse_frame(text: &str) -> Vec<Frame> {
    text.trim()
        .split('\n')
        .filter(|line| !line.trim().is_empty())
        .filter_map(classify_line)
        .collect()
}

fn classify_line(line: &str) -> Option<Frame> {
    let reply: RawReply = serde_json::from_str(line).ok()?;
    if let Some(push) = reply.push {
        return match push.publication {
            Some(p) => Some(Frame::Publication { channel: push.channel, data: p.data }),
            None => Some(Frame::Other),
        };
    }
    if reply.id != 0 {
        return Some(Frame::Ack { id: reply.id, error: reply.error });
    }
    // No push, no id, no error → server ping `{}`.
    if reply.error.is_none() {
        return Some(Frame::Ping);
    }
    Some(Frame::Other)
}
```

- [ ] **Step 5: Run the tests, expect PASS (7 tests)**

Run: `cargo test --manifest-path DesktopApp/src-tauri/Cargo.toml remote::wire`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add DesktopApp/src-tauri/src/remote/wire.rs DesktopApp/src-tauri/src/remote/mod.rs
git commit -m "feat(remote): add centrifugo json wire codec"
```

---

### Task 3: `CentrifugoClient` trait + fake (`client.rs`)

**Files:** Create `DesktopApp/src-tauri/src/remote/client.rs`; modify `remote/mod.rs`.

The trait is the seam the real `tokio-tungstenite` client (2b-β) and the test fake both implement. It is intentionally minimal: outbound `publish`. Inbound publications are delivered to the bridge through an `mpsc::Receiver` the client owns (wired in 2b-β); the bridge logic is tested by feeding envelopes directly in Task 5.

- [ ] **Step 1: Declare the module**

In `remote/mod.rs` add:

```rust
pub mod client;
```

- [ ] **Step 2: Write the failing test**

Create `DesktopApp/src-tauri/src/remote/client.rs`:

```rust
use async_trait::async_trait;
use serde_json::Value;

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn fake_records_published_messages() {
        let fake = FakeCentrifugoClient::new();
        fake.publish("sess:s1", json!({ "type": "cmdResult", "ok": true })).await.unwrap();
        fake.publish("sess:s1", json!({ "type": "sessionActivity" })).await.unwrap();

        let sent = fake.published();
        assert_eq!(sent.len(), 2);
        assert_eq!(sent[0].0, "sess:s1");
        assert_eq!(sent[0].1, json!({ "type": "cmdResult", "ok": true }));
        assert_eq!(sent[1].0, "sess:s1");
    }
}
```

- [ ] **Step 3: Run the test, expect FAIL**

Run: `cargo test --manifest-path DesktopApp/src-tauri/Cargo.toml remote::client`
Expected: FAIL — `FakeCentrifugoClient` not found.

- [ ] **Step 4: Write the implementation**

Insert above the `#[cfg(test)]` block:

```rust
/// Outbound side of a Centrifugo connection. The real implementation
/// (tokio-tungstenite) and the test fake both implement this. Inbound
/// publications are delivered out-of-band via an mpsc channel owned by the
/// implementation (wired in plan 2b-β).
#[async_trait]
pub trait CentrifugoClient: Send + Sync {
    async fn publish(&self, channel: &str, data: Value) -> anyhow::Result<()>;
}

/// Test double: records every published (channel, data) pair.
#[derive(Default)]
pub struct FakeCentrifugoClient {
    published: parking_lot::Mutex<Vec<(String, Value)>>,
}

impl FakeCentrifugoClient {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn published(&self) -> Vec<(String, Value)> {
        self.published.lock().clone()
    }
}

#[async_trait]
impl CentrifugoClient for FakeCentrifugoClient {
    async fn publish(&self, channel: &str, data: Value) -> anyhow::Result<()> {
        self.published.lock().push((channel.to_string(), data));
        Ok(())
    }
}
```

- [ ] **Step 5: Run the test, expect PASS**

Run: `cargo test --manifest-path DesktopApp/src-tauri/Cargo.toml remote::client`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add DesktopApp/src-tauri/src/remote/client.rs DesktopApp/src-tauri/src/remote/mod.rs
git commit -m "feat(remote): add CentrifugoClient trait and fake"
```

---

### Task 4: Internal event bus + watcher tap (`bus.rs`, `watcher.rs`)

**Files:** Create `DesktopApp/src-tauri/src/remote/bus.rs`; modify `remote/mod.rs` and `DesktopApp/src-tauri/src/sessions/watcher.rs`.

The bus lets the bridge observe the same session events the watcher already emits to the webview, without disturbing that path. `SessionWatchers` gains an optional broadcast sender; when set, it publishes a `SessionBusEvent` alongside each `app.emit`.

- [ ] **Step 1: Declare the module**

In `remote/mod.rs` add:

```rust
pub mod bus;
```

- [ ] **Step 2: Write the failing test**

Create `DesktopApp/src-tauri/src/remote/bus.rs`:

```rust
use tokio::sync::broadcast;

/// A session-domain event observed from `SessionWatchers`, to be forwarded
/// to Centrifugo by the bridge. Mirrors the existing `session:{id}:*` emits.
#[derive(Debug, Clone, PartialEq)]
pub enum SessionBusEvent {
    Append { session_id: String, blocks: serde_json::Value },
    Activity { session_id: String, activity: serde_json::Value },
    Title { session_id: String, title: String },
    Usage { session_id: String, summary: serde_json::Value },
}

/// Broadcast hub. `SessionWatchers` publishes; the bridge subscribes.
#[derive(Clone)]
pub struct RemoteEventBus {
    tx: broadcast::Sender<SessionBusEvent>,
}

impl RemoteEventBus {
    pub fn new() -> Self {
        let (tx, _rx) = broadcast::channel(256);
        Self { tx }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<SessionBusEvent> {
        self.tx.subscribe()
    }

    /// Publish an event. Ignores the "no active receivers" error so the watcher
    /// never blocks or fails when the bridge isn't connected.
    pub fn publish(&self, event: SessionBusEvent) {
        let _ = self.tx.send(event);
    }
}

impl Default for RemoteEventBus {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn subscriber_receives_published_event() {
        let bus = RemoteEventBus::new();
        let mut rx = bus.subscribe();
        bus.publish(SessionBusEvent::Title { session_id: "s1".into(), title: "Hello".into() });
        let got = rx.recv().await.unwrap();
        assert_eq!(got, SessionBusEvent::Title { session_id: "s1".into(), title: "Hello".into() });
    }

    #[test]
    fn publish_without_subscribers_does_not_panic() {
        let bus = RemoteEventBus::new();
        bus.publish(SessionBusEvent::Title { session_id: "s1".into(), title: "x".into() });
    }
}
```

- [ ] **Step 3: Run the test, expect FAIL then PASS**

Run: `cargo test --manifest-path DesktopApp/src-tauri/Cargo.toml remote::bus`
Expected: FAIL (types undefined) → after Step 2's code is in place it should PASS (the implementation is included above; if it already passes, that's fine — the test and impl are in one file).

- [ ] **Step 4: Tap the bus from `SessionWatchers`**

In `DesktopApp/src-tauri/src/sessions/watcher.rs`:

Add an import near the top:
```rust
use crate::remote::bus::{RemoteEventBus, SessionBusEvent};
```

Add a field to `SessionWatchers` (after `last_activity`):
```rust
    bus: Mutex<Option<RemoteEventBus>>,
```

Initialize it in `SessionWatchers::new()` (add to the struct literal):
```rust
            bus: Mutex::new(None),
```

Add a setter method in `impl SessionWatchers`:
```rust
    pub fn set_bus(&self, bus: RemoteEventBus) {
        *self.bus.lock() = Some(bus);
    }
```

In `handle_change`, immediately after each existing `app.emit(...)` loop, publish the mirror to the bus. Add a single helper call after the activity-emit block, reusing the already-computed updates. Concretely, capture the updates before they are consumed by the emit loops by cloning into the bus inside each loop. Replace the three emit loops:

```rust
        for (sid, blocks) in block_updates {
            let _ = app.emit(&format!("session:{sid}:append"), serde_json::json!({ "blocks": blocks }));
        }
        for (sid, title) in title_updates {
            let _ = app.emit(&format!("session:{sid}:title"), serde_json::json!({ "title": title }));
        }
        for (sid, summary) in usage_updates {
            let _ = app.emit(&format!("session:{sid}:usage"), &summary);
        }
```

with a version that also forwards to the bus (only when a bus is set):

```rust
        let bus = self.bus.lock().clone();
        for (sid, blocks) in block_updates {
            let blocks_json = serde_json::json!({ "blocks": blocks });
            let _ = app.emit(&format!("session:{sid}:append"), &blocks_json);
            if let Some(b) = &bus {
                b.publish(SessionBusEvent::Append { session_id: sid, blocks: blocks_json });
            }
        }
        for (sid, title) in title_updates {
            let _ = app.emit(&format!("session:{sid}:title"), serde_json::json!({ "title": title.clone() }));
            if let Some(b) = &bus {
                b.publish(SessionBusEvent::Title { session_id: sid, title });
            }
        }
        for (sid, summary) in usage_updates {
            let _ = app.emit(&format!("session:{sid}:usage"), &summary);
            if let Some(b) = &bus {
                b.publish(SessionBusEvent::Usage { session_id: sid, summary: serde_json::to_value(&summary).unwrap_or_default() });
            }
        }
```

And in the activity loop, after the existing `app.emit` for activity, add the bus publish:

```rust
            if changed_state {
                last.insert(sid.clone(), new_activity);
                let activity_json = serde_json::json!({ "activity": new_activity });
                let _ = app.emit(&format!("session:{sid}:activity"), &activity_json);
                if let Some(b) = &bus {
                    b.publish(SessionBusEvent::Activity { session_id: sid.clone(), activity: serde_json::to_value(new_activity).unwrap_or_default() });
                }
            }
```

(Note: `RemoteEventBus` derives `Clone`, so `self.bus.lock().clone()` yields an `Option<RemoteEventBus>` usable across the loops without holding the lock.)

- [ ] **Step 5: Verify the watcher still builds and the whole suite passes**

Run: `cargo test --manifest-path DesktopApp/src-tauri/Cargo.toml`
Expected: builds; all tests pass (existing watcher behavior unchanged — bus is `None` in those tests).

- [ ] **Step 6: Commit**

```bash
git add DesktopApp/src-tauri/src/remote/bus.rs DesktopApp/src-tauri/src/remote/mod.rs DesktopApp/src-tauri/src/sessions/watcher.rs
git commit -m "feat(remote): add event bus and tap it from session watcher"
```

---

### Task 5: Bridge command handler (`bridge.rs`)

**Files:** Create `DesktopApp/src-tauri/src/remote/bridge.rs`; modify `remote/mod.rs`.

`RemoteBridge::handle_envelope` is the heart: it turns an incoming `RemoteEnvelope` into a `RemoteEvent::CmdResult` by running the pure `command_to_action` (from 2a) and executing the resulting `PtyAction` through a `PtyActuator`. The actuator trait isolates the side effects (PTY write/kill, resume-spawn) so this is unit-testable with a fake. The real actuator (wrapping `PtyManager` + the Tauri spawn path) and the async run-loop that pumps the `CentrifugoClient`'s inbound stream and the event bus are wired in 2b-β.

- [ ] **Step 1: Declare the module**

In `remote/mod.rs` add:

```rust
pub mod bridge;
```

- [ ] **Step 2: Write the failing tests**

Create `DesktopApp/src-tauri/src/remote/bridge.rs`:

```rust
use crate::error::AppResult;
use crate::remote::dispatch::{command_to_action, PtyAction};
use crate::remote::protocol::{RemoteEnvelope, RemoteEvent};
use crate::remote::registry::SessionPtyRegistry;

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
```

- [ ] **Step 3: Run the tests, expect FAIL**

Run: `cargo test --manifest-path DesktopApp/src-tauri/Cargo.toml remote::bridge`
Expected: FAIL — `RemoteBridge` / `PtyActuator` not found.

- [ ] **Step 4: Write the implementation**

Insert above the `#[cfg(test)]` block:

```rust
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
```

Note: the bridge owns its own `SessionPtyRegistry` in this plan for test isolation. In 2b-β it will instead hold the shared `Arc<SessionPtyRegistry>` from `AppState`; adjust `new` to take `Arc<SessionPtyRegistry>` at that point.

- [ ] **Step 5: Run the tests, expect PASS (4 tests)**

Run: `cargo test --manifest-path DesktopApp/src-tauri/Cargo.toml remote::bridge`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add DesktopApp/src-tauri/src/remote/bridge.rs DesktopApp/src-tauri/src/remote/mod.rs
git commit -m "feat(remote): add bridge command handler with pty actuator seam"
```

---

### Task 6: Final verification

- [ ] **Step 1: Full Rust suite**

Run: `cargo test --manifest-path DesktopApp/src-tauri/Cargo.toml`
Expected: all tests pass (2a tests + new `remote::wire`, `remote::client`, `remote::bus`, `remote::bridge`).

- [ ] **Step 2: Lint**

Run (from `DesktopApp/`): `npm run lint`
Expected: zero errors (no TS surface changed, but confirms nothing broke).

- [ ] **Step 3: Clippy (optional but recommended)**

Run: `cargo clippy --manifest-path DesktopApp/src-tauri/Cargo.toml -- -D warnings`
Expected: no warnings in the new `remote` modules.

---

## Deferred to 2b-β (needs Centrifugo deployment data)

- Real `TungsteniteCentrifugoClient` implementing `CentrifugoClient`: connect with JWT, subscribe to `cmd:<device>`, deliver publications via an `mpsc::Receiver<RemoteEnvelope>`, ping/pong, reconnect with backoff (algorithm in the research doc §6).
- The async run-loop: pump inbound envelopes → `handle_envelope` → publish `cmdResult`; subscribe the event bus → publish `SessionBusEvent` to `sess:<id>`.
- Production `PtyActuator` wrapping `PtyManager` + the Tauri spawn path; switch `RemoteBridge` to hold `Arc<SessionPtyRegistry>` from `AppState`.
- `allowRemoteSpawn` setting (persisted) feeding `RemoteBridge::new`.
- Unbind the registry on `pty:exit` (the 2a code-review follow-up).
- App-startup wiring in `lib.rs` (connect the bridge when configured) + `AppState` fields (`RemoteEventBus`, bridge handle).
- **Live integration test** (likely `#[ignore]`, env-gated) against a real Centrifugo.

### Centrifugo data required to start 2b-β
1. WebSocket URL (e.g. `wss://<host>/connection/websocket`).
2. A way to obtain a connection JWT for testing — either the `token_hmac_secret_key` (HS256) or a pre-minted test token; plus the `sub`/claims expected.
3. Confirmation of the **channel access model**: are `cmd:<device>` / `sess:<id>` public (connection-JWT only) or private (per-channel subscription tokens)? (Research open question #1.)
4. Confirmation that the namespace has **`allow_publish_for_subscriber: true`** (or equivalent) so the desktop may publish to `sess:`/`dev:`. (Research open question #2.)
5. Whether the deployed server requires the `centrifuge-json` subprotocol header. (Research open question #5.)

---

## Self-Review

**Spec/research coverage:** wire codec matches research §1.2–1.4 (newline framing, command shape, ping `{}`, publication `push.pub`, error shape) → Task 2. Trait seam for testability (research §2.4) → Task 3. Event bus tap mirroring existing `session:*` emits (design doc "Touch points" #2) → Task 4. Command→effect with `command_to_action` reuse + ack (design doc command dispatch) → Task 5. All network/credential-dependent items explicitly deferred with the exact data needed → "Deferred to 2b-β".

**Placeholder scan:** none — every code step is complete. Task 4 Step 3 notes the impl ships with its test in one file (no separate red step needed for the bus type).

**Type consistency:** `RemoteEvent::CmdResult { command_id, ok, error }` matches the 2a `protocol.rs` definition. `PtyAction` variants (`Write{pty_id,bytes}`, `Kill{pty_id}`, `Spawn{session_id,project_id}`, `Reject{reason}`) match 2a `dispatch.rs`. `command_to_action(cmd, &registry, allow_spawn)` signature matches 2a. `SessionPtyRegistry::{new,bind,pty_for}` match 2a. `Frame`/`WireError` used identically in `wire.rs` tests and impl.
