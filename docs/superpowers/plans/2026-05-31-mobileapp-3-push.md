# MobileApp #3 — Push Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Notify the phone (via an OS push) when one of its sessions is waiting for the user — so the user can approve/deny/respond without keeping the app open.

**Architecture: Approach A — the desktop pokes CloudService.** Events normally flow desktop→Centrifugo→phone, bypassing CloudService, so CloudService can't see them. Instead: the phone registers its **Expo push token** with CloudService (`POST /v1/push-token`); when the desktop bridge observes a session entering the "waiting for user" state, it calls CloudService (`POST /v1/notify`); CloudService looks up the device's stored Expo token and sends the push via the **Expo Push API**. This keeps CloudService out of the high-volume event stream — it's a low-volume, desktop-triggered path.

**Tech Stack:** Rust/axum + sqlx (CloudService) · Rust/Tauri (desktop) · Expo SDK 56 + `expo-notifications` (mobile) · `reqwest` (Expo Push HTTP).

> **Read `MobileApp/CLAUDE.md` and `CloudService/README.md` first.** Builds on Plan 1 (REST client, auth slice) and Plan 2 (subscriptions). CloudService internals confirmed by code reading (see below).

## Honest caveat this plan encodes (from code reading)

**There is no permission-specific signal on the desktop.** The JSONL/activity layer has no "permission prompt" event and the PTY exposes none. The closest proxy is `SessionActivity::WaitingUser` (`DesktopApp/src-tauri/src/sessions/activity.rs`), which fires whenever Claude finishes a turn and waits for user input — which **includes** permission prompts but also ordinary "your turn" moments. This plan triggers push on `WaitingUser` transitions, **per-session de-duplicated** (one push per transition into `WaitingUser`, not repeated). Consequence: the push semantics are "**a session is waiting for you**", not strictly "permission request". The notification copy reflects that. (A future improvement could add a permission-specific JSONL event; out of scope here.)

## Integration points (confirmed)

- **CloudService** (`CloudService/src/`): `AppState` (lib.rs:16) holds `Arc<dyn store::*>` + `Arc<dyn centrifugo::CentrifugoApi>` + `Arc<config::Config>`; routes registered in `app()` (lib.rs:25). Store traits + `InMemory*` fakes + `MysqlStore` in `store/{mod,mysql}.rs`. `PhoneToken { id, device_id, token_hash, created_at, last_used_at }`. Auth extractors `PhoneAuth` / `DeviceAuth` (`auth.rs`). Outbound HTTP pattern in `centrifugo.rs` (`reqwest`, `error_for_status()`, `anyhow`). Migrations in `CloudService/migrations/NNNN_*.sql`, run at boot. Tests: `CloudService/tests/api.rs` via `tower::ServiceExt::oneshot` + in-memory fakes.
- **Desktop** (`DesktopApp/src-tauri/src/remote/`): `CloudClient` (`cloud_client.rs`) — `reqwest`, `.bearer_auth(device_secret)`, methods `register`/`fetch_token`/`pair_start`. The bridge run loop (`bridge.rs:run`) receives every `SessionBusEvent`; `startup.rs` holds `cloud_url` + `device_secret`. The activity event flows as `SessionBusEvent::Activity { session_id, activity }`.

## File Structure

```
CloudService/
  migrations/0002_add_expo_push_token.sql   # NEW
  src/store/mod.rs        # MODIFY: PhoneToken + expo_push_token; PhoneTokenStore methods; InMemory impl
  src/store/mysql.rs      # MODIFY: Mysql impl of the new methods
  src/expo.rs             # NEW: ExpoApi trait + HttpExpoClient + FakeExpoClient
  src/lib.rs              # MODIFY: AppState.expo; build_state wiring; 2 new routes
  src/routes/mod.rs       # MODIFY: pub mod push_token; pub mod notify;
  src/routes/push_token.rs# NEW: POST /v1/push-token (PhoneAuth)
  src/routes/notify.rs    # NEW: POST /v1/notify (DeviceAuth)
  tests/api.rs            # MODIFY: tests for both routes (+ FakeExpoClient)
DesktopApp/src-tauri/src/remote/
  cloud_client.rs         # MODIFY: notify_permission()
  bridge.rs               # MODIFY: on WaitingUser activity, call notify (deduped)
  startup.rs              # MODIFY: thread CloudClient + device_secret into the bridge run loop
MobileApp/
  src/lib/push.ts         # NEW: register Expo push token + notification handlers
  src/lib/api.ts          # MODIFY: registerPushToken()
  app/_layout.tsx         # MODIFY: notification response listener → deep link
  app/pair.tsx            # MODIFY: register push token after pairing
  __tests__/push.test.ts, api.test.ts  # tests
```

