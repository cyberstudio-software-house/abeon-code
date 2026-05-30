# Remote Bridge 2b-β (Live Networking) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Connect the offline core (2b-α) to a real Centrifugo deployment: a `tokio-tungstenite` client behind the existing `CentrifugoClient` trait, an async run-loop that pumps commands and forwards session events, a production `PtyActuator`, the `allowRemoteSpawn` setting, registry cleanup on natural PTY exit, app-startup wiring, and an env-gated live integration test.

**Architecture:** The real client slots behind `remote::client::CentrifugoClient` (so the run-loop and bridge are unchanged). The client owns reader+writer tasks over a split WebSocket; inbound publications on `cmd:<device>` are parsed into `RemoteEnvelope` and delivered on an `mpsc::Receiver`; `publish()` enqueues a command to the writer task. The run-loop (`RemoteBridge::run`) selects over the inbound command receiver and the `RemoteEventBus`, calling `handle_envelope` (2b-α) for commands and forwarding `SessionBusEvent`s as publications. Everything except the live test is validated offline — the client against a local `tokio-tungstenite` mock server, the run-loop against the 2b-α fakes.

**Tech Stack:** tokio-tungstenite 0.29 (added in 2b-α), futures-util, async-trait, serde_json, tokio; add `jsonwebtoken` for HS256 token minting.

**Builds on (merged to `main`):** 2a + 2b-α: `remote::{protocol, registry, dispatch, wire, client, bus, bridge}`; `validation`.

**Deployment data** (from gitignored `docs/centrifungo.md`, read via env in tests — NEVER hardcode): host `ws.k8s.abeon.app`, endpoint `wss://ws.k8s.abeon.app/connection/websocket`, HMAC token secret `CENTRIFUGO_TOKEN_SECRET` (HS256). Open questions resolved empirically by the live test (Task 7): public vs token-gated channels, `allow_publish_for_subscriber`, subprotocol header.

**Working dir:** paths under `DesktopApp/`. cargo: `--manifest-path DesktopApp/src-tauri/Cargo.toml`.

**Channel naming (constants, Task 3):** down/events `sess:<sessionId>`; command-results `dev:<deviceId>`; up/commands `cmd:<deviceId>` (client subscribes).

---

### Task 1: HS256 token minting (`remote::token`)

Add `jsonwebtoken = "9"` to `DesktopApp/src-tauri/Cargo.toml`. Create `remote/token.rs` (declare `pub mod token;` in `remote/mod.rs`):

```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, PartialEq)]
struct ConnectClaims {
    sub: String,
    exp: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    channel: Option<String>,
}

/// Mint a Centrifugo connection JWT (HS256) for device `sub`, valid `ttl_secs`.
/// `now_unix` is injected so the function stays pure/testable.
pub fn mint_connection_token(secret: &str, sub: &str, now_unix: usize, ttl_secs: usize) -> anyhow::Result<String> {
    use jsonwebtoken::{encode, EncodingKey, Header};
    let claims = ConnectClaims { sub: sub.to_string(), exp: now_unix + ttl_secs, channel: None };
    Ok(encode(&Header::default(), &claims, &EncodingKey::from_secret(secret.as_bytes()))?)
}

/// Mint a channel subscription JWT (HS256) — used only if the deployment gates channels.
pub fn mint_subscription_token(secret: &str, sub: &str, channel: &str, now_unix: usize, ttl_secs: usize) -> anyhow::Result<String> {
    use jsonwebtoken::{encode, EncodingKey, Header};
    let claims = ConnectClaims { sub: sub.to_string(), exp: now_unix + ttl_secs, channel: Some(channel.to_string()) };
    Ok(encode(&Header::default(), &claims, &EncodingKey::from_secret(secret.as_bytes()))?)
}
```

Tests (TDD): mint a token, decode it back with the same secret + `HS256` validation and assert `sub`/`exp`/`channel`; assert decoding with a wrong secret fails. Commit: `feat(remote): add HS256 centrifugo token minting`.

---

### Task 2: `allowRemoteSpawn` setting

In `DesktopApp/src-tauri/src/commands/settings.rs` add a typed reader (follow the existing `get_setting`/`resolve_*` patterns):

```rust
/// Whether the remote bridge may spawn a process for a mobile `resumeSession`.
/// Defaults to false (most sensitive remote op; opt-in).
pub fn allow_remote_spawn(conn: &rusqlite::Connection) -> bool {
    get_setting_value(conn, "allowRemoteSpawn").as_deref() == Some("true")
}
```

