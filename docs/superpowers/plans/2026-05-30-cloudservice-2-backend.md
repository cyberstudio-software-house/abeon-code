# CloudService Plan 2 — Backend service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the CloudService axum microservice — device registration, pairing, Centrifugo token minting, and command authorization that publishes to `abeon-cloud-cmd:<deviceId>` — as a distroless Docker image deployable on k8s next to Centrifugo.

**Architecture:** A Rust `lib + bin` crate at `CloudService/`. The library exposes `app(AppState) -> Router` and all modules so handlers are integration-tested via `tower::oneshot` against in-memory fakes (no DB or network in tests). State holds trait objects (`Arc<dyn DeviceStore>`, `Arc<dyn PhoneTokenStore>`, `Arc<dyn PairingStore>`, `Arc<dyn CentrifugoApi>`) so production wires sqlx/reqwest impls while tests wire fakes. Timestamps are unix-epoch `BIGINT` to avoid MySQL/MariaDB timezone mapping pitfalls. The crate depends on `abeon-remote-core` (Plan 1) for the command contract, validation, token minting, and channel names.

**Tech Stack:** Rust (edition 2021), axum 0.8, tokio 1, sqlx 0.8 (MySQL, runtime queries), reqwest 0.12 (rustls), uuid, rand, sha2, hex, tracing, `abeon-remote-core`.

---

## Prerequisites

- **Plan 1 must be merged** (the `crates/abeon-remote-core` crate exists with `protocol`, `token`, `validation`, `channels`).
- Tests in this plan need **no** database or network — they run against fakes. The sqlx MySQL impl is covered by a single `#[ignore]`d integration test that needs a live MariaDB.

## Context the implementer needs

- **Runtime queries, not the `query!` macro.** Use `sqlx::query("...").bind(..)`. The compile-time `query!` macro needs a live DB at build time, which would break the hermetic Docker build. Do not use it.
- **axum 0.8 specifics:** path params use `{name}` syntax; custom extractors implement `FromRequestParts<AppState>` with a plain `async fn` (no `#[async_trait]`). Read a response body in tests with `axum::body::to_bytes(resp.into_body(), usize::MAX)`.
- **Trait objects need `#[async_trait]`** (the `async-trait` crate) to be `dyn`-compatible — store and Centrifugo traits use it.
- **Hashes** are SHA-256 hex of high-entropy random tokens (correct here; argon2 is for human passwords). Bearer comparison is by hash lookup.
- Verify commands run from the repo root unless stated. CloudService cargo commands use `--manifest-path CloudService/Cargo.toml`.

## File structure

- Create: `CloudService/Cargo.toml`
- Create: `CloudService/src/lib.rs` — `AppState`, `app()`, module decls
- Create: `CloudService/src/main.rs` — env/config, pool, migrations, serve
- Create: `CloudService/src/config.rs` — typed env config
- Create: `CloudService/src/error.rs` — `AppError` + `IntoResponse`
- Create: `CloudService/src/crypto.rs` — token/code generation + sha256 hex
- Create: `CloudService/src/store/mod.rs` — domain types, store traits, in-memory fakes
- Create: `CloudService/src/store/mysql.rs` — sqlx MariaDB impls
- Create: `CloudService/src/centrifugo.rs` — `CentrifugoApi` trait + reqwest impl + fake
- Create: `CloudService/src/auth.rs` — `Principal` / `DeviceAuth` / `PhoneAuth` extractors
- Create: `CloudService/src/routes/mod.rs`
- Create: `CloudService/src/routes/health.rs`
- Create: `CloudService/src/routes/devices.rs`
- Create: `CloudService/src/routes/token.rs`
- Create: `CloudService/src/routes/pairing.rs`
- Create: `CloudService/src/routes/command.rs`
- Create: `CloudService/migrations/0001_init.sql`
- Create: `CloudService/tests/api.rs` — integration tests via `oneshot` + fakes
- Create: `CloudService/Dockerfile`
- Create: `CloudService/k8s/{deployment,service,ingress}.yaml`
- Modify: `CloudService/README.md` — status + run/test notes

---

### Task 1: Scaffold the crate (config + health, builds and serves)

**Files:**
- Create: `CloudService/Cargo.toml`, `CloudService/src/{lib.rs,main.rs,config.rs,error.rs}`, `CloudService/src/routes/{mod.rs,health.rs}`

- [ ] **Step 1: Write `CloudService/Cargo.toml`**

```toml
[package]
name = "cloudservice"
version = "0.1.0"
edition = "2021"

[lib]
name = "cloudservice"
path = "src/lib.rs"

[[bin]]
name = "cloudservice"
path = "src/main.rs"

[dependencies]
abeon-remote-core = { path = "../crates/abeon-remote-core" }
axum = "0.8"
tokio = { version = "1", features = ["macros", "rt-multi-thread", "signal"] }
tower = { version = "0.5", features = ["util"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
thiserror = "2"
anyhow = "1"
async-trait = "0.1"
sqlx = { version = "0.8", default-features = false, features = ["runtime-tokio", "tls-rustls-ring-webpki", "mysql", "migrate"] }
reqwest = { version = "0.12", default-features = false, features = ["json", "rustls-tls"] }
uuid = { version = "1", features = ["v4"] }
rand = "0.8"
sha2 = "0.10"
hex = "0.4"
tracing = "0.1"
tracing-subscriber = { version = "0.3", features = ["env-filter"] }
```

- [ ] **Step 2: Write `CloudService/src/config.rs`**

```rust
use std::env;

/// Typed runtime configuration, loaded from environment variables.
#[derive(Debug, Clone)]
pub struct Config {
    pub bind_addr: String,
    pub database_url: String,
    pub centrifugo_token_secret: String,
    pub centrifugo_api_key: String,
    pub centrifugo_api_url: String,
    pub token_ttl_secs: i64,
    pub pairing_ttl_secs: i64,
}

impl Config {
    /// Load from env, returning an error naming the first missing required var.
    pub fn from_env() -> anyhow::Result<Self> {
        fn req(key: &str) -> anyhow::Result<String> {
            env::var(key).map_err(|_| anyhow::anyhow!("missing required env var {key}"))
        }
        Ok(Config {
            bind_addr: env::var("BIND_ADDR").unwrap_or_else(|_| "0.0.0.0:8080".into()),
            database_url: req("DATABASE_URL")?,
            centrifugo_token_secret: req("CENTRIFUGO_TOKEN_SECRET")?,
            centrifugo_api_key: req("CENTRIFUGO_API_KEY")?,
            centrifugo_api_url: req("CENTRIFUGO_API_URL")?,
            token_ttl_secs: env::var("TOKEN_TTL_SECS").ok().and_then(|v| v.parse().ok()).unwrap_or(3600),
            pairing_ttl_secs: env::var("PAIRING_TTL_SECS").ok().and_then(|v| v.parse().ok()).unwrap_or(300),
        })
    }
}
```

- [ ] **Step 3: Write `CloudService/src/error.rs`**

