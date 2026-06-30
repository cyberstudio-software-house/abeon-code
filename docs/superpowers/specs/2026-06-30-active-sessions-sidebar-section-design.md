# Active sessions sidebar section — design

## Problem

The sidebar lists projects, each expandable to reveal its sessions. There is no
single place to see which sessions are *active right now* or *waiting for the
user's reaction* across all projects. To find a session that needs attention the
user must remember which project it belongs to and expand it.

We add a new section at the top of the sidebar, above the projects list, that
surfaces sessions which are either running or waiting for the user. The section
can be turned off in settings.

## Goals

- Show, above the projects list, sessions that are **active (running)** or
  **waiting for the user's reaction** (`waitingUser`, `waitingTool`, or flagged
  via the attention/bell mechanism).
- Cover **all projects**, including ones the user has never expanded this
  session (data is not lazily limited to loaded projects).
- Include both providers (**Claude + Codex**), consistent with the per-project
  session list.
- Be toggleable in **Settings → Ogólne**, enabled by default.

## Non-goals

- No new persistence of session state; the section is derived from existing
  on-disk session data plus the in-memory attention set.
- No change to the remote bridge `RosterEntry` contract (mobile v1).
- No grouping by project — the list is flat (project identity shown per row).

## Inclusion criteria

A session appears in the section when **any** of:

- backend-computed `activity` is `running`, `waitingUser`, or `waitingTool`; or
- its id is present in the frontend `attentionSessions` set (real-time bell,
  fed by `onSessionAttention` push events).

Sessions with `activity === 'idle'` and no attention flag are excluded.

## Architecture & data flow

```
list_active_sessions (Rust)                  -- scans all projects, filters non-idle
  -> tauri.listActiveSessions() (lib/tauri.ts)
  -> sessionsSlice.activeSessions: ActiveSession[]    -- refreshed on poll + focus
  -> selectActiveSessionRows(state)          -- merge with attentionSessions + project color, sort by urgency
  -> ActiveSessionsPanel (sidebar)           -- rendered above the projects <ul>
```

Refresh is wired into the **existing** activity machinery rather than a new
timer:

- `startActivityPolling` tick (every 10 s while the window is focused) also calls
  `refreshActiveSessions()`.
- The `Sidebar` focus effect that already calls `loadActivity()` on window focus
  also calls `refreshActiveSessions()`.

## Backend (`src-tauri`)

### New domain type `ActiveSession`

In `domain/session.rs` (or a small `domain/active.rs`), `#[derive(TS)]` exported
to `src/types/`:

```rust
pub struct ActiveSession {
    pub session_id: String,
    pub project_id: i64,
    pub project_name: String,
    pub title: String,
    pub activity: SessionActivity,
    pub last_modified: i64,
    pub provider: Provider,
}
```

`RosterEntry` is intentionally **not** reused: it is the remote v1 contract and
lacks `provider`, which the desktop click handler needs to spawn the right CLI.

### Refactor: extract `list_project_sessions`

The Claude+Codex listing + title-merge body currently inline in `list_sessions`
(`commands/sessions.rs`, ~lines 47–58) is extracted into:

```rust
fn list_project_sessions(
    conn: &PooledConn,
    proj: &Project,
    window: usize,
) -> AppResult<Vec<SessionMeta>>
```

`list_sessions` is rewritten to call it (then apply offset/limit as today). This
keeps the merge logic single-sourced.

### New command `list_active_sessions`

```rust
const ACTIVE_SCAN_WINDOW: usize = 30; // most-recent N per project; active sessions are recent

#[tauri::command]
pub fn list_active_sessions(state: State<AppState>) -> AppResult<Vec<ActiveSession>>
```

Iterates `projects_repo::list`, calls `list_project_sessions(.., ACTIVE_SCAN_WINDOW)`
per project, keeps sessions with `activity != Idle`, maps each to `ActiveSession`
with the project name. A failure for one project is skipped (same resilience
pattern as `roster_snapshot`). Registered in `lib.rs`; type regenerated with
`cargo test`.

Cost note: `compute_activity` cheaply returns `Idle` from mtime alone when a
session file is stale, only reading the file tail for recently-modified files, so
scanning N recent sessions across all projects is dominated by stat calls.

