# Centrifugo Rust Client — Technical Reference

**Date:** 2026-05-30
**Purpose:** Implementation reference for a thin `CentrifugoClient` in Rust (Tauri/tokio) for the AbeonCode remote bridge feature.

---

## 1. Centrifugo Client Protocol (JSON, bidirectional)

### 1.1 Protocol overview

Centrifugo's bidirectional WebSocket protocol is defined by a [Protobuf schema](https://github.com/centrifugal/protocol/blob/master/definitions/client.proto) and supports two wire encodings: JSON (text frames) and binary Protobuf. For our use case we use **JSON text frames**.

The protocol is **command/reply with asynchronous pushes**:

- The client sends `Command` objects; each carries an integer `id` field.
- The server sends `Reply` objects; replies to client commands carry the matching `id`.
- Asynchronous server-initiated pushes (publications, disconnect notices, etc.) carry `id: 0` or no `id` — they are identified by having a `push` field.

### 1.2 Framing

Each WebSocket **text frame** contains one or more commands/replies encoded as **newline-delimited JSON** (`\n` separator, no trailing newline required).

Sending two subscribe commands in one frame:
```
{"id":1,"subscribe":{"channel":"cmd:device-abc"}}\n{"id":2,"subscribe":{"channel":"sess:xyz"}}
```

Decoding a frame with multiple replies:
```rust
for line in frame.trim().split('\n') {
    let reply: Reply = serde_json::from_str(line)?;
}
```

Source: centrifuge-js `json.ts` codec — `encodeCommands` joins with `\n`, `decodeReplies` splits on `\n`.

### 1.3 JSON wire shapes

#### Connect (client → server)

Minimal form (only token is required for authenticated connections):
```json
{"id":1,"connect":{"token":"<JWT>"}}
```

Full form (all optional fields):
```json
{
  "id": 1,
  "connect": {
    "token": "<JWT>",
    "name": "abeoncode",
    "version": "1.0.0",
    "data": null,
    "subs": {}
  }
}
```

The `Command` Protobuf has the command payload as a named field (`connect`, `subscribe`, `publish`, etc.) rather than a numeric `method` field. **The v5/v6 JSON format uses field names, not numeric method codes.** (The v3 protocol used `"method": 0` integer codes — do not use that.)

#### ConnectResult (server → client, reply)

```json
{
  "id": 1,
  "connect": {
    "client": "421bf374-dd01-4f82-9def-8c31697e956f",
    "version": "5.4.0",
    "expires": true,
    "ttl": 3600,
    "ping": 25,
    "pong": true,
    "session": "sess-id",
    "node": "node1"
  }
}
```

Key fields:
- `client` — server-assigned connection ID (use for debugging).
- `ping` — server's ping interval **in seconds** (0 means no application-level pings). Cache this.
- `pong` — whether the server expects pong replies from this client.
- `ttl` — seconds until token expires; schedule a `refresh` command before expiry.

#### Subscribe (client → server)

Public channel (no subscription token needed):
```json
{"id":2,"subscribe":{"channel":"cmd:device-abc"}}
```

Private/protected channel (requires a channel-scoped JWT):
```json
{"id":2,"subscribe":{"channel":"$private","token":"<channel-JWT>"}}
```

Recovery (resume from a known offset):
```json
{"id":2,"subscribe":{"channel":"cmd:device-abc","recover":true,"epoch":"abc","offset":42}}
```

#### SubscribeResult (server → client, reply)

```json
{
  "id": 2,
  "subscribe": {
    "expires": false,
    "recoverable": true,
    "epoch": "abc",
    "offset": 43,
    "recovered": true,
    "publications": []
  }
}
```

`publications` contains any missed messages if recovery was requested.

#### Publish (client → server)

```json
{"id":3,"publish":{"channel":"sess:xyz","data":{"event":"output","text":"hello"}}}
```

`data` is an arbitrary JSON value. The server does **not** validate it.

#### PublishResult (server → client, reply)

```json
{"id":3,"publish":{}}
```

Empty result on success. On failure the reply carries an `error` field instead:

