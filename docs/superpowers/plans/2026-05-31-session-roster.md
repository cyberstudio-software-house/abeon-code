# Session Roster Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the mobile "Sesje" tab show all desktop sessions grouped by project, auto-populated on connect and kept fresh, by adding a roster snapshot + live metadata deltas over the existing device channel.

**Architecture:** Mobile auto-sends a new `RequestRoster` command over the existing `cmd:<dev>` pipeline on connect; the desktop bridge answers with a `SessionRoster` snapshot published to `abeon-cloud-dev:<deviceId>`, and additionally mirrors lightweight `SessionActivity|Title|Usage` events to that channel for freshness. The mobile routes device-channel publications by `type` and renders a grouped list.

**Tech Stack:** Rust (Tauri 2, ts-rs, tokio), React Native / Expo (Zustand 5, centrifuge v5, jest-expo/web).

**Spec:** `docs/superpowers/specs/2026-05-31-abeoncloud-session-roster-design.md`

**Branch:** `feat/session-roster` (already created).

**Node 22 prefix for ALL mobile commands:** `export PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH"` then run from `MobileApp/`.

---

## File Structure

**Contract**
- `crates/abeon-remote-core/src/protocol.rs` — add `RemoteCommand::RequestRoster`.
- `DesktopApp/src-tauri/src/domain/session_event.rs` — add `SessionEvent::SessionRoster`; export `RosterEntry`.
- `DesktopApp/src-tauri/src/domain/roster.rs` (NEW) — `RosterEntry` struct.
- Generated TS (do NOT hand-edit): `DesktopApp/src/types/*`, `MobileApp/src/types/{RemoteCommand,SessionEvent,RosterEntry}.ts`.

**Desktop**
- `DesktopApp/src-tauri/src/commands/sessions.rs` — add `roster_snapshot()` enumeration helper.
- `DesktopApp/src-tauri/src/remote/bridge.rs` — `RosterProvider` trait, `AppRosterProvider`, run-loop `RequestRoster` handling + initial snapshot + mirror deltas.
- `DesktopApp/src-tauri/src/remote/startup.rs` — construct + pass `AppRosterProvider`.

**Mobile**
- `MobileApp/src/store/sessionsSlice.ts` — `Session` gains `projectId`/`projectName`; `applySessionEvent` `sessionRoster` case.
- `MobileApp/src/lib/centrifugo.ts` — `parseSessionEvent` accepts `sessionRoster`; `subscribeDevice` history backfill + raw routing.
- `MobileApp/src/store/connectionSlice.ts` — device routing → `applySessionEvent`; auto-`RequestRoster` on connect.
- `MobileApp/src/lib/roster.ts` (NEW) — pure `groupByProject` selector helper.
- `MobileApp/app/(tabs)/sessions.tsx` — grouped `SectionList`.

---

## Task 1: Contract — RequestRoster, RosterEntry, SessionRoster + regen

**Files:**
- Modify: `crates/abeon-remote-core/src/protocol.rs`
- Create: `DesktopApp/src-tauri/src/domain/roster.rs`
- Modify: `DesktopApp/src-tauri/src/domain/mod.rs`, `DesktopApp/src-tauri/src/domain/session_event.rs`

- [ ] **Step 1: Add `RequestRoster` to `RemoteCommand`**

In `crates/abeon-remote-core/src/protocol.rs`, inside `enum RemoteCommand`, add as the last variant (a unit variant; serde `tag="type"` makes it `{"type":"requestRoster"}`):

```rust
    /// Mobile asks the desktop to publish a full SessionRoster snapshot.
    RequestRoster,
```

- [ ] **Step 2: Create `RosterEntry`**

Create `DesktopApp/src-tauri/src/domain/roster.rs`:

