# CloudService Plan 3 — Desktop integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the desktop to CloudService — register on boot, fetch its Centrifugo token from `/v1/token` instead of self-minting, and add a pairing dialog (one-time code + QR) so a phone can pair.

**Architecture:** A new async `reqwest` client `remote/cloud_client.rs` talks to CloudService. `startup.rs` gains a CloudService path: when `cloudServiceUrl` is set it registers (once, persisting `remoteDeviceId`/`remoteDeviceSecret`) and fetches a connection token; with no URL it keeps the existing self-mint path (now legacy/test-only). A `remote_pair_start` Tauri command backs a `PairingDialog.tsx` that renders the code as text + QR. The three AbeonCloud settings (`remoteBridgeEnabled`, `allowRemoteSpawn`, `cloudServiceUrl`) are surfaced in `SettingsDialog`.

**Tech Stack:** Rust (Tauri 2, reqwest 0.12 rustls, wiremock for tests), React 19 + Zustand, `qrcode.react`.

---

## Prerequisites

- **Plan 1 merged** (`abeon-remote-core`). **Plan 2 merged** (CloudService running, or at least its API shape fixed). Pairing end-to-end needs a reachable CloudService, but all code here is unit/mock-tested without one.
- Read `DesktopApp/CLAUDE.md` first (xterm/PTY/ts-rs/settings-persistence gotchas).

## Context the implementer needs

- **Settings persistence is two-tier** (`DesktopApp/CLAUDE.md`): localStorage + SQLite via `settings_repo`. Backend-only keys (`remoteDeviceId`, `remoteDeviceSecret`) are written directly through `settings_repo` and are NOT in the frontend `PERSISTED_KEYS`. User-facing keys (`remoteBridgeEnabled`, `allowRemoteSpawn`, `cloudServiceUrl`) ARE added to the store + `PERSISTED_KEYS` + serialize/deserialize switches.
- **Every Tauri command** has a matching wrapper in `src/lib/tauri.ts`; components never call `invoke` directly.
- **r2d2 `DbPool` is `Clone + Send + Sync`** — clone it before `tauri::async_runtime::spawn` to use `settings_repo` inside the async block.
- Verify commands run from `DesktopApp/` (`npm --prefix DesktopApp ...` from repo root also works).

## File structure

- Create: `DesktopApp/src-tauri/src/remote/cloud_client.rs` — async CloudService client + tests
- Create: `DesktopApp/src-tauri/src/commands/remote.rs` — `remote_pair_start` command
- Modify: `DesktopApp/src-tauri/src/remote/mod.rs` — declare `cloud_client`
- Modify: `DesktopApp/src-tauri/src/commands/mod.rs` — declare `remote`
- Modify: `DesktopApp/src-tauri/src/remote/startup.rs` — CloudService register + token fetch
- Modify: `DesktopApp/src-tauri/src/lib.rs` — register the new command
- Modify: `DesktopApp/src-tauri/Cargo.toml` — add `reqwest`; dev `wiremock`
- Modify: `DesktopApp/src/lib/tauri.ts` — `remotePairStart` wrapper
- Modify: `DesktopApp/src/store/settingsSlice.ts` + `src/store/index.ts` — three settings
- Create: `DesktopApp/src/components/dialogs/PairingDialog.tsx` — QR + code
- Modify: `DesktopApp/src/components/dialogs/SettingsDialog.tsx` — AbeonCloud section
- Modify: `ONBOARDING.md` — mark #3 in progress / note CloudService wiring

---

### Task 1: CloudService HTTP client (`cloud_client.rs`)

**Files:**
- Create: `DesktopApp/src-tauri/src/remote/cloud_client.rs`
- Modify: `DesktopApp/src-tauri/src/remote/mod.rs`, `DesktopApp/src-tauri/Cargo.toml`

- [ ] **Step 1: Add dependencies to `DesktopApp/src-tauri/Cargo.toml`**

In `[dependencies]` add:

```toml
reqwest = { version = "0.12", default-features = false, features = ["json", "rustls-tls"] }
```

In `[dev-dependencies]` add (create the section if absent):

```toml
wiremock = "0.6"
```

- [ ] **Step 2: Declare the module in `DesktopApp/src-tauri/src/remote/mod.rs`**

