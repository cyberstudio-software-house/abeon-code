# AbeonCode

Tauri 2 + React 19 + Zustand 5 + Tailwind 4 desktop app for managing AI-CLI coding sessions (Claude Code, etc.) per project, with embedded xterm.js terminals and Git/Actions panels.

## Stack quick map

- **Frontend**: Vite + React 19 + TypeScript (`src/`)
- **State**: Zustand single store composed from slices (`src/store/index.ts`)
- **Backend**: Rust Tauri 2 (`src-tauri/src/`), SQLite for persistence
- **Terminal**: xterm.js 6 + FitAddon + WebLinksAddon, driven by PTY commands over Tauri IPC
- **Tests**: Vitest + jsdom (`npm test`), cargo for Rust (`npm run test:rust`)
- **Lint/type-check**: `npm run lint` (= `tsc -b --noEmit`)

## Folder map

### Frontend (`src/`)
- `store/` — Zustand slices, one per domain: `settingsSlice`, `projectsSlice`, `sessionsSlice`, `tabsSlice`, `panesSlice`, `actionsSlice`, `gitSlice`, `terminalDrawersSlice`. Composed in `store/index.ts`.
- `lib/tauri.ts` — **single typed wrapper** over `invoke()`/`listen()`. Every IPC call lives here; do not call `invoke` directly from components.
- `types/` — TS types, several are ts-rs-generated from Rust (`PtyKind.ts`, `GitStatus.ts`, etc.) — do not edit by hand.
- `components/`
  - `layout/AppShell.tsx` — three-column shell with draggable resizers; persists widths via store.
  - `layout/TitleBar.tsx` — custom titlebar.
  - `sidebar/` — left column: project list, sessions, sort menu, search.
  - `center/` — middle column: `CenterPanel` → `PaneLayout` (renders the pane tree: one tab bar per pane, one `TabPanel` content layer per tab, `PaneResizers`, `PaneDragOverlay` + `usePaneDrag` for the tab-drag gesture). **Tabs and panes are managed here.** `TerminalDrawerChrome` + `useTerminalDrawerShortcuts` render the per-session terminal drawer (layers computed by `lib/paneLayers.ts`, geometry in `lib/drawerGeometry.ts`).
  - `right/` — right column: Git panel (`GitSection` with tabs: working-tree changes / commit history via `GitHistory` + `CommitDiffDialog`), Actions list, runnable scripts.
  - `terminal/TerminalView.tsx` — xterm wrapper for any PTY (claude, action, shell).
  - `history/` — session history viewer (markdown blocks).
  - `dialogs/` — modal dialogs (`ConfirmDialog`, `SettingsDialog`, `AddProjectDialog`, `AddActionDialog`, `RestoreSessionsDialog`).
  - `shared/` — `Icon`, `IconBtn`, `Kbd`.

### Backend (`src-tauri/src/`)
- `diagnostics.rs` — log file redirect and lifecycle lines, see "Diagnostics log".
- `commands/` — Tauri command handlers grouped by domain: `projects.rs`, `sessions.rs`, `pty.rs`, `actions.rs`, `git.rs`, `settings.rs`, `activity.rs`. Registered in `lib.rs`.
- `db/` — SQLite migrations + queries.
- `pty/` — PTY spawning and lifecycle (claude / action / shell variants).
- `sessions/` — session reading and watch; Claude Code JSONL format at top level, `sessions/codex/` holds the OpenAI Codex rollout adapter, and `sessions/opencode/` holds the read-only OpenCode SQLite adapter.
- `git/` — git2 wrappers: `mod.rs` (status + working-tree diff), `history.rs` (branches, log, commit detail, per-commit file diff).
- `detectors/` — script detection (npm/cargo/etc).
- `domain/` — shared structs (ts-rs derives live here).

## Key conventions

- **Language**: identifiers in English only. User-facing UI text in Polish (e.g. `ConfirmDialog` messages: "Zamknąć aktywny tab?").
- **Commits**: Conventional Commits 1.0.0 (`feat(scope):`, `fix(scope):`, `refactor:`, ...). Recent history is the canonical example.
- **No co-author trailer** in commits.
- **No comments unless WHY is non-obvious**. Existing code rarely has comments; match that.
- **IPC contract**: every Rust command has a matching wrapper in `src/lib/tauri.ts`. When adding a command: add the Rust handler, register it in `lib.rs`, then add the typed wrapper.
- **Types crossing the IPC boundary**: defined in Rust with `#[derive(TS)]` and exported to `src/types/`. Tagged enums use `rename_all = "camelCase"` on the variant tag but keep `snake_case` for struct-variant fields — see `PtyKindClient` in `lib/tauri.ts` for the convention.