```rust
use serde::{Deserialize, Serialize};
use ts_rs::TS;
use crate::domain::session::SessionActivity;

/// One row of the mobile session list = SessionMeta essentials + project name.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/types/")]
#[serde(rename_all = "camelCase")]
pub struct RosterEntry {
    pub session_id: String,
    #[ts(type = "number")]
    pub project_id: i64,
    pub project_name: String,
    pub title: String,
    pub activity: SessionActivity,
    #[ts(type = "number")]
    pub last_modified: i64,
}
```

Add to `DesktopApp/src-tauri/src/domain/mod.rs`:

```rust
pub mod roster;
```

- [ ] **Step 3: Add `SessionRoster` variant + export**

In `DesktopApp/src-tauri/src/domain/session_event.rs`: add the import and the variant.

```rust
use crate::domain::roster::RosterEntry;
```

Add as the last variant of `enum SessionEvent`:

```rust
    SessionRoster { entries: Vec<RosterEntry> },
```

In the `export_session_event_to_mobile_app` test, add `RosterEntry` to the export loop array (so `MobileApp/src/types/RosterEntry.ts` is materialized):

```rust
            ("RosterEntry", crate::domain::roster::RosterEntry::export_to_string().unwrap()),
```

- [ ] **Step 4: Add a wire-shape test for SessionRoster**

Append to the `tests` mod in `session_event.rs`:

```rust
    #[test]
    fn session_roster_wire_is_flat_entries() {
        use crate::domain::roster::RosterEntry;
        use crate::domain::session::SessionActivity;
        let ev = SessionEvent::SessionRoster {
            entries: vec![RosterEntry {
                session_id: "s1".into(),
                project_id: 7,
                project_name: "demo".into(),
                title: "Hello".into(),
                activity: SessionActivity::Idle,
                last_modified: 123,
            }],
        };
        let json = serde_json::to_value(&ev).unwrap();
        assert_eq!(json["type"], "sessionRoster");
        assert!(json["entries"].is_array());
        assert_eq!(json["entries"][0]["sessionId"], "s1");
        assert_eq!(json["entries"][0]["projectName"], "demo");
    }
```

> NOTE: `SessionActivity::Idle` — confirm the actual idle/default variant name in `domain/session.rs` and use it. If it is e.g. `SessionActivity::Idle` keep as-is; otherwise substitute the real variant.

- [ ] **Step 5: Run desktop Rust tests (contract crate + session_event)**

```bash
cargo test --manifest-path crates/abeon-remote-core/Cargo.toml
cargo test --manifest-path DesktopApp/src-tauri/Cargo.toml session_event
```
Expected: PASS, and these regenerate TS into `DesktopApp/src/types/` and `MobileApp/src/types/`.

- [ ] **Step 6: Verify generated types updated and DesktopApp types consistent**

```bash
git status DesktopApp/src/types MobileApp/src/types
```
Expected: `RemoteCommand.ts` (now includes `"requestRoster"`), `SessionEvent.ts` (now includes `sessionRoster`), new `RosterEntry.ts` in BOTH `DesktopApp/src/types` and `MobileApp/src/types`. No files written outside those two dirs.

- [ ] **Step 7: Commit**

```bash
git add crates/abeon-remote-core/src/protocol.rs DesktopApp/src-tauri/src/domain DesktopApp/src/types MobileApp/src/types
git commit -m "feat(remote): add RequestRoster command, RosterEntry, SessionRoster event"
```

---

## Task 2: Desktop — roster enumeration helper

**Files:**
- Modify: `DesktopApp/src-tauri/src/commands/sessions.rs`

- [ ] **Step 1: Write the failing test**

Add to the bottom of `commands/sessions.rs` (create a `#[cfg(test)] mod roster_tests`). Use the SAME temp-DB pattern as `db/projects_repo.rs` tests (`init_pool` + a forgotten `NamedTempFile`). With no projects inserted, the roster is empty:

```rust
#[cfg(test)]
mod roster_tests {
    use super::*;
    use crate::db::init_pool;
    use tempfile::NamedTempFile;

    fn pool() -> crate::db::DbPool {
        let f = NamedTempFile::new().unwrap();
        let path = f.path().to_path_buf();
        std::mem::forget(f);
        init_pool(&path).unwrap()
    }

    #[test]
    fn roster_snapshot_empty_db_is_empty() {
        let p = pool();
        let c = p.get().unwrap();
        let entries = roster_snapshot(&c).unwrap();
        assert!(entries.is_empty());
    }
}
```

- [ ] **Step 2: Run it to confirm it fails**

```bash
cargo test --manifest-path DesktopApp/src-tauri/Cargo.toml roster_snapshot_empty_db
```
Expected: FAIL (`roster_snapshot` not found).

- [ ] **Step 3: Implement `roster_snapshot`**

Add to `commands/sessions.rs` (reuses the existing private `session_dir`, `reader`, `session_titles_repo`, `projects_repo`). `ROSTER_SESSIONS_PER_PROJECT = 30`.

```rust
use crate::domain::roster::RosterEntry;

const ROSTER_SESSIONS_PER_PROJECT: usize = 30;

/// Build a roster of the most-recent sessions across all projects. Used by the
/// remote bridge to answer RequestRoster. Failures for a single project are skipped
/// (a missing claude dir must not sink the whole roster).
pub fn roster_snapshot(conn: &rusqlite::Connection) -> AppResult<Vec<RosterEntry>> {
    let mut out = Vec::new();
    for proj in projects_repo::list(conn)? {
        let dir = match session_dir(&proj) { Ok(d) => d, Err(_) => continue };
        let mut sessions = match catch(move || reader::list_sessions(proj.id, &dir, ROSTER_SESSIONS_PER_PROJECT, 0)) {
            Ok(s) => s,
            Err(_) => continue,
        };
        let titles = session_titles_repo::get_all(conn, proj.id);
        for s in &mut sessions {
            if let Some(t) = titles.get(&s.id) { s.title = t.clone(); }
            out.push(RosterEntry {
                session_id: s.id.clone(),
                project_id: proj.id,
                project_name: proj.name.clone(),
                title: s.title.clone(),
                activity: s.activity,
                last_modified: s.last_modified,
            });
        }
    }
    Ok(out)
}
```

> NOTE: `proj` is moved into the `catch` closure via `dir`; clone `proj.id`/`proj.name` before the closure if the borrow checker complains (capture `dir` only). Adjust so `proj.id`/`proj.name` remain usable after the call.

- [ ] **Step 4: Run the test**

```bash
cargo test --manifest-path DesktopApp/src-tauri/Cargo.toml roster_snapshot_empty_db
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add DesktopApp/src-tauri/src/commands/sessions.rs
git commit -m "feat(remote): roster_snapshot enumerates recent sessions per project"
```

---

## Task 3: Desktop — bridge RosterProvider + RequestRoster + mirror deltas

**Files:**
- Modify: `DesktopApp/src-tauri/src/remote/bridge.rs`

- [ ] **Step 1: Add `RosterProvider` trait + change `run` to accept it**

In `bridge.rs`, near `PtyActuator`:

```rust
use crate::domain::roster::RosterEntry;

/// Supplies the current session roster for RequestRoster + the startup snapshot.
/// Isolated as a trait so the run loop is testable without a DB.
pub trait RosterProvider: Send + Sync {
    fn snapshot(&self) -> Vec<RosterEntry>;
}
```

Add an `AppRosterProvider` (prod impl) below `AppPtyActuator`:

```rust
pub struct AppRosterProvider { app: AppHandle }
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
```

- [ ] **Step 2: Add a helper to encode a roster snapshot to a device-channel publication**

Add near `encode_bus_event`:

```rust
fn encode_roster(entries: Vec<RosterEntry>) -> serde_json::Value {
    serde_json::to_value(SessionEvent::SessionRoster { entries }).expect("SessionRoster serializes")
}

/// Returns Some(value) for the lightweight metadata events that should ALSO be
/// mirrored to the device channel; None for Append (too heavy — per-session only).
fn device_mirror(event: &SessionBusEvent) -> Option<serde_json::Value> {
    match event {
        SessionBusEvent::Append { .. } => None,
        other => Some(encode_bus_event(other.clone()).1),
    }
}
```

> NOTE: `encode_bus_event` currently takes `SessionBusEvent` by value. Either make it take `&SessionBusEvent` (and update its one caller), or clone in `device_mirror` as shown. Keep one source of truth for the encoding.

- [ ] **Step 3: Change `run` signature + handle RequestRoster + initial + mirror**

Add `roster: Arc<dyn RosterProvider>` as a parameter to `RemoteBridge::run` (after `actuator`). At the top of `run`, before the loop, publish the initial snapshot:

```rust
        let dev_channel = result_channel(&device_id);
        let _ = client.publish(&dev_channel, encode_roster(roster.snapshot())).await;
```

In the inbound branch, special-case `RequestRoster` BEFORE `handle_envelope`:

```rust
                        Some(env) => {
                            if matches!(env.command, crate::remote::protocol::RemoteCommand::RequestRoster) {
                                let _ = client.publish(&dev_channel, encode_roster(roster.snapshot())).await;
                                let ack = RemoteEvent::CmdResult { command_id: env.command_id, ok: true, error: None };
                                if let Ok(data) = serde_json::to_value(&ack) {
                                    let _ = client.publish(&results, data).await;
                                }
                            } else {
                                let ev = self.handle_envelope(env, actuator.as_ref());
                                if let Ok(data) = serde_json::to_value(&ev) {
                                    let _ = client.publish(&results, data).await;
                                }
                            }
                        }
```

In the bus branch, after publishing to the per-session channel, also mirror metadata to the device channel:

```rust
                            let (channel, data) = encode_bus_event(event.clone());
                            let _ = client.publish(&channel, data).await;
                            if let Some(mirror) = device_mirror(&event) {
                                let _ = client.publish(&dev_channel, mirror).await;
                            }
```

> NOTE: this requires `event` to be available by reference/clone in the bus branch; adjust the existing `match ev { Ok(event) => ... }` so `event` is usable for both the notify check, the per-session publish, and the mirror. `results` and `dev_channel` are the same string (`result_channel(device_id)`); keep `dev_channel` and reuse it for `results` too, or define both — do not double-compute.

- [ ] **Step 4: Update existing `run` tests + add new ones**

Every existing `bridge.run(...)` call in tests must pass a fake roster provider. Add:

```rust
    #[derive(Default)]
    struct FakeRosterProvider { entries: Vec<RosterEntry> }
    impl RosterProvider for FakeRosterProvider {
        fn snapshot(&self) -> Vec<RosterEntry> { self.entries.clone() }
    }
```

Update the two `tokio::spawn(bridge.run(...))` calls to pass `std::sync::Arc::new(FakeRosterProvider::default())` in the new position. Note both will now publish an **initial** empty roster first, so adjust their `published()` index assertions accordingly (the first publication is the startup `sessionRoster`).

Add a new test:

```rust
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
        let handle = tokio::spawn(bridge.run("dev-1".into(), rx, bus.subscribe(), client.clone(), actuator, roster, None, None));

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
        let handle = tokio::spawn(bridge.run("dev-1".into(), rx, bus.subscribe(), client.clone(), actuator, roster, None, None));

        bus.publish(crate::remote::bus::SessionBusEvent::Activity { session_id: "s1".into(), activity: crate::domain::session::SessionActivity::WaitingUser });
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;

        let pubs = client.published();
        assert!(pubs.iter().any(|(ch, d)| ch == "abeon-cloud-sess:s1" && d["type"] == "sessionActivity"));
        assert!(pubs.iter().any(|(ch, d)| ch == "abeon-cloud-dev:dev-1" && d["type"] == "sessionActivity"));
        drop(tx); let _ = handle.await; drop(bus);
    }
```