Add alongside the existing `pub mod` lines:

```rust
pub mod cloud_client;
```

- [ ] **Step 3: Write `DesktopApp/src-tauri/src/remote/cloud_client.rs`**

```rust
use serde::Deserialize;

/// Async client for the CloudService REST API. The desktop uses it to register,
/// fetch short-lived Centrifugo tokens, and start phone pairing.
pub struct CloudClient {
    http: reqwest::Client,
    base: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RegisterResponse {
    device_id: String,
    device_secret: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TokenResponse {
    token: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairCode {
    pub code: String,
    pub expires_in_secs: i64,
}

impl CloudClient {
    pub fn new(base: impl Into<String>) -> Self {
        Self { http: reqwest::Client::new(), base: base.into() }
    }

    fn url(&self, path: &str) -> String {
        format!("{}{}", self.base.trim_end_matches('/'), path)
    }

    /// First-boot registration → `(deviceId, deviceSecret)`.
    pub async fn register(&self) -> anyhow::Result<(String, String)> {
        let resp: RegisterResponse = self
            .http
            .post(self.url("/v1/devices"))
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
        Ok((resp.device_id, resp.device_secret))
    }

    /// Exchange the device secret for a short-lived Centrifugo connection JWT.
    pub async fn fetch_token(&self, device_secret: &str) -> anyhow::Result<String> {
        let resp: TokenResponse = self
            .http
            .post(self.url("/v1/token"))
            .bearer_auth(device_secret)
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
        Ok(resp.token)
    }

    /// Start pairing → a one-time code to display as text/QR.
    pub async fn pair_start(&self, device_secret: &str) -> anyhow::Result<PairCode> {
        let resp: PairCode = self
            .http
            .post(self.url("/v1/pair/start"))
            .bearer_auth(device_secret)
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
        Ok(resp)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[tokio::test]
    async fn register_parses_device_id_and_secret() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/devices"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "deviceId": "dev-1", "deviceSecret": "sekret"
            })))
            .mount(&server)
            .await;

        let client = CloudClient::new(server.uri());
        let (id, secret) = client.register().await.unwrap();
        assert_eq!(id, "dev-1");
        assert_eq!(secret, "sekret");
    }

    #[tokio::test]
    async fn fetch_token_sends_bearer_and_returns_token() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/token"))
            .and(header("authorization", "Bearer sekret"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "token": "jwt-123", "expiresInSecs": 3600
            })))
            .mount(&server)
            .await;

        let client = CloudClient::new(server.uri());
        let token = client.fetch_token("sekret").await.unwrap();
        assert_eq!(token, "jwt-123");
    }

    #[tokio::test]
    async fn pair_start_returns_code() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/pair/start"))
            .and(header("authorization", "Bearer sekret"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "code": "ABCD2345", "expiresInSecs": 300
            })))
            .mount(&server)
            .await;

        let client = CloudClient::new(server.uri());
        let pc = client.pair_start("sekret").await.unwrap();
        assert_eq!(pc.code, "ABCD2345");
        assert_eq!(pc.expires_in_secs, 300);
    }
}
```

- [ ] **Step 4: Run the client tests**

Run: `cargo test --manifest-path DesktopApp/src-tauri/Cargo.toml cloud_client`
Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add DesktopApp/src-tauri/Cargo.toml DesktopApp/src-tauri/src/remote/cloud_client.rs \
        DesktopApp/src-tauri/src/remote/mod.rs DesktopApp/src-tauri/Cargo.lock
git commit -m "feat(remote): add async CloudService HTTP client (register/token/pair)"
```

---

### Task 2: Register-on-boot + token fetch in `startup.rs`

**Files:**
- Modify: `DesktopApp/src-tauri/src/remote/startup.rs`

The new behavior: when `cloudServiceUrl` is set, register (once, persisting `remoteDeviceId`/`remoteDeviceSecret`) and fetch the token from CloudService; the device id comes from CloudService. When `cloudServiceUrl` is empty, keep the existing self-mint path (legacy/test-only) unchanged.

- [ ] **Step 1: Replace the body of `init_remote_bridge` and add the helper**

Full new contents of `DesktopApp/src-tauri/src/remote/startup.rs`:

```rust
use std::sync::Arc;
use tauri::{AppHandle, Manager};
use crate::state::AppState;
use crate::remote::bus::RemoteEventBus;
use crate::remote::bridge::{RemoteBridge, AppPtyActuator, PtyActuator, cmd_channel};
use crate::remote::ws_client::TungsteniteCentrifugoClient;
use crate::remote::token::mint_connection_token;
use crate::remote::cloud_client::CloudClient;
use crate::db::DbPool;

