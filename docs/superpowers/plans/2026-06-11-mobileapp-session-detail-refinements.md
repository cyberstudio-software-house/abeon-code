# MobileApp Session-Detail Refinements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the mobile session-detail screen usable end-to-end: load+refresh conversation history, answer questions, grant/deny permissions with real context, fix the header status-bar overlap, and sort projects by recent activity like the desktop.

**Architecture:** Two protocol commands are added in the Rust contract crate (`RequestHistory`, `ApproveAlwaysPermission`) and regenerated into both apps' `src/types/`. The desktop bridge answers `RequestHistory` by reading the full session JSONL and republishing it as chunked `SessionAppend` events (no Centrifugo retention needed); it maps `ApproveAlwaysPermission` to a key sequence. The mobile app requests history on session open, repurposes the coarse activity states (`waitingTool` → permission prompt with tool context; `waitingUser` → free-text answer), adds a third permission button, and wraps the screen in safe-area + keyboard-avoiding views.

**Tech Stack:** Rust (Tauri 2, ts-rs, tokio, serde), React Native / Expo SDK 56 (expo-router, zustand 5, react-native-safe-area-context), Jest (`jest-expo/web`) + `@testing-library/react-native`, cargo test.

**Spec:** `docs/superpowers/specs/2026-06-11-mobileapp-session-detail-refinements-design.md`

**Branch:** `feat/mobile-session-detail-refinements` (already created; spec committed there).

---

## Toolchain notes (read before running anything)

- **Rust** commands run from the repo root or `DesktopApp/`. Contract-type regeneration: `cargo test --manifest-path crates/abeon-remote-core/Cargo.toml`.
- **Mobile** commands require Node 22. Prefix every npm/npx call:
  `export PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH"` then run from `MobileApp/`.
  Lint: `npm run lint` (= `tsc --noEmit`). Tests: `npm test` or `npx jest <pattern>`.
- **Never hand-edit** `MobileApp/src/types/*` or `DesktopApp/src/types/*` — they are ts-rs output. After editing `crates/abeon-remote-core/src/protocol.rs`, regenerate and confirm `git status DesktopApp/src/types` is clean (only the contract files changed).
- **No code comments** unless the WHY is non-obvious (project convention). Identifiers in English; user-facing strings in Polish.

---

## File Structure

**Rust (desktop + contract):**
- Modify `crates/abeon-remote-core/src/protocol.rs` — add two `RemoteCommand` variants + round-trip tests.
- Regenerate `DesktopApp/src/types/RemoteCommand.ts` and `MobileApp/src/types/RemoteCommand.ts` (ts-rs output).
- Modify `DesktopApp/src-tauri/src/remote/dispatch.rs` — `APPROVE_ALWAYS_KEYS`, map both new commands in `command_to_action`, tests.
- Modify `DesktopApp/src-tauri/src/commands/sessions.rs` — add `history_blocks_for_session` helper + test.
- Modify `DesktopApp/src-tauri/src/remote/bridge.rs` — `HistoryProvider` trait, `AppHistoryProvider`, `RequestHistory` branch in `run`, tests.
- Modify `DesktopApp/src-tauri/src/remote/startup.rs` — construct + pass `AppHistoryProvider`.

**Mobile:**
- Modify `MobileApp/src/lib/roster.ts` — sort sections by recent activity.
- Modify `MobileApp/__tests__/lib/roster.test.ts` (or create) — sort test.
- Modify `MobileApp/src/components/PermissionPrompt.tsx` — tool context + third button.
- Modify `MobileApp/__tests__/components/PermissionPrompt.test.tsx` (create) — render/callback test.
- Modify `MobileApp/app/session/[id].tsx` — request history on mount, permission on `waitingTool`, tool label, approve-always handler, SafeArea + KeyboardAvoidingView.

---

## Task 1: Protocol — add `RequestHistory` and `ApproveAlwaysPermission`

**Files:**
- Modify: `crates/abeon-remote-core/src/protocol.rs`
- Regenerate: `DesktopApp/src/types/RemoteCommand.ts`, `MobileApp/src/types/RemoteCommand.ts`