- [ ] **Step 5: Run bridge tests**

```bash
cargo test --manifest-path DesktopApp/src-tauri/Cargo.toml --lib remote::bridge
```
Expected: PASS (incl. the updated existing tests).

- [ ] **Step 6: Commit**

```bash
git add DesktopApp/src-tauri/src/remote/bridge.rs
git commit -m "feat(remote): bridge answers RequestRoster + mirrors session deltas to device channel"
```

---

## Task 4: Desktop — wire AppRosterProvider into startup

**Files:**
- Modify: `DesktopApp/src-tauri/src/remote/startup.rs`

- [ ] **Step 1: Construct + pass the provider**

In `startup.rs`, import it and build it from the AppHandle, then pass to `run`:

```rust
use crate::remote::bridge::{RemoteBridge, AppPtyActuator, AppRosterProvider, PtyActuator, RosterProvider, cmd_channel};
```

Before the `bridge.run(...)` call, after building `actuator`:

```rust
        let roster: Arc<dyn RosterProvider> = Arc::new(AppRosterProvider::new(app_for_actuator.clone()));
```

> NOTE: `app_for_actuator` is moved into `AppPtyActuator::new`. Clone the `AppHandle` for the actuator and reuse the original for the roster provider (AppHandle is cheap to clone). Adjust the two constructions so both get a handle.

Update the call:

```rust
        bridge.run(device_id, conn.inbound, bus_rx, conn.client, actuator, roster, cloud, device_secret).await;
```

- [ ] **Step 2: Build the desktop backend**

```bash
cargo build --manifest-path DesktopApp/src-tauri/Cargo.toml
```
Expected: compiles clean.

- [ ] **Step 3: Run the full desktop Rust suite**

```bash
npm --prefix DesktopApp run test:rust
```
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add DesktopApp/src-tauri/src/remote/startup.rs
git commit -m "feat(remote): wire AppRosterProvider into bridge startup"
```

---

## Task 5: Mobile — sessionsSlice roster seeding

**Files:**
- Modify: `MobileApp/src/store/sessionsSlice.ts`
- Test: `MobileApp/__tests__/sessionsSlice.test.ts` (create if absent; match existing store test style)

- [ ] **Step 1: Write the failing test**

```ts
import { createStore } from '@/src/store';
import type { SessionEvent } from '@/src/types/SessionEvent';

test('sessionRoster seeds rows grouped-ready with project info', () => {
  const store = createStore();
  const ev: SessionEvent = { type: 'sessionRoster', entries: [
    { sessionId: 's1', projectId: 1, projectName: 'demo', title: 'A', activity: 'idle', lastModified: 10 },
    { sessionId: 's2', projectId: 1, projectName: 'demo', title: 'B', activity: 'waitingUser', lastModified: 20 },
  ] } as unknown as SessionEvent;
  store.getState().applySessionEvent(ev);
  const s1 = store.getState().sessions.get('s1')!;
  expect(s1.projectName).toBe('demo');
  expect(s1.title).toBe('A');
  expect(store.getState().sessions.get('s2')!.activity).toBe('waitingUser');
});
```

- [ ] **Step 2: Run it (fails)**

```bash
export PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH" && npx jest sessionsSlice
```
Expected: FAIL.

- [ ] **Step 3: Extend `Session` + add the case**

In `sessionsSlice.ts`, extend the interface:

```ts
export interface Session {
  id: string;
  title: string | null;
  activity: SessionActivity | null;
  usage: UsageSummary | null;
  projectId: number | null;
  projectName: string | null;
  lastEventAt: number;
}
```

Update `upsert` defaults to include the new fields:

```ts
function upsert(map: Map<string, Session>, id: string): Session {
  return map.get(id) ?? { id, title: null, activity: null, usage: null, projectId: null, projectName: null, lastEventAt: 0 };
}
```

Add a `sessionRoster` case in `applySessionEvent`'s `switch` (note: roster carries many entries, so handle it before the single-session logic — restructure so a `sessionRoster` event seeds all entries and returns, while the other cases keep operating on `e.sessionId`):

```ts
  applySessionEvent: (e) => {
    if (e.type === 'sessionRoster') {
      const sessions = new Map(get().sessions);
      for (const entry of e.entries) {
        const prev = upsert(sessions, entry.sessionId);
        sessions.set(entry.sessionId, {
          ...prev,
          title: entry.title,
          activity: entry.activity,
          projectId: entry.projectId,
          projectName: entry.projectName,
          lastEventAt: entry.lastModified,
        });
      }
      set({ sessions });
      return;
    }
    // ... existing single-session logic unchanged ...
  },