```rust
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::json;

/// Service error. `IntoResponse` renders a generic JSON body so internals never leak.
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("unauthorized")]
    Unauthorized,
    #[error("{0}")]
    BadRequest(String),
    #[error("{0}")]
    Conflict(String),
    #[error("upstream error")]
    Upstream(String),
    #[error("internal error")]
    Internal(#[from] anyhow::Error),
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, msg) = match &self {
            AppError::Unauthorized => (StatusCode::UNAUTHORIZED, "unauthorized".to_string()),
            AppError::BadRequest(m) => (StatusCode::BAD_REQUEST, m.clone()),
            AppError::Conflict(m) => (StatusCode::CONFLICT, m.clone()),
            AppError::Upstream(m) => {
                tracing::error!(error = %m, "centrifugo upstream error");
                (StatusCode::BAD_GATEWAY, "upstream error".to_string())
            }
            AppError::Internal(e) => {
                tracing::error!(error = ?e, "internal error");
                (StatusCode::INTERNAL_SERVER_ERROR, "internal error".to_string())
            }
        };
        (status, Json(json!({ "error": msg }))).into_response()
    }
}

pub type AppResult<T> = Result<T, AppError>;
```

- [ ] **Step 4: Write `CloudService/src/routes/mod.rs`**

```rust
pub mod command;
pub mod devices;
pub mod health;
pub mod pairing;
pub mod token;
```

(The `command`/`devices`/`pairing`/`token` modules are added in later tasks. For this task, create them as empty files so `routes/mod.rs` compiles — see Step 7.)

- [ ] **Step 5: Write `CloudService/src/routes/health.rs`**

```rust
use crate::AppState;
use axum::extract::State;
use axum::http::StatusCode;

/// Liveness — process is up.
pub async fn healthz() -> &'static str {
    "ok"
}

/// Readiness — dependencies reachable (DB ping). Returns 503 if not ready.
pub async fn readyz(State(state): State<AppState>) -> StatusCode {
    match state.devices.ping().await {
        Ok(()) => StatusCode::OK,
        Err(_) => StatusCode::SERVICE_UNAVAILABLE,
    }
}
```

- [ ] **Step 6: Write `CloudService/src/lib.rs`**

```rust
pub mod auth;
pub mod centrifugo;
pub mod config;
pub mod crypto;
pub mod error;
pub mod routes;
pub mod store;

use axum::routing::{get, post};
use axum::Router;
use std::sync::Arc;

/// Shared application state. Trait objects let production wire sqlx/reqwest impls
/// while tests wire in-memory fakes.
#[derive(Clone)]
pub struct AppState {
    pub devices: Arc<dyn store::DeviceStore>,
    pub phones: Arc<dyn store::PhoneTokenStore>,
    pub pairing: Arc<dyn store::PairingStore>,
    pub centrifugo: Arc<dyn centrifugo::CentrifugoApi>,
    pub config: Arc<config::Config>,
}

/// Build the router. Pure function of state so tests can call it with fakes.
pub fn app(state: AppState) -> Router {
    Router::new()
        .route("/healthz", get(routes::health::healthz))
        .route("/readyz", get(routes::health::readyz))
        .route("/v1/devices", post(routes::devices::register))
        .route("/v1/token", post(routes::token::issue))
        .route("/v1/pair/start", post(routes::pairing::start))
        .route("/v1/pair/claim", post(routes::pairing::claim))
        .route("/v1/command", post(routes::command::publish))
        .with_state(state)
}
```

- [ ] **Step 7: Write `CloudService/src/main.rs` and placeholder module files**

`CloudService/src/main.rs`:

```rust
use cloudservice::{app, config::Config};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();

    let config = Config::from_env()?;
    let state = cloudservice::build_state(config).await?;
    let listener = tokio::net::TcpListener::bind(&state.config.bind_addr).await?;
    tracing::info!(addr = %state.config.bind_addr, "cloudservice listening");

    axum::serve(listener, app(state))
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    Ok(())
}

async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
    tracing::info!("shutdown signal received");
}
```

Note: `build_state` is implemented in Task 5 (it wires the sqlx pool + reqwest client). For this task to compile and serve, temporarily stub it in `lib.rs` by appending:

```rust
/// Replaced with the real implementation in Task 5.
pub async fn build_state(_config: config::Config) -> anyhow::Result<AppState> {
    anyhow::bail!("build_state not implemented until Task 5")
}
```

Also create empty placeholder files so the crate compiles now (filled by later tasks):
`CloudService/src/crypto.rs`, `CloudService/src/store/mod.rs`, `CloudService/src/store/mysql.rs`, `CloudService/src/centrifugo.rs`, `CloudService/src/auth.rs`, `CloudService/src/routes/devices.rs`, `CloudService/src/routes/token.rs`, `CloudService/src/routes/pairing.rs`, `CloudService/src/routes/command.rs` — each with `// filled in by a later task`.

> The placeholder files referenced by `lib.rs`/`routes/mod.rs` (`store`, `centrifugo`, `auth`, the four route handlers) will not satisfy the references in `lib.rs` yet (e.g. `store::DeviceStore`). Therefore **Task 1 builds only after Tasks 2–4 land the referenced items.** To keep Task 1 self-verifying, comment out the four `/v1/*` routes and the `store/centrifugo` fields temporarily is NOT desired. Instead, Task 1's verification is deferred: implement Tasks 2–4, then run Step 8.

- [ ] **Step 8: Verify build (run after Tasks 2–4 are also implemented)**

Run: `cargo build --manifest-path CloudService/Cargo.toml`
Expected: compiles. (If you are doing strict task-by-task TDD, treat Tasks 1–4 as one buildable unit and run this after Task 4.)

- [ ] **Step 9: Commit**

```bash
git add CloudService/Cargo.toml CloudService/src/
git commit -m "feat(cloud): scaffold CloudService crate (config, error, health, router)"
```

---

### Task 2: Crypto helpers (hashing + secret/code generation)

**Files:**
- Modify: `CloudService/src/crypto.rs`

- [ ] **Step 1: Write the module with tests**

```rust
use rand::Rng;
use sha2::{Digest, Sha256};

/// Lowercase hex SHA-256. Used to store/compare high-entropy bearer tokens.
pub fn sha256_hex(input: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(input.as_bytes());
    hex::encode(hasher.finalize())
}

/// A 256-bit random secret as 64 lowercase hex chars (device secrets, phone tokens).
pub fn generate_secret() -> String {
    let bytes: [u8; 32] = rand::thread_rng().gen();
    hex::encode(bytes)
}

/// An 8-char human-friendly pairing code from an unambiguous alphabet
/// (no 0/O/1/I/L). Shown by the desktop as text + QR.
pub fn generate_pairing_code() -> String {
    const ALPHABET: &[u8] = b"23456789ABCDEFGHJKMNPQRSTUVWXYZ";
    let mut rng = rand::thread_rng();
    (0..8).map(|_| ALPHABET[rng.gen_range(0..ALPHABET.len())] as char).collect()
}

/// Unix epoch seconds (UTC). No chrono dependency; avoids tz mapping issues.
pub fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("system clock before epoch")
        .as_secs() as i64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha256_is_deterministic_and_64_hex() {
        let a = sha256_hex("hello");
        assert_eq!(a, sha256_hex("hello"));
        assert_eq!(a.len(), 64);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, sha256_hex("world"));
    }

    #[test]
    fn secret_is_64_hex_and_unique() {
        let a = generate_secret();
        let b = generate_secret();
        assert_eq!(a.len(), 64);
        assert_ne!(a, b);
    }

    #[test]
    fn pairing_code_is_8_chars_from_alphabet() {
        let code = generate_pairing_code();
        assert_eq!(code.len(), 8);
        assert!(code.chars().all(|c| "23456789ABCDEFGHJKMNPQRSTUVWXYZ".contains(c)));
    }
}
```

- [ ] **Step 2: Run the crypto tests**

