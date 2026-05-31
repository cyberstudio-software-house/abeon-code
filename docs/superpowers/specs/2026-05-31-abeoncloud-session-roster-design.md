# AbeonCloud — Session Roster (mobile session discovery)

**Date:** 2026-05-31
**Status:** Approved (user delegated design decisions; proceeding to implementation)
**Scope:** `crates/abeon-remote-core`, `DesktopApp/src-tauri`, `MobileApp`

## Problem

The mobile "Sesje" tab always shows "Brak aktywnych sesji". The desktop bridge
publishes session events **only** to per-session channels (`abeon-cloud-sess:<id>`),
and the mobile subscribes to those channels **only after opening a session detail
screen** (which needs an `id` it never has). The device channel (`abeon-cloud-dev:<deviceId>`)
handler is a no-op. There is **no session-discovery mechanism**, so the mobile can
never enumerate which sessions exist → the list is permanently empty.

The original design (`2026-05-31-abeoncloud-mobileapp-design.md`, lines 124/151/161)
specified the device channel would carry "which sessions online" + an on-demand
snapshot. That piece was never implemented. This spec fills it.

## Goal

The "Sesje" tab shows **all sessions, grouped by project** (the most recent N per
project), auto-populated on connect, kept fresh as session activity/title/usage
changes, without depending on Centrifugo presence configuration.

## Chosen approach — Hybrid (request-on-connect + live deltas)

Rejected alternatives:
- **Centrifugo presence (join_leave):** the desktop's hand-rolled WS client
  (`ws_client.rs`) subscribes to a single channel (`cmd:<device>`) and has no SDK to
  hide presence-frame parsing; `join_leave` config on the namespace is also
  unconfirmed. Too much new machinery + an infra dependency.
- **Periodic snapshot + history:** wasteful publishes, staleness up to the interval.
- **CloudService `GET /v1/sessions`:** CloudService is a stateless relay; making it
  track session state contradicts its design.

The hybrid reuses the **existing command channel** the desktop already consumes, so
it needs no presence config and no second desktop subscription, while giving the same
auto-populating UX as a presence-driven design.

### Channel content (after this change)

```
abeon-cloud-dev:<deviceId>   (mobile subscribes; reads channel history on reconnect)
   ├─ cmdResult                         RemoteEvent           (unchanged)
   ├─ sessionRoster                     SessionEvent          ◀── NEW  (full snapshot)
   └─ sessionActivity/Title/Usage       SessionEvent          ◀── NEW  (lightweight deltas, NO append)

abeon-cloud-sess:<id>        (mobile subscribes when a detail screen opens)
   └─ sessionAppend/Activity/Title/Usage SessionEvent         (unchanged — full stream incl. append)
```

The device channel becomes a multiplexed feed. The mobile routes each publication by
its `type` tag: `cmdResult` → command ack; `sessionRoster` → seed the list;
`sessionActivity|sessionTitle|sessionUsage` → update the matching roster row.

### Data flow

1. **Connect.** Mobile `centrifuge` connects → subscribes read-only to
   `abeon-cloud-dev:<deviceId>` → reads channel **history** (backfill) → **auto-sends
   `RequestRoster`** via `POST /v1/command` (the existing command pipeline).
2. **Snapshot.** The desktop bridge receives `RequestRoster`, builds the roster from
   its DB (all projects, recent N sessions each), and publishes one `SessionRoster`
   event to the device channel. The bridge **also** publishes a snapshot once at
   startup (covers desktop-restart while a phone is already connected).
3. **Freshness.** Whenever the bridge forwards a `SessionActivity|Title|Usage` bus
   event to the per-session channel, it **also** publishes it to the device channel,
   so roster rows update live. `SessionAppend` is NOT mirrored (too heavy; only needed
   in detail view).
4. **Detail.** Opening a session subscribes to `abeon-cloud-sess:<id>` for the full
   stream including append + history backfill (unchanged).

## Contract changes (Rust → ts-rs → mobile)

| Type | Location | Purpose |
|---|---|---|
| `RemoteCommand::RequestRoster` (no fields) | `abeon-remote-core/src/protocol.rs` | mobile→desktop roster request over `cmd:<dev>` |
| `SessionEvent::SessionRoster { entries: Vec<RosterEntry> }` | `DesktopApp/.../domain/session_event.rs` | full snapshot on the device channel |
| `RosterEntry { session_id, project_id, project_name, title, activity, last_modified }` | `DesktopApp/.../domain/` (new, `#[derive(TS)]`) | one roster row = `SessionMeta` + `project_name` |

Wire format stays `type`-tagged camelCase (matches existing `SessionEvent`).
`RosterEntry.activity` reuses the existing `SessionActivity` enum.