```

> NOTE: the generated `SessionEvent` union now includes the `sessionRoster` variant after Task 1, so `e.type === 'sessionRoster'` narrows `e.entries` correctly. `RosterEntry` field names are camelCase (`sessionId`, `projectId`, `projectName`, `lastModified`).

- [ ] **Step 4: Run the test (passes) + full suite**

```bash
export PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH" && npx jest sessionsSlice && npm run lint
```
Expected: PASS, lint clean.

- [ ] **Step 5: Commit**

```bash
git add MobileApp/src/store/sessionsSlice.ts MobileApp/__tests__/sessionsSlice.test.ts
git commit -m "feat(mobile): seed session list from sessionRoster snapshot"
```

---

## Task 6: Mobile — centrifugo device-channel parse + history + routing

**Files:**
- Modify: `MobileApp/src/lib/centrifugo.ts`
- Test: `MobileApp/__tests__/centrifugo.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { parseSessionEvent } from '@/src/lib/centrifugo';

test('parseSessionEvent accepts sessionRoster', () => {
  const ev = parseSessionEvent({ type: 'sessionRoster', entries: [] });
  expect(ev).not.toBeNull();
  expect(ev!.type).toBe('sessionRoster');
});
```

- [ ] **Step 2: Run it (fails)**

```bash
export PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH" && npx jest centrifugo.test
```
Expected: FAIL (roster not in `SESSION_TYPES`).

- [ ] **Step 3: Add `sessionRoster` to the parser + device history/routing**

In `centrifugo.ts`, add to the set:

```ts
const SESSION_TYPES = new Set(['sessionAppend', 'sessionActivity', 'sessionTitle', 'sessionUsage', 'sessionRoster']);
```

Change `subscribeDevice` so the device channel feeds BOTH a `cmdResult` handler and the session-event sink, and backfills via history (mirror `subscribeSession`):

```ts
  const subscribeDevice = (
    deviceId: string,
    onCmdResult: (e: RemoteEvent) => void,
    onSessionEvent: (e: SessionEvent) => void,
  ) => {
    const sub = client.newSubscription(`abeon-cloud-dev:${deviceId}`);
    const route = (data: unknown) => {
      const cmd = parseDeviceEvent(data);
      if (cmd) { onCmdResult(cmd); return; }
      const se = parseSessionEvent(data);
      if (se) onSessionEvent(se);
    };
    sub.on('subscribed', (ctx) => {
      if (!ctx.recovered) {
        sub.history({ limit: 100 }).then((r) => { for (const p of r.publications) route(p.data); }).catch(() => {});
      }
    });
    sub.on('publication', (ctx) => route(ctx.data));
    sub.subscribe();
    return sub;
  };