- [ ] **Step 1: Add the two variants to the enum**

In `crates/abeon-remote-core/src/protocol.rs`, inside `pub enum RemoteCommand`, add after `RequestRoster` (keep the existing variants unchanged):

```rust
    /// Mobile asks the desktop to publish a full SessionAppend backfill for one
    /// session to its session channel (no Centrifugo retention required).
    RequestHistory {
        session_id: String,
    },
    /// Approve a permission prompt with "and don't ask again" — selects the
    /// second menu option (down arrow + Enter) instead of the default.
    ApproveAlwaysPermission {
        session_id: String,
    },
```

- [ ] **Step 2: Add round-trip tests**

In the `#[cfg(test)] mod tests` block of the same file, add:

```rust
    #[test]
    fn request_history_round_trips() {
        let cmd = RemoteCommand::RequestHistory { session_id: "s1".into() };
        let json = serde_json::to_string(&cmd).unwrap();
        assert_eq!(json, r#"{"type":"requestHistory","sessionId":"s1"}"#);
        let back: RemoteCommand = serde_json::from_str(&json).unwrap();
        assert_eq!(back, cmd);
    }

    #[test]
    fn approve_always_round_trips() {
        let cmd = RemoteCommand::ApproveAlwaysPermission { session_id: "s1".into() };
        let json = serde_json::to_string(&cmd).unwrap();
        assert_eq!(json, r#"{"type":"approveAlwaysPermission","sessionId":"s1"}"#);
        let back: RemoteCommand = serde_json::from_str(&json).unwrap();
        assert_eq!(back, cmd);
    }
```

- [ ] **Step 3: Run tests to verify they fail, then pass after Step 1**

Run: `cargo test --manifest-path crates/abeon-remote-core/Cargo.toml`
Expected: the two new tests pass; the existing `export_contract_to_mobile_app` test rewrites the TS files. (Note: this command compiles the workspace — the desktop crate's exhaustive `match` on `RemoteCommand` in `dispatch.rs`/`bridge.rs` will FAIL to compile until Tasks 2–3 add the new arms. That is expected. To run this crate's tests in isolation first, this command targets only the contract crate manifest and will compile cleanly because the contract crate does not match on the enum.)

- [ ] **Step 4: Verify generated types updated**

Run: `git status --short DesktopApp/src/types MobileApp/src/types`
Expected: `RemoteCommand.ts` modified in both. Open `MobileApp/src/types/RemoteCommand.ts` and confirm it now ends with `... | { "type": "requestHistory", sessionId: string, } | { "type": "approveAlwaysPermission", sessionId: string, };`.

- [ ] **Step 5: Commit**

```bash
git add crates/abeon-remote-core/src/protocol.rs DesktopApp/src/types/RemoteCommand.ts MobileApp/src/types/RemoteCommand.ts
git commit -m "feat(remote): add RequestHistory and ApproveAlwaysPermission commands"
```

---

## Task 2: Desktop dispatch — map the new commands to PTY effects

**Files:**
- Modify: `DesktopApp/src-tauri/src/remote/dispatch.rs`

- [ ] **Step 1: Add the key constant**

In `DesktopApp/src-tauri/src/remote/dispatch.rs`, after the `DENY_KEYS` const (line ~19), add:

```rust
/// Key sequence to accept a permission prompt with "and don't ask again":
/// move down to the second option, then Enter. Assumes the standard 3-option
/// Claude permission menu — see the spec's risk note.
pub const APPROVE_ALWAYS_KEYS: &str = "\x1b[B\r";
```

- [ ] **Step 2: Add match arms in `command_to_action`**

In the `match cmd { ... }` of `command_to_action`, add these arms (place `ApproveAlwaysPermission` next to `ApprovePermission`, and `RequestHistory` next to `RequestRoster`):

```rust
        RemoteCommand::ApproveAlwaysPermission { session_id } => {
            write_to_session(reg, session_id, APPROVE_ALWAYS_KEYS.as_bytes().to_vec())
        }
        RemoteCommand::RequestHistory { .. } => {
            PtyAction::Reject { reason: "requestHistory has no pty effect".into() }
        }
```