---

## Task 1: CloudService — store the Expo push token

**Files:** Modify `CloudService/src/store/mod.rs`, `store/mysql.rs`; create `CloudService/migrations/0002_add_expo_push_token.sql`.

- [ ] **Step 1: Migration.** `CloudService/migrations/0002_add_expo_push_token.sql`:
```sql
ALTER TABLE phone_tokens ADD COLUMN expo_push_token VARCHAR(255) NULL;
```

- [ ] **Step 2: Extend the row + trait.** In `store/mod.rs`, add `pub expo_push_token: Option<String>` to `PhoneToken` (update its constructors/`create` call sites — `routes/pairing.rs::claim` builds a `PhoneToken`; set `expo_push_token: None` there). Add to `PhoneTokenStore`:
```rust
async fn set_expo_push_token(&self, phone_id: &str, expo_token: &str) -> anyhow::Result<()>;
async fn expo_push_token_for_device(&self, device_id: &str) -> anyhow::Result<Option<String>>;
```

- [ ] **Step 3: Failing test** in `CloudService/tests/api.rs` (or a store unit test) — register a device, pair to get a `phone_token`, then assert `set_expo_push_token` followed by `expo_push_token_for_device(device_id)` returns the token. Run `cargo test --manifest-path CloudService/Cargo.toml` → FAIL.

- [ ] **Step 4: Implement** in `InMemoryPhones` (mod.rs) — find the `PhoneToken` by id and set the field; lookup the most-recent token for a device and return its `expo_push_token`. In `MysqlStore` (mysql.rs) — `UPDATE phone_tokens SET expo_push_token=? WHERE id=?` and `SELECT expo_push_token FROM phone_tokens WHERE device_id=? AND expo_push_token IS NOT NULL ORDER BY created_at DESC LIMIT 1`.

- [ ] **Step 5: Run → PASS. Step 6: Commit** `feat(cloud): store Expo push token per phone`.

---

## Task 2: CloudService — `ExpoApi` client (send a push)

**Files:** Create `CloudService/src/expo.rs`; modify `src/lib.rs` (`pub mod expo;`, `AppState.expo`, `build_state`).

- [ ] **Step 1: Define the trait + fake + http impl** (mirrors `centrifugo.rs`). `CloudService/src/expo.rs`:
```rust
use async_trait::async_trait;
use serde_json::json;

#[async_trait]
pub trait ExpoApi: Send + Sync {
    /// Best-effort push send. Returns Ok(()) even if Expo reports a soft error;
    /// hard transport errors propagate so the caller can log them.
    async fn send_push(&self, to: &str, title: &str, body: &str) -> anyhow::Result<()>;
}

pub struct HttpExpo { client: reqwest::Client, url: String }
impl HttpExpo {
    pub fn new(url: impl Into<String>) -> Self { Self { client: reqwest::Client::new(), url: url.into() } }
}
#[async_trait]
impl ExpoApi for HttpExpo {
    async fn send_push(&self, to: &str, title: &str, body: &str) -> anyhow::Result<()> {
        let endpoint = format!("{}/--/api/v2/push/send", self.url.trim_end_matches('/'));
        self.client.post(&endpoint)
            .json(&json!({ "to": to, "title": title, "body": body, "sound": "default" }))
            .send().await?.error_for_status()?;
        Ok(())
    }
}

#[derive(Default)]
pub struct FakeExpo { pub sent: std::sync::Mutex<Vec<(String, String, String)>> }
#[async_trait]
impl ExpoApi for FakeExpo {
    async fn send_push(&self, to: &str, title: &str, body: &str) -> anyhow::Result<()> {
        self.sent.lock().unwrap().push((to.into(), title.into(), body.into())); Ok(())
    }
}
```

- [ ] **Step 2: Wire into `AppState`.** Add `pub expo: Arc<dyn expo::ExpoApi>` to `AppState` (lib.rs). In `build_state`, `expo: Arc::new(expo::HttpExpo::new(config.expo_push_url.clone()))`. Add to `config.rs`: `expo_push_url` = `env::var("EXPO_PUSH_URL").unwrap_or_else(|_| "https://exp.host".into())`. Update `tests/api.rs::test_state` to pass `Arc::new(FakeExpo::default())` (or accept it as a param like `centrifugo`).

- [ ] **Step 3:** `cargo test --manifest-path CloudService/Cargo.toml` compiles + existing tests green. **Step 4: Commit** `feat(cloud): add Expo Push API client (trait + http + fake)`.

---

## Task 3: CloudService — `POST /v1/push-token` and `POST /v1/notify`