## Persistence model (settings)

Two-tier in `store/index.ts`:
1. **localStorage** under key `abeoncode.settings` — instant cache, hydrated synchronously at boot.
2. **SQLite** via Tauri — canonical store, hydrated async. Per-key writes through `setSetting`.

A `subscribe` handler diffs persisted fields and writes both layers. `PERSISTED_KEYS` is the allowlist. Migration flag `migrated_v2` controls one-time localStorage → SQLite seeding. When changing persisted shape, update both `PERSISTED_KEYS` and the serialize/deserialize switches.

## Tabs system

Two slices, neither complete on its own: `src/store/tabsSlice.ts` owns the flat tab list, and
`src/store/panesSlice.ts` owns the pane tree (`layout` + `focusedPaneId`) that decides **which**
tab is visible and where. A tab exists in `tabs[]` but renders only where `layout` puts it.
`reconcilePanes` (`lib/paneTree.ts`, run from a `store/index.ts` subscriber) is the only thing
keeping them in sync: it attaches orphaned tabs to the focused pane, drops unknown ids, collapses
emptied panes and keeps `activeTabId === focusedLeaf.activeTabId`. Actions that open tabs therefore
need to know nothing about panes.

Three tab kinds:
- `session` — Claude session, has `mode: 'history' | 'terminal'` (resume vs. live).
- `action` — running script with `status: 'running' | 'exited'`.
- `terminal` — bare shell PTY.

Closing a tab with an active process (`session+terminal`, `action`, `terminal`) **must** route through
the `ConfirmDialog` owned by `useTabBarActions.tsx`. Helpers there: `isActiveProcess()` +
`closeWithGuard()`. Close triggers: X button, middle-click on tab, Ctrl/Cmd+W (global capture-phase
listener).

### Tab bar layout modes

Setting `tabLayoutMode` (`'classic' | 'stacked'`, persisted) picks the renderer `PaneLayout` mounts
per pane:

- `classic` — `TabBar.tsx`: one 32 px row, projects collapsed into inline groups; `TitleBar` visible.
- `stacked` — `StackedTabBar.tsx`: 60 px, projects on the top row and the sessions of the active
  tab's project below (with `+`/`$`); `TitleBar` hidden so the side columns reach the top of the
  window (on macOS a 28 px `data-tauri-drag-region` strip replaces it, because `titleBarStyle:
  "Overlay"` floats the traffic lights over the content).

Both renderers share `useTabBarActions.tsx` (close guards, rename, context menus, detach, Ctrl+W)
and `TabItem.tsx`. The bar's height is **not** a constant: `tabBarHeight(mode)` in
`lib/paneGeometry.ts` feeds `PaneLayout` (content-layer offsets), `usePaneDrag` (`overTabBar`,
`canSplit`) and `PaneResizers` (minimum pane height). A new renderer must be added there too, or
content layers will overlap the bar.

### Terminal drawer

A session tab can own a bottom drawer of shells (`store/terminalDrawersSlice.ts`, keyed by the
session tab id). Drawer terminals are **not** tabs: `tabs[]`, `reconcilePanes`, MRU and nav history
never see them. Splits reuse `PaneNode`, with every leaf id equal to the terminal id it holds.

- Entry point is `openTerminal(projectId, { toggle })`: the active session of the same project gets
  its drawer (`$` toggles; toolbar, history header, sidebar and launcher only show), any other case
  opens a terminal tab. `mod+t` (`AppShell.tsx`) toggles only when DOM focus is really inside that
  drawer (`[data-drawer-owner="<tabId>"]`), otherwise it shows — the store's `hasFocus` can drift
  from DOM focus (e.g. caret in the commit textarea).
- `PaneLayout` renders tab layers and drawer layers from one array (`computePaneLayers`) sorted by
  id. Detaching (`detachDrawerTerminal`) turns the terminal into a `terminal` tab with the **same id**
  in one `set()`, so React keeps the node and the PTY survives with its scrollback.