const DEFAULT_WS_URL: &str = "wss://ws.k8s.abeon.app/connection/websocket";

/// Wire the remote bridge at startup, only when enabled (`remoteBridgeEnabled ==
/// "true"`). Identity/token come from CloudService when `cloudServiceUrl` is set;
/// otherwise the legacy self-mint path (needs `CENTRIFUGO_TOKEN_SECRET`) is used.
pub fn init_remote_bridge(app: AppHandle) {
    let state = app.state::<AppState>();
    let conn = match state.db.get() { Ok(c) => c, Err(_) => return };

    let enabled = matches!(crate::db::settings_repo::get(&conn, "remoteBridgeEnabled"), Ok(Some(ref v)) if v == "true");
    if !enabled { return; }

    let cloud_url = crate::db::settings_repo::get(&conn, "cloudServiceUrl")
        .ok()
        .flatten()
        .filter(|s| !s.is_empty());
    let legacy_secret = std::env::var("CENTRIFUGO_TOKEN_SECRET").ok().filter(|s| !s.is_empty());

    // Without CloudService AND without a legacy secret there is no way to auth.
    if cloud_url.is_none() && legacy_secret.is_none() { return; }

    let url = std::env::var("CENTRIFUGO_WS_URL").unwrap_or_else(|_| DEFAULT_WS_URL.to_string());
    let allow_spawn = crate::commands::settings::allow_remote_spawn(&conn);
    let legacy_device_id = resolve_device_id(&conn);
    drop(conn);

    let bus = RemoteEventBus::new();
    state.session_watchers.set_bus(bus.clone());

    let registry_for_hook = state.session_pty.clone();
    state.pty.set_exit_hook(Arc::new(move |id| registry_for_hook.unbind_pty(&id)));

    let registry = state.session_pty.clone();
    let app_for_actuator = app.clone();
    let bus_rx = bus.subscribe();
    let db = state.db.clone();

    tauri::async_runtime::spawn(async move {
        let (device_id, token) = match acquire_identity(&db, cloud_url, legacy_secret, &legacy_device_id).await {
            Ok(v) => v,
            Err(e) => { eprintln!("remote bridge: identity acquisition failed: {e}"); return; }
        };

        let conn = match TungsteniteCentrifugoClient::connect(&url, &token, &cmd_channel(&device_id), None).await {
            Ok(c) => c,
            Err(e) => { eprintln!("remote bridge: connect failed: {e}"); return; }
        };
        let bridge = Arc::new(RemoteBridge::new(registry, allow_spawn));
        let actuator: Arc<dyn PtyActuator> = Arc::new(AppPtyActuator::new(app_for_actuator));
        bridge.run(device_id, conn.inbound, bus_rx, conn.client, actuator).await;
        eprintln!("remote bridge: run-loop ended");
    });
}

/// Resolve `(deviceId, connectionToken)`. CloudService path: register once
/// (persisting id+secret), then fetch a token. Legacy path: self-mint with the
/// env secret and the locally-assigned device id.
async fn acquire_identity(
    db: &DbPool,
    cloud_url: Option<String>,
    legacy_secret: Option<String>,
    legacy_device_id: &str,
) -> anyhow::Result<(String, String)> {
    if let Some(base) = cloud_url {
        let client = CloudClient::new(base);
        let (device_id, device_secret) = ensure_registered(db, &client).await?;
        let token = client.fetch_token(&device_secret).await?;
        return Ok((device_id, token));
    }
    let secret = legacy_secret.expect("checked before spawn");
    let now = unix_now();
    let token = mint_connection_token(&secret, legacy_device_id, now, 3600)?;
    Ok((legacy_device_id.to_string(), token))
}

