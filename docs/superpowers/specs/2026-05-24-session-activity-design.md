# Session Activity — Design Spec

**Date**: 2026-05-24
**Status**: Draft → awaiting user review
**Author**: brainstorming session

## 1. Goal

Add a derived "activity" state to each Claude Code session in AbeonCode so users can see at a glance whether a session is running, waiting for them, blocked on a tool/permission prompt, or idle. State must surface in the sidebar (session list), tab bar, and the active session panel header.

## 2. Non-goals

- OS-level notifications when state changes (deferred).
- User-configurable thresholds for state detection (kept as Rust constants).
- Tracking which OS process / PTY owns a given session in the backend.
- Filtering or sorting sessions by activity state (deferred).
- Visualising activity in places outside sidebar / tab bar / center header.

## 3. The four states

| Variant     | Semantics                                                    | Typical trigger                             |
|-------------|--------------------------------------------------------------|---------------------------------------------|
| `running`     | Claude is doing something right now                          | File mtime < 5s ago, or last event is `user`/`tool_use` with recent activity |
| `waitingUser` | Claude finished a turn, expects a reply                      | Last significant event is `assistant` text  |
| `waitingTool` | Claude issued a `tool_use` and nothing answered for a while   | `tool_use` without matching `tool_result` and mtime > 30s old |
| `idle`        | Session is dormant or cannot be classified                    | mtime > 24h, empty file, fallback for parse errors |

## 4. Architecture overview

```
┌─────────────────────── Rust backend ───────────────────────┐
│  sessions/activity.rs (NEW)                                │
│    enum SessionActivity { Running, WaitingUser,            │
│                           WaitingTool, Idle }              │
│    fn compute_activity(path, now_ms) -> SessionActivity    │
│                                                            │
│  sessions/reader.rs (MOD)     sessions/watcher.rs (MOD)    │
│    list_sessions enriches      handle_change emits         │
│    SessionMeta.activity        session:{sid}:activity      │
│                                only on state change        │
│                                                            │
│  domain/session.rs (MOD)                                   │
│    SessionMeta { ..., activity: SessionActivity }          │
└────────────────────────────────────────────────────────────┘
                       │                  │
                       │ IPC return       │ tauri event
                       ▼                  ▼
┌─────────────────── React frontend ─────────────────────────┐
│  lib/activity.ts (NEW) — state → color/icon/label maps     │
│                                                            │
│  store/sessionsSlice.ts (MOD)                              │
│    + listener `session:*:activity` (cross-project patch)   │
│    + refreshActivity(projectId) for poll/focus refresh     │
│                                                            │
│  sidebar/SessionItem.tsx (MOD)   — dot color from activity │
│  center/TabBar.tsx       (MOD)   — dot in session tabs     │
│  center/CenterPanel.tsx  (MOD)   — badge in panel header   │
│                                                            │
│  store/sessionsSlice.ts exposes                            │
│    startActivityPolling / stopActivityPolling              │
│    setInterval(10s) gated by window focus                  │
│  layout/AppShell.tsx wires lifecycle in one useEffect      │
└────────────────────────────────────────────────────────────┘
```

### Module boundaries

- `activity.rs` is a **pure function over `path` + `now_ms`**. It has no knowledge of the DB, `AppState`, the PTY manager, or Tauri — making it deterministically testable.
- `reader.rs` only gains a single call to `compute_activity` per listed session; existing logic untouched.
- `watcher.rs` adds a second emission path (`:activity`) and a `HashMap<sid, SessionActivity>` for diff-only emission.

## 5. Detection algorithm

`fn compute_activity(path: &Path, now_ms: i64) -> SessionActivity`

### Step 1 — tail the file

- Open the file. On failure → `Idle`.
- `seek(SeekFrom::End(-8192))` (or from start if file is smaller).
- Read to end. On seek/read failure → `Idle`.
- Drop everything before the first `\n` after the seek position (the seeked-into line may be partial).
- Split the remainder by `\n` and parse from the end.

### Step 2 — find last significant event

Walking backwards through parsed lines, skip:

- `queue-operation`, `last-prompt` (infrastructure)
- `system` (not state-bearing)
- `user` with empty content or whose content is meta (`<command-name>…`, `<local-command-caveat>…`)

The first non-skipped record is `last_event` (one of: `user`, `assistant`, or `user` whose first content item is `tool_result`).

If none is found in the tail → `Idle`.

### Step 3 — read mtime

`age_ms = now_ms - mtime_ms`. mtime errors → `Idle`.

### Step 4 — decide (order matters)

```text
if age_ms > 24h:             Idle              # hard cap, must come first
if age_ms < 5s:              Running           # file is pulsing; trust mtime over content
match last_event:
    user text                  → Running
    user tool_result (ok)      → Running
    user tool_result (error)   → WaitingUser
    assistant containing tool_use without matching tool_result in the tail:
        if age_ms < 30s        → Running       # tool legitimately executing
        else                   → WaitingTool   # likely permission prompt / hang
    assistant text only        → WaitingUser
    nothing found              → Idle
```