(The `RequestHistory` arm is never reached in production — the run loop intercepts it before `handle_envelope` — but the `match` must stay exhaustive.)

- [ ] **Step 3: Add tests**

In the `#[cfg(test)] mod tests` of the same file, add:

```rust
    #[test]
    fn approve_always_writes_down_then_enter() {
        let reg = reg_with("s1", "pty-a");
        let cmd = RemoteCommand::ApproveAlwaysPermission { session_id: "s1".into() };
        assert_eq!(
            command_to_action(&cmd, &reg, false),
            PtyAction::Write { pty_id: "pty-a".into(), bytes: APPROVE_ALWAYS_KEYS.as_bytes().to_vec() }
        );
    }

    #[test]
    fn request_history_has_no_pty_effect() {
        let reg = reg_with("s1", "pty-a");
        let cmd = RemoteCommand::RequestHistory { session_id: "s1".into() };
        assert!(matches!(command_to_action(&cmd, &reg, false), PtyAction::Reject { .. }));
    }
```

- [ ] **Step 4: Run tests**

Run: `cargo test --manifest-path DesktopApp/src-tauri/Cargo.toml dispatch`
Expected: PASS (new + existing dispatch tests). Note: full crate still won't compile until Task 3 adds the bridge `RequestHistory` branch only if the bridge matches the enum — it does not yet, so this should compile and pass now.

- [ ] **Step 5: Commit**

```bash
git add DesktopApp/src-tauri/src/remote/dispatch.rs
git commit -m "feat(remote): map ApproveAlwaysPermission to down+enter keys"
```

---

## Task 3: Desktop bridge — answer `RequestHistory` with a chunked backfill

**Files:**
- Modify: `DesktopApp/src-tauri/src/commands/sessions.rs`
- Modify: `DesktopApp/src-tauri/src/remote/bridge.rs`
- Modify: `DesktopApp/src-tauri/src/remote/startup.rs`

- [ ] **Step 1: Add `history_blocks_for_session` to `commands/sessions.rs`**

Add this function near `roster_snapshot` (it reuses the same helpers `session_dir`, `catch`, `reader`, `projects_repo` already imported in the file):

```rust
/// Read the most-recent history blocks (chronological, capped by the reader at 500)
/// for a session, locating its project by scanning known projects for the matching
/// session file. Used by the remote bridge to answer RequestHistory. Returns empty
/// on any failure so a single bad project never sinks the backfill.
pub fn history_blocks_for_session(
    conn: &r2d2::PooledConnection<r2d2_sqlite::SqliteConnectionManager>,
    session_id: &str,
) -> Vec<crate::domain::HistoryBlock> {
    let projects = match projects_repo::list(conn) { Ok(p) => p, Err(_) => return Vec::new() };
    for proj in projects {
        let dir = match session_dir(&proj) { Ok(d) => d, Err(_) => continue };
        let exists = reader::session_file(&dir, session_id).map(|p| p.exists()).unwrap_or(false);
        if !exists { continue; }
        let pid = proj.id;
        let sid = session_id.to_string();
        if let Ok(h) = catch(move || reader::read_history(pid, &dir, &sid, Some(500), None)) {
            return h.blocks;
        }
    }
    Vec::new()
}
```

- [ ] **Step 2: Add a test for the helper**

In the `#[cfg(test)] mod roster_tests` of `commands/sessions.rs`, add:

```rust
    #[test]
    fn history_blocks_for_unknown_session_is_empty() {
        let p = pool();
        let c = p.get().unwrap();
        let blocks = history_blocks_for_session(&c, "no-such-session");
        assert!(blocks.is_empty());
    }
```

Run: `cargo test --manifest-path DesktopApp/src-tauri/Cargo.toml history_blocks_for_unknown_session`
Expected: PASS.

- [ ] **Step 3: Add the `HistoryProvider` trait + production impl in `bridge.rs`**

After the `RosterProvider` trait (line ~42) add:

```rust
/// Supplies the full history blocks for a session, used to answer RequestHistory.
/// Isolated as a trait so the run loop is testable without a DB/filesystem.
pub trait HistoryProvider: Send + Sync {
    fn history(&self, session_id: &str) -> Vec<crate::domain::session::HistoryBlock>;
}
```

After `AppRosterProvider`'s impl (line ~85) add:

```rust
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
```

(Confirm the `HistoryBlock` path: it is re-exported from `crate::domain` — `crate::domain::session::HistoryBlock` matches the `use crate::domain::session::SessionActivity;` already at the top of the file. If the type lives at `crate::domain::HistoryBlock`, use that path consistently in both the trait and impl.)

- [ ] **Step 4: Add the backfill chunk size constant**

Near `ROSTER_REPUBLISH_SECS` (line ~21) add:

```rust
/// How many history blocks per SessionAppend publish during a RequestHistory backfill.
/// Keeps individual Centrifugo messages well under the server's max size.
const HISTORY_CHUNK_BLOCKS: usize = 20;
```

- [ ] **Step 5: Thread `HistoryProvider` through `run` and handle `RequestHistory`**

Change the `run` signature to accept a history provider (add the parameter after `roster`):

```rust
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
```

In the inbound-command arm, replace the existing `if matches!(env.command, ... RequestRoster) { ... } else { ... }` block with a three-way branch:

```rust
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
```

- [ ] **Step 6: Add a `FakeHistoryProvider` and update existing run-loop tests**

In `#[cfg(test)] mod tests` add a fake near `FakeRosterProvider`:

```rust
    #[derive(Default)]
    struct FakeHistoryProvider {
        blocks: Vec<crate::domain::session::HistoryBlock>,
    }

    impl HistoryProvider for FakeHistoryProvider {
        fn history(&self, _session_id: &str) -> Vec<crate::domain::session::HistoryBlock> {
            self.blocks.clone()
        }
    }
```

Every existing call to `bridge.run(...)` in the tests must pass the new `history` arg. Add this line before each `tokio::spawn(bridge.run(...))` and insert the arg after `roster`:

```rust
        let history: std::sync::Arc<dyn HistoryProvider> = std::sync::Arc::new(FakeHistoryProvider::default());
```

i.e. each spawn becomes:

```rust
        let handle = tokio::spawn(bridge.run("dev-1".into(), rx, bus.subscribe(), client.clone(), actuator, roster, history, None, None));
```

(Apply to all four `#[tokio::test]` run-loop tests: `run_publishes_cmd_result_for_inbound_command`, `run_forwards_bus_event_to_session_channel`, `request_roster_publishes_snapshot_and_ack`, `activity_bus_event_is_mirrored_to_device_channel`. In the first test, `client_for_run` is used instead of `client.clone()` — keep that and just add `history` after `roster`.)

- [ ] **Step 7: Add a RequestHistory run-loop test**