/// Read persisted `remoteDeviceId`/`remoteDeviceSecret`; if absent, register with
/// CloudService and persist both. The secret is stored only locally (SQLite).
async fn ensure_registered(db: &DbPool, client: &CloudClient) -> anyhow::Result<(String, String)> {
    {
        let conn = db.get()?;
        let id = crate::db::settings_repo::get(&conn, "remoteDeviceId").ok().flatten();
        let secret = crate::db::settings_repo::get(&conn, "remoteDeviceSecret").ok().flatten();
        if let (Some(id), Some(secret)) = (id, secret) {
            if !id.is_empty() && !secret.is_empty() {
                return Ok((id, secret));
            }
        }
    }
    let (device_id, device_secret) = client.register().await?;
    let conn = db.get()?;
    crate::db::settings_repo::set(&conn, "remoteDeviceId", &device_id)?;
    crate::db::settings_repo::set(&conn, "remoteDeviceSecret", &device_secret)?;
    Ok((device_id, device_secret))
}

fn unix_now() -> usize {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as usize)
        .unwrap_or(0)
}

fn resolve_device_id(conn: &rusqlite::Connection) -> String {
    if let Ok(Some(id)) = crate::db::settings_repo::get(conn, "remoteDeviceId") {
        if !id.is_empty() { return id; }
    }
    let id = uuid::Uuid::new_v4().to_string();
    let _ = crate::db::settings_repo::set(conn, "remoteDeviceId", &id);
    id
}
```

- [ ] **Step 2: Verify the desktop crate still compiles**

Run: `cargo build --manifest-path DesktopApp/src-tauri/Cargo.toml`
Expected: compiles. (`DbPool` is the type from `crate::db`; confirm the import path matches — if `db::DbPool` is re-exported differently, adjust the `use`.)

- [ ] **Step 3: Run the Rust suite**

Run: `npm --prefix DesktopApp run test:rust`
Expected: all tests pass (no behavior change to existing tests; `startup.rs` has no unit tests of its own).

- [ ] **Step 4: Commit**

```bash
git add DesktopApp/src-tauri/src/remote/startup.rs
git commit -m "feat(remote): register with CloudService and fetch token on bridge startup"
```

---

### Task 3: `remote_pair_start` Tauri command

**Files:**
- Create: `DesktopApp/src-tauri/src/commands/remote.rs`
- Modify: `DesktopApp/src-tauri/src/commands/mod.rs`, `DesktopApp/src-tauri/src/lib.rs`

- [ ] **Step 1: Declare the module in `DesktopApp/src-tauri/src/commands/mod.rs`**

Add alongside the existing `pub mod` lines:

```rust
pub mod remote;
```

- [ ] **Step 2: Write `DesktopApp/src-tauri/src/commands/remote.rs`**

```rust
use tauri::State;
use crate::state::AppState;
use crate::error::{AppError, AppResult};
use crate::remote::cloud_client::CloudClient;

/// A pairing code to display (text + QR) to the user.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairCodeDto {
    pub code: String,
    pub expires_in_secs: i64,
}

/// Start phone pairing: ensure the device is registered with CloudService, then
/// request a one-time code. Requires `cloudServiceUrl` to be configured.
#[tauri::command]
pub async fn remote_pair_start(state: State<'_, AppState>) -> AppResult<PairCodeDto> {
    let base = {
        let conn = state.db.get().map_err(|e| AppError::Other(e.to_string()))?;
        crate::db::settings_repo::get(&conn, "cloudServiceUrl")
            .ok()
            .flatten()
            .filter(|s| !s.is_empty())
            .ok_or_else(|| AppError::InvalidInput("cloudServiceUrl is not configured".into()))?
    };
    let client = CloudClient::new(base);

    // Ensure we have a device secret (register on first use).
    let device_secret = {
        let conn = state.db.get().map_err(|e| AppError::Other(e.to_string()))?;
        crate::db::settings_repo::get(&conn, "remoteDeviceSecret").ok().flatten().filter(|s| !s.is_empty())
    };
    let device_secret = match device_secret {
        Some(s) => s,
        None => {
            let (id, secret) = client.register().await.map_err(|e| AppError::Other(e.to_string()))?;
            let conn = state.db.get().map_err(|e| AppError::Other(e.to_string()))?;
            crate::db::settings_repo::set(&conn, "remoteDeviceId", &id)?;
            crate::db::settings_repo::set(&conn, "remoteDeviceSecret", &secret)?;
            secret
        }
    };

    let pc = client.pair_start(&device_secret).await.map_err(|e| AppError::Other(e.to_string()))?;
    Ok(PairCodeDto { code: pc.code, expires_in_secs: pc.expires_in_secs })
}
```

- [ ] **Step 3: Register the command in `DesktopApp/src-tauri/src/lib.rs`**

In the `tauri::generate_handler![ ... ]` list (near the `commands::settings::*` entries), add:

```rust
            commands::remote::remote_pair_start,