**Files:** Create `routes/push_token.rs`, `routes/notify.rs`; modify `routes/mod.rs`, `lib.rs`, `tests/api.rs`.

- [ ] **Step 1: Failing route tests** in `tests/api.rs`:
  - `push_token`: register device → pair → `POST /v1/push-token` (Bearer phoneToken, body `{ "expoToken": "ExponentPushToken[x]" }`) → 200; then `expo_push_token_for_device` returns it.
  - `notify`: with a stored push token, `POST /v1/notify` (Bearer **deviceSecret**, body `{ "sessionId": "s1" }`) → 200 and the `FakeExpo.sent` contains one entry addressed to that token.
  - `notify` with no stored token → 200 (no-op) and `FakeExpo.sent` is empty (best-effort).
  Run → FAIL.

- [ ] **Step 2: Implement handlers.** `routes/push_token.rs`:
```rust
use crate::auth::PhoneAuth;
use crate::error::AppResult;
use crate::AppState;
use axum::{extract::State, Json};
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PushTokenRequest { pub expo_token: String }

pub async fn register(
    State(state): State<AppState>,
    PhoneAuth(phone): PhoneAuth,
    Json(req): Json<PushTokenRequest>,
) -> AppResult<axum::http::StatusCode> {
    state.phones.set_expo_push_token(&phone.id, &req.expo_token).await?;
    Ok(axum::http::StatusCode::OK)
}
```
`routes/notify.rs`:
```rust
use crate::auth::DeviceAuth;
use crate::error::AppResult;
use crate::AppState;
use axum::{extract::State, Json};
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotifyRequest { pub session_id: String }

pub async fn notify(
    State(state): State<AppState>,
    DeviceAuth(device): DeviceAuth,
    Json(req): Json<NotifyRequest>,
) -> AppResult<axum::http::StatusCode> {
    if let Some(token) = state.phones.expo_push_token_for_device(&device.id).await? {
        // best-effort; log on failure, never fail the desktop's call
        let _ = state.expo.send_push(&token, "AbeonCloud", "Sesja czeka na Ciebie").await;
    }
    Ok(axum::http::StatusCode::OK)
}
```

- [ ] **Step 3: Register** in `routes/mod.rs` (`pub mod push_token; pub mod notify;`) and `lib.rs` (`.route("/v1/push-token", post(routes::push_token::register))`, `.route("/v1/notify", post(routes::notify::notify))`).

- [ ] **Step 4:** `cargo test --manifest-path CloudService/Cargo.toml` → PASS. Update `CloudService/README.md` endpoint table with the two new rows. **Step 5: Commit** `feat(cloud): add /v1/push-token and /v1/notify endpoints`.

---

## Task 4: Desktop — notify hook on `WaitingUser` (deduped)

**Files:** Modify `DesktopApp/src-tauri/src/remote/cloud_client.rs`, `remote/bridge.rs`, `remote/startup.rs`.

- [ ] **Step 1: Add the client method.** `cloud_client.rs`:
```rust
pub async fn notify_permission(&self, device_secret: &str, session_id: &str) -> anyhow::Result<()> {
    self.http.post(self.url("/v1/notify"))
        .bearer_auth(device_secret)
        .json(&serde_json::json!({ "sessionId": session_id }))
        .send().await?.error_for_status()?;
    Ok(())
}
```

- [ ] **Step 2: Failing test** for the dedup gate. Add a small pure helper in `bridge.rs` (or a new `remote/notify_gate.rs`) so it's testable without a socket:
```rust
/// Decide whether an activity transition warrants a "waiting" push: only on a
/// transition INTO WaitingUser, and not if the session was already WaitingUser.
pub fn should_notify(prev: Option<SessionActivity>, next: SessionActivity) -> bool {
    next == SessionActivity::WaitingUser && prev != Some(SessionActivity::WaitingUser)
}
```
Test: `should_notify(None, WaitingUser) == true`; `should_notify(Some(Running), WaitingUser) == true`; `should_notify(Some(WaitingUser), WaitingUser) == false`; `should_notify(Some(WaitingUser), Running) == false`. Run desktop tests → FAIL.

- [ ] **Step 3: Implement + wire the call site.** In the bridge run loop where `SessionBusEvent::Activity { session_id, activity }` is handled, keep a `HashMap<String, SessionActivity>` of last-seen activity; when `should_notify(prev, activity)` and a `CloudClient` + `device_secret` are configured, spawn `tokio::spawn(async move { let _ = client.notify_permission(&secret, &sid).await; })` (best-effort, never blocks the bridge). Thread the optional `CloudClient` + `device_secret` into the bridge from `startup.rs` (it already constructs the client + holds `device_secret` when `cloudServiceUrl` is set; pass `None` when unset, so the legacy/self-mint path simply skips push).