Regeneration:
- `RemoteCommand` via `cargo test --manifest-path crates/abeon-remote-core/Cargo.toml`
  (emits to both `DesktopApp/src/types/` and `MobileApp/src/types/`).
- `SessionEvent` + `RosterEntry` via the `export_session_event_to_mobile_app` test in
  `session_event.rs` (add `SessionRoster`/`RosterEntry` to its export list) — uses
  `export_to_string()` + manual write per the MobileApp ts-rs gotcha.

## Desktop changes (`DesktopApp/src-tauri`)

- **`RosterProvider` trait** (in `bridge.rs`, mirroring `PtyActuator`):
  `fn snapshot(&self) -> Vec<RosterEntry>`. Isolated so the run loop is testable
  without a DB. Production `AppRosterProvider { app: AppHandle }` enumerates
  `projects_repo::list(&conn)` → per project `reader::list_sessions(project_id, dir,
  Some(ROSTER_SESSIONS_PER_PROJECT), 0)` → maps each `SessionMeta` to a `RosterEntry`
  with the project name. `ROSTER_SESSIONS_PER_PROJECT = 30`.
- **`RemoteBridge::run` loop:**
  - On `RequestRoster` inbound: build snapshot via the provider, publish
    `SessionRoster` to `result_channel(device_id)` (= device channel), and still emit
    a `cmdResult { ok: true }` ack for pipeline uniformity. `RequestRoster` does NOT go
    through `command_to_action`/`PtyActuator` (it has no PTY effect).
  - After the run loop starts (or just before entering it), publish an initial
    `SessionRoster` snapshot to the device channel.
  - In the bus branch: for `Activity|Title|Usage` events, publish to the device
    channel **in addition** to the per-session channel. `Append` → per-session only.
- **Wiring** (`startup.rs`): construct `AppRosterProvider` from the `AppHandle` and
  pass it into `bridge.run(...)` alongside the actuator.

## Mobile changes (`MobileApp`)

- **`sessionsSlice`:** extend `Session` with `projectId: number | null` and
  `projectName: string | null`. `applySessionEvent` gains a `sessionRoster` case that
  upserts every entry (id, projectId, projectName, title, activity,
  `lastEventAt = last_modified`). Existing metadata cases unchanged (they update rows
  the roster already seeded).
- **`centrifugo.ts`:** `parseSessionEvent` accepts `sessionRoster`. `subscribeDevice`
  forwards raw publications + reads channel **history** on subscribe (mirror the
  per-session backfill). The device handler routes by `type`: `cmdResult` → existing
  ack path; session events → `applySessionEvent`.
- **`connectionSlice`:** after subscribing the device channel, auto-dispatch
  `RequestRoster` once `connected` fires (and on each reconnect). Wire the device
  handler to `applySessionEvent`.
- **`sessions.tsx`:** render a `SectionList` grouped by `projectName` (sessions
  without a project → "Inne"). Sections sorted by name; rows within a section sorted by
  `lastEventAt` desc. Empty state unchanged.

## Error handling

- **Desktop offline at connect:** `RequestRoster` returns command `409` (presence
  gate). Mobile keeps the (possibly history-backfilled) list and re-requests on the
  next `connected`. No error toast — an empty list with the offline banner already
  communicates state.
- **Large roster:** bounded to `ROSTER_SESSIONS_PER_PROJECT` per project. If a payload
  is still large, that is acceptable for MVP; pagination is future work and is
  explicitly out of scope.
- **Delta before snapshot:** a metadata event for a session not yet in the map upserts
  a row with null project (groups under "Inne") until the next snapshot reconciles it.

## Testing

- **Rust (`bridge.rs`):** `RequestRoster` publishes a `SessionRoster` to the device
  channel (fake `RosterProvider`) + a `cmdResult` ack; `Activity` bus event publishes
  to BOTH device and per-session channels; `Append` publishes to per-session only.
- **Rust (`session_event.rs`):** `SessionRoster` wire shape is `type: "sessionRoster"`
  with a flat `entries` array; export test materializes `RosterEntry.ts`.
- **Mobile (jest):** `applySessionEvent` seeds rows from a `sessionRoster`; grouping
  selector buckets by project and sorts; device-channel router dispatches by `type`.
- **Contract:** `git status DesktopApp/src/types` clean after regen (the ts-rs gotcha
  guard).

## Out of scope (YAGNI)

- Roster pagination / infinite scroll.
- Project metadata beyond name (icon, color, path).
- Centrifugo presence.
- Per-session unsubscribe management for roster rows (roster rows are data, not
  subscriptions).