```

- [ ] **Step 4: Build**

Run: `cargo build --manifest-path DesktopApp/src-tauri/Cargo.toml`
Expected: compiles. (If `AppError` lacks an `Other(String)` variant, use the closest existing variant — confirm against `src-tauri/src/error.rs`; `Other(String)` and `InvalidInput(String)` both exist per that file.)

- [ ] **Step 5: Commit**

```bash
git add DesktopApp/src-tauri/src/commands/remote.rs DesktopApp/src-tauri/src/commands/mod.rs \
        DesktopApp/src-tauri/src/lib.rs
git commit -m "feat(remote): add remote_pair_start Tauri command"
```

---

### Task 4: Surface AbeonCloud settings in the store

**Files:**
- Modify: `DesktopApp/src/store/settingsSlice.ts`, `DesktopApp/src/store/index.ts`

- [ ] **Step 1: Add the three fields + setters to `settingsSlice.ts`**

In the settings state interface (near `skipPermissions: boolean;`), add:

```ts
  remoteBridgeEnabled: boolean;
  allowRemoteSpawn: boolean;
  cloudServiceUrl: string;
```

In the actions interface (near `setSkipPermissions`), add:

```ts
  setRemoteBridgeEnabled: (v: boolean) => void;
  setAllowRemoteSpawn: (v: boolean) => void;
  setCloudServiceUrl: (url: string) => void;
```

In the slice creator, add default values (near the other defaults) and the setters (mirror `setSkipPermissions`’s implementation):

```ts
  remoteBridgeEnabled: false,
  allowRemoteSpawn: false,
  cloudServiceUrl: '',
  setRemoteBridgeEnabled: (v) => set({ remoteBridgeEnabled: v }),
  setAllowRemoteSpawn: (v) => set({ allowRemoteSpawn: v }),
  setCloudServiceUrl: (url) => set({ cloudServiceUrl: url }),
```

- [ ] **Step 2: Add the keys to `PERSISTED_KEYS` in `src/store/index.ts`**

```ts
  'skipPermissions',
  'remoteBridgeEnabled', 'allowRemoteSpawn', 'cloudServiceUrl',
```

- [ ] **Step 3: Add serialize/deserialize handling**

In `src/store/index.ts`, the persistence layer round-trips each persisted key through SQLite as a string. Booleans need explicit string conversion. In the loop that writes settings (`for (const key of PERSISTED_KEYS)`, around line 277) and the one that hydrates (around line 304), follow the existing pattern used for `skipPermissions` (a boolean): serialize with `String(value)` / `JSON.stringify` and parse booleans with `value === 'true'`. Match exactly how `skipPermissions` is handled in those switch/branch blocks so the new booleans persist identically; `cloudServiceUrl` is a plain string and needs no conversion.

> If `skipPermissions` is handled by a generic boolean branch, add `remoteBridgeEnabled` and `allowRemoteSpawn` to that same branch; add `cloudServiceUrl` to the string branch. Do not invent a new serialization scheme.

- [ ] **Step 4: Type-check**

Run: `npm --prefix DesktopApp run lint`
Expected: zero errors.

- [ ] **Step 5: Commit**

```bash
git add DesktopApp/src/store/settingsSlice.ts DesktopApp/src/store/index.ts
git commit -m "feat(settings): surface remoteBridgeEnabled, allowRemoteSpawn, cloudServiceUrl"
```

---

### Task 5: Pairing dialog + Settings wiring

**Files:**
- Modify: `DesktopApp/package.json` (add `qrcode.react`)
- Modify: `DesktopApp/src/lib/tauri.ts`
- Create: `DesktopApp/src/components/dialogs/PairingDialog.tsx`
- Modify: `DesktopApp/src/components/dialogs/SettingsDialog.tsx`

- [ ] **Step 1: Add the QR dependency**

Run: `npm --prefix DesktopApp install qrcode.react`
Expected: `qrcode.react` added to `dependencies`.

- [ ] **Step 2: Add the `remotePairStart` wrapper to `src/lib/tauri.ts`**

Add a type and a method on the `tauri` object (follow the existing `invoke<...>` style):

```ts
export type PairCode = { code: string; expiresInSecs: number };
```

Inside the `export const tauri = { ... }` object, add:

```ts
  remotePairStart: () => invoke<PairCode>('remote_pair_start'),