- `TerminalView.takeFocus` decides who gets the keyboard; `focused` still drives
  `activeAgentPtyId`, so "insert into active session" keeps targeting Claude while the drawer types.
- `TerminalView` only calls `term.focus()` when `visible`/`takeFocus` change. Every non-hiding reveal
  bumps `drawer.focusRequest`, which reaches the focused drawer terminal as `focusToken` (a dep of
  the focus effect, never of the spawn effect) — this pulls the keyboard back after a button click
  stole DOM focus. The drawer header `preventDefault`s mousedown for the same reason.
- A hidden drawer (`open: false`) leaves a `CollapsedDrawerBar` under its session, listed by
  `computePaneLayers` as `collapsedDrawers` (active tab of a pane only). The session layer gives up
  `DRAWER_HEADER_HEIGHT` (`computeCollapsedDrawerLayout`); the hidden terminals keep their open-size
  rects so their PTYs are not resized. The bar sits outside the content layers, so its click calls
  `focusPane` itself before `showTerminalDrawer`.
- `HistoryView` leaves `Ctrl/Cmd+F` to the shell while its session's drawer holds the keyboard.
- A store subscriber prunes drawers whose session tab vanished; that is the only cleanup path.
- Detaching a session to a window first turns its drawer terminals into tabs of the source window;
  detaching a project group hands them over as fresh terminal tabs.

## Session restore after a restart

Session tabs persist in localStorage (`abeoncode.tabs`) and always come back in `history` mode.
A tab that was running in a terminal is saved with `live: true`. At boot `store/index.ts` turns those
marks into `pendingResumeTabIds`, and `AppShell` shows `RestoreSessionsDialog` for them;
`resumePendingSessions` flips the tabs to `mode: 'terminal'`, which is the same `--resume` path as the
"Kontynuuj w terminalu" button in the session footer.

- Setting `sessionRestoreMode` (`ask` | `always` | `never`, persisted) is read synchronously at boot
  from the localStorage settings cache: `always` restores the tabs straight into terminal mode,
  `never` drops the marks, `ask` (default) queues them for the dialog.
- Queued tabs keep their `live` mark until the prompt is answered (`writeTabsToLocalStorage` treats
  `pendingResumeTabIds` as live), so quitting with the dialog still open does not lose them.
- `setSessionMode`, `closeTab` and `detachTabs` prune the queue.
- Only the main window takes part: detached windows never persist tabs.

### Closing the main window

`AppShell` mirrors the detached-window close guard: `onCloseRequested` prompts while any tab holds a
live process. The confirm path calls `freezeTabPersistence()` **before** it drops the tabs. Dropping
them is what kills the PTYs, and an unfrozen persistence subscriber would save the emptied list and
erase the `live` marks the next start needs.

## Detached windows

Two window modes beyond the main shell, both routed by `lib/windowMode.ts` (`?view=…` in the
webview URL) and rendered by `layout/DetachedShell.tsx`:

- `session` — seeded with one session tab (`lib/detachSession.ts`, label `session-<id>`), but the
  window is a full pane host: its per-pane tab bar carries the `+`/`$` buttons and splits work
  exactly as in the main window.
- `group` — every tab of one project (`lib/detachGroup.ts`, label `project-<id>`); the tab list
  travels as base64 JSON in the query string.

New window labels **must** be covered by `src-tauri/capabilities/default.json` (`windows` array) —
an uncovered label gets zero permissions and every `invoke` from it fails at runtime, which no
frontend test catches.

Detached windows never persist settings or tabs (`store/index.ts` bails out of `subscribe` when
`windowMode` is set), so they do not come back after an app restart.

Handing a project group over is two-phase, because session PTYs must die before the new window
respawns them, while action PTYs must survive:
1. the source window drops session/terminal/picker tabs on `tauri://created` → `TerminalView`
   cleanup kills their PTYs;
2. the new window adopts running action PTYs by id (`processManager.adopt`; Rust broadcasts
   `pty:*` events to every webview) and emits `abeon:detach-ready`;
3. the source window then calls `processManager.release` (unsubscribe, **no** `ptyKill`) and drops
   the action tabs.

## Providers

The app drives three AI CLIs, selected per session via `domain::Provider` (`claude` | `codex` | `opencode`):