(Use whatever the existing internal getter is named — read the file first; reuse it, don't add a new query path.) Add a test using an in-memory DB: unset → false; set "true" → true; set "false" → false. Commit: `feat(remote): add allowRemoteSpawn setting reader`.

> Frontend toggle in SettingsDialog is out of scope here (add later); `PERSISTED_KEYS` in `store/index.ts` should include `allowRemoteSpawn` when the UI lands.

---

### Task 3: Async run-loop (`RemoteBridge::run`) — tested against fakes

Extend `remote/bridge.rs`. Add channel-name constants and an async `run` method. `RemoteBridge` switches to hold `Arc<SessionPtyRegistry>` (shared with AppState) — update `new` accordingly and fix the 2b-α tests to pass an `Arc`.

```rust
use std::sync::Arc;
use tokio::sync::{broadcast, mpsc};
use crate::remote::client::CentrifugoClient;
use crate::remote::bus::SessionBusEvent;

pub fn cmd_channel(device_id: &str) -> String { format!("cmd:{device_id}") }
pub fn result_channel(device_id: &str) -> String { format!("dev:{device_id}") }
pub fn session_channel(session_id: &str) -> String { format!("sess:{session_id}") }
```

`run` signature:
```rust
impl RemoteBridge {
    pub async fn run(
        self: Arc<Self>,
        device_id: String,
        mut inbound: mpsc::Receiver<RemoteEnvelope>,
        mut bus: broadcast::Receiver<SessionBusEvent>,
        client: Arc<dyn CentrifugoClient>,
        actuator: Arc<dyn PtyActuator>,
    ) { /* select! loop: see below */ }
}
```

Loop behavior (use `tokio::select!`):
- inbound envelope → `let ev = self.handle_envelope(env, actuator.as_ref());` → serialize `ev` to JSON → `client.publish(&result_channel(&device_id), json).await`.
- bus event → map to `(channel, json)` and `client.publish(...)`:
  - `Append{session_id, blocks}` → `session_channel(&session_id)`, `{ "type":"sessionAppend","sessionId":session_id, ...blocks }` (decide a stable shape; mirror `RemoteEvent` naming).
  - `Activity/Title/Usage` similarly to `sess:<id>`.
- `bus.recv()` returning `Err(Lagged)` → log and continue; `Err(Closed)` → break. inbound `None` → break.

Tests (TDD, with `FakeCentrifugoClient` + a `FakePtyActuator`): 
1. push a `SendPrompt` envelope on `inbound`; after the loop processes it, assert the fake client published a `cmdResult ok:true` to `dev:<device>` and the fake actuator recorded the write. (Drive by sending one message then dropping the sender to end the loop; `tokio::spawn` the run and await it, or run with a timeout.)
2. publish a `SessionBusEvent::Title` on the bus; assert the fake client published to `sess:<id>`.

Commit: `feat(remote): add async run-loop forwarding commands and session events`.

---

### Task 4: Real `TungsteniteCentrifugoClient` — tested against a mock WS server

Create `remote/ws_client.rs` (declare in `mod.rs`). Implement `CentrifugoClient` (publish) plus a constructor that connects and returns the inbound `mpsc::Receiver<RemoteEnvelope>`.

```rust
pub struct TungsteniteCentrifugoClient {
    /// Sends outbound command frames (already-encoded JSON lines) to the writer task.
    out_tx: tokio::sync::mpsc::Sender<String>,
    next_id: std::sync::atomic::AtomicU32,
}

pub struct CentrifugoConnection {
    pub client: std::sync::Arc<TungsteniteCentrifugoClient>,
    /// Inbound RemoteEnvelopes parsed from publications on the subscribed command channel.
    pub inbound: tokio::sync::mpsc::Receiver<crate::remote::protocol::RemoteEnvelope>,
}

impl TungsteniteCentrifugoClient {
    /// Connect, send `connect{token}`, subscribe to `command_channel` (with optional
    /// per-channel `sub_token`), and spawn reader+writer tasks. Reader: parse frames via
    /// `wire::parse_frame`; reply `PONG` to `Frame::Ping`; on `Frame::Publication` for the
    /// command channel, deserialize `data` into `RemoteEnvelope` and forward to `inbound`.
    pub async fn connect(
        url: &str,
        token: &str,
        command_channel: &str,
        sub_token: Option<&str>,
    ) -> anyhow::Result<CentrifugoConnection> { /* ... */ }
}

#[async_trait::async_trait]
impl CentrifugoClient for TungsteniteCentrifugoClient {
    async fn publish(&self, channel: &str, data: serde_json::Value) -> anyhow::Result<()> {
        let id = self.next_id.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let frame = crate::remote::wire::encode_command(id, "publish",
            serde_json::json!({ "channel": channel, "data": data }));
        self.out_tx.send(frame).await.map_err(|_| anyhow::anyhow!("ws writer closed"))?;
        Ok(())
    }
}
```

Implementation notes: use `tokio_tungstenite::connect_async`; `ws.split()` into sink/stream; a writer task drains `out_rx` and sends `Message::Text`; the connect/subscribe frames are sent before spawning (or first in the writer); reader loop `stream.next()` → `parse_frame` per text message. Reconnection/backoff: keep minimal here (single connection); a reconnect wrapper can be a follow-up — note it explicitly if deferred.

Tests (offline, no creds): start a `tokio-tungstenite` server bound to `127.0.0.1:0` in the test. It should: accept, read the first text frame and assert it contains `"connect"` and the token; read the next and assert it contains `"subscribe"` and the command channel; then send a publication frame `{"push":{"channel":"cmd:test","pub":{"data":{"commandId":"c1","command":{"type":"stopSession","sessionId":"s1"}}}}}`; assert the client forwards a matching `RemoteEnvelope` on `inbound`; then have the test call `client.publish("sess:x", json!({"k":1}))` and assert the server receives a `"publish"` frame for `sess:x`. Also send a `{}` ping from the server and assert the client replies `{}`.

Commit: `feat(remote): add tokio-tungstenite centrifugo client`.

---

### Task 5: Production `PtyActuator` + AppState fields

Create a production actuator wrapping the shared `Arc<PtyManager>` and the spawn path. `write`/`kill` delegate to `PtyManager`. `spawn_resume` builds a `PtyKind::Claude { session_id: Some(id), fresh: false, .. }` and calls the same spawn routine `spawn_pty` uses — factor the body of `spawn_pty` into a reusable `pub(crate) fn spawn_claude_resume(state, app, project_id, session_id) -> AppResult<String>` so both the Tauri command and the actuator share it (DRY; keeps the documented `bash -c` + env behavior). The actuator needs `AppHandle` + `State`/DB access — hold the pieces it needs (e.g. an `AppHandle` and `Arc<...>`), constructed at startup.

Add to `AppState`: `pub remote_bus: Arc<RemoteEventBus>` (set on the watcher via `session_watchers.set_bus(...)` at startup). Validation already guards session_id in the shared spawn path.

This task is mostly integration; verify with `cargo build` + the full suite. Commit: `feat(remote): production pty actuator and app-state bus`.

---

### Task 6: Unbind registry on natural PTY exit

Currently `pty_kill` unbinds, but a process that exits on its own leaves a stale `sessionId→ptyId`. Give `PtyManager::spawn` access to the shared `Arc<SessionPtyRegistry>` (or pass an `on_exit` callback) so the exit path (`PtyHandle` exit thread in `pty/handle.rs`, which emits `pty:{id}:exit`) also calls `registry.unbind_pty(id)`. Read `pty/handle.rs` first; choose the least-invasive hook (e.g. an `Option<Arc<SessionPtyRegistry>>` on the handle, unbind in the exit thread before/after emitting). Add a test if the chosen seam allows it (e.g. a unit test that the exit callback unbinds). Commit: `fix(remote): unbind session registry on natural pty exit`.

---

### Task 7: App-startup wiring + env-gated live integration test

1. Startup wiring in `lib.rs`: behind a config gate (a setting like `remoteBridgeEnabled` + a device id + token source), construct the bus, set it on the watcher, mint a connection token (Task 1) from the secret (read from a setting/env, NOT hardcoded), connect the client (Task 4), and `tokio::spawn` `RemoteBridge::run`. If not configured, do nothing (default off). Keep this minimal and gated so normal app launch is unaffected.

2. Live integration test (`#[ignore]`, env-gated): reads `CENTRIFUGO_TOKEN_SECRET` and `CENTRIFUGO_WS_URL` from env (skip/early-return if unset). Mint a token, connect, subscribe to a throwaway channel, publish a message to `sess:test-<rand>`, and assert no permission error. This empirically answers the open questions:
   - publish rejected with code 103 → namespace needs `allow_publish_for_subscriber`.
   - subscribe rejected → channels are token-gated; switch to `mint_subscription_token`.
   Document the findings in `docs/superpowers/research/2026-05-30-centrifugo-rust-client.md` (§7).

Run manually: `CENTRIFUGO_TOKEN_SECRET=… CENTRIFUGO_WS_URL=wss://ws.k8s.abeon.app/connection/websocket cargo test --manifest-path DesktopApp/src-tauri/Cargo.toml --ignored live_centrifugo`.

Commit: `feat(remote): wire bridge startup and add gated live integration test`.

---

### Task 8: Final verification

- `cargo test --manifest-path DesktopApp/src-tauri/Cargo.toml` — all offline tests pass.
- `cargo clippy --manifest-path DesktopApp/src-tauri/Cargo.toml -- -D warnings` — clean in `remote`.
- (from `DesktopApp/`) `npm run lint` — zero errors.
- Run the live test manually with the real secret; record what the open questions resolved to.

---

## Self-Review

**Coverage vs 2b-α "Deferred to 2b-β":** real client (T4), run-loop (T3), production actuator + AppState (T5), allowRemoteSpawn (T2), pty:exit unbind (T6), startup wiring + live test (T7). Token minting (T1) added because the desktop needs a connection JWT before CloudService exists.

**Offline-testable vs live:** T1–T6 are fully unit/mock-tested without credentials (mock WS server for T4, fakes for T3). Only T7's live test needs the secret/host and is `#[ignore]`d so CI/normal runs stay green.

**Open assumptions:** channel access model and `allow_publish` are unknown until T7 runs; T4's client supports an optional subscription token so either model works, and T7 documents the resolution. The single-connection client defers reconnect/backoff — call this out if not added.