```

Update the `CentrifugoHandles` interface signature for `subscribeDevice` to the new three-arg shape.

- [ ] **Step 4: Run tests + lint**

```bash
export PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH" && npx jest centrifugo && npm run lint
```
Expected: PASS, lint clean (connectionSlice will be fixed in Task 7 — if lint fails only there, proceed to Task 7 then re-lint).

- [ ] **Step 5: Commit**

```bash
git add MobileApp/src/lib/centrifugo.ts MobileApp/__tests__/centrifugo.test.ts
git commit -m "feat(mobile): route + backfill session events on the device channel"
```

---

## Task 7: Mobile — connectionSlice routing + auto RequestRoster

**Files:**
- Modify: `MobileApp/src/store/connectionSlice.ts`

- [ ] **Step 1: Wire device routing + auto-request on connect**

Replace the `connect()` body's subscription + add the auto-request. Import `dispatchCommand`:

```ts
import { dispatchCommand } from '@/src/lib/dispatch';
```

In `connect()`:

```ts
  connect: () => {
    const { phoneToken, deviceId, handles } = get();
    if (!phoneToken || !deviceId || handles) return;
    const getToken = async () => (await fetchToken(phoneToken)).token;
    const h = createCentrifugo(getToken);
    const requestRoster = () => { void dispatchCommand(phoneToken, { type: 'requestRoster' } as never); };
    h.client.on('connecting', () => set({ connectionStatus: 'connecting' }));
    h.client.on('connected', () => { set({ connectionStatus: 'connected' }); requestRoster(); });
    h.client.on('disconnected', () => set({ connectionStatus: 'disconnected' }));
    h.subscribeDevice(
      deviceId,
      () => { /* cmdResult acks; wired to UI feedback later */ },
      (e) => get().applySessionEvent(e),
    );
    set({ handles: h, connectionStatus: 'connecting' });
  },
```

> NOTE: `{ type: 'requestRoster' }` must match the generated `RemoteCommand` union. After Task 1 regen, prefer the precise type over `as never`: `dispatchCommand(phoneToken, { type: 'requestRoster' })` should type-check directly — drop the cast if it does. `Deps` already includes `SessionsSlice`, so `get().applySessionEvent` is available.

- [ ] **Step 2: Lint + full suite**

```bash
export PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH" && npm run lint && npx jest
```
Expected: lint clean, all tests pass.

- [ ] **Step 3: Commit**

```bash
git add MobileApp/src/store/connectionSlice.ts
git commit -m "feat(mobile): auto-request roster on connect and feed device events to the store"
```

---

## Task 8: Mobile — grouped session list UI

**Files:**
- Create: `MobileApp/src/lib/roster.ts`
- Test: `MobileApp/__tests__/roster.test.ts`
- Modify: `MobileApp/app/(tabs)/sessions.tsx`

- [ ] **Step 1: Write the failing test for the pure grouping helper**

```ts
import { groupByProject } from '@/src/lib/roster';
import type { Session } from '@/src/store/sessionsSlice';

const mk = (id: string, projectName: string | null, at: number): Session =>
  ({ id, title: id, activity: null, usage: null, projectId: null, projectName, lastEventAt: at });

test('groupByProject buckets by project and sorts rows desc by lastEventAt', () => {
  const groups = groupByProject([mk('a', 'P1', 1), mk('b', 'P1', 5), mk('c', null, 9)]);
  expect(groups.map((g) => g.title)).toEqual(['Inne', 'P1']); // sections sorted by name, 'Inne' for null
  const p1 = groups.find((g) => g.title === 'P1')!;
  expect(p1.data.map((s) => s.id)).toEqual(['b', 'a']);       // 5 before 1
});
```

- [ ] **Step 2: Run it (fails)**

```bash
export PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH" && npx jest roster
```
Expected: FAIL.

- [ ] **Step 3: Implement `groupByProject`**

Create `MobileApp/src/lib/roster.ts`:

```ts
import type { Session } from '@/src/store/sessionsSlice';

export interface SessionSection { title: string; data: Session[]; }

const UNGROUPED = 'Inne';