Run: `cargo test --manifest-path CloudService/Cargo.toml crypto`
Expected: 3 tests pass.

- [ ] **Step 3: Commit**

```bash
git add CloudService/src/crypto.rs
git commit -m "feat(cloud): add crypto helpers (sha256, secret/code generation)"
```

---

### Task 3: Domain types, store traits, and in-memory fakes

**Files:**
- Modify: `CloudService/src/store/mod.rs`

- [ ] **Step 1: Write the module (types + traits + fakes + tests)**

```rust
pub mod mysql;

use async_trait::async_trait;
use std::collections::HashMap;
use std::sync::Mutex;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Device {
    pub id: String,
    pub device_secret_hash: String,
    pub label: Option<String>,
    pub created_at: i64,
    pub last_seen_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PhoneToken {
    pub id: String,
    pub device_id: String,
    pub token_hash: String,
    pub created_at: i64,
    pub last_used_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PairingCode {
    pub code_hash: String,
    pub device_id: String,
    pub expires_at: i64,
    pub created_at: i64,
}

#[async_trait]
pub trait DeviceStore: Send + Sync {
    async fn create(&self, device: &Device) -> anyhow::Result<()>;
    async fn find_by_secret_hash(&self, hash: &str) -> anyhow::Result<Option<Device>>;
    async fn touch_last_seen(&self, id: &str, now: i64) -> anyhow::Result<()>;
    /// Readiness probe — a trivial round-trip to the backing store.
    async fn ping(&self) -> anyhow::Result<()>;
}

#[async_trait]
pub trait PhoneTokenStore: Send + Sync {
    async fn create(&self, token: &PhoneToken) -> anyhow::Result<()>;
    async fn find_by_hash(&self, hash: &str) -> anyhow::Result<Option<PhoneToken>>;
}

#[async_trait]
pub trait PairingStore: Send + Sync {
    async fn create(&self, code: &PairingCode) -> anyhow::Result<()>;
    /// Single-use redeem: if a non-expired code exists, delete and return it.
    async fn take(&self, code_hash: &str, now: i64) -> anyhow::Result<Option<PairingCode>>;
}

// ---- In-memory fakes (used by tests) ----

#[derive(Default)]
pub struct InMemoryDevices(Mutex<Vec<Device>>);
#[derive(Default)]
pub struct InMemoryPhones(Mutex<Vec<PhoneToken>>);
#[derive(Default)]
pub struct InMemoryPairing(Mutex<HashMap<String, PairingCode>>);

#[async_trait]
impl DeviceStore for InMemoryDevices {
    async fn create(&self, device: &Device) -> anyhow::Result<()> {
        self.0.lock().unwrap().push(device.clone());
        Ok(())
    }
    async fn find_by_secret_hash(&self, hash: &str) -> anyhow::Result<Option<Device>> {
        Ok(self.0.lock().unwrap().iter().find(|d| d.device_secret_hash == hash).cloned())
    }
    async fn touch_last_seen(&self, id: &str, now: i64) -> anyhow::Result<()> {
        if let Some(d) = self.0.lock().unwrap().iter_mut().find(|d| d.id == id) {
            d.last_seen_at = Some(now);
        }
        Ok(())
    }
    async fn ping(&self) -> anyhow::Result<()> {
        Ok(())
    }
}

#[async_trait]
impl PhoneTokenStore for InMemoryPhones {
    async fn create(&self, token: &PhoneToken) -> anyhow::Result<()> {
        self.0.lock().unwrap().push(token.clone());
        Ok(())
    }
    async fn find_by_hash(&self, hash: &str) -> anyhow::Result<Option<PhoneToken>> {
        Ok(self.0.lock().unwrap().iter().find(|t| t.token_hash == hash).cloned())
    }
}

#[async_trait]
impl PairingStore for InMemoryPairing {
    async fn create(&self, code: &PairingCode) -> anyhow::Result<()> {
        self.0.lock().unwrap().insert(code.code_hash.clone(), code.clone());
        Ok(())
    }
    async fn take(&self, code_hash: &str, now: i64) -> anyhow::Result<Option<PairingCode>> {
        let mut map = self.0.lock().unwrap();
        match map.get(code_hash).cloned() {
            Some(code) if code.expires_at > now => {
                map.remove(code_hash);
                Ok(Some(code))
            }
            Some(_) => {
                map.remove(code_hash); // expired — clean up, treat as absent
                Ok(None)
            }
            None => Ok(None),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn device_round_trips_by_secret_hash() {
        let store = InMemoryDevices::default();
        let d = Device {
            id: "dev-1".into(),
            device_secret_hash: "abc".into(),
            label: None,
            created_at: 100,
            last_seen_at: None,
        };
        store.create(&d).await.unwrap();
        assert_eq!(store.find_by_secret_hash("abc").await.unwrap(), Some(d));
        assert_eq!(store.find_by_secret_hash("nope").await.unwrap(), None);
    }

    #[tokio::test]
    async fn pairing_take_is_single_use_and_expiry_aware() {
        let store = InMemoryPairing::default();
        let code = PairingCode { code_hash: "h".into(), device_id: "dev-1".into(), expires_at: 200, created_at: 100 };
        store.create(&code).await.unwrap();
        // expired (now >= expires_at) → None
        assert_eq!(store.take("h", 200).await.unwrap(), None);

        let code2 = PairingCode { code_hash: "h2".into(), device_id: "dev-1".into(), expires_at: 200, created_at: 100 };
        store.create(&code2).await.unwrap();
        assert_eq!(store.take("h2", 150).await.unwrap(), Some(code2)); // valid
        assert_eq!(store.take("h2", 150).await.unwrap(), None);        // single-use
    }
}
```

- [ ] **Step 2: Run the store tests**

Run: `cargo test --manifest-path CloudService/Cargo.toml store::tests`
Expected: 2 tests pass.

- [ ] **Step 3: Commit**

```bash
git add CloudService/src/store/mod.rs
git commit -m "feat(cloud): add domain types, store traits, and in-memory fakes"
```

---

### Task 4: Centrifugo server-API client (trait + reqwest impl + fake)

**Files:**
- Modify: `CloudService/src/centrifugo.rs`

- [ ] **Step 1: Write the module**