- **Spawn**: `PtyKind::Agent { provider, … }` → `build_agent_command` in `commands/pty.rs`. Claude pre-assigns ids (`--session-id`/`--resume`); Codex and OpenCode cannot, so fresh tabs for those providers use a `new-<uuid>` placeholder linked later by `sessionsSlice.refreshActivity` (provider-matched). OpenCode resumes with `opencode --session <id>` and bypasses permissions with `--auto`.
- **Discovery**: Claude reads `~/.claude/projects/<encoded>/`; Codex reads global `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl(.zst)` filtered by `session_meta.cwd == project.path`; OpenCode 1.18.31 reads `~/.local/share/opencode/opencode.db` in read-only mode, filters by exact `session.directory == project.path`, and excludes rows with `parent_id` from the top-level list.
- **History**: Codex rollout `response_item`s map to the shared `HistoryBlock`; Codex block UUIDs are synthetic `cx-<physical_line>-<block_idx>`. OpenCode maps `message` and `part` rows to stable `oc-<part_id>` blocks. OpenCode history is mutable, so DB/WAL changes emit `session:<id>:sync` and the frontend replaces the overlapping tail instead of using append offsets.
- **Settings**: `enabledProviders` is persisted; more than one enabled provider opens a `providerPicker` tab for a new session. Provider detection checks binaries on the shell PATH. Codex and OpenCode model IDs are persisted as opaque strings; OpenCode keeps the native `provider/model` form and discovers values through `opencode models`.
- **v1 limits (by design)**: OpenCode remote bridge control, usage/cost, limits, and subagent presentation are unsupported. Codex `.zst` watcher updates activity only, without appended block parsing. Title generation dispatches per provider (`claude -p`, `codex exec --ephemeral`, or `opencode run --format json`) from a temporary directory; temporary OpenCode title sessions are deleted best-effort.

## Diagnostics log

Desktop launchers start the app with stdout/stderr on `/dev/null`, so `eprintln!`, Rust panics and
GTK/WebKit messages (written by C code straight to fd 2) used to vanish. `diagnostics::init()` — the
first call in `run()` — detects a discarded stderr and `dup2`s
`<data_local_dir>/pl.cyberstudio.abeoncode/logs/abeoncode.log` onto fd 2 (and fd 1 when it is
discarded too). On Linux that is `~/.local/share/pl.cyberstudio.abeoncode/logs/abeoncode.log`.
A terminal or a pipe is left alone, so `npm run tauri dev` still prints to the console. The file is
copy-truncated to `abeoncode.log.1` above 2 MiB, at start and once a minute.

Timestamped lifecycle lines come from `diagnostics::log_event`: `start`, `window close requested`,
`window destroyed`, `exit requested`, `exit`, `panic: …` and `terminated by SIGTERM|SIGHUP|SIGINT`
(the signal is logged, then re-raised with its default action, so the exit status is unchanged).

Reading an unexpected shutdown: a run whose `start` line has no matching `exit`, signal or panic line
died by SIGKILL or a hard fault (check the kernel journal and `/var/log/apport.log`); a lost Wayland
connection leaves a `Gdk-Message` line; a plain window close shows `window close requested` followed
by `exit`.

## Keyboard shortcuts (global)