"Matching `tool_result`" is detected by `tool_use_id` correlation inside the tail window. If the matching `tool_result` is outside the 8 KiB tail, we may produce a transient `WaitingTool`/`Running`; the next watcher tick or polling pass will reclassify.

### Step 5 — return

`SessionActivity::{Running, WaitingUser, WaitingTool, Idle}`

## 6. Types and IPC contract

### Rust (`src-tauri/src/domain/session.rs`)

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/types/")]
#[serde(rename_all = "camelCase")]
pub enum SessionActivity {
    Running,
    WaitingUser,
    WaitingTool,
    Idle,
}

pub struct SessionMeta {
    /* existing fields unchanged */
    pub activity: SessionActivity,
}
```

`ts-rs` generates `src/types/SessionActivity.ts`:

```ts
export type SessionActivity = "running" | "waitingUser" | "waitingTool" | "idle";
```

### Tauri event

| Event name                  | Payload                                            | When emitted |
|-----------------------------|----------------------------------------------------|--------------|
| `session:{sid}:activity`    | `{ "activity": SessionActivity }`                  | Watcher detects file change AND new state ≠ last emitted state for this `sid` |

The existing `session:{sid}:append` event is unchanged. Both fire on the same modify event in the watcher; `:activity` only when the value differs.

### Frontend IPC wrapper (`src/lib/tauri.ts`)

No new `invoke` commands. Add one event subscription helper:

```ts
onSessionActivity(sid: string, cb: (a: SessionActivity) => void): UnlistenFn
```

Mirrors the existing `onSessionAppend` pattern.

### Constants (Rust, in `activity.rs`)

```rust
const TAIL_BYTES: u64 = 8 * 1024;
const LIVE_WINDOW_MS: i64 = 5_000;
const TOOL_STALL_MS: i64 = 30_000;
const IDLE_HARD_CAP_MS: i64 = 24 * 60 * 60 * 1000;
```

No new persisted settings.

## 7. Data flow

### Initial load / project switch

1. `Sidebar` selects project → `store.loadInitialSessions(projectId)`.
2. IPC `list_sessions` → `reader::list_sessions` → for each entry, `meta_for_file_fast` + `compute_activity`.
3. Returned `SessionMeta[]` carries `activity` already set.
4. Components render the right dot color from the first paint — no flicker, no second round-trip.

### Polling (10s, focus-gated)

`sessionsSlice.ts` exposes two functions: `startActivityPolling()` and `stopActivityPolling()`. Their internals:

- On `window` `focus`: start `setInterval(10_000)`.
- On `blur`: clear the interval.
- Each tick (for the currently selected `projectId` read from `projectsSlice`):
  - `tauri.listSessions(projectId, currentCount, 0)` — `currentCount` is the existing length, **not** the default `PAGE`, so `loadMoreSessions` is preserved.
  - Patch the store: for each returned item, update only the `activity` field. Title, message count, etc. remain whatever the store already has (renames and message increments come through other paths).

`AppShell.tsx` mounts the lifecycle once in a `useEffect`:

```ts
useEffect(() => {
  startActivityPolling();
  return () => stopActivityPolling();
}, []);
```

This colocates state ownership with the slice and keeps `AppShell` declarative — same pattern the project already uses for other store-driven lifecycles.

### Push (open tab)

1. Tab opens → existing `openSessionWatch(sid)` already wires the watcher.
2. CLI writes JSONL → `notify` → `watcher.handle_change(path)`.
3. Watcher already emits `session:{sid}:append`. Additionally:
   - Run `compute_activity(path, now)`.
   - If `new_state != last_activity[sid]`, emit `session:{sid}:activity` and update `last_activity[sid]`.
4. Frontend listener (`onSessionActivity`) patches the store entry across **all** `sessionsByProject` entries (sessions may belong to a tab whose project is not currently in focus).

### Idempotency

`patchActivity(sid, activity)`: if `sid` is not in any project's items, it is a no-op (no throw). Tab-level renderers fall back to `idle` when their backing session isn't in the store.

## 8. UI rendering

### Color and icon mapping — `src/lib/activity.ts`

```ts
export const ACTIVITY_DOT: Record<SessionActivity, string> = {
  running:     'bg-success',
  waitingUser: 'bg-accent',
  waitingTool: 'bg-warn',
  idle:        'bg-muted',
};

export const ACTIVITY_LABEL: Record<SessionActivity, string> = {
  running:     'Aktywna — Claude pracuje',
  waitingUser: 'Czeka na Twoją odpowiedź',
  waitingTool: 'Czeka na zatwierdzenie narzędzia',
  idle:        'Bezczynna',
};