Add a new test. It needs a real `HistoryBlock`; use the `System` variant (simplest, no extra fields beyond the common ones — adjust field names to match `crate::domain::session::HistoryBlock`'s `System` variant: `uuid`, `timestamp`, `subtype`, `message`):

```rust
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
```

(If the `System` variant's field names differ, run `cargo test` once to read the compiler error and adjust — or use whichever `HistoryBlock` variant the domain defines with the fewest fields.)

- [ ] **Step 8: Wire `AppHistoryProvider` in `startup.rs`**

In `DesktopApp/src-tauri/src/remote/startup.rs`, update the import line to include the new items:

```rust
use crate::remote::bridge::{RemoteBridge, AppPtyActuator, AppRosterProvider, AppHistoryProvider, PtyActuator, RosterProvider, HistoryProvider, cmd_channel};
```

Inside the spawned task, after the `roster` line, add:

```rust
        let history: Arc<dyn HistoryProvider> = Arc::new(AppHistoryProvider::new(app_for_actuator.clone()));
```

The `roster` line currently consumes `app_for_actuator` by value (`AppRosterProvider::new(app_for_actuator)`). Change it to clone so both providers can hold a handle:

```rust
        let roster: Arc<dyn RosterProvider> = Arc::new(AppRosterProvider::new(app_for_actuator.clone()));
        let history: Arc<dyn HistoryProvider> = Arc::new(AppHistoryProvider::new(app_for_actuator));
```

Update the `bridge.run(...)` call to pass `history` after `roster`:

```rust
        bridge.run(device_id, conn.inbound, bus_rx, conn.client, actuator, roster, history, cloud, device_secret).await;
```

- [ ] **Step 9: Build + test the whole desktop crate**

Run: `cargo test --manifest-path DesktopApp/src-tauri/Cargo.toml`
Expected: PASS (compiles with the new exhaustive arms; bridge tests including the new RequestHistory test pass).

- [ ] **Step 10: Commit**

```bash
git add DesktopApp/src-tauri/src/commands/sessions.rs DesktopApp/src-tauri/src/remote/bridge.rs DesktopApp/src-tauri/src/remote/startup.rs
git commit -m "feat(remote): backfill session history on RequestHistory via chunked SessionAppend"
```

---

## Task 4: Mobile — sort projects by recent activity

**Files:**
- Modify: `MobileApp/src/lib/roster.ts:23-25`
- Test: `MobileApp/__tests__/lib/roster.test.ts`

- [ ] **Step 1: Write the failing test**

In `MobileApp/__tests__/lib/roster.test.ts` (create if missing; if it exists, add this test inside the existing `describe`):

```ts
import { groupByProject } from '@/src/lib/roster';
import type { Session } from '@/src/store/sessionsSlice';

function session(id: string, projectName: string, lastEventAt: number): Session {
  return { id, title: id, activity: 'idle', usage: null, projectId: 1, projectName, lastEventAt };
}

describe('groupByProject ordering', () => {
  it('orders projects by most-recent activity, newest first', () => {
    const sessions = [
      session('a', 'Alpha', 100),
      session('b', 'Beta', 300),
      session('c', 'Gamma', 200),
    ];
    const sections = groupByProject(sessions);
    expect(sections.map((s) => s.title)).toEqual(['Beta', 'Gamma', 'Alpha']);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `export PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH" && cd MobileApp && npx jest roster`
Expected: FAIL — current code sorts alphabetically → `['Alpha', 'Beta', 'Gamma']`.

- [ ] **Step 3: Change the section sort**

In `MobileApp/src/lib/roster.ts`, replace the final `.sort(...)` in `groupByProject` (line ~25). Current:

```ts
    .sort((a, b) => a.title.localeCompare(b.title));
```

New (each section's `data` is already sorted most-recent-first, so `data[0]` holds its newest `lastEventAt`):

```ts
    .sort((a, b) => (b.data[0]?.lastEventAt ?? 0) - (a.data[0]?.lastEventAt ?? 0));
```

- [ ] **Step 4: Run it to verify it passes**

Run: `export PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH" && cd MobileApp && npx jest roster`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add MobileApp/src/lib/roster.ts MobileApp/__tests__/lib/roster.test.ts
git commit -m "feat(mobile): sort project sections by recent activity"
```

---

## Task 5: Mobile — PermissionPrompt with tool context + third button

**Files:**
- Modify: `MobileApp/src/components/PermissionPrompt.tsx`
- Test: `MobileApp/__tests__/components/PermissionPrompt.test.tsx` (create)

- [ ] **Step 1: Write the failing test**

Create `MobileApp/__tests__/components/PermissionPrompt.test.tsx`:

```tsx
import { render, fireEvent } from '@testing-library/react-native';
import { PermissionPrompt } from '@/src/components/PermissionPrompt';

describe('PermissionPrompt', () => {
  it('renders the tool label and fires all three callbacks', () => {
    const onApprove = jest.fn();
    const onApproveAlways = jest.fn();
    const onDeny = jest.fn();
    const { getByText } = render(
      <PermissionPrompt
        toolLabel="Bash · rm -rf /tmp/x"
        onApprove={onApprove}
        onApproveAlways={onApproveAlways}
        onDeny={onDeny}
      />,
    );
    getByText('Bash · rm -rf /tmp/x');
    fireEvent.press(getByText('Zatwierdź'));
    fireEvent.press(getByText('Zatwierdź i nie pytaj'));
    fireEvent.press(getByText('Odrzuć'));
    expect(onApprove).toHaveBeenCalledTimes(1);
    expect(onApproveAlways).toHaveBeenCalledTimes(1);
    expect(onDeny).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `export PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH" && cd MobileApp && npx jest PermissionPrompt`
Expected: FAIL — `toolLabel`/`onApproveAlways` props and the "Zatwierdź i nie pytaj" button don't exist yet.

- [ ] **Step 3: Update the component**

Replace the contents of `MobileApp/src/components/PermissionPrompt.tsx` with:

```tsx
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { useColorScheme } from 'react-native';
import { resolveTokens } from '@/src/theme/tokens';

interface PermissionPromptProps {
  toolLabel?: string | null;
  onApprove: () => void;
  onApproveAlways: () => void;
  onDeny: () => void;
}

export function PermissionPrompt({ toolLabel, onApprove, onApproveAlways, onDeny }: PermissionPromptProps) {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const t = resolveTokens(scheme);

  return (
    <View style={[styles.card, { backgroundColor: t.bgElev, borderColor: t.accent }]}>
      <Text style={[styles.label, { color: t.accent }]}>⚠ Prośba o zgodę</Text>
      <Text style={[styles.question, { color: t.fg }]}>
        {toolLabel ? `Claude chce użyć: ${toolLabel}` : 'Sesja czeka na Twoją decyzję'}
      </Text>
      <View style={styles.actions}>
        <Pressable onPress={onApprove} style={[styles.btn, { backgroundColor: t.accent }]}>
          <Text style={[styles.btnText, { color: t.accentFg }]}>Zatwierdź</Text>
        </Pressable>
        <Pressable onPress={onDeny} style={[styles.btnOutline, { borderColor: t.danger }]}>
          <Text style={[styles.btnText, { color: t.danger }]}>Odrzuć</Text>
        </Pressable>
      </View>
      <Pressable onPress={onApproveAlways} style={[styles.btnGhost, { borderColor: t.border }]}>
        <Text style={[styles.btnText, { color: t.fg2 }]}>Zatwierdź i nie pytaj</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: 16,
    borderWidth: 1.5,
    padding: 16,
    marginVertical: 6,
  },
  label: {
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    fontFamily: 'monospace',
    marginBottom: 8,
  },
  question: {
    fontSize: 15,
    fontWeight: '500',
    marginBottom: 14,
  },
  actions: {
    flexDirection: 'row',
    gap: 10,
  },
  btn: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 14,
    alignItems: 'center',
  },
  btnOutline: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 14,
    alignItems: 'center',
    borderWidth: 1,
  },
  btnGhost: {
    marginTop: 10,
    paddingVertical: 10,
    borderRadius: 12,
    alignItems: 'center',
    borderWidth: 1,
  },
  btnText: {
    fontSize: 14,
    fontWeight: '600',
  },
});
```

- [ ] **Step 4: Run it to verify it passes**

Run: `export PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH" && cd MobileApp && npx jest PermissionPrompt`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add MobileApp/src/components/PermissionPrompt.tsx MobileApp/__tests__/components/PermissionPrompt.test.tsx
git commit -m "feat(mobile): show tool context and add 'approve always' to PermissionPrompt"
```

---

## Task 6: Mobile — session screen wiring (history request, waitingTool prompt, safe-area, keyboard)

**Files:**
- Modify: `MobileApp/app/session/[id].tsx`

- [ ] **Step 1: Rewrite the screen**

Replace the contents of `MobileApp/app/session/[id].tsx` with the version below. Changes from current: `requestHistory` dispatched on mount; `KeyboardAvoidingView` + `SafeAreaView edges={['top']}`; permission prompt shown on `waitingTool` with the last tool-use label; `handleApproveAlways` added.

```tsx
import { useEffect, useMemo } from 'react';
import { View, Text, FlatList, StyleSheet, useColorScheme, KeyboardAvoidingView, Platform } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams } from 'expo-router';
import { useStore } from '@/src/store';
import { resolveTokens } from '@/src/theme/tokens';
import { HistoryBlockView } from '@/src/components/HistoryBlockView';
import { PermissionPrompt } from '@/src/components/PermissionPrompt';
import { CommandBar } from '@/src/components/CommandBar';
import { dispatchCommand } from '@/src/lib/dispatch';
import type { HistoryBlock } from '@/src/types/HistoryBlock';

export default function SessionScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const t = resolveTokens(scheme);

  const phoneToken = useStore((s) => s.phoneToken);

  // Subscribe to the session channel on mount, then ask the desktop to backfill the
  // full history (the watcher only publishes NEW blocks, so without this request a
  // freshly-opened session shows nothing). connect() is idempotent and synchronously
  // creates the handles, so deep-linking straight here still opens a working subscription.
  useEffect(() => {
    useStore.getState().connect();
    const h = useStore.getState().handles;
    const sub = h?.subscribeSession(id, useStore.getState().applySessionEvent);
    if (phoneToken) {
      void dispatchCommand(phoneToken, { type: 'requestHistory', sessionId: id });
    }
    return () => { sub?.unsubscribe(); };
  }, [id, phoneToken]);

  const title = useStore((s) => s.sessions.get(id)?.title ?? null);
  const activity = useStore((s) => s.sessions.get(id)?.activity ?? null);
  const historyMap = useStore((s) => s.history);
  const blocks = useMemo(() => historyMap.get(id) ?? [], [historyMap, id]);

  const isPermission = activity === 'waitingTool';

  const toolLabel = useMemo(() => {
    for (let i = blocks.length - 1; i >= 0; i--) {
      const b = blocks[i];
      if (b.kind === 'toolUse') {
        return `${b.name}${b.input_summary ? ` · ${b.input_summary}` : ''}`;
      }
    }
    return null;
  }, [blocks]);

  function activityLine(): string {
    switch (activity) {
      case 'running': return 'Claude pracuje…';
      case 'waitingUser': return 'Czeka na Twoją odpowiedź';
      case 'waitingTool': return 'Prośba o zgodę';
      case 'idle': return 'Bezczynna';
      default: return '';
    }
  }

  function handleSend(text: string) {
    if (!phoneToken) return;
    void dispatchCommand(phoneToken, { type: 'sendPrompt', sessionId: id, text });
  }

  function handleStop() {
    if (!phoneToken) return;
    void dispatchCommand(phoneToken, { type: 'stopSession', sessionId: id });
  }

  function handleApprove() {
    if (!phoneToken) return;
    void dispatchCommand(phoneToken, { type: 'approvePermission', sessionId: id });
  }

  function handleApproveAlways() {
    if (!phoneToken) return;
    void dispatchCommand(phoneToken, { type: 'approveAlwaysPermission', sessionId: id });
  }

  function handleDeny() {
    if (!phoneToken) return;
    void dispatchCommand(phoneToken, { type: 'denyPermission', sessionId: id });
  }

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: t.bg }]} edges={['top']}>
      <View style={[styles.header, { borderBottomColor: t.border, backgroundColor: t.bgElev }]}>
        <Text style={[styles.headerTitle, { color: t.fg }]} numberOfLines={1}>
          {title ?? 'Sesja'}
        </Text>
        {activity != null && (
          <Text style={[styles.headerActivity, { color: activity === 'running' ? t.success : t.fg2 }]}>
            {activityLine()}
          </Text>
        )}
      </View>

      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <FlatList<HistoryBlock>
          data={blocks}
          keyExtractor={(item) => item.uuid}
          contentContainerStyle={styles.listContent}
          renderItem={({ item }) => <HistoryBlockView block={item} />}
          ListEmptyComponent={
            <Text style={[styles.emptyText, { color: t.muted }]}>Brak historii</Text>
          }
        />

        {isPermission && (
          <View style={styles.permWrap}>
            <PermissionPrompt
              toolLabel={toolLabel}
              onApprove={handleApprove}
              onApproveAlways={handleApproveAlways}
              onDeny={handleDeny}
            />
          </View>
        )}

        <CommandBar onSend={handleSend} onStop={handleStop} />
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  flex: {
    flex: 1,
  },
  header: {
    paddingHorizontal: 18,
    paddingTop: 14,
    paddingBottom: 12,
    borderBottomWidth: 1,
  },
  headerTitle: {
    fontSize: 17,
    fontWeight: '600',
    letterSpacing: -0.2,
  },
  headerActivity: {
    fontSize: 13,
    marginTop: 3,
  },
  listContent: {
    paddingHorizontal: 14,
    paddingTop: 12,
    paddingBottom: 8,
  },
  emptyText: {
    textAlign: 'center',
    marginTop: 40,
    fontSize: 14,
  },
  permWrap: {
    paddingHorizontal: 14,
  },
});
```

- [ ] **Step 2: Type-check**

Run: `export PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH" && cd MobileApp && npm run lint`
Expected: exit 0. (Confirms `requestHistory`/`approveAlwaysPermission` are in the regenerated `RemoteCommand` union and that `react-native-safe-area-context` types resolve.)

- [ ] **Step 3: Run the full mobile test suite**

Run: `export PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH" && cd MobileApp && npm test`
Expected: PASS (existing + new roster/PermissionPrompt tests).

- [ ] **Step 4: Commit**

```bash
git add MobileApp/app/session/[id].tsx
git commit -m "feat(mobile): request history on open, permission prompt on waitingTool, safe-area + keyboard"
```

---

## Task 7: Final verification

- [ ] **Step 1: Rust — full desktop + contract crates green**

Run: `cargo test --manifest-path crates/abeon-remote-core/Cargo.toml && cargo test --manifest-path DesktopApp/src-tauri/Cargo.toml`
Expected: PASS. Confirm `git status DesktopApp/src/types MobileApp/src/types` shows no UNcommitted type drift (only `RemoteCommand.ts`, already committed in Task 1).

- [ ] **Step 2: Mobile — lint + tests green**

Run: `export PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH" && cd MobileApp && npm run lint && npm test`
Expected: both exit 0.

- [ ] **Step 3: Manual on-device checklist (record results, do not auto-claim done)**

When a build is available (`eas build` / dev client), verify against a desktop that is online and remote-bridge-enabled:
1. Open a session with prior conversation → history populates within ~1s (RequestHistory backfill).
2. While `running`, new blocks append live.
3. Claude asks a free-text question (`waitingUser`) → typing an answer in the command bar reaches the session.
4. Claude requests a tool permission (`waitingTool`) → prompt shows the tool label; **Zatwierdź** and **Odrzuć** behave correctly; verify **Zatwierdź i nie pytaj** against a real 3-option menu (spec risk note — if it mis-selects, restrict to two buttons or revisit keystrokes).
5. Header does not overlap the status bar; command bar is not covered by the keyboard.
6. Project order matches the desktop's `activity` sort mode.

---

## Self-Review notes

- **Spec coverage:** pkt 1 → Tasks 1,3,6 (RequestHistory + backfill + mobile request). pkt 2 → Task 6 (`waitingUser` activity line + CommandBar). pkt 3 → Tasks 1,2,5,6 (ApproveAlwaysPermission + prompt on `waitingTool` + tool label + 3 buttons). pkt 4 → Task 6 (SafeArea + KeyboardAvoidingView). pkt 5 → Task 4 (activity sort).
- **Type consistency:** `RemoteCommand` tags `requestHistory` / `approveAlwaysPermission` match between Rust round-trip tests and mobile dispatch calls. `HistoryProvider::history` signature is identical in trait, prod impl, and fake. `PermissionPrompt` prop names (`toolLabel`, `onApprove`, `onApproveAlways`, `onDeny`) match between component, test, and caller.
- **Known assumptions to verify during execution:** the `HistoryBlock` import path (`crate::domain::session::HistoryBlock` vs `crate::domain::HistoryBlock`) and the `System` variant field names (Step 7, Task 3) — resolve from the compiler if they differ. The `ApproveAlwaysPermission` keystroke (`\x1b[B\r`) is a documented best-effort assumption pending on-device confirmation.
```