```rust
use async_trait::async_trait;
use serde_json::{json, Value};
use std::sync::Mutex;

/// The Centrifugo server-side operations CloudService needs: publish a command
/// and check whether the target desktop is connected (presence).
#[async_trait]
pub trait CentrifugoApi: Send + Sync {
    async fn publish(&self, channel: &str, data: Value) -> anyhow::Result<()>;
    /// Number of connected clients on a channel (0 ⇒ desktop offline).
    async fn presence_count(&self, channel: &str) -> anyhow::Result<u64>;
}

/// Real client against the Centrifugo HTTP server API (in-cluster).
pub struct HttpCentrifugo {
    client: reqwest::Client,
    api_url: String,
    api_key: String,
}

impl HttpCentrifugo {
    pub fn new(api_url: String, api_key: String) -> Self {
        Self { client: reqwest::Client::new(), api_url, api_key }
    }

    async fn call(&self, method: &str, params: Value) -> anyhow::Result<Value> {
        let url = format!("{}/api", self.api_url.trim_end_matches('/'));
        let resp = self
            .client
            .post(&url)
            .header("X-API-Key", &self.api_key)
            .json(&json!({ "method": method, "params": params }))
            .send()
            .await?
            .error_for_status()?;
        let body: Value = resp.json().await?;
        if let Some(err) = body.get("error") {
            anyhow::bail!("centrifugo {method} error: {err}");
        }
        Ok(body.get("result").cloned().unwrap_or(Value::Null))
    }
}

#[async_trait]
impl CentrifugoApi for HttpCentrifugo {
    async fn publish(&self, channel: &str, data: Value) -> anyhow::Result<()> {
        self.call("publish", json!({ "channel": channel, "data": data })).await?;
        Ok(())
    }
    async fn presence_count(&self, channel: &str) -> anyhow::Result<u64> {
        let result = self.call("presence_stats", json!({ "channel": channel })).await?;
        Ok(result.get("num_clients").and_then(Value::as_u64).unwrap_or(0))
    }
}

/// Fake recording published messages; presence is configurable per test.
pub struct FakeCentrifugo {
    pub published: Mutex<Vec<(String, Value)>>,
    pub present: Mutex<u64>,
}

impl Default for FakeCentrifugo {
    fn default() -> Self {
        Self { published: Mutex::new(Vec::new()), present: Mutex::new(1) }
    }
}

#[async_trait]
impl CentrifugoApi for FakeCentrifugo {
    async fn publish(&self, channel: &str, data: Value) -> anyhow::Result<()> {
        self.published.lock().unwrap().push((channel.to_string(), data));
        Ok(())
    }
    async fn presence_count(&self, _channel: &str) -> anyhow::Result<u64> {
        Ok(*self.present.lock().unwrap())
    }
}
```

- [ ] **Step 2: Verify it compiles (no DB/network needed)**