- [ ] **Step 4:** `cargo test --manifest-path DesktopApp/src-tauri/Cargo.toml` → PASS (should_notify + existing). **Step 5: Commit** `feat(remote): notify CloudService on WaitingUser for push (deduped)`.

---

## Task 5: Mobile — register the Expo push token + handle taps

**Files:** Modify `MobileApp/src/lib/api.ts` (add `registerPushToken`); create `MobileApp/src/lib/push.ts`; modify `app/pair.tsx` and `app/_layout.tsx`.

- [ ] **Step 1: Failing test** — extend `MobileApp/__tests__/api.test.ts` with `registerPushToken('pt_1', 'ExponentPushToken[x]')` posting to `/v1/push-token` with Bearer + body `{ expoToken }`. Run → FAIL.

- [ ] **Step 2: Implement `registerPushToken`** in `src/lib/api.ts` (same `request` helper):
```ts
export function registerPushToken(phoneToken: string, expoToken: string): Promise<unknown> {
  return request('/v1/push-token', {
    method: 'POST',
    headers: { Authorization: `Bearer ${phoneToken}` },
    body: JSON.stringify({ expoToken }),
  });
}
```

- [ ] **Step 3: Push registration helper.** `src/lib/push.ts`:
```ts
import * as Notifications from 'expo-notifications';
import { registerPushToken } from '@/src/lib/api';

// Requests OS permission, gets the Expo push token, and registers it with CloudService.
// Returns false if permission was denied (app still works in-foreground).
export async function registerForPush(phoneToken: string): Promise<boolean> {
  const { status } = await Notifications.requestPermissionsAsync();
  if (status !== 'granted') return false;
  const { data: expoToken } = await Notifications.getExpoPushTokenAsync();
  await registerPushToken(phoneToken, expoToken);
  return true;
}
```
Add a foreground handler so notifications surface in-app: `Notifications.setNotificationHandler({ handleNotification: async () => ({ shouldShowBanner: true, shouldPlaySound: false, shouldSetBadge: false }) })` (set once at module load in `_layout.tsx`).

- [ ] **Step 4: Call it after pairing.** In `app/pair.tsx`'s success path (after `pair(c)`), `void registerForPush(c.phoneToken)` (don't block navigation on it). Also attempt on app start when already paired (in `_layout.tsx` after hydration, if `phoneToken` present).

- [ ] **Step 5: Deep-link on tap.** In `_layout.tsx`, add `Notifications.addNotificationResponseReceivedListener((resp) => { const sid = resp.notification.request.content.data?.sessionId; if (sid) router.push('/session/' + sid); })`. (For the session id to be present, extend CloudService `/v1/notify` Task 3 to include `data: { sessionId }` in the Expo payload — add `"data": { "sessionId": session_id }` to the `send_push` body and thread `session_id` through `ExpoApi::send_push`.)

- [ ] **Step 6:** `npm run lint` exit 0; `npx jest api push` green. **Step 7: Commit** `feat(mobile): register Expo push token and deep-link notification taps`.

---

## Task 6: End-to-end wiring note + config

- [ ] **Step 1:** Document the new env/config: CloudService `EXPO_PUSH_URL` (optional, defaults to `https://exp.host`) in `CloudService/README.md` + `CloudService/k8s` config map note. No new secret (Expo push to Expo-managed tokens needs no key).
- [ ] **Step 2:** Note in `ONBOARDING.md` that push is "session waiting for you" (WaitingUser proxy), deduped per transition, best-effort.
- [ ] **Step 3: Commit** `docs: document push (EXPO_PUSH_URL, WaitingUser proxy semantics)`.

---

## Done criteria (Plan 3)

- CloudService: `cargo test --manifest-path CloudService/Cargo.toml` green incl. new `/v1/push-token` + `/v1/notify` tests (FakeExpo asserts the right token + payload); migration `0002` present.
- Desktop: `cargo test --manifest-path DesktopApp/src-tauri/Cargo.toml` green incl. `should_notify` dedup tests; the bridge calls `notify_permission` on `WaitingUser` transitions (best-effort, skipped when `cloudServiceUrl` unset).
- Mobile: `npm run lint` exit 0, `npx jest` green; after pairing the phone registers its Expo token; a `/v1/notify` results in an OS notification whose tap deep-links to `/session/<id>`.
- The whole flow is honestly scoped as "**a session is waiting for you**" (no permission-specific signal exists); deduped to one push per `WaitingUser` transition.