export function groupByProject(sessions: Session[]): SessionSection[] {
  const buckets = new Map<string, Session[]>();
  for (const s of sessions) {
    const key = s.projectName ?? UNGROUPED;
    const arr = buckets.get(key) ?? [];
    arr.push(s);
    buckets.set(key, arr);
  }
  return [...buckets.entries()]
    .map(([title, data]) => ({ title, data: [...data].sort((a, b) => b.lastEventAt - a.lastEventAt) }))
    .sort((a, b) => a.title.localeCompare(b.title));
}
```

- [ ] **Step 4: Run it (passes)**

```bash
export PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH" && npx jest roster
```
Expected: PASS.

- [ ] **Step 5: Switch `sessions.tsx` to a grouped `SectionList`**

Replace the `FlatList` with a `SectionList` driven by `groupByProject`. Keep the existing `SessionCard`, command handlers, and empty state.

```tsx
import { useEffect, useMemo } from 'react';
import { View, Text, SectionList, StyleSheet, useColorScheme } from 'react-native';
import { router } from 'expo-router';
import { useStore } from '@/src/store';
import { resolveTokens } from '@/src/theme/tokens';
import { SessionCard } from '@/src/components/SessionCard';
import { dispatchCommand } from '@/src/lib/dispatch';
import { groupByProject } from '@/src/lib/roster';

export default function Sessions() {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const t = resolveTokens(scheme);
  useEffect(() => { useStore.getState().connect(); }, []);
  const sessions = useStore((s) => s.sessions);
  const phoneToken = useStore((s) => s.phoneToken);
  const sections = useMemo(() => groupByProject([...sessions.values()]), [sessions]);

  function handleApprove(sessionId: string) { if (phoneToken) void dispatchCommand(phoneToken, { type: 'approvePermission', sessionId }); }
  function handleDeny(sessionId: string) { if (phoneToken) void dispatchCommand(phoneToken, { type: 'denyPermission', sessionId }); }

  return (
    <View style={[styles.container, { backgroundColor: t.bg }]}>
      <SectionList
        sections={sections}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.listContent}
        renderSectionHeader={({ section }) => (
          <Text style={[styles.sectionHeader, { color: t.muted }]}>{section.title}</Text>
        )}
        renderItem={({ item }) => (
          <SessionCard
            session={item}
            onPress={() => { router.push(`/session/${item.id}`); }}
            onApprove={() => handleApprove(item.id)}
            onDeny={() => handleDeny(item.id)}
          />
        )}
        ListEmptyComponent={<Text style={[styles.emptyText, { color: t.muted }]}>Brak aktywnych sesji</Text>}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  listContent: { padding: 16, flexGrow: 1 },
  sectionHeader: { fontSize: 13, fontWeight: '600', marginTop: 12, marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.5 },
  emptyText: { textAlign: 'center', marginTop: 60, fontSize: 15 },
});
```

> NOTE: `SessionCard` currently takes a `session` of the old shape; the added `projectId`/`projectName` fields are additive and optional to the card, so it keeps compiling. If `SessionCard`'s prop type is a strict `Session`, it already includes the new fields after Task 5 — no card change needed.

- [ ] **Step 6: Lint + full suite**

```bash
export PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH" && npm run lint && npx jest
```
Expected: lint clean, all tests pass.

- [ ] **Step 7: Commit**

```bash
git add MobileApp/src/lib/roster.ts MobileApp/__tests__/roster.test.ts "MobileApp/app/(tabs)/sessions.tsx"
git commit -m "feat(mobile): group session list by project (SectionList)"
```

---

## Final verification (after all tasks)

- [ ] Desktop: `npm --prefix DesktopApp run lint && npm --prefix DesktopApp run test:rust`
- [ ] Mobile: `export PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH" && cd MobileApp && npm run lint && npx jest`
- [ ] Contract guard: `git status DesktopApp/src/types` clean (no stray regen output).
- [ ] Mobile bundle smoke: `npx expo export --platform android` succeeds (no missing-module/type errors).