```

- [ ] **Step 3: Write `DesktopApp/src/components/dialogs/PairingDialog.tsx`**

```tsx
import { useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { tauri, type PairCode } from '../../lib/tauri';

export function PairingDialog({ onClose }: { onClose: () => void }) {
  const [pair, setPair] = useState<PairCode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function start() {
    setLoading(true);
    setError(null);
    try {
      setPair(await tauri.remotePairStart());
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-surface rounded-lg p-6 w-[360px] flex flex-col items-center gap-4">
        <h2 className="text-lg font-semibold">Sparuj telefon</h2>
        {!pair && (
          <button
            onClick={start}
            disabled={loading}
            className="px-4 py-2 rounded bg-accent text-white disabled:opacity-50"
          >
            {loading ? 'Generowanie…' : 'Wygeneruj kod parowania'}
          </button>
        )}
        {pair && (
          <>
            <QRCodeSVG value={pair.code} size={180} />
            <div className="text-2xl font-mono tracking-widest">{pair.code}</div>
            <p className="text-sm text-muted text-center">
              Zeskanuj kod w aplikacji mobilnej. Kod wygasa za {Math.round(pair.expiresInSecs / 60)} min.
            </p>
          </>
        )}
        {error && <p className="text-sm text-red-500">{error}</p>}
        <button onClick={onClose} className="text-muted hover:text-fg transition-colors">
          Zamknij
        </button>
      </div>
    </div>
  );
}
```

> Tailwind tokens (`bg-surface`, `text-muted`, `bg-accent`) follow this project's theme. If a token does not exist, substitute the nearest one already used in `SettingsDialog.tsx`.

- [ ] **Step 4: Add an "AbeonCloud" section to `SettingsDialog.tsx`**

Wire the three settings + a pairing button. Import at the top:

```tsx
import { useState } from 'react';
import { PairingDialog } from './PairingDialog';
```

Inside the component, add local state:

```tsx
  const [pairingOpen, setPairingOpen] = useState(false);
```

Read settings + setters from the store the same way the dialog reads `skipPermissions` (via the store hook already in this component), then render a section (place it near the existing toggles). Use the project's existing toggle/input markup; a minimal version:

```tsx
  {/* AbeonCloud */}
  <section className="flex flex-col gap-3">
    <h3 className="text-sm font-semibold">AbeonCloud (zdalne sterowanie)</h3>
    <label className="flex items-center gap-2">
      <input type="checkbox" checked={remoteBridgeEnabled}
             onChange={e => setRemoteBridgeEnabled(e.target.checked)} />
      Włącz zdalny most (wymaga restartu)
    </label>
    <label className="flex items-center gap-2">
      <input type="checkbox" checked={allowRemoteSpawn}
             onChange={e => setAllowRemoteSpawn(e.target.checked)} />
      Zezwól na zdalne wznawianie sesji
    </label>
    <label className="flex flex-col gap-1">
      <span className="text-sm">Adres CloudService</span>
      <input type="text" value={cloudServiceUrl}
             onChange={e => setCloudServiceUrl(e.target.value)}
             placeholder="https://cloud.k8s.abeon.app"
             className="border rounded px-2 py-1 bg-bg" />
    </label>
    <button onClick={() => setPairingOpen(true)}
            className="self-start px-3 py-1.5 rounded bg-accent text-white">
      Sparuj telefon
    </button>
  </section>
  {pairingOpen && <PairingDialog onClose={() => setPairingOpen(false)} />}
```

Pull `remoteBridgeEnabled`, `allowRemoteSpawn`, `cloudServiceUrl` and their setters from the store selector this component already uses (extend the existing `useStore(...)` selection).

- [ ] **Step 5: Type-check and run frontend tests**

Run: `npm --prefix DesktopApp run lint`
Expected: zero errors.

Run: `npm --prefix DesktopApp test`
Expected: existing tests pass (no test targets the new dialog; add none unless the suite convention requires it).

- [ ] **Step 6: Commit**

```bash
git add DesktopApp/package.json DesktopApp/package-lock.json DesktopApp/src/lib/tauri.ts \
        DesktopApp/src/components/dialogs/PairingDialog.tsx \
        DesktopApp/src/components/dialogs/SettingsDialog.tsx
git commit -m "feat(ui): add AbeonCloud settings section and phone pairing dialog"
```

---

### Task 6: Update onboarding doc

**Files:**
- Modify: `ONBOARDING.md`

- [ ] **Step 1: Update the status table and #3 section**

In the repo layout table, change the `CloudService/` row status from `**not started (#3)**` to `**in progress (#3) — backend + desktop wiring landed**`.

Under "Remaining work → #3 CloudService", prepend a short note:

```
> **Update (2026-05-30):** CloudService backend (axum + MariaDB + Centrifugo
> server API) and the desktop integration (register-on-boot, token via `/v1/token`,
> pairing dialog) are implemented per
> `docs/superpowers/plans/2026-05-30-cloudservice-{1,2,3}-*.md`. Remaining: deploy
> the image to k8s (secrets + ConfigMap + Ingress in the k8s repo), confirm the
> Centrifugo `api_key` + `presence: true` on `abeon-cloud-cmd`, and build the MobileApp (#4).
```

- [ ] **Step 2: Commit**

```bash
git add ONBOARDING.md
git commit -m "docs: mark CloudService (#3) in progress — backend + desktop wiring landed"
```

---

## Self-Review

**Spec coverage (against the design's "Desktop-side integration" section):**
- `remote/cloud_client.rs` with `register` / `fetch_token` / `pair_start` → Task 1. ✓
- `startup.rs` registers on boot, fetches token via `/v1/token` instead of self-minting (legacy self-mint retained for the gated live test only) → Task 2. ✓
- `deviceId`/`deviceSecret` persisted in SQLite settings → Tasks 2, 3. ✓
- New `cloudServiceUrl` setting + `remoteBridgeEnabled`/`allowRemoteSpawn` surfaced → Task 4. ✓
- Pairing UI: `PairingDialog.tsx` with QR + Polish copy, Tauri command + typed wrapper → Tasks 3, 5. ✓

**Placeholder scan:** Full code given for all Rust and the dialog component. The two intentionally pattern-matched steps (Task 4 Step 3 serialize/deserialize, Task 5 Step 4 store selector wiring) reference the existing `skipPermissions` implementation as the exact template rather than inventing a scheme — this is deliberate "follow the established pattern," not a vague placeholder. ✓

**Type consistency:**
- `PairCode` shape (`code`, `expiresInSecs`) matches between the Rust `PairCodeDto` (Task 3, camelCase serde), the TS `PairCode` type (Task 5), and CloudService's `PairStartResponse` (Plan 2 Task 9). ✓
- `CloudClient::{register, fetch_token, pair_start}` defined in Task 1 are called identically in Tasks 2 and 3. ✓
- Setting keys (`remoteDeviceId`, `remoteDeviceSecret`, `cloudServiceUrl`, `remoteBridgeEnabled`, `allowRemoteSpawn`) are spelled identically across `startup.rs`, `commands/remote.rs`, and the store. ✓
- Tauri command name `remote_pair_start` matches the `tauri.ts` wrapper `invoke<PairCode>('remote_pair_start')` and the `generate_handler!` registration. ✓

**Risk note for the executor:** confirm `crate::db::DbPool` is the correct path/type name for the r2d2 pool (Task 2 import) and that `AppError::Other(String)` exists (Task 3) — both are used by existing code per `src-tauri/src/error.rs`, but verify before relying on them. The CloudService base URL must NOT have a trailing path; `cloud_client` appends `/v1/...`.
```