## Frontend store (`src/store`)

### `settingsSlice`

- Add `showActiveSessions: boolean` (default `true`) and
  `setShowActiveSessions(v)`.
- Add `'showActiveSessions'` to `PERSISTED_KEYS` in `index.ts`, plus the matching
  cases in the serialize and deserialize switches and the localStorage
  deserialize guard.

### `sessionsSlice`

- Add `activeSessions: ActiveSession[]` (default `[]`).
- Add `refreshActiveSessions(): Promise<void>` calling `tauri.listActiveSessions()`
  and setting state (swallow/log errors like `loadActivity`).
- Call `refreshActiveSessions()` from the `startActivityPolling` tick.

### Selector `selectActiveSessionRows`

Combines `activeSessions`, `attentionSessions`, and `projects` into sorted rows:

1. Start from `activeSessions`.
2. Add any `attentionSessions` id not already present, resolved best-effort from
   `sessionsByProject` (skip if metadata cannot be resolved).
3. Dedupe by `sessionId`.
4. Attach project color via `getProjectColor` (lookup by `projectId`).
5. Sort by urgency: attention/bell first, then `waitingUser`/`waitingTool`, then
   `running`; within a tier by `lastModified` desc.

Consumed with `useShallow` (array selector — see the `selectSortedProjects`
gotcha in `DesktopApp/CLAUDE.md`).

## UI (`src/components/sidebar`)

### `ActiveSessionsPanel.tsx`

- Header "Aktywne" with a count badge and a chevron to collapse/expand
  (local-only collapse state). Own `max-h` + `overflow-y-auto` so a long list
  never dominates the sidebar.
- Rendered in `Sidebar.tsx` between the search box and the projects `<ul>`, only
  when `showActiveSessions && rows.length > 0` (empty list → whole section hidden).
- Row layout: project color dot (`getProjectColor`) → state icon (bell for
  attention, otherwise `ACTIVITY_ICON`/`ACTIVITY_TEXT` by activity) → title
  (truncate) → small project name → relative time (`formatRelative`).
- Click → `openSessionTab(projectId, sessionId, title, provider)` then
  `clearAttention(sessionId)` — mirrors `AppShell.focusSession`.

### `SettingsDialog` → `GeneralTab`

Add a toggle "Pokaż aktywne sesje nad projektami" bound to `showActiveSessions`,
following the existing `<label>` toggle pattern used for notifications.

## Edge cases

- Empty list → section hidden entirely.
- Setting turned off → panel disappears immediately (reactive on
  `showActiveSessions`).
- Session removed from disk → drops out on the next scan.
- Attention session whose metadata cannot be resolved yet → omitted until a scan
  surfaces it (it will, since attention implies a recent mtime).

## Testing

- **Rust** (`commands/sessions.rs` tests, following `roster_tests`):
  - `list_active_sessions` excludes idle sessions.
  - includes both Claude and Codex sessions.
  - a broken/missing project directory is skipped, not fatal.
- **Frontend** (Vitest):
  - `selectActiveSessionRows` sorts by urgency tier then recency, and dedupes an
    attention session already present in `activeSessions`.
  - `ActiveSessionsPanel` is hidden when the list is empty.
  - panel is hidden when `showActiveSessions` is false.

## Files touched

- `src-tauri/src/domain/session.rs` (or new `active.rs`) — `ActiveSession` type.
- `src-tauri/src/commands/sessions.rs` — `list_project_sessions` extraction,
  `list_active_sessions` command, tests.
- `src-tauri/src/lib.rs` — register command.
- `src/types/ActiveSession.ts` — generated.
- `src/lib/tauri.ts` — `listActiveSessions` wrapper.
- `src/store/settingsSlice.ts`, `src/store/index.ts` — `showActiveSessions`
  setting + persistence.
- `src/store/sessionsSlice.ts` — `activeSessions`, `refreshActiveSessions`,
  `selectActiveSessionRows`, poll wiring.
- `src/components/sidebar/ActiveSessionsPanel.tsx` — new component (+ test).
- `src/components/sidebar/Sidebar.tsx` — render the panel.
- `src/components/dialogs/SettingsDialog.tsx` — `GeneralTab` toggle.
