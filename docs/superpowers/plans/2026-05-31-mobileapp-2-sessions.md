# MobileApp #2 — Sessions & Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the paired MobileApp show the live session list and a session's live history, and send high-level commands (prompt / approve / deny / stop / resume) — by subscribing read-only to Centrifugo and routing commands through CloudService.

**Architecture:** Promote the desktop's per-session mirror events into a **typed `SessionEvent`** so the phone consumes them type-safely (reusing the existing `HistoryBlock` / `SessionActivity` / `UsageSummary` TS types). A `centrifuge` wrapper subscribes to `abeon-cloud-sess:<id>` (session mirror) and `abeon-cloud-dev:<deviceId>` (cmdResult acks); inbound events drive a Zustand `sessionsSlice`; screens render from the store; UI actions build a `RemoteEnvelope` and `POST /v1/command`. Reconnect resyncs via Centrifugo channel history.

**Tech Stack:** Expo SDK 56 · expo-router · Zustand v5 · `centrifuge` v5 · ts-rs 11 (Rust) · Jest (`jest-expo/web`).

> **Read `MobileApp/CLAUDE.md` first** (Node 22, `jest-expo/web` preset, jest 30.4.0 pin, `@/` alias, ts-rs `export_to_string` mechanism). Builds on Plan 1 (merged): `@/src/lib/api` (`sendCommand`), `@/src/store` (`useStore`, `createStore`), `@/src/theme/tokens`, `@/src/types/Remote*`.

## Findings this plan acts on (from code reading)

1. **Session mirror events are untyped today.** `DesktopApp/src-tauri/src/remote/bridge.rs::encode_bus_event` publishes ad-hoc JSON; `remote/bus.rs::SessionBusEvent` carries `serde_json::Value` for `blocks`/`activity`/`summary`. The concrete payloads already have typed, ts-rs-exported sources: `HistoryBlock` (`DesktopApp/src-tauri/src/domain/session.rs`), `SessionActivity` (same file), `UsageSummary`/`TokenTotals`/`ModelUsage` (`domain/usage.rs`).
2. **Double-wrap bug:** `sessions/watcher.rs` sets the bus `Append.blocks` to `json!({ "blocks": blocks })`, and `encode_bus_event` nests it again → the wire is `{ "blocks": { "blocks": [...] } }`. This plan flattens it to `blocks: Vec<HistoryBlock>` when typing.
3. **Wire shapes** (current, camelCase, `type`-tagged): `{type:"sessionAppend",sessionId,blocks}`, `{type:"sessionActivity",sessionId,activity:"running"|"waitingUser"|"waitingTool"|"idle"}`, `{type:"sessionTitle",sessionId,title}`, `{type:"sessionUsage",sessionId,summary:{tokens,costUsd,byModel,unknownModels}}`. cmdResult on the dev channel: `{type:"cmdResult",commandId,ok,error?}`.
4. **`centrifuge` v5 API:** `new Centrifuge(url, { token, getToken })`; `client.newSubscription(channel)` → `sub.on('publication', ctx => ctx.data)`, `sub.subscribe()`; `sub.history({ limit, since })` → `{ publications: [{data}], offset, epoch }`; client events `connecting|connected|disconnected|error`; `sub.on('subscribed', ctx => ctx.recovered / ctx.streamPosition)`.

## File Structure

```
crates/abeon-remote-core/src/protocol.rs   # (no change) Remote* stay here
DesktopApp/src-tauri/src/
  domain/session_event.rs   # NEW: typed SessionEvent enum (reuses HistoryBlock/SessionActivity/UsageSummary)
  remote/bus.rs             # MODIFY: SessionBusEvent carries typed payloads
  remote/bridge.rs          # MODIFY: encode_bus_event serializes SessionEvent
  sessions/watcher.rs       # MODIFY: build typed events; fix the double-wrap
MobileApp/
  src/types/                # ts-rs OUTPUT gains SessionEvent.ts + HistoryBlock.ts + SessionActivity.ts + UsageSummary.ts + TokenTotals.ts + ModelUsage.ts
  src/lib/
    centrifugo.ts           # NEW: connect + subscribe + parse + history backfill
    commands.ts             # NEW: RemoteEnvelope builders + command id generation
  src/store/
    sessionsSlice.ts        # NEW: sessions map + history map + event reducers
    connectionSlice.ts      # NEW: centrifuge lifecycle + token refresh + resync
    index.ts                # MODIFY: compose the new slices
  app/(tabs)/
    sessions.tsx            # MODIFY: real session list
    activity.tsx            # MODIFY: items needing attention (waitingUser)
  app/session/[id].tsx      # NEW: live history + command bar
  src/components/
    SessionCard.tsx, HistoryBlockView.tsx, CommandBar.tsx, PermissionPrompt.tsx   # NEW
  __tests__/                # sessionsSlice, commands, centrifugo-parse, connection specs
```