Run: `cargo build --manifest-path CloudService/Cargo.toml`
Expected: compiles. (At this point `lib.rs`'s references to `store::*` and `centrifugo::*` resolve; route handlers are still placeholders, so the `app()` route registrations referencing `routes::devices::register` etc. will fail until Task 6+. If so, this build is deferred to Task 6 Step verification — proceed to Task 5.)

- [ ] **Step 3: Commit**

```bash
git add CloudService/src/centrifugo.rs
git commit -m "feat(cloud): add Centrifugo server-API client (publish + presence) with fake"
```

---

### Task 5: sqlx MariaDB store impls + migrations + `build_state`

**Files:**
- Modify: `CloudService/src/store/mysql.rs`, `CloudService/src/lib.rs`
- Create: `CloudService/migrations/0001_init.sql`

- [ ] **Step 1: Write `CloudService/migrations/0001_init.sql`**

```sql
CREATE TABLE devices (
    id                  CHAR(36)     NOT NULL,
    device_secret_hash  CHAR(64)     NOT NULL,
    label               VARCHAR(128) NULL,
    created_at          BIGINT       NOT NULL,
    last_seen_at        BIGINT       NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_devices_secret_hash (device_secret_hash)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE phone_tokens (
    id            CHAR(36)     NOT NULL,
    device_id     CHAR(36)     NOT NULL,
    token_hash    CHAR(64)     NOT NULL,
    created_at    BIGINT       NOT NULL,
    last_used_at  BIGINT       NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_phone_token_hash (token_hash),
    KEY idx_phone_device (device_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE pairing_codes (
    code_hash   CHAR(64) NOT NULL,
    device_id   CHAR(36) NOT NULL,
    expires_at  BIGINT   NOT NULL,
    created_at  BIGINT   NOT NULL,
    PRIMARY KEY (code_hash)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

- [ ] **Step 2: Write `CloudService/src/store/mysql.rs`**

```rust
use super::{Device, DeviceStore, PairingCode, PairingStore, PhoneToken, PhoneTokenStore};
use async_trait::async_trait;
use sqlx::{MySql, Pool, Row};

/// sqlx-backed store. One struct implements all three traits over a shared pool.
#[derive(Clone)]
pub struct MysqlStore {
    pool: Pool<MySql>,
}

impl MysqlStore {
    pub fn new(pool: Pool<MySql>) -> Self {
        Self { pool }
    }
}

#[async_trait]
impl DeviceStore for MysqlStore {
    async fn create(&self, d: &Device) -> anyhow::Result<()> {
        sqlx::query(
            "INSERT INTO devices (id, device_secret_hash, label, created_at, last_seen_at) \
             VALUES (?, ?, ?, ?, ?)",
        )
        .bind(&d.id)
        .bind(&d.device_secret_hash)
        .bind(&d.label)
        .bind(d.created_at)
        .bind(d.last_seen_at)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    async fn find_by_secret_hash(&self, hash: &str) -> anyhow::Result<Option<Device>> {
        let row = sqlx::query(
            "SELECT id, device_secret_hash, label, created_at, last_seen_at \
             FROM devices WHERE device_secret_hash = ?",
        )
        .bind(hash)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.map(|r| Device {
            id: r.get("id"),
            device_secret_hash: r.get("device_secret_hash"),
            label: r.get("label"),
            created_at: r.get("created_at"),
            last_seen_at: r.get("last_seen_at"),
        }))
    }

    async fn touch_last_seen(&self, id: &str, now: i64) -> anyhow::Result<()> {
        sqlx::query("UPDATE devices SET last_seen_at = ? WHERE id = ?")
            .bind(now)
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    async fn ping(&self) -> anyhow::Result<()> {
        sqlx::query("SELECT 1").execute(&self.pool).await?;
        Ok(())
    }
}

#[async_trait]
impl PhoneTokenStore for MysqlStore {
    async fn create(&self, t: &PhoneToken) -> anyhow::Result<()> {
        sqlx::query(
            "INSERT INTO phone_tokens (id, device_id, token_hash, created_at, last_used_at) \
             VALUES (?, ?, ?, ?, ?)",
        )
        .bind(&t.id)
        .bind(&t.device_id)
        .bind(&t.token_hash)
        .bind(t.created_at)
        .bind(t.last_used_at)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    async fn find_by_hash(&self, hash: &str) -> anyhow::Result<Option<PhoneToken>> {
        let row = sqlx::query(
            "SELECT id, device_id, token_hash, created_at, last_used_at \
             FROM phone_tokens WHERE token_hash = ?",
        )
        .bind(hash)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.map(|r| PhoneToken {
            id: r.get("id"),
            device_id: r.get("device_id"),
            token_hash: r.get("token_hash"),
            created_at: r.get("created_at"),
            last_used_at: r.get("last_used_at"),
        }))
    }
}

#[async_trait]
impl PairingStore for MysqlStore {
    async fn create(&self, c: &PairingCode) -> anyhow::Result<()> {
        sqlx::query(
            "INSERT INTO pairing_codes (code_hash, device_id, expires_at, created_at) \
             VALUES (?, ?, ?, ?)",
        )
        .bind(&c.code_hash)
        .bind(&c.device_id)
        .bind(c.expires_at)
        .bind(c.created_at)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    async fn take(&self, code_hash: &str, now: i64) -> anyhow::Result<Option<PairingCode>> {
        let mut tx = self.pool.begin().await?;
        let row = sqlx::query(
            "SELECT code_hash, device_id, expires_at, created_at \
             FROM pairing_codes WHERE code_hash = ? FOR UPDATE",
        )
        .bind(code_hash)
        .fetch_optional(&mut *tx)
        .await?;

        let result = match row {
            Some(r) => {
                let code = PairingCode {
                    code_hash: r.get("code_hash"),
                    device_id: r.get("device_id"),
                    expires_at: r.get("expires_at"),
                    created_at: r.get("created_at"),
                };
                // Always delete (single-use); return only if still valid.
                sqlx::query("DELETE FROM pairing_codes WHERE code_hash = ?")
                    .bind(code_hash)
                    .execute(&mut *tx)
                    .await?;
                if code.expires_at > now { Some(code) } else { None }
            }
            None => None,
        };
        tx.commit().await?;
        Ok(result)
    }
}
```

- [ ] **Step 3: Implement `build_state` in `CloudService/src/lib.rs`**

Replace the temporary `build_state` stub from Task 1 with:

```rust
/// Wire production dependencies (sqlx pool + Centrifugo HTTP client), running
/// pending migrations before serving.
pub async fn build_state(config: config::Config) -> anyhow::Result<AppState> {
    use sqlx::mysql::MySqlPoolOptions;
    let pool = MySqlPoolOptions::new()
        .max_connections(10)
        .acquire_timeout(std::time::Duration::from_secs(10))
        .connect(&config.database_url)
        .await?;
    sqlx::migrate!("./migrations").run(&pool).await?;

    let store = Arc::new(store::mysql::MysqlStore::new(pool));
    let centrifugo = Arc::new(centrifugo::HttpCentrifugo::new(
        config.centrifugo_api_url.clone(),
        config.centrifugo_api_key.clone(),
    ));
    Ok(AppState {
        devices: store.clone(),
        phones: store.clone(),
        pairing: store,
        centrifugo,
        config: Arc::new(config),
    })
}
```

- [ ] **Step 4: Write an `#[ignore]`d integration test for the MariaDB impl**

Append to `CloudService/src/store/mysql.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::{Device, PairingCode};

    /// Needs a live MariaDB. Run with:
    ///   TEST_DATABASE_URL=mysql://user:pass@127.0.0.1/cloudservice_test \
    ///   cargo test --manifest-path CloudService/Cargo.toml mysql -- --ignored --nocapture
    #[tokio::test]
    #[ignore]
    async fn device_and_pairing_round_trip_against_mariadb() {
        let url = std::env::var("TEST_DATABASE_URL").expect("set TEST_DATABASE_URL");
        let pool = sqlx::mysql::MySqlPool::connect(&url).await.unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        let store = MysqlStore::new(pool);

        let d = Device {
            id: format!("dev-{}", crate::crypto::generate_secret()),
            device_secret_hash: crate::crypto::sha256_hex("secret-x"),
            label: Some("test".into()),
            created_at: 1000,
            last_seen_at: None,
        };
        store.create(&d).await.unwrap();
        let found = store.find_by_secret_hash(&d.device_secret_hash).await.unwrap();
        assert_eq!(found.as_ref().map(|x| &x.id), Some(&d.id));

        let code = PairingCode {
            code_hash: crate::crypto::sha256_hex(&crate::crypto::generate_pairing_code()),
            device_id: d.id.clone(),
            expires_at: 9_999_999_999,
            created_at: 1000,
        };
        store.create(&code).await.unwrap();
        assert!(store.take(&code.code_hash, 1001).await.unwrap().is_some());
        assert!(store.take(&code.code_hash, 1001).await.unwrap().is_none()); // single-use
    }
}
```

- [ ] **Step 5: Verify compilation**

Run: `cargo build --manifest-path CloudService/Cargo.toml`
Expected: compiles (route handlers still placeholders — full `app()` wiring verifies in Task 10).

- [ ] **Step 6: Commit**

```bash
git add CloudService/src/store/mysql.rs CloudService/src/lib.rs CloudService/migrations/
git commit -m "feat(cloud): add sqlx MariaDB store impls, migrations, and build_state"
```

---

### Task 6: Auth extractors (`Principal`, `DeviceAuth`, `PhoneAuth`)

**Files:**
- Modify: `CloudService/src/auth.rs`

- [ ] **Step 1: Write the module**

```rust
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
```

- [ ] **Step 2: Commit (build verified in Task 10 once handlers exist)**

```bash
git add CloudService/src/auth.rs
git commit -m "feat(cloud): add bearer auth extractors (device, phone, principal)"
```

---

### Task 7: `POST /v1/devices` — registration

**Files:**
- Modify: `CloudService/src/routes/devices.rs`

- [ ] **Step 1: Write the handler**

```rust
use crate::crypto::{generate_secret, now_unix, sha256_hex};
use crate::error::AppResult;
use crate::store::Device;
use crate::AppState;
use axum::extract::State;
use axum::Json;
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisterResponse {
    pub device_id: String,
    pub device_secret: String,
}

/// Unauthenticated first-boot registration. Returns the device's id and the
/// plaintext secret ONCE; only the hash is stored.
pub async fn register(State(state): State<AppState>) -> AppResult<Json<RegisterResponse>> {
    let device_id = uuid::Uuid::new_v4().to_string();
    let device_secret = generate_secret();
    let device = Device {
        id: device_id.clone(),
        device_secret_hash: sha256_hex(&device_secret),
        label: None,
        created_at: now_unix(),
        last_seen_at: None,
    };
    state.devices.create(&device).await?;
    Ok(Json(RegisterResponse { device_id, device_secret }))
}
```

- [ ] **Step 2: Commit**

```bash
git add CloudService/src/routes/devices.rs
git commit -m "feat(cloud): add POST /v1/devices registration handler"
```

---

### Task 8: `POST /v1/token` — Centrifugo JWT minting

**Files:**
- Modify: `CloudService/src/routes/token.rs`

- [ ] **Step 1: Write the handler**

```rust
use crate::auth::Principal;
use crate::crypto::now_unix;
use crate::error::{AppError, AppResult};
use crate::AppState;
use abeon_remote_core::token::mint_connection_token;
use axum::extract::State;
use axum::Json;
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenResponse {
    pub token: String,
    pub expires_in_secs: i64,
}

/// Mint a short-lived Centrifugo connection JWT. Desktops authenticate with their
/// `deviceSecret` (sub = deviceId); phones with their `phoneToken` (sub = phone:<id>).
pub async fn issue(
    State(state): State<AppState>,
    principal: Principal,
) -> AppResult<Json<TokenResponse>> {
    let (sub, touch_device) = match principal {
        Principal::Device(d) => (d.id.clone(), Some(d.id)),
        Principal::Phone(p) => (format!("phone:{}", p.id), None),
    };
    let ttl = state.config.token_ttl_secs;
    let token = mint_connection_token(
        &state.config.centrifugo_token_secret,
        &sub,
        now_unix() as usize,
        ttl as usize,
    )
    .map_err(AppError::Internal)?;

    if let Some(id) = touch_device {
        let _ = state.devices.touch_last_seen(&id, now_unix()).await;
    }
    Ok(Json(TokenResponse { token, expires_in_secs: ttl }))
}
```

- [ ] **Step 2: Commit**

```bash
git add CloudService/src/routes/token.rs
git commit -m "feat(cloud): add POST /v1/token Centrifugo JWT minting"
```

---

### Task 9: `POST /v1/pair/start` and `POST /v1/pair/claim`

**Files:**
- Modify: `CloudService/src/routes/pairing.rs`

- [ ] **Step 1: Write the handlers**

```rust
use crate::auth::DeviceAuth;
use crate::crypto::{generate_pairing_code, generate_secret, now_unix, sha256_hex};
use crate::error::{AppError, AppResult};
use crate::store::{PairingCode, PhoneToken};
use crate::AppState;
use axum::extract::State;
use axum::Json;
use serde::{Deserialize, Serialize};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairStartResponse {
    pub code: String,
    pub expires_in_secs: i64,
}

/// Desktop-authenticated: mint a one-time pairing code bound to this device.
pub async fn start(
    State(state): State<AppState>,
    DeviceAuth(device): DeviceAuth,
) -> AppResult<Json<PairStartResponse>> {
    let code = generate_pairing_code();
    let ttl = state.config.pairing_ttl_secs;
    let now = now_unix();
    let row = PairingCode {
        code_hash: sha256_hex(&code),
        device_id: device.id,
        expires_at: now + ttl,
        created_at: now,
    };
    state.pairing.create(&row).await?;
    Ok(Json(PairStartResponse { code, expires_in_secs: ttl }))
}

#[derive(Deserialize)]
pub struct PairClaimRequest {
    pub code: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairClaimResponse {
    pub phone_token: String,
    pub device_id: String,
}

/// Unauthenticated: redeem a pairing code for a long-lived phone token bound to
/// the code's device. The code is single-use and expiry-checked by the store.
pub async fn claim(
    State(state): State<AppState>,
    Json(req): Json<PairClaimRequest>,
) -> AppResult<Json<PairClaimResponse>> {
    let row = state
        .pairing
        .take(&sha256_hex(&req.code), now_unix())
        .await?
        .ok_or_else(|| AppError::BadRequest("invalid or expired pairing code".into()))?;

    let phone_token = generate_secret();
    let token = PhoneToken {
        id: uuid::Uuid::new_v4().to_string(),
        device_id: row.device_id.clone(),
        token_hash: sha256_hex(&phone_token),
        created_at: now_unix(),
        last_used_at: None,
    };
    state.phones.create(&token).await?;
    Ok(Json(PairClaimResponse { phone_token, device_id: row.device_id }))
}
```

- [ ] **Step 2: Commit**

```bash
git add CloudService/src/routes/pairing.rs
git commit -m "feat(cloud): add POST /v1/pair/start and /v1/pair/claim handlers"
```

---

### Task 10: `POST /v1/command` — authorize, presence-gate, publish

**Files:**
- Modify: `CloudService/src/routes/command.rs`

- [ ] **Step 1: Write the handler**

```rust
use crate::auth::PhoneAuth;
use crate::error::{AppError, AppResult};
use crate::AppState;
use abeon_remote_core::channels::cmd_channel;
use abeon_remote_core::protocol::{RemoteCommand, RemoteEnvelope};
use abeon_remote_core::validation::validate_session_id;
use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;
use serde::Serialize;

#[derive(Serialize)]
pub struct CommandResponse {
    pub published: bool,
}

/// Every `RemoteCommand` variant carries a `session_id`.
fn command_session_id(c: &RemoteCommand) -> &str {
    match c {
        RemoteCommand::SendPrompt { session_id, .. }
        | RemoteCommand::ApprovePermission { session_id }
        | RemoteCommand::DenyPermission { session_id }
        | RemoteCommand::StopSession { session_id }
        | RemoteCommand::ResumeSession { session_id, .. } => session_id,
    }
}

/// Phone-authenticated. Validates the envelope, confirms the paired desktop is
/// online (presence), then publishes to `abeon-cloud-cmd:<deviceId>`.
pub async fn publish(
    State(state): State<AppState>,
    PhoneAuth(phone): PhoneAuth,
    Json(envelope): Json<RemoteEnvelope>,
) -> AppResult<(StatusCode, Json<CommandResponse>)> {
    // Trust boundary: same allowlist the desktop enforces on the session id.
    validate_session_id(command_session_id(&envelope.command))
        .map_err(|e| AppError::BadRequest(e.0))?;

    let channel = cmd_channel(&phone.device_id);

    // Presence gate: do not publish into the void.
    let present = state
        .centrifugo
        .presence_count(&channel)
        .await
        .map_err(|e| AppError::Upstream(e.to_string()))?;
    if present == 0 {
        return Err(AppError::Conflict("desktop offline".into()));
    }

    let data = serde_json::to_value(&envelope).map_err(|e| AppError::Internal(e.into()))?;
    state
        .centrifugo
        .publish(&channel, data)
        .await
        .map_err(|e| AppError::Upstream(e.to_string()))?;

    Ok((StatusCode::ACCEPTED, Json(CommandResponse { published: true })))
}
```

- [ ] **Step 2: Build the whole crate (all handlers now exist)**

Run: `cargo build --manifest-path CloudService/Cargo.toml`
Expected: compiles with no errors. `app()` route registrations now resolve.

- [ ] **Step 3: Commit**

```bash
git add CloudService/src/routes/command.rs
git commit -m "feat(cloud): add POST /v1/command with validation, presence gate, publish"
```

---

### Task 11: Integration tests (full flows via `oneshot` + fakes)

**Files:**
- Create: `CloudService/tests/api.rs`

- [ ] **Step 1: Write the test harness + tests**

```rust
use axum::body::Body;
use axum::http::{Request, StatusCode};
use cloudservice::centrifugo::FakeCentrifugo;
use cloudservice::config::Config;
use cloudservice::store::{InMemoryDevices, InMemoryPairing, InMemoryPhones};
use cloudservice::{app, AppState};
use serde_json::{json, Value};
use std::sync::Arc;
use tower::ServiceExt; // for `oneshot`

fn test_state(centrifugo: Arc<FakeCentrifugo>) -> AppState {
    AppState {
        devices: Arc::new(InMemoryDevices::default()),
        phones: Arc::new(InMemoryPhones::default()),
        pairing: Arc::new(InMemoryPairing::default()),
        centrifugo,
        config: Arc::new(Config {
            bind_addr: "0.0.0.0:0".into(),
            database_url: "unused".into(),
            centrifugo_token_secret: "test-secret".into(),
            centrifugo_api_key: "test-key".into(),
            centrifugo_api_url: "http://unused".into(),
            token_ttl_secs: 3600,
            pairing_ttl_secs: 300,
        }),
    }
}

async fn json_request(
    state: AppState,
    method: &str,
    uri: &str,
    bearer: Option<&str>,
    body: Value,
) -> (StatusCode, Value) {
    let mut builder = Request::builder().method(method).uri(uri).header("content-type", "application/json");
    if let Some(b) = bearer {
        builder = builder.header("authorization", format!("Bearer {b}"));
    }
    let req = builder.body(Body::from(serde_json::to_vec(&body).unwrap())).unwrap();
    let resp = app(state).oneshot(req).await.unwrap();
    let status = resp.status();
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
    let value: Value = if bytes.is_empty() { Value::Null } else { serde_json::from_slice(&bytes).unwrap() };
    (status, value)
}

#[tokio::test]
async fn full_pairing_and_command_flow() {
    let centrifugo = Arc::new(FakeCentrifugo::default()); // present = 1 by default
    let state = test_state(centrifugo.clone());

    // 1. Desktop registers.
    let (s, body) = json_request(state.clone(), "POST", "/v1/devices", None, json!({})).await;
    assert_eq!(s, StatusCode::OK);
    let device_secret = body["deviceSecret"].as_str().unwrap().to_string();
    let device_id = body["deviceId"].as_str().unwrap().to_string();

    // 2. Desktop starts pairing.
    let (s, body) = json_request(state.clone(), "POST", "/v1/pair/start", Some(&device_secret), json!({})).await;
    assert_eq!(s, StatusCode::OK);
    let code = body["code"].as_str().unwrap().to_string();

    // 3. Phone claims the code.
    let (s, body) = json_request(state.clone(), "POST", "/v1/pair/claim", None, json!({ "code": code })).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(body["deviceId"], device_id);
    let phone_token = body["phoneToken"].as_str().unwrap().to_string();

    // 4. Phone sends a command → published to the device's cmd channel.
    let env = json!({
        "commandId": "c1",
        "command": { "type": "sendPrompt", "sessionId": "550e8400-e29b-41d4-a716-446655440000", "text": "hi" }
    });
    let (s, body) = json_request(state.clone(), "POST", "/v1/command", Some(&phone_token), env).await;
    assert_eq!(s, StatusCode::ACCEPTED);
    assert_eq!(body["published"], true);

    let published = centrifugo.published.lock().unwrap();
    assert_eq!(published.len(), 1);
    assert_eq!(published[0].0, format!("abeon-cloud-cmd:{device_id}"));
    assert_eq!(published[0].1["commandId"], "c1");
}

#[tokio::test]
async fn command_without_auth_is_unauthorized() {
    let state = test_state(Arc::new(FakeCentrifugo::default()));
    let env = json!({ "commandId": "c1", "command": { "type": "stopSession", "sessionId": "s1" } });
    let (s, _) = json_request(state, "POST", "/v1/command", None, env).await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn command_rejects_invalid_session_id() {
    let centrifugo = Arc::new(FakeCentrifugo::default());
    let state = test_state(centrifugo.clone());
    let (_, body) = json_request(state.clone(), "POST", "/v1/devices", None, json!({})).await;
    let device_secret = body["deviceSecret"].as_str().unwrap().to_string();
    let (_, body) = json_request(state.clone(), "POST", "/v1/pair/start", Some(&device_secret), json!({})).await;
    let code = body["code"].as_str().unwrap().to_string();
    let (_, body) = json_request(state.clone(), "POST", "/v1/pair/claim", None, json!({ "code": code })).await;
    let phone_token = body["phoneToken"].as_str().unwrap().to_string();

    let env = json!({ "commandId": "c1", "command": { "type": "stopSession", "sessionId": "../etc/passwd" } });
    let (s, _) = json_request(state, "POST", "/v1/command", Some(&phone_token), env).await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
    assert!(centrifugo.published.lock().unwrap().is_empty());
}

#[tokio::test]
async fn command_when_desktop_offline_is_conflict() {
    let centrifugo = Arc::new(FakeCentrifugo::default());
    *centrifugo.present.lock().unwrap() = 0; // desktop not connected
    let state = test_state(centrifugo.clone());
    let (_, body) = json_request(state.clone(), "POST", "/v1/devices", None, json!({})).await;
    let device_secret = body["deviceSecret"].as_str().unwrap().to_string();
    let (_, body) = json_request(state.clone(), "POST", "/v1/pair/start", Some(&device_secret), json!({})).await;
    let code = body["code"].as_str().unwrap().to_string();
    let (_, body) = json_request(state.clone(), "POST", "/v1/pair/claim", None, json!({ "code": code })).await;
    let phone_token = body["phoneToken"].as_str().unwrap().to_string();

    let env = json!({ "commandId": "c1", "command": { "type": "stopSession", "sessionId": "s1" } });
    let (s, _) = json_request(state, "POST", "/v1/command", Some(&phone_token), env).await;
    assert_eq!(s, StatusCode::CONFLICT);
    assert!(centrifugo.published.lock().unwrap().is_empty());
}

#[tokio::test]
async fn expired_or_unknown_code_is_bad_request() {
    let state = test_state(Arc::new(FakeCentrifugo::default()));
    let (s, _) = json_request(state, "POST", "/v1/pair/claim", None, json!({ "code": "ZZZZZZZZ" })).await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
}
```

- [ ] **Step 2: Run the full test suite**

Run: `cargo test --manifest-path CloudService/Cargo.toml`
Expected: all unit tests + 5 integration tests pass; the `#[ignore]`d MariaDB test is skipped.

- [ ] **Step 3: Commit**

```bash
git add CloudService/tests/api.rs
git commit -m "test(cloud): integration tests for pairing, auth, validation, presence flows"
```

---

### Task 12: Dockerfile (multi-stage distroless)

**Files:**
- Create: `CloudService/Dockerfile`, `CloudService/.dockerignore`

- [ ] **Step 1: Write `CloudService/.dockerignore`**

```
target
**/target
.git
```

- [ ] **Step 2: Write `CloudService/Dockerfile`**

The build context must be the **repo root** (the crate depends on `../crates/abeon-remote-core` by path).

```dockerfile
# Build context = repo root.  docker build -f CloudService/Dockerfile .
FROM rust:1-bookworm AS builder
WORKDIR /build
COPY crates/ crates/
COPY CloudService/ CloudService/
RUN cargo build --release --manifest-path CloudService/Cargo.toml

FROM gcr.io/distroless/cc-debian12 AS runtime
WORKDIR /app
COPY --from=builder /build/CloudService/target/release/cloudservice /app/cloudservice
# migrations are embedded at compile time via sqlx::migrate!; no runtime copy needed.
USER nonroot:nonroot
ENV BIND_ADDR=0.0.0.0:8080
EXPOSE 8080
ENTRYPOINT ["/app/cloudservice"]
```

- [ ] **Step 3: Verify the image builds**

Run (from repo root): `docker build -f CloudService/Dockerfile -t cloudservice:dev .`
Expected: build succeeds; final stage is distroless. (If Docker is unavailable in the execution environment, skip the build but commit the files; the CI/cluster will build it.)

- [ ] **Step 4: Commit**

```bash
git add CloudService/Dockerfile CloudService/.dockerignore
git commit -m "feat(cloud): add multi-stage distroless Dockerfile"
```

---

### Task 13: k8s manifests

**Files:**
- Create: `CloudService/k8s/{deployment,service,ingress}.yaml`

These are authored here for review and applied in the separate k8s repo. Namespace `cs-app-cust1004-tools` (next to Centrifugo). Secrets `cloudservice-secrets` (keys `DATABASE_URL`, `CENTRIFUGO_TOKEN_SECRET`, `CENTRIFUGO_API_KEY`) and ConfigMap `cloudservice-config` (`CENTRIFUGO_API_URL`) are created out-of-band.

- [ ] **Step 1: Write `CloudService/k8s/deployment.yaml`**

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: cloudservice
  namespace: cs-app-cust1004-tools
  labels:
    app: cloudservice
spec:
  replicas: 2
  strategy:
    type: RollingUpdate
  selector:
    matchLabels:
      app: cloudservice
  template:
    metadata:
      labels:
        app: cloudservice
    spec:
      containers:
        - name: cloudservice
          image: cloudservice:dev # replaced by CI with the pushed tag
          ports:
            - containerPort: 8080
          env:
            - name: BIND_ADDR
              value: "0.0.0.0:8080"
            - name: CENTRIFUGO_API_URL
              valueFrom:
                configMapKeyRef:
                  name: cloudservice-config
                  key: CENTRIFUGO_API_URL
            - name: DATABASE_URL
              valueFrom:
                secretKeyRef:
                  name: cloudservice-secrets
                  key: DATABASE_URL
            - name: CENTRIFUGO_TOKEN_SECRET
              valueFrom:
                secretKeyRef:
                  name: cloudservice-secrets
                  key: CENTRIFUGO_TOKEN_SECRET
            - name: CENTRIFUGO_API_KEY
              valueFrom:
                secretKeyRef:
                  name: cloudservice-secrets
                  key: CENTRIFUGO_API_KEY
          livenessProbe:
            httpGet:
              path: /healthz
              port: 8080
            initialDelaySeconds: 3
            periodSeconds: 10
          readinessProbe:
            httpGet:
              path: /readyz
              port: 8080
            initialDelaySeconds: 3
            periodSeconds: 10
          resources:
            requests:
              cpu: "50m"
              memory: "32Mi"
            limits:
              cpu: "500m"
              memory: "128Mi"
```

- [ ] **Step 2: Write `CloudService/k8s/service.yaml`**

```yaml
apiVersion: v1
kind: Service
metadata:
  name: cloudservice
  namespace: cs-app-cust1004-tools
  labels:
    app: cloudservice
spec:
  selector:
    app: cloudservice
  ports:
    - name: http
      port: 80
      targetPort: 8080
  type: ClusterIP
```

- [ ] **Step 3: Write `CloudService/k8s/ingress.yaml`**

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: cloudservice
  namespace: cs-app-cust1004-tools
  annotations:
    # TLS/issuer annotations follow the cluster's existing convention — align
    # with the Centrifugo ingress in the k8s repo before applying.
    cert-manager.io/cluster-issuer: letsencrypt-prod
spec:
  ingressClassName: nginx
  tls:
    - hosts:
        - cloud.k8s.abeon.app
      secretName: cloudservice-tls
  rules:
    - host: cloud.k8s.abeon.app
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: cloudservice
                port:
                  number: 80
```

- [ ] **Step 4: Commit**

```bash
git add CloudService/k8s/
git commit -m "feat(cloud): add k8s Deployment, Service, and Ingress manifests"
```

---

### Task 14: README + run/test docs

**Files:**
- Modify: `CloudService/README.md`

- [ ] **Step 1: Replace the README body with status + run/test instructions**

```markdown
# CloudService

Auth/pairing + command-authorization microservice for AbeonCloud. Mints Centrifugo
JWTs, pairs phones to desktops, and is the single server-side checkpoint that
publishes authorized commands to `abeon-cloud-cmd:<deviceId>`.

See the design: `../docs/superpowers/specs/2026-05-30-abeoncloud-cloudservice-design.md`.

## Endpoints

| Method | Path             | Auth            | Purpose                                  |
|--------|------------------|-----------------|------------------------------------------|
| POST   | `/v1/devices`    | none            | Desktop first-boot registration          |
| POST   | `/v1/token`      | device or phone | Mint a short-lived Centrifugo connection JWT |
| POST   | `/v1/pair/start` | device          | Mint a one-time pairing code (QR)        |
| POST   | `/v1/pair/claim` | none            | Phone redeems a code → phone token       |
| POST   | `/v1/command`    | phone           | Validate + presence-gate + publish a command |
| GET    | `/healthz`       | none            | Liveness                                 |
| GET    | `/readyz`        | none            | Readiness (DB ping)                      |

## Configuration (env)

| Var | Required | Default | Notes |
|-----|----------|---------|-------|
| `DATABASE_URL` | yes | — | MariaDB DSN `mysql://user:pass@host/db` |
| `CENTRIFUGO_TOKEN_SECRET` | yes | — | HS256 secret for minting JWTs |
| `CENTRIFUGO_API_KEY` | yes | — | Centrifugo server-API key |
| `CENTRIFUGO_API_URL` | yes | — | In-cluster Centrifugo HTTP base, e.g. `http://centrifugo-websocket.cs-app-cust1004-tools:8000` |
| `BIND_ADDR` | no | `0.0.0.0:8080` | listen address |
| `TOKEN_TTL_SECS` | no | `3600` | JWT lifetime |
| `PAIRING_TTL_SECS` | no | `300` | pairing-code lifetime |

## Develop / test

```bash
cargo build  --manifest-path CloudService/Cargo.toml
cargo test   --manifest-path CloudService/Cargo.toml          # unit + integration (fakes; no DB/network)

# MariaDB-backed store test (needs a live DB):
TEST_DATABASE_URL=mysql://user:pass@127.0.0.1/cloudservice_test \
  cargo test --manifest-path CloudService/Cargo.toml mysql -- --ignored --nocapture
```

## Docker

```bash
# build context is the repo root (path-dependency on ../crates/abeon-remote-core)
docker build -f CloudService/Dockerfile -t cloudservice:dev .
```
```

- [ ] **Step 2: Commit**

```bash
git add CloudService/README.md
git commit -m "docs(cloud): document endpoints, config, and run/test instructions"
```

---

## Self-Review

**Spec coverage (against the CloudService design):**
- HTTP API (`/v1/devices`, `/token`, `/pair/start`, `/pair/claim`, `/command`, `/healthz`, `/readyz`) → Tasks 1, 7–11. ✓
- Opaque bearer creds hashed at rest (SHA-256), constant work via hash lookup → Tasks 2, 6. ✓
- Centrifugo connection JWT, `sub=deviceId` / `sub=phone:<id>` → Task 8. ✓
- Command authz: phone bound to device, envelope validated via shared crate, publish to `abeon-cloud-cmd:<deviceId>` → Task 10. ✓
- Presence gate → 409 when offline → Task 10 + test in Task 11. ✓
- Pairing: 8-char single-use code, TTL, hashed, bound to device → Tasks 2, 9; single-use enforced in store (Task 3/5). ✓
- MariaDB via sqlx, stateless, BIGINT timestamps → Tasks 3, 5. ✓
- Server reaches Centrifugo over in-cluster HTTP with `X-API-Key` → Task 4. ✓
- Error mapping (401/400/409/502/503) → Task 1 (`AppError`) + handlers. ✓
- Distroless Docker + k8s Deployment/Service/Ingress + readiness → Tasks 12, 13. ✓

**Placeholder scan:** Every file is shown in full. The only deliberate "filled by a later task" markers are empty module stubs in Task 1 Step 7, each replaced by a named later task. No vague "add validation"/"handle errors". ✓

**Type consistency:**
- `AppState` fields (`devices`/`phones`/`pairing`/`centrifugo`/`config`) defined in Task 1 are used identically in Tasks 6–11 and the test harness (Task 11). ✓
- Store trait method names (`create`, `find_by_secret_hash`, `touch_last_seen`, `ping`, `find_by_hash`, `take`) defined in Task 3 match the sqlx impl (Task 5), the fakes (Task 3), and all call sites (Tasks 6–10). ✓
- `CentrifugoApi::{publish, presence_count}` defined in Task 4, called in Task 10, faked/asserted in Task 11. ✓
- Response field casing: handlers use `#[serde(rename_all = "camelCase")]`, so tests read `deviceId`/`deviceSecret`/`phoneToken`/`code`/`published` — consistent (Tasks 7–11). ✓
- `AppError::BadRequest(e.0)` in Task 10 consumes `ValidationError`'s `.0` (defined in Plan 1 Task 2). ✓

**Build-ordering note for the executor:** `lib.rs` (Task 1) references items created in Tasks 2–6 and route handlers from Tasks 7–10, so a clean `cargo build` first succeeds at **Task 10 Step 2**. Earlier per-task "verify" steps that depend on later items say so inline. If executing strictly task-by-task with a subagent, treat Tasks 1–10 as a single buildable unit and run the build at the end of Task 10; run the isolated unit tests (crypto in Task 2, store in Task 3) as written since those modules compile independently.
```