- `Ctrl/Cmd+K` — focus sidebar search (`Sidebar.tsx`, document listener **with `capture: true`** so it wins over xterm's textarea while a session/terminal is focused).
- `Ctrl/Cmd+W` — close active tab (`TabBar.tsx`, document listener **with `capture: true`** so it wins over xterm's textarea).
- `Ctrl/Cmd+T` — toggle the session terminal drawer, or open a terminal tab outside a session (`AppShell.tsx`). While the drawer has focus, `Ctrl/Cmd+Shift+O` / `Ctrl/Cmd+Shift+E` split right / down and `Ctrl/Cmd+Alt+arrows` move between splits (`useTerminalDrawerShortcuts.ts`, capture-phase).

Pattern when adding a new global shortcut that may conflict with xterm: register on `document` in `useEffect` with `{ capture: true }`, then `preventDefault()` + `stopPropagation()`.

## Gotchas

- **Never call `term.dispose()`** in `TerminalView.tsx` — triggers a webkit2gtk crash. The cleanup path kills the PTY, detaches listeners, and lets the `Terminal` object be GC'd with its container. See note around line 127.
- **Content layers must never change DOM parent** — `PaneLayout` keeps every tab layer a direct sibling in one container and only moves it via inline `left/top/width/height`. Wrapping layers per pane (or re-keying them) remounts `TerminalView`, whose cleanup kills the live PTY.
- **Content layers must also keep their relative order** — `computePaneLayers` sorts them by id.
  React moves reordered keyed siblings with `insertBefore`, which detaches the node for a moment and
  resets xterm's scroll position and focus.
- **Middle-click on tabs needs `e.preventDefault()` in `onMouseDown`** — otherwise webview activates autoscroll cursor.
- **xterm input is base64-encoded** over IPC (`pty_write` / `pty:*:output`). The encoding/decoding is centralized in `lib/tauri.ts` — components never deal with base64 directly.
- **PTY output during hidden tabs is buffered** in `TerminalView.pendingWrites` and flushed on `visible` change. Don't bypass this — writing to an un-fitted xterm corrupts layout.
- **Settings hydration race**: `applyPersistedToState` runs sync from localStorage at boot; `hydrateFromSqlite` runs async. The SQLite path pre-sets `prevSnapshot` before applying state to prevent the `subscribe` handler from echoing hydrated values back to disk. Preserve this ordering when modifying.
- **Zustand selectors over arrays**: wrap with `useShallow` when selecting arrays/objects — see `selectSortedProjects` usage in `Sidebar.tsx` (commit `1bd2d64` fixed an infinite-rerender from missing it).
- **ts-rs exports `src/types/*.ts` during `cargo test`, NOT `cargo build`**. After adding `#[derive(TS)]`, run `cargo test` once to materialize the file. **Remote-contract types** (`RemoteCommand`/`RemoteEnvelope`/`RemoteEvent`) now live in the shared `crates/abeon-remote-core` crate; regenerate them with `cargo test --manifest-path crates/abeon-remote-core/Cargo.toml` (they still emit into `DesktopApp/src/types/`).
- **Lint**: `npm run lint` (= `tsc --noEmit`) should report zero errors. Any error is a real issue.
- The codex rollout fixture (`src-tauri/tests/fixtures/codex-rollout.jsonl`) is synthetic (documented 0.139 format) — verify against a real capture before relying on new payload fields.
- **Process-env mutating Rust tests** use shared `TEST_ENV_LOCK: Mutex<()>` at parent-module scope in `commands/settings.rs`. Reuse this pattern (not new local locks) when adding tests that touch `std::env::set_var`/`remove_var`.
- **Shell PTY program** is resolved per-spawn via `commands::settings::resolve_shell(&conn)` (fallback: `shellPath` setting → `$SHELL` → `"bash"`). Claude/Action PTYs deliberately use `bash -c <cmd>` (NOT `-lc`) as a stable command runner. `-l` was dropped because bash's login profile sources `nvm.sh` which calls `nvm use default` — that overrides the PATH we pre-loaded from the user's chosen shell, falling back to bash's nvm default (often a different node version than zsh's). Env from the chosen shell already provides what `-l` would have set up, so login behavior is redundant.
- **PTY env is loaded from the user's chosen shell**, not inherited from the Tauri process. `commands::settings::ensure_shell_env(&state, &shell)` runs `<shell> -lc 'env -0'` once and caches in `AppState::shell_env` (`Mutex<Option<HashMap>>`). Falls back to `std::env::vars()` if the subprocess fails. Cache is invalidated by `set_setting` when key == `"shellPath"`. This is how `bash -c "claude"` finds the right node binary even when nvm is set up only in zsh/fish rcfiles.
- **Action `pre_command`** (e.g. `nvm use 18`) runs via `<resolve_shell> -ic '<pre> && <cmd>'` — the chosen shell in **interactive** mode (`-i`), NOT bash and NOT login (`-l`). Reason: `nvm`/`fnm` are shell functions defined in the *interactive* rcfile (`~/.zshrc`, `~/.bashrc`), which only `-i` sources; `-l` sources profile files that usually lack the function, and bash never reads zsh's rcfile. Plain actions (no `pre_command`) still use `bash -c <cmd>` with the pre-loaded env.

## Useful commands

- `npm run dev` — Vite only (no Tauri shell).
- `npm run tauri dev` — full app.
- `npm run lint` — TS project references, no emit.
- `npm test` — frontend tests.
- `npm run test:rust` — backend tests.