---

## Task 1: Typed `SessionEvent` (Rust) + export to MobileApp + bridge emits it

**Files:**
- Create: `DesktopApp/src-tauri/src/domain/session_event.rs`
- Modify: `DesktopApp/src-tauri/src/domain/mod.rs` (add `pub mod session_event;`), `remote/bus.rs`, `remote/bridge.rs`, `sessions/watcher.rs`
- Test/generate: a ts-rs export test writing into `MobileApp/src/types/`

> Use Node-free `cargo` here. The desktop `#[derive(TS)]` exports go to `DesktopApp/src/types/` during `cargo test` (per DesktopApp/CLAUDE.md). The MobileApp copy uses the `export_to_string()` pattern (see Plan 1 Task 3 / MobileApp CLAUDE.md).

- [ ] **Step 1: Define the typed enum.** `DesktopApp/src-tauri/src/domain/session_event.rs`:

```rust
use serde::{Deserialize, Serialize};
use ts_rs::TS;
use crate::domain::session::{HistoryBlock, SessionActivity};
use crate::domain::usage::UsageSummary;

/// The per-session mirror events the bridge publishes to `abeon-cloud-sess:<id>`.
/// Typed so the mobile app consumes them safely. Wire format is camelCase, `type`-tagged.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/types/")]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum SessionEvent {
    SessionAppend { session_id: String, blocks: Vec<HistoryBlock> },
    SessionActivity { session_id: String, activity: SessionActivity },
    SessionTitle { session_id: String, title: String },
    SessionUsage { session_id: String, summary: UsageSummary },
}
```

- [ ] **Step 2: Write a failing round-trip test** (bottom of `session_event.rs`):

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_append_wire_is_flat_blocks() {
        let ev = SessionEvent::SessionAppend {
            session_id: "s1".into(),
            blocks: vec![HistoryBlock::UserText { uuid: "u1".into(), timestamp: 1, text: "hi".into() }],
        };
        let json = serde_json::to_value(&ev).unwrap();
        assert_eq!(json["type"], "sessionAppend");
        assert_eq!(json["sessionId"], "s1");
        assert!(json["blocks"].is_array(), "blocks must be a flat array, not double-wrapped");
        assert_eq!(json["blocks"][0]["kind"], "userText");
    }

    #[test]
    fn activity_wire_is_scalar_string() {
        let ev = SessionEvent::SessionActivity { session_id: "s1".into(), activity: SessionActivity::WaitingUser };
        let json = serde_json::to_value(&ev).unwrap();
        assert_eq!(json["type"], "sessionActivity");
        assert_eq!(json["activity"], "waitingUser");
    }
}
```

- [ ] **Step 3: Run, expect compile/fail.** `cargo test --manifest-path DesktopApp/src-tauri/Cargo.toml session_event` → FAIL (module not wired / assertions). Wire `pub mod session_event;` in `domain/mod.rs`, fix until both tests pass.

- [ ] **Step 4: Make the bus carry typed payloads.** In `remote/bus.rs`, change `SessionBusEvent` to the typed shape:

```rust
use crate::domain::session::{HistoryBlock, SessionActivity};
use crate::domain::usage::UsageSummary;

#[derive(Debug, Clone, PartialEq)]
pub enum SessionBusEvent {
    Append { session_id: String, blocks: Vec<HistoryBlock> },
    Activity { session_id: String, activity: SessionActivity },
    Title { session_id: String, title: String },
    Usage { session_id: String, summary: UsageSummary },
}
```
(Their existing `bus.rs` tests use `Title`; keep those compiling. `HistoryBlock`/`UsageSummary` derive `Clone`; confirm `PartialEq` — if `UsageSummary` lacks `PartialEq`, derive it there or drop `PartialEq` from `SessionBusEvent` and adjust the bus test to compare via serialization.)

- [ ] **Step 5: `encode_bus_event` builds a typed `SessionEvent` and serializes it.** In `remote/bridge.rs`:

```rust
use crate::domain::session_event::SessionEvent;

