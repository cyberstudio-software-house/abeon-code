# Detached Session Window — design

**Date:** 2026-06-03
**App:** DesktopApp (Tauri 2 + React 19 + Zustand)
**Status:** approved direction, pending spec review

## Goal

Let the user open a session tab in a separate OS window ("detached window"). The
detached window shows only the session thread (center) and the full right panel
(Actions / Git changes / Usage). No project list (Sidebar), no tab bar. The
existing TitleBar stays as-is.

The session is **moved**, not mirrored: detaching closes the tab in the main
window and the session runs as a live terminal in the detached window. A PTY is
bound to the webview that spawned it, so a session can only be live in one window
at a time — moving sidesteps any dual-PTY conflict. Resuming from JSONL in the new
window is consistent with the existing history→terminal resume flow.

## Decisions (locked)

1. **Behavior:** move session live to the new window; the source tab closes.
2. **Trigger:** right-click context menu on a tab → "Otwórz w nowym oknie".
   The same menu also gets "Zmień nazwę" and "Zamknij" (wired to existing handlers).
3. **Close window = close session,** routed through the existing `ConfirmDialog`
   guard when the process is live (consistent with Ctrl/Cmd+W).
4. **Right panel:** all three sections (Actions, Git, Usage) — identical to main.
5. **Right panel resizer:** kept (same drag logic / persisted width as `AppShell`).
6. **Fresh, unsaved sessions are detachable too** (no gating).

## Approach (chosen)

Spawn a separate `WebviewWindow` pointing at the same `index.html` with URL query
params identifying the session. `App.tsx` detects the params and renders a
`DetachedSessionShell` (TitleBar + single session thread + RightPanel) instead of
`AppShell`. Maximum reuse: `TerminalView` / `RightPanel` already take
`projectId` + `sessionId` as input and read the active tab from the store.

Rejected alternative: bridging the full Zustand store across windows via Rust
events. The detached window is ephemeral and re-hydrates settings/projects/session
from SQLite + JSONL on its own, so a state bridge is unnecessary complexity.

## Components

### 1. `src/lib/windowMode.ts` (new)
Single source of truth for "which mode is this window in". Parses
`window.location.search` into:

```ts
type WindowMode =
  | { view: 'session'; projectId: number; sessionId: string;
      linkedSessionId?: string; title: string; fresh: boolean }
  | null; // null => main window
```

Pure function, unit-tested like `middleClickPasteGuard.test.ts`. All `fresh` /
`linkedSessionId` fields round-trip through the URL so `TerminalView`'s existing
fresh-vs-resume logic works unchanged in the detached window.

### 2. `src/store/index.ts` — conditional boot
At boot, branch on `windowMode`:
- **Main window** (mode null): unchanged — restore tabs from localStorage, persist
  normally.
- **Detached window:** skip `loadTabsFromLocalStorage()` restore. Instead seed
  `tabs = [<the one session tab>]`, `activeTabId = <its id>`, `mode: 'terminal'`,
  carrying `fresh` / `linkedSessionId` from the URL. **Skip the tabs-persistence
  branch** in the `subscribe` handler so the detached window never overwrites the
  main window's `abeoncode.tabs`. Settings hydration (localStorage + SQLite) runs
  as today; settings writes from the detached window are suppressed to avoid
  cross-window races (detached window is a read-only consumer of settings).

### 3. `App.tsx` — entry branch
`if (windowMode) return <DetachedSessionShell mode={windowMode} />;` otherwise
render `<AppShell />`. Both stay wrapped in `ThemeProvider` / `ErrorBoundary` /
`Toaster` exactly as now.

### 4. `src/components/layout/DetachedSessionShell.tsx` (new)
Layout mirrors `AppShell` minus Sidebar and TabBar:
- `TitleBar` — unchanged (shows session title + project + active-session counter).
- Center: a single live `TerminalView kind="claude"` for the seeded session
  (no `TabBar` / `TabContent` / `TabSwitcher`).
- Right: `RightPanel` — unchanged, all three sections; reactive off the seeded
  active tab.
- Right-panel resizer reusing the same width logic (`leftWidth` is irrelevant;
  reuse `rightWidth` + the `DragHandle` clamp logic from `AppShell`). Consider
  extracting the shared `DragHandle` + clamp if it stays identical.