```json
{"id":3,"error":{"code":103,"message":"permission denied","temporary":false}}
```

#### Error object shape

```json
{
  "code": 103,
  "message": "permission denied",
  "temporary": false
}
```

- `code` — numeric error code (see [Centrifugo error codes](https://centrifugal.dev/docs/transports/client_protocol)).
- `message` — human-readable description.
- `temporary` — if `true` the operation may succeed after a delay/reconnect; if `false` it is permanent (e.g. permission denied).

Common error codes:
| Code | Meaning |
|------|---------|
| 100 | Internal server error (temporary) |
| 101 | Already connected |
| 103 | Permission denied (permanent) |
| 104 | Method not found |
| 105 | Limit exceeded |
| 107 | Not available |
| 108 | Token expired |
| 109 | Expired (subscription token) |
| 110 | Unauthorized |

#### Server Push — Publication (server → client, async)

A push reply has no positive `id` (id field is 0 or absent) and contains a `push` field:

```json
{
  "push": {
    "channel": "cmd:device-abc",
    "pub": {
      "data": {"command":"run","args":["npm","test"]},
      "offset": 44,
      "info": {
        "user": "server",
        "client": "server-client-id"
      },
      "tags": {}
    }
  }
}
```

Detection in code: a reply is a push if `reply.id == 0 && reply.push.is_some()`.

Other push subtypes (discriminated by which field is present inside `push`):
- `pub` — publication (the main data event).
- `join` / `leave` — presence events.
- `unsubscribe` — server unsubscribed the client from a channel.
- `disconnect` — server is disconnecting the client (contains `code` + `reason` + `reconnect`).
- `subscribe` — server-side subscription was added.
- `message` — unidirectional message (used with `send` command, not `publish`).

### 1.4 Ping / keepalive

Centrifugo uses **application-level** ping/pong (not WebSocket-level ping frames).

Flow:
1. After connect, the server sends an empty `{}` JSON text frame every `ping` seconds (default 25 s).
2. The client detects this as a reply with no `id` and no `push` field.
3. The client responds with an empty command `{}` (a pong) within `pong_timeout` seconds (default 8 s).
4. If no pong arrives within `pong_timeout`, the server closes the connection.

Detection and response (from centrifuge-python reference implementation):
```python
# Ping detection
if reply.get("id", 0) == 0 and not reply.get("push"):
    # It's a ping — send back an empty {}
    await send_commands([{}])
```

In Rust:
```rust
// Empty frame arrives as: {}
// Reply with empty pong:
sink.send(Message::Text("{}".into())).await?;
```

The client should also maintain a **pong watchdog timer**: if no ping has been received after `ping_interval + pong_timeout` seconds, assume the connection is broken and reconnect.

Server config keys: `client.ping_interval` (default `"25s"`), `client.pong_timeout` (default `"8s"`).

### 1.5 Full Protobuf field reference (Command / Reply)

```proto
message Command {
  uint32 id = 1;
  ConnectRequest connect = 4;
  SubscribeRequest subscribe = 5;
  UnsubscribeRequest unsubscribe = 6;
  PublishRequest publish = 7;
  PingRequest ping = 11;
  // ...
}

message Reply {
  uint32 id = 1;
  Error error = 2;
  Push push = 4;
  ConnectResult connect = 5;
  SubscribeResult subscribe = 6;
  PublishResult publish = 8;
  PingResult ping = 12;
  // ...
}

message Push {
  string channel = 2;
  Publication pub = 4;
  Join join = 5;
  Leave leave = 6;
  Unsubscribe unsubscribe = 7;
  Disconnect disconnect = 11;
  // ...
}
```

Source: [`centrifugal/protocol/definitions/client.proto`](https://github.com/centrifugal/protocol/blob/master/definitions/client.proto)

---

## 2. Crate Assessment

### 2.1 `tokio-centrifuge` (IntrepidAI/tokio-centrifuge)

| Attribute | Value |
|-----------|-------|
| Latest version | 0.2.6 (September 29, 2025) |
| v0.3.0 | In-progress (no release date) |
| Rust edition | 2024 |
| MSRV | 1.85 |
| Official Centrifugo listing | Yes — listed on centrifugal.dev as community SDK |
| Stars / forks | ~11 stars / 3 forks |
| License | MIT |
| Client-side publish | Yes (via `MessageStore` → `Command::Publish`) |
| Reconnection | Yes — exponential backoff in `do_connection_cycle` |
| Protocol encoding | JSON + Protobuf (prost) |
| TLS | native-tls (default), rustls-tls-native-roots, rustls-tls-webpki-roots |
| Transport | tokio-tungstenite 0.28 |
| Batching | Yes — drains message store in batches of 32 |
| Changelog quality | Poor — "software not stabilized, changes weren't documented" for v0.0.0–0.2.6 |
| Breaking change imminent | Yes — v0.3.0 changes `new_subscription` signature |

Architecture: event-driven with a `JoinSet` of tasks, `SlotMap` for subscriptions, `oneshot` channels for request/reply correlation, configurable `reconnect_strategy`.

### 2.2 `centrifuge-client` (pscheid92/centrifuge-rs)

| Attribute | Value |
|-----------|-------|
| Latest version | 0.1.0-alpha.2 (April 23, 2026) |
| License | MIT |
| Rust edition | 2024 |
| MSRV | 1.85+ |
| Compatibility | Centrifugo v4, v5, v6; Centrifuge >= 0.25.0 |
| Client-side publish | Yes — `client.publish(channel, data)` and `sub.publish(data)` |
| Reconnection | Yes — configurable `min_reconnect_delay` / `max_reconnect_delay` |
| SDK spec coverage | Claims 139/139 requirements from the official spec |
| Protocol encoding | JSON + Protobuf (prost) |
| TLS | native-tls (default), rustls via `rustls` feature |
| Transport | tokio-tungstenite 0.29 |
| Batching | Yes — `start_batching()` / `stop_batching()` API |
| Custom transport | Yes — replaceable via `Transport` trait |
| Test infra | Uses `testcontainers` (real Centrifugo container in tests) |
| Dev status | Alpha — API not stabilized |

Key public API:
```rust
let client = Client::new(ClientConfig::new("wss://host/connection/websocket"));
let (sub, mut events) = client.subscribe("cmd:device-abc").await?;
client.connect().await?;

// Receive publications
while let Some(event) = events.recv().await {
    match event {
        SubEvent::Publication(p) => { /* p.data is serde_json::Value */ }
        SubEvent::Subscribed(ctx) => {}
        _ => {}
    }
}

// Publish
client.publish("sess:xyz", serde_json::json!({"event":"output"})).await?;
```

### 2.3 Other crates (informational, not recommended)

- **`rucent`** — HTTP API client only, not WebSocket. Not relevant.
- **`tauri-plugin-centrifugo`** — Tauri-specific plugin wrapping tokio-centrifuge. Adds JS bindings. Not suitable as a library dependency for our Rust-side bridge.
- **`centrifuge-rs` (orhanbalci)** — Appears unmaintained; targets old Centrifugo v1/v2 protocol.

### 2.4 Recommendation

**Roll our own thin implementation over `tokio-tungstenite`**, behind a `CentrifugoClient` trait.

Rationale:

1. **Both alpha crates have unstable APIs.** `centrifuge-client` is `0.1.0-alpha.2`; `tokio-centrifuge` has breaking changes inbound in v0.3.0. Either one risks churn during our implementation sprint.
2. **Protocol is simple for our use case.** We need exactly: connect (with JWT), subscribe to 1–2 channels, receive publications, publish, and ping/pong keepalive. The full SDK surface (presence, history, RPC, recovery, server-side subscriptions, token refresh callbacks) adds complexity we don't need today.
3. **Trait boundary.** We need a `CentrifugoClient` trait to inject a fake in unit tests (Tauri commands can't easily run a real server in CI). Both crates don't expose a trait; wrapping them behind our own trait negates their convenience anyway.
4. **Dependency hygiene.** Both crates pull in `prost`, `prost-build` (a build-time dep), and `slotmap`/`uuid` — not needed for JSON-only. A direct `tokio-tungstenite` + `serde_json` approach keeps the compile graph lean.
5. **`centrifuge-client` is usable as a protocol reference.** Its source is a faithful implementation of the [client SDK spec](https://centrifugal.dev/docs/transports/client_api) and is a good cross-check when writing our own deserialization.

If the scope later grows to include presence, history, or token refresh, re-evaluate `centrifuge-client` once it stabilises (>=0.1.0 stable).

---

## 3. tokio-tungstenite Essentials

### 3.1 Cargo dependency lines

Add to `src-tauri/Cargo.toml`:

```toml
[dependencies]
# WebSocket
tokio-tungstenite = { version = "0.29", features = ["rustls-tls-webpki-roots"] }
# Alternatively for native-tls (uses OS certificate store, required on some Linux distros):
# tokio-tungstenite = { version = "0.29", features = ["native-tls"] }

# JSON
serde = { version = "1", features = ["derive"] }
serde_json = "1"

# Async utilities (already a Tauri dep, ensure these features are on)
tokio = { version = "1", features = ["rt-multi-thread", "macros", "sync", "time"] }
futures-util = "0.3"
```

TLS feature choice:
- `rustls-tls-webpki-roots` — pure-Rust TLS, bundles the Mozilla root store. No system cert store needed. Recommended for reproducible builds and cross-compilation.
- `rustls-tls-native-roots` — rustls but reads from the OS trust store.
- `native-tls` — delegates to OpenSSL (Linux), SChannel (Windows), SecureTransport (macOS). Required if the deployment server uses an internal CA cert in the OS store.

### 3.2 Connecting and splitting

```rust
use tokio_tungstenite::{connect_async, tungstenite::Message};
use futures_util::{SinkExt, StreamExt};

let (ws_stream, _response) = connect_async("wss://host:8000/connection/websocket").await?;
let (mut sink, mut stream) = ws_stream.split();

// Writer task
tokio::spawn(async move {
    sink.send(Message::Text(r#"{"id":1,"connect":{"token":"JWT"}}"#.into())).await.unwrap();
});

// Reader loop
while let Some(msg) = stream.next().await {
    let text = msg?.into_text()?;
    for line in text.trim().split('\n') {
        let reply: serde_json::Value = serde_json::from_str(line)?;
        // dispatch…
    }
}
```

`ws_stream.split()` comes from `futures_util::StreamExt` and returns `(SplitSink<…, Message>, SplitStream<…>)`. The sink and stream can be moved into separate tasks because they are `Send + 'static`.

### 3.3 Custom request headers (for auth or subprotocol)

```rust
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::header::{AUTHORIZATION, SEC_WEBSOCKET_PROTOCOL};

let mut req = "wss://host/connection/websocket".into_client_request()?;
req.headers_mut().insert(
    SEC_WEBSOCKET_PROTOCOL,
    "centrifuge-json".parse()?,  // optional; centrifugo auto-detects
);
let (ws_stream, _) = connect_async(req).await?;
```

### 3.4 TLS source summary

| Feature flag | TLS impl | Root certs |
|---|---|---|
| `native-tls` | OS/platform (openssl/schannel/sec-transport) | OS cert store |
| `rustls-tls-native-roots` | rustls 0.23 | OS cert store |
| `rustls-tls-webpki-roots` | rustls 0.23 | Bundled Mozilla roots |

No TLS feature = plaintext `ws://` only.

---

## 4. Connection JWT Structure

### 4.1 Connection token

The JWT is HMAC-signed (typically HS256) with the Centrifugo server's `token_hmac_secret_key`. RSA and ECDSA are also supported.

Minimal payload for an authenticated client:
```json
{
  "sub": "device-abc",
  "exp": 1717094400
}
```

Claims:
| Claim | Required | Description |
|-------|----------|-------------|
| `sub` | Yes | User/device identifier string. Empty string = anonymous. |
| `exp` | Recommended | Unix timestamp (seconds). Enables token refresh flow. |
| `info` | No | Arbitrary JSON; visible in presence/join events. |
| `channels` | No | Array of channels to auto-subscribe on connect (server-side). |
| `subs` | No | Map of channel → SubscribeOption, for fine-grained server-side subs. |
| `aud` | No | Audience claim (validated if `token_audience` is configured server-side). |
| `iss` | No | Issuer claim. |
| `meta` | No | Server-only metadata, never sent to clients. |

Example for the desktop bridge device:
```json
{
  "sub": "device-abc",
  "exp": 1717094400,
  "info": {"role": "desktop"}
}
```

### 4.2 Subscription token (channel-scoped)

Used when a channel requires per-client authorization (namespace option `token_channel_namespace` or private channels prefixed with `$`). A separate JWT per channel:

```json
{
  "sub": "device-abc",
  "channel": "cmd:device-abc",
  "exp": 1717094400
}
```

Claims beyond connection token:
| Claim | Description |
|-------|-------------|
| `channel` | The exact channel string being subscribed to |
| `info` | Channel-specific metadata |
| `override` | Per-subscriber capability overrides (e.g. disable join/leave) |
| `expire_at` | Decouple token expiry from subscription expiry |

### 4.3 Minting (backend responsibility)

The CloudService backend will mint both token types using any standard JWT library (e.g. `jsonwebtoken` crate in Rust, or equivalent in Go/Node). For HS256:

```rust
// Pseudocode using the jsonwebtoken crate
let claims = ConnectClaims {
    sub: "device-abc".to_string(),
    exp: (Utc::now() + Duration::hours(1)).timestamp() as usize,
};
let token = encode(&Header::default(), &claims, &EncodingKey::from_secret(SECRET))?;
```

The desktop client receives the token via an API call to CloudService before initiating the WebSocket connection.

---

## 5. Suggested Rust Types for Our Thin Implementation

```rust
// Commands (outbound)
#[derive(Serialize)]
struct ConnectCmd { token: String, name: Option<String> }
#[derive(Serialize)]
struct SubscribeCmd { channel: String, #[serde(skip_serializing_if="Option::is_none")] token: Option<String> }
#[derive(Serialize)]
struct PublishCmd { channel: String, data: serde_json::Value }

#[derive(Serialize)]
#[serde(rename_all = "lowercase")]
enum Command {
    // id is a wrapper field; each variant serializes as {"id":N,"connect":{…}}
}

// Replies (inbound)
#[derive(Deserialize)]
struct Reply {
    #[serde(default)]
    id: u32,
    #[serde(default)]
    error: Option<CentrifugoError>,
    connect: Option<ConnectResult>,
    subscribe: Option<SubscribeResult>,
    publish: Option<PublishResult>,
    push: Option<Push>,
}

#[derive(Deserialize)]
struct CentrifugoError { code: u32, message: String, #[serde(default)] temporary: bool }

#[derive(Deserialize)]
struct Push { channel: String, pub: Option<Publication> }

#[derive(Deserialize)]
struct Publication { data: serde_json::Value, offset: Option<u64> }

// Trait for testability
#[async_trait]
trait CentrifugoClientTrait: Send + Sync {
    async fn connect(&self, token: &str) -> Result<()>;
    async fn subscribe(&self, channel: &str) -> Result<mpsc::Receiver<Publication>>;
    async fn publish(&self, channel: &str, data: serde_json::Value) -> Result<()>;
    async fn disconnect(&self);
}
```

Note: the `id` correlation pattern needs special handling in serde because JSON field names match the command type. The cleanest approach is hand-serializing commands as:
```rust
fn serialize_command(id: u32, payload_key: &str, payload: &impl Serialize) -> String {
    serde_json::json!({"id": id, payload_key: payload}).to_string()
}
```

---

## 6. Reconnection Algorithm

Reference: centrifugal.dev client SDK spec and tokio-centrifuge `do_connection_cycle`.

```
attempt = 0
loop:
    delay = min(base * 2^attempt + jitter, max_delay)
    sleep(delay)
    attempt += 1
    
    ws = connect(url)       -- TCP + WS handshake
    if fail: continue
    
    send Connect{token}
    recv ConnectResult      -- expect within timeout (e.g. 5 s)
    if error.code == 110 (Unauthorized): fetch new token, retry
    if error.temporary: continue
    if error permanent: abort
    
    for each known subscription:
        send Subscribe{channel}  -- may include recover=true, offset, epoch
    
    enter message loop:
        on ping ({}): send pong ({})
        on publication push: dispatch to subscriber channel
        on disconnect push: check reconnect flag, break
        on io error: break
    
    attempt = 0  -- reset on successful session
```

Backoff values aligned with centrifuge-js defaults: base 500 ms, max 20 s, full jitter.

---

## 7. Open Questions

1. **Channel access model for `cmd:<device>` and `sess:<id>`.** Do these use private channels (require subscription token per channel), or are they public channels protected only by the connection JWT? This determines whether `subscribe` needs a per-channel token and whether the CloudService must mint subscription tokens, not just connection tokens. *Blocker for the subscribe command implementation.*

2. **`allow_publish` namespace configuration.** Client-side publish to `sess:<id>` / `dev:<device>` requires `allow_publish_for_subscriber: true` (or `allow_publish_for_client`) in the relevant namespace on the Centrifugo server config. Confirm this is set in the deployed CloudService config before writing the publish path. *Blocker for publish integration test.*

3. **Connection token expiry handling.** The ConnectResult's `ttl` field indicates seconds until token expiry. The server will disconnect with error code 108 (`token expired`) if the client doesn't send a `refresh` command. Our minimal client should either (a) fetch a fresh token and reconnect, or (b) implement the `refresh` command. This is not needed for initial integration but becomes a production requirement for long-lived desktop sessions.

4. **Message ordering / recovery.** Subscription recovery (using `offset` + `epoch`) ensures no publications are missed across reconnects. We need to decide whether to implement this for `cmd:<device>` (commands might be stateful). This requires storing the last `offset` and `epoch` from `SubscribeResult` and each incoming `Publication`.

5. **WebSocket subprotocol header.** The Centrifugo docs mention `centrifuge-json` and `centrifuge-protobuf` subprotocol strings. Sending `Sec-WebSocket-Protocol: centrifuge-json` is optional but makes protocol negotiation explicit. Verify with the CloudService team whether the deployed Centrifugo requires or ignores this header.

---

## 8. Sources

- [Centrifugo Client Protocol docs](https://centrifugal.dev/docs/transports/client_protocol) — wire format overview (v5/v6)
- [Centrifugo Protobuf schema](https://github.com/centrifugal/protocol/blob/master/definitions/client.proto) — canonical field definitions
- [centrifuge-python client source](https://github.com/centrifugal/centrifuge-python) — ping/pong handling reference
- [centrifuge-js json.ts codec](https://github.com/centrifugal/centrifuge-js) — framing (newline-delimited) reference
- [Centrifugo WebSocket transport docs](https://centrifugal.dev/docs/transports/websocket) — endpoint, framing, ping behaviour
- [Centrifugo authentication docs](https://centrifugal.dev/docs/server/authentication) — JWT claims, algorithms
- [Centrifugo channel token auth docs](https://centrifugal.dev/docs/server/channel_token_auth) — subscription token claims
- [Centrifugo channel configuration](https://centrifugal.dev/docs/server/channels) — `allow_publish_for_subscriber` et al.
- [Centrifugo client SDK API spec](https://centrifugal.dev/docs/transports/client_api) — state machine, reconnect, subscription lifecycle
- [Centrifugo client SDKs listing](https://centrifugal.dev/docs/transports/client_sdk) — tokio-centrifuge listed as community SDK
- [tokio-centrifuge GitHub](https://github.com/IntrepidAI/tokio-centrifuge) — v0.2.6, MIT, unofficial
- [centrifuge-client (pscheid92) GitHub](https://github.com/pscheid92/centrifuge-rs) — v0.1.0-alpha.2, MIT, 139/139 spec coverage
- [tokio-tungstenite docs.rs](https://docs.rs/tokio-tungstenite/latest/tokio_tungstenite/) — v0.29.0 API
- [tokio-tungstenite crates.io](https://crates.io/crates/tokio-tungstenite) — version/features