export const ACTIVITY_ICON: Record<SessionActivity, IconName> = {
  running:     'spinner',
  waitingUser: 'dot',
  waitingTool: 'pause',
  idle:        'dot',
};
```

### `SessionItem.tsx` (sidebar)

The existing `<span className="w-[5px] h-[5px] rounded-full ..." />` at line 27 currently has a dead `bg-muted ? bg-muted` branch. Replace with:

```tsx
<span
  className={`w-[5px] h-[5px] rounded-full shrink-0 ${ACTIVITY_DOT[session.activity]}`}
  title={ACTIVITY_LABEL[session.activity]}
/>
```

`active` (tab open) remains signalled by the `<li>`-level `bg-bg-elev text-fg`.

### `TabBar.tsx` (tab dot for `session` tabs)

Add an identical dot to the left of the tab title, only for tabs with `kind === 'session'`. Activity comes from a new cross-project selector:

```ts
export const selectSessionActivity =
  (sid: string) => (s: AppStore): SessionActivity => {
    for (const proj of Object.values(s.sessionsByProject)) {
      const found = proj.items.find(x => x.id === sid);
      if (found) return found.activity;
    }
    return 'idle';
  };
```

### `CenterPanel.tsx` (panel header badge)

Before the session title, render a small badge:

```tsx
<span
  className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] ${ACTIVITY_DOT[activity]} text-bg`}
  title={ACTIVITY_LABEL[activity]}
>
  <Icon name={ACTIVITY_ICON[activity]}
        className={`w-3 h-3 ${activity === 'running' ? 'animate-spin' : ''}`} />
</span>
```

Only `running` animates. All other states render statically.

## 9. Error handling

- **`compute_activity` is infallible by design**: signature returns `SessionActivity`, not `Result<…>`. Any I/O, parse, or mtime error → `Idle`. Activity is derived metadata, not a critical path — a sessione listed without flair is better than a failing listing.
- **Watcher emission**: if `compute_activity` returns `Idle` because of a transient I/O error, the next file modification will retry. Diff-only emission prevents oscillation spam.
- **Frontend listener**: patching an unknown `sid` is a silent no-op — safe across tabs/projects.

## 10. Testing strategy

### Rust unit tests (in `sessions/activity.rs`)

```text
empty_file_returns_idle
file_modified_now_returns_running
file_modified_25h_ago_returns_idle
last_event_assistant_text_returns_waiting_user
last_event_user_text_returns_running
last_event_tool_use_fresh_returns_running
last_event_tool_use_stale_returns_waiting_tool
tool_use_with_paired_tool_result_returns_waiting_user
tool_use_with_paired_tool_result_error_returns_waiting_user
only_meta_user_records_returns_idle
only_system_records_returns_idle
huge_assistant_text_truncates_correctly
last_8kib_starts_mid_line_skips_partial
```

Fixtures: inline JSONL strings; `tempfile::TempDir`; `now_ms` passed as a parameter so no system clock dependency.

### Rust integration

A small test ensuring `reader::list_sessions` carries `activity` end-to-end for sample fixtures.

### Frontend (vitest)

```text
SessionItem renders dot color from activity
ACTIVITY_LABEL maps every state (exhaustiveness smoke test)
refreshActivity patches activity only, preserves title/count
onSessionActivity listener updates the correct session in store
```

### Out of scope for tests

- `useActivityPolling` setInterval timing (brittle in jsdom).
- `notify` crate behavior (external).
- Performance benchmarks (deltas are well below noise floor).

## 11. Rollout / migration

- No DB migration: `activity` is derived, never persisted.
- No `PERSISTED_KEYS` change.
- `SessionMeta` shape changes are compatible — backend always sets the new field, frontend always reads it. No version skew window because both ship in the same build.

## 12. Files touched

### New

- `src-tauri/src/sessions/activity.rs`
- `src/lib/activity.ts`

### Modified

- `src-tauri/src/domain/session.rs` — add `SessionActivity` enum, add `activity` field to `SessionMeta`.
- `src-tauri/src/sessions/mod.rs` — `pub mod activity;`
- `src-tauri/src/sessions/reader.rs` — call `compute_activity` in `meta_for_file_fast`.
- `src-tauri/src/sessions/watcher.rs` — diff-only `:activity` emission, hold `last_activity` map.
- `src/store/sessionsSlice.ts` — `refreshActivity`, `patchActivity`, `selectSessionActivity`, `startActivityPolling`, `stopActivityPolling`, `onSessionActivity` wiring.
- `src/lib/tauri.ts` — `onSessionActivity` helper.
- `src/components/sidebar/SessionItem.tsx` — dot color.
- `src/components/center/TabBar.tsx` — dot in `session` tabs.
- `src/components/center/CenterPanel.tsx` — header badge.
- `src/components/layout/AppShell.tsx` — single `useEffect` mounting the polling lifecycle.

## 13. Open questions

None at the time of writing. All thresholds are explicit constants and can be tuned later in a one-line change.