- On mount, call `loadProjects()` (in `AppShell` this is done by Sidebar, which is
  absent here) so the right panel can resolve `projectId → project`.
- Window close guard (see §6).

### 5. Context menu on tabs (`src/components/center/TabBar.tsx` + new `TabContextMenu.tsx`)
Add `onContextMenu` on each tab element. Open a small cursor-anchored menu
mirroring `ProjectManageMenu` styling (`role="menu"`, `role="menuitem"` buttons,
`absolute … border border-border bg-bg shadow-lg`, document `mousedown`
click-outside close — same pattern as `ProjectItem`).

Menu items:
- **Otwórz w nowym oknie** — only for `kind === 'session'` tabs. Detach handler (§ below).
- **Zmień nazwę** — triggers existing inline rename (`renameTab` path already in `TabBar`).
- **Zamknij** — calls existing `closeWithGuard(tab)`.

Detach handler:
1. Build a deterministic label `session-<sessionId>`.
2. If a `WebviewWindow` with that label already exists → `setFocus()` and stop
   (guard against two PTYs for the same session).
3. Otherwise `new WebviewWindow(label, { url: 'index.html?view=session&projectId=…&sessionId=…&fresh=…&linkedSessionId=…&title=…', title, decorations/titleBarStyle/hiddenTitle matching the main window's config, sized from main window's dimensions })`.
4. On window `created`/`tauri://created` → `closeTab(tabId)` in the main window
   (the move). The main PTY dies; the detached window resumes from JSONL (or
   spawns fresh for an unsaved session via the `fresh` flag).

### 6. Window close = close session (with guard)
In `DetachedSessionShell`, register `getCurrentWebviewWindow().onCloseRequested`:
- If the session PTY is live (`isActiveProcess`-style check, reused from `TabBar`),
  `event.preventDefault()`, show the existing `ConfirmDialog` ("Zamknąć aktywną
  sesję?"). On confirm: kill the PTY, then `window.close()`. On cancel: keep open.
- If not live: allow close.

### 7. `src-tauri/capabilities/default.json`
Extend `"windows": ["main"]` to `["main", "session-*"]` so detached windows inherit
the same IPC permissions (PTY, settings, git, sessions). This is the **only**
backend-side change — no new Rust code or commands.

## Data flow

```
[main window] right-click session tab → "Otwórz w nowym oknie"
  → WebviewWindow.create(label=session-<id>, url=index.html?view=session&…)
  → on created: closeTab(tabId)   // session leaves main

[detached window] boot
  → windowMode = { view:'session', projectId, sessionId, linkedSessionId?, fresh }
  → seed store: tabs=[session], activeTabId=session, mode:'terminal'
  → hydrate settings (localStorage + SQLite, read-only); loadProjects()
  → render TitleBar + TerminalView(claude, resume/fresh) + RightPanel
  → RightPanel sections read activeTab.projectId/sessionId → fetch git/actions/usage

[detached window] OS close button
  → onCloseRequested → live? ConfirmDialog → kill PTY → window.close()
```

## Edge cases

- **Re-detaching the same session:** label collision → focus the existing window
  instead of creating a second one.
- **Fresh unsaved session:** `fresh:true` + no `linkedSessionId` → detached window
  spawns a fresh claude PTY (new conversation), same as the main window would.
  Once claude writes a real session id, `linkNewSession` runs in the detached
  window normally.
- **Main window closes while detached lives:** independent OS windows / processes;
  no coupling.
- **Detached window reload:** URL params persist across reload, so it re-seeds the
  same session correctly.

## Testing

- `windowMode.ts` — unit test URL parse/serialize round-trip (missing params,
  `fresh` bool, optional `linkedSessionId`), mirroring `middleClickPasteGuard.test.ts`.
- Boot seeding — detached mode skips tab restore and seeds exactly one active tab;
  does not write `abeoncode.tabs`.
- Close guard — `isActiveProcess` decision reused; live session prompts, non-live
  closes directly.
- No Rust changes → no new backend tests (capability JSON only).

## Out of scope (YAGNI)

- Multiple tabs inside a detached window (the window is single-session by design).
- Dragging a tab back into the main window (close = end session; re-open from
  sidebar if needed).
- Syncing arbitrary store slices between windows beyond settings/projects/session.