fn encode_bus_event(event: SessionBusEvent) -> (String, serde_json::Value) {
    let (session_id, ev) = match event {
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
```
Update the existing `bridge.rs` test `run_forwards_bus_event_to_session_channel` if its assertion shape changed (it checks `published[0].1["type"] == "sessionTitle"` — still true).

- [ ] **Step 6: Fix the producer (watcher) to pass flat typed values.** In `sessions/watcher.rs`, where it currently does `json!({ "blocks": blocks })` and `serde_json::to_value(new_activity)`, pass the typed values directly: `SessionBusEvent::Append { session_id: sid, blocks }` (the `Vec<HistoryBlock>`), `SessionBusEvent::Activity { session_id: sid, activity: new_activity }`, `SessionBusEvent::Usage { session_id: sid, summary }`. Leave the local `app.emit("session:{sid}:*")` Tauri events as-is (those feed the desktop UI and are out of scope) — only the bus payloads change.

- [ ] **Step 7: Run the desktop suite.** `cargo test --manifest-path DesktopApp/src-tauri/Cargo.toml` → all green. Confirm `git status DesktopApp/src/types` shows new `SessionEvent.ts` (and that `HistoryBlock.ts`/`SessionActivity.ts`/`UsageSummary.ts`/`TokenTotals.ts`/`ModelUsage.ts` exist there already).

- [ ] **Step 8: Export `SessionEvent` + dependencies into MobileApp.** Add a test in `crates/abeon-remote-core`? No — `SessionEvent` lives in DesktopApp, so add the mobile-export test in `DesktopApp/src-tauri/src/domain/session_event.rs`:

```rust
    #[test]
    fn export_session_event_to_mobile_app() {
        use ts_rs::TS;
        use crate::domain::session::{HistoryBlock, SessionActivity};
        use crate::domain::usage::{UsageSummary, TokenTotals, ModelUsage};
        // export_to_string renders the exact ts-rs bytes (incl. the ./Dep imports);
        // write SessionEvent and each dependency it imports into the mobile types dir.
        // Path is relative to the crate manifest dir (DesktopApp/src-tauri) under `cargo test`.
        let dir = std::path::Path::new("../../MobileApp/src/types");
        std::fs::create_dir_all(dir).unwrap();
        for (name, body) in [
            ("SessionEvent", SessionEvent::export_to_string().unwrap()),
            ("HistoryBlock", HistoryBlock::export_to_string().unwrap()),
            ("SessionActivity", SessionActivity::export_to_string().unwrap()),
            ("UsageSummary", UsageSummary::export_to_string().unwrap()),
            ("TokenTotals", TokenTotals::export_to_string().unwrap()),
            ("ModelUsage", ModelUsage::export_to_string().unwrap()),
        ] {
            std::fs::write(dir.join(format!("{name}.ts")), body).unwrap();
        }
    }
```
Run `cargo test --manifest-path DesktopApp/src-tauri/Cargo.toml export_session_event_to_mobile_app`. Then verify the six `.ts` files appear under `MobileApp/src/types/` and `diff` each against `DesktopApp/src/types/<name>.ts` (identical). Adjust the relative path if files land elsewhere (same empirical check as Plan 1 Task 3), leaving no stray dirs.

- [ ] **Step 9: Commit.**
```bash
git add DesktopApp/src-tauri/src/domain/session_event.rs DesktopApp/src-tauri/src/domain/mod.rs \
  DesktopApp/src-tauri/src/remote/bus.rs DesktopApp/src-tauri/src/remote/bridge.rs \
  DesktopApp/src-tauri/src/sessions/watcher.rs DesktopApp/src/types MobileApp/src/types
git commit -m "feat(remote): type per-session mirror events as SessionEvent; export to MobileApp"
```

---

## Task 2: Centrifugo client wrapper (`src/lib/centrifugo.ts`)

**Files:**
- Create: `MobileApp/src/lib/centrifugo.ts`, `MobileApp/__tests__/centrifugo.test.ts`

The wrapper is split so the **parsing** (pure) is unit-tested without the real socket.

- [ ] **Step 1: Failing test for the pure parser.** `MobileApp/__tests__/centrifugo.test.ts`:

```ts
import { parseSessionEvent, parseDeviceEvent } from '@/src/lib/centrifugo';

test('parses a sessionAppend publication into a typed event', () => {
  const ev = parseSessionEvent({ type: 'sessionAppend', sessionId: 's1', blocks: [{ kind: 'userText', uuid: 'u', timestamp: 1, text: 'hi' }] });
  expect(ev).toEqual({ type: 'sessionAppend', sessionId: 's1', blocks: [{ kind: 'userText', uuid: 'u', timestamp: 1, text: 'hi' }] });
});

test('parses sessionActivity', () => {
  expect(parseSessionEvent({ type: 'sessionActivity', sessionId: 's1', activity: 'waitingUser' }))
    .toEqual({ type: 'sessionActivity', sessionId: 's1', activity: 'waitingUser' });
});

test('returns null for an unknown session event type', () => {
  expect(parseSessionEvent({ type: 'somethingElse' })).toBeNull();
});

test('parses a cmdResult device event', () => {
  expect(parseDeviceEvent({ type: 'cmdResult', commandId: 'c1', ok: true }))
    .toEqual({ type: 'cmdResult', commandId: 'c1', ok: true });
});
```

- [ ] **Step 2: Run, expect FAIL** (`npx jest centrifugo`).

- [ ] **Step 3: Implement parser + client factory.** `MobileApp/src/lib/centrifugo.ts`:

```ts
import { Centrifuge, type Subscription } from 'centrifuge';
import { CENTRIFUGO_WS_URL } from '@/src/lib/config';
import type { SessionEvent } from '@/src/types/SessionEvent';
import type { RemoteEvent } from '@/src/types/RemoteEvent';

const SESSION_TYPES = new Set(['sessionAppend', 'sessionActivity', 'sessionTitle', 'sessionUsage']);

export function parseSessionEvent(data: unknown): SessionEvent | null {
  if (data && typeof data === 'object' && SESSION_TYPES.has((data as { type?: string }).type ?? '')) {
    return data as SessionEvent;
  }
  return null;
}

export function parseDeviceEvent(data: unknown): RemoteEvent | null {
  if (data && typeof data === 'object' && (data as { type?: string }).type === 'cmdResult') {
    return data as RemoteEvent;
  }
  return null;
}

export interface CentrifugoHandles {
  client: Centrifuge;
  subscribeSession: (sessionId: string, onEvent: (e: SessionEvent) => void) => Subscription;
  subscribeDevice: (deviceId: string, onEvent: (e: RemoteEvent) => void) => Subscription;
  disconnect: () => void;
}

// getToken is called by centrifuge whenever it needs a (fresh) connection JWT.
export function createCentrifugo(getToken: () => Promise<string>): CentrifugoHandles {
  const client = new Centrifuge(CENTRIFUGO_WS_URL, { getToken: async () => getToken() });
  const subscribeSession = (sessionId: string, onEvent: (e: SessionEvent) => void) => {
    const sub = client.newSubscription(`abeon-cloud-sess:${sessionId}`);
    sub.on('publication', (ctx) => { const e = parseSessionEvent(ctx.data); if (e) onEvent(e); });
    sub.subscribe();
    return sub;
  };
  const subscribeDevice = (deviceId: string, onEvent: (e: RemoteEvent) => void) => {
    const sub = client.newSubscription(`abeon-cloud-dev:${deviceId}`);
    sub.on('publication', (ctx) => { const e = parseDeviceEvent(ctx.data); if (e) onEvent(e); });
    sub.subscribe();
    return sub;
  };
  client.connect();
  return { client, subscribeSession, subscribeDevice, disconnect: () => client.disconnect() };
}
```

- [ ] **Step 4: Run, expect PASS** (`npx jest centrifugo`, 4 tests). Verify `npm run lint` exits 0 (the `centrifuge` types must resolve — it's installed).

- [ ] **Step 5: Commit.**
```bash
git add MobileApp/src/lib/centrifugo.ts MobileApp/__tests__/centrifugo.test.ts
git commit -m "feat(mobile): add centrifuge client wrapper and event parsers"
```

---

## Task 3: Command builders (`src/lib/commands.ts`)

**Files:**
- Create: `MobileApp/src/lib/commands.ts`, `MobileApp/__tests__/commands.test.ts`

- [ ] **Step 1: Failing test.** `MobileApp/__tests__/commands.test.ts`:

```ts
import { buildEnvelope } from '@/src/lib/commands';

test('builds a sendPrompt envelope with a command id', () => {
  const env = buildEnvelope({ type: 'sendPrompt', sessionId: 's1', text: 'go' }, () => 'cid-1');
  expect(env).toEqual({ commandId: 'cid-1', command: { type: 'sendPrompt', sessionId: 's1', text: 'go' } });
});

test('builds an approvePermission envelope', () => {
  const env = buildEnvelope({ type: 'approvePermission', sessionId: 's1' }, () => 'cid-2');
  expect(env.command).toEqual({ type: 'approvePermission', sessionId: 's1' });
  expect(env.commandId).toBe('cid-2');
});
```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement.** `MobileApp/src/lib/commands.ts`:

```ts
import type { RemoteCommand } from '@/src/types/RemoteCommand';
import type { RemoteEnvelope } from '@/src/types/RemoteEnvelope';

// Injectable id generator keeps this pure/testable; production passes a uuid.
export function buildEnvelope(command: RemoteCommand, genId: () => string): RemoteEnvelope {
  return { commandId: genId(), command };
}
```
(Production callers generate the id with `expo-crypto`'s `randomUUID()` or `globalThis.crypto.randomUUID()`. Add that at the call site in Task 6, not here.)

- [ ] **Step 4: Run, expect PASS.** **Step 5: Commit** `feat(mobile): add RemoteEnvelope command builder`.

---

## Task 4: `sessionsSlice` (Zustand)

**Files:**
- Create: `MobileApp/src/store/sessionsSlice.ts`, `MobileApp/__tests__/sessionsSlice.test.ts`
- Modify: `MobileApp/src/store/index.ts` (compose the slice)

- [ ] **Step 1: Failing test.** `MobileApp/__tests__/sessionsSlice.test.ts`:

```ts
import { createStore } from '@/src/store';

test('applySessionEvent(sessionTitle) upserts a session with the title', () => {
  const s = createStore();
  s.getState().applySessionEvent({ type: 'sessionTitle', sessionId: 's1', title: 'Refaktor' });
  expect(s.getState().sessions.get('s1')?.title).toBe('Refaktor');
});

test('applySessionEvent(sessionActivity) updates status', () => {
  const s = createStore();
  s.getState().applySessionEvent({ type: 'sessionActivity', sessionId: 's1', activity: 'waitingUser' });
  expect(s.getState().sessions.get('s1')?.activity).toBe('waitingUser');
});

test('applySessionEvent(sessionAppend) appends history blocks in order', () => {
  const s = createStore();
  s.getState().applySessionEvent({ type: 'sessionAppend', sessionId: 's1', blocks: [{ kind: 'userText', uuid: 'a', timestamp: 1, text: 'x' }] });
  s.getState().applySessionEvent({ type: 'sessionAppend', sessionId: 's1', blocks: [{ kind: 'assistantText', uuid: 'b', timestamp: 2, text: 'y' }] });
  expect(s.getState().history.get('s1')?.map((b) => b.uuid)).toEqual(['a', 'b']);
});

test('applySessionEvent(sessionUsage) stores the summary', () => {
  const s = createStore();
  const summary = { tokens: { input: 1, output: 2, cacheWrite: 0, cacheRead: 0 }, costUsd: 0.1, byModel: [], unknownModels: [] };
  s.getState().applySessionEvent({ type: 'sessionUsage', sessionId: 's1', summary });
  expect(s.getState().sessions.get('s1')?.usage?.costUsd).toBe(0.1);
});

test('append de-dupes by block uuid (history replay safe)', () => {
  const s = createStore();
  const blk = { kind: 'userText', uuid: 'a', timestamp: 1, text: 'x' } as const;
  s.getState().applySessionEvent({ type: 'sessionAppend', sessionId: 's1', blocks: [blk] });
  s.getState().applySessionEvent({ type: 'sessionAppend', sessionId: 's1', blocks: [blk] });
  expect(s.getState().history.get('s1')?.length).toBe(1);
});
```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement.** `MobileApp/src/store/sessionsSlice.ts`:

```ts
import type { StateCreator } from 'zustand';
import type { SessionEvent } from '@/src/types/SessionEvent';
import type { HistoryBlock } from '@/src/types/HistoryBlock';
import type { SessionActivity } from '@/src/types/SessionActivity';
import type { UsageSummary } from '@/src/types/UsageSummary';

export interface Session {
  id: string;
  title: string | null;
  activity: SessionActivity | null;
  usage: UsageSummary | null;
  lastEventAt: number;
}

export interface SessionsSlice {
  sessions: Map<string, Session>;
  history: Map<string, HistoryBlock[]>;
  applySessionEvent: (e: SessionEvent) => void;
  resetSessions: () => void;
}

function upsert(map: Map<string, Session>, id: string): Session {
  const cur = map.get(id) ?? { id, title: null, activity: null, usage: null, lastEventAt: 0 };
  return cur;
}

export const createSessionsSlice: StateCreator<SessionsSlice, [], [], SessionsSlice> = (set, get) => ({
  sessions: new Map(),
  history: new Map(),
  resetSessions: () => set({ sessions: new Map(), history: new Map() }),
  applySessionEvent: (e) => {
    const sessions = new Map(get().sessions);
    const history = new Map(get().history);
    const s = { ...upsert(sessions, e.sessionId), lastEventAt: Date.now() };
    switch (e.type) {
      case 'sessionTitle': s.title = e.title; break;
      case 'sessionActivity': s.activity = e.activity; break;
      case 'sessionUsage': s.usage = e.summary; break;
      case 'sessionAppend': {
        const prev = history.get(e.sessionId) ?? [];
        const seen = new Set(prev.map((b) => b.uuid));
        const next = [...prev, ...e.blocks.filter((b) => !seen.has(b.uuid))];
        history.set(e.sessionId, next);
        break;
      }
    }
    sessions.set(e.sessionId, s);
    set({ sessions, history });
  },
});
```
`MobileApp/src/store/index.ts` — compose: `export type AppState = AuthSlice & SessionsSlice & ConnectionSlice;` and spread `createSessionsSlice` into both `createStore()` and `useStore` (ConnectionSlice added in Task 5).

> `Date.now()` is fine in app/runtime code (this is React Native, not a workflow script). Tests assert relative ordering/length, not exact timestamps.

- [ ] **Step 4: Run, expect PASS (5 tests).** **Step 5: Commit** `feat(mobile): add sessions slice with typed event reducers`.

---

## Task 5: `connectionSlice` — centrifuge lifecycle + token refresh + resync

**Files:**
- Create: `MobileApp/src/store/connectionSlice.ts`, `MobileApp/__tests__/connectionSlice.test.ts`
- Modify: `MobileApp/src/store/index.ts`

The slice owns connection STATE and the `getToken` strategy; it depends on `@/src/lib/api`'s `fetchToken` and `@/src/lib/centrifugo`'s `createCentrifugo`. Tests mock both.

- [ ] **Step 1: Failing test.** `MobileApp/__tests__/connectionSlice.test.ts`:

```ts
jest.mock('@/src/lib/api', () => ({ fetchToken: jest.fn(async () => ({ token: 'jwt_1', expiresInSecs: 3600 })) }));
const fakeHandles = { client: {}, subscribeSession: jest.fn(), subscribeDevice: jest.fn(), disconnect: jest.fn() };
jest.mock('@/src/lib/centrifugo', () => ({ createCentrifugo: jest.fn(() => fakeHandles) }));

import { createStore } from '@/src/store';
import { fetchToken } from '@/src/lib/api';
import { createCentrifugo } from '@/src/lib/centrifugo';

beforeEach(() => jest.clearAllMocks());

test('connect() requires a paired token and opens centrifuge', async () => {
  const s = createStore();
  await s.getState().pair({ phoneToken: 'pt_1', deviceId: 'dev_1' });
  s.getState().connect();
  expect(createCentrifugo).toHaveBeenCalledTimes(1);
  // the getToken passed to createCentrifugo fetches a fresh JWT with the phoneToken
  const getToken = (createCentrifugo as jest.Mock).mock.calls[0][0];
  expect(await getToken()).toBe('jwt_1');
  expect(fetchToken).toHaveBeenCalledWith('pt_1');
  expect(fakeHandles.subscribeDevice).toHaveBeenCalledWith('dev_1', expect.any(Function));
});

test('disconnect() tears down the client', async () => {
  const s = createStore();
  await s.getState().pair({ phoneToken: 'pt_1', deviceId: 'dev_1' });
  s.getState().connect();
  s.getState().disconnect();
  expect(fakeHandles.disconnect).toHaveBeenCalled();
});
```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement.** `MobileApp/src/store/connectionSlice.ts`:

```ts
import type { StateCreator } from 'zustand';
import { fetchToken } from '@/src/lib/api';
import { createCentrifugo, type CentrifugoHandles } from '@/src/lib/centrifugo';
import type { AuthSlice } from '@/src/store/authSlice';
import type { SessionsSlice } from '@/src/store/sessionsSlice';

export interface ConnectionSlice {
  connectionStatus: 'idle' | 'connecting' | 'connected' | 'disconnected';
  handles: CentrifugoHandles | null;
  connect: () => void;
  disconnect: () => void;
}

type Deps = AuthSlice & SessionsSlice & ConnectionSlice;

export const createConnectionSlice: StateCreator<Deps, [], [], ConnectionSlice> = (set, get) => ({
  connectionStatus: 'idle',
  handles: null,
  connect: () => {
    const { phoneToken, deviceId, handles } = get();
    if (!phoneToken || !deviceId || handles) return;
    const getToken = async () => (await fetchToken(phoneToken)).token;
    const h = createCentrifugo(getToken);
    h.subscribeDevice(deviceId, () => { /* cmdResult acks; Task 6 wires UI feedback */ });
    set({ handles: h, connectionStatus: 'connecting' });
  },
  disconnect: () => {
    get().handles?.disconnect();
    set({ handles: null, connectionStatus: 'disconnected' });
  },
});
```
Compose into `index.ts` (`AppState = AuthSlice & SessionsSlice & ConnectionSlice`). Session-channel subscriptions are opened lazily when a session screen mounts (Task 6) via `get().handles?.subscribeSession(id, get().applySessionEvent)`.

> Reconnect/resync: `centrifuge` auto-reconnects and recovers history when the channel has history enabled; on `subscribed` with `recovered === false`, call `sub.history({ limit: 100 })` and feed each `pub.data` through `applySessionEvent` (the slice already de-dupes by block uuid, so replay is safe). Wire this inside `subscribeSession` in `centrifugo.ts` as a follow-up step in Task 8.

- [ ] **Step 4: Run, expect PASS.** **Step 5: Commit** `feat(mobile): add connection slice (centrifuge lifecycle + token refresh)`.

---

## Task 6: Session list + live history + commands (screens)

**Files:**
- Create: `MobileApp/src/components/SessionCard.tsx`, `HistoryBlockView.tsx`, `CommandBar.tsx`, `PermissionPrompt.tsx`, `MobileApp/app/session/[id].tsx`
- Modify: `MobileApp/app/(tabs)/sessions.tsx`, `MobileApp/app/(tabs)/activity.tsx`

> Components render from the store and use `resolveTokens(useColorScheme())`. Follow the v2 mockup (`MobileApp/design/v2-evolution.html`): gold accent, session cards with status glow + usage, inline approve/deny on the waiting card, floating command bar. Select store fields **individually**. UI text Polish.

- [ ] **Step 1: Session list.** `app/(tabs)/sessions.tsx` reads `useStore((s) => s.sessions)` (a Map — wrap render in `useMemo(() => [...sessions.values()], [sessions])`; the Map reference changes on each event so this is stable enough), renders a `FlatList` of `SessionCard`. A card shows title, activity glow (running=success, waitingUser=accent pulsing, idle=muted), model/usage from `usage`, and — when `activity === 'waitingUser'` — inline **Zatwierdź / Odrzuć** buttons that call the approve/deny command (Step 3). Tapping a card routes to `/session/${id}`.

- [ ] **Step 2: Live history.** `app/session/[id].tsx` uses `useLocalSearchParams()` for `id`; on mount subscribes the session channel (`useEffect(() => { const sub = useStore.getState().handles?.subscribeSession(id, useStore.getState().applySessionEvent); return () => sub?.unsubscribe(); }, [id])`); renders `useStore((s) => s.history.get(id) ?? [])` via `HistoryBlockView` (one renderer per `kind`: userText bubble, assistantText, assistantThinking (muted/italic), toolUse (mono "✎ name · input_summary"), toolResult (mono, danger if is_error), system, attachment). Shows the activity line ("Claude pracuje…" when running) and a `PermissionPrompt` when `activity === 'waitingUser'`. Bottom: `CommandBar`.

- [ ] **Step 3: Commands.** `CommandBar` has a text input + send (sendPrompt) and the quick actions. Wire a helper that builds the envelope and posts it:
```tsx
import { buildEnvelope } from '@/src/lib/commands';
import { sendCommand } from '@/src/lib/api';
import type { RemoteCommand } from '@/src/types/RemoteCommand';
async function dispatch(phoneToken: string, command: RemoteCommand) {
  const env = buildEnvelope(command, () => globalThis.crypto.randomUUID());
  await sendCommand(phoneToken, env);
}
```
`PermissionPrompt` renders Zatwierdź → `dispatch(pt, { type:'approvePermission', sessionId })`, Odrzuć → `denyPermission`. CommandBar send → `sendPrompt`. A "Zatrzymaj" chip → `stopSession`. `resumeSession` (with `projectId`) is shown only behind a confirm and may be rejected server-side (`allowRemoteSpawn`); surface a 409/error toast. Reading `phoneToken` from `useStore((s) => s.phoneToken)`; guard buttons when null.

- [ ] **Step 4: Activity tab.** `app/(tabs)/activity.tsx` lists sessions where `activity === 'waitingUser'` (derived from the sessions Map) with the same inline approve/deny — the "needs your attention" view.

- [ ] **Step 5: Verify.** `npm run lint` exit 0; `npx jest` green (slices/parsers/commands covered; screens are glue). Manually sanity-check render paths if a device is available (optional).

- [ ] **Step 6: Commit** `feat(mobile): add session list, live history, and command actions`.

---

## Task 7: Reconnect / resync hardening + connection status UI

**Files:**
- Modify: `MobileApp/src/lib/centrifugo.ts` (history backfill on non-recovered subscribe), `MobileApp/src/store/connectionSlice.ts` (map client lifecycle events to `connectionStatus`), a small banner component.

- [ ] **Step 1: Failing test** for the backfill helper. Extract the "apply a history page" logic into a pure function `applyHistoryPage(pubs, onEvent)` in `centrifugo.ts` and test that it routes each `pub.data` through `parseSessionEvent` + `onEvent`, skipping unparseable entries.
- [ ] **Step 2–4:** Implement: in `subscribeSession`, `sub.on('subscribed', (ctx) => { if (!ctx.recovered) sub.history({ limit: 100 }).then((r) => applyHistoryPage(r.publications, onEvent)); })`. In `connectionSlice`, attach `client.on('connecting'|'connected'|'disconnected', …)` to set `connectionStatus`. Add a thin top banner ("Łączenie…" / "Offline") shown when not `connected`. Tests for the pure backfill helper; lint+jest green.
- [ ] **Step 5: Commit** `feat(mobile): resync session history on reconnect and show connection status`.

---

## Done criteria (Plan 2)

- `cargo test --manifest-path DesktopApp/src-tauri/Cargo.toml` green; `SessionEvent.ts` (+ deps) generated into both `DesktopApp/src/types/` and `MobileApp/src/types/`, diff-identical; the `sessionAppend` wire is a flat `blocks` array (double-wrap fixed).
- `cd MobileApp && npm run lint` exit 0 and `npx jest` green (centrifugo parser, commands, sessionsSlice, connectionSlice, backfill helper).
- In the app: the Sesje tab lists live sessions with status + usage; opening one shows live history and the command bar; approve/deny/stop/sendPrompt post to `/v1/command`; a backgrounded reconnect resyncs history without duplicate blocks.

**Next:** Plan 3 (Push) — mobile push registration + CloudService `/v1/push-token` & `/v1/notify` + the desktop notify hook (Approach A).
