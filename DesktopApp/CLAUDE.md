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
- `store/` — Zustand slices, one per domain: `settingsSlice`, `projectsSlice`, `sessionsSlice`, `tabsSlice`, `panesSlice`, `actionsSlice`, `gitSlice`, `terminalDrawersSlice`, `notesSlice`, `filesSlice`. Composed in `store/index.ts`.
- `lib/settingsCategories.ts` — settings categories (groups, labels, icons, search keywords), `filterSettingsCategories` and the "Terminal is new" flag; `lib/terminalAppearance.ts` — terminal fonts, palettes and xterm option builders; `lib/toolStatus.ts` — pairs tool-use blocks with their results for the history view; `lib/activity.ts` — session activity labels and colours (amber = running, blue = waiting for you); `lib/fileText.ts` (file tab ids, path helpers, BOM/EOL decode and encode), `lib/useFilesSync.ts` (directory-change listener) and `lib/fileGitStatus.ts` (git status by relative path) belong to the file browser.
- `lib/tauri.ts` — **single typed wrapper** over `invoke()`/`listen()`. Every IPC call lives here; do not call `invoke` directly from components.
- `types/` — TS types, several are ts-rs-generated from Rust (`PtyKind.ts`, `GitStatus.ts`, etc.) — do not edit by hand.
- `components/`
  - `layout/AppShell.tsx` — three-column shell with draggable resizers; persists widths via store.
  - `layout/AppHeader.tsx` — the 44 px app header (logo, project row or breadcrumb, active-session count); see "Header project row and pane bar".
  - `sidebar/` — left column: project list, sessions, sort menu, search.
  - `center/` — middle column: `CenterPanel` → `PaneLayout` (renders the pane tree: one `PaneBar` and one card frame per pane, one `TabPanel` content layer per tab, `PaneResizers`, `PaneDragOverlay` + `usePaneDrag` for the tab-drag gesture). `HeaderProjectRow` (project groups of the focused pane, mounted in `AppHeader`) and `useTabBarActions` (close guards, rename, menus, detach) live here too. **Tabs and panes are managed here.** `TerminalDrawerChrome` + `useTerminalDrawerShortcuts` render the per-session terminal drawer (layers computed by `lib/paneLayers.ts`, geometry in `lib/drawerGeometry.ts`).
  - `right/` — right column: Git panel (`GitSection` with tabs: working-tree changes / commit history via `GitHistory` + `CommitDiffDialog`), Actions list, runnable scripts. `RightPanel` swaps in `NotesPanel` while `notesPanelOpen`.
  - `notes/` — notes: `NotesPanel` (right-column list/editor), `NoteTiles`, `NoteEditor` (shared by panel and tab), `NoteTabView` (the `note` tab). Store in `store/notesSlice.ts`, helpers in `lib/noteText.ts`, change sync in `lib/useNotesSync.ts`. See "Notes".
  - `files/` — file browser: `FilesPanel` (right-column header, search box, tree or results), `FileTree`, `FileSearchResults`, `FileEntryMenu`, `FileTabView` (the `file` tab) and `CodeEditor` (the only CodeMirror import). Store in `store/filesSlice.ts`. See "File browser".
  - `terminal/TerminalView.tsx` — xterm wrapper for any PTY (claude, action, shell); `useTerminalAppearance.ts` feeds it the persisted appearance settings.
  - `history/` — session history viewer (markdown blocks).
  - `settings/` — the full-window settings view: `SettingsView` (search, nav column, page), `SettingsNav`, `controls.tsx` (shared `SettingsPage`/`SettingsSection`/`SettingsRow`, `Segmented`, `Switch`, `Stepper`, `SelectField`) and `categories/*` (one page per category, plus `TerminalPreview` and `CustomPaletteEditor`). See "Settings view".
  - `dialogs/` — modal dialogs (`ConfirmDialog`, `AddProjectDialog`, `AddActionDialog`, `RestoreSessionsDialog`, `UnsavedFilesDialog` + `useUnsavedFilesPrompt`, ClickUp and diff dialogs).
  - `shared/` — `Icon`, `IconBtn`, `Kbd`.

### Backend (`src-tauri/src/`)
- `diagnostics.rs` — log file redirect and lifecycle lines, see "Diagnostics log".
- `commands/` — Tauri command handlers grouped by domain: `projects.rs`, `sessions.rs`, `pty.rs`, `actions.rs`, `git.rs`, `settings.rs`, `activity.rs`, `notes.rs`, `files.rs`. Registered in `lib.rs`.
- `db/` — SQLite migrations + queries.
- `pty/` — PTY spawning and lifecycle (claude / action / shell variants).
- `sessions/` — session reading and watch; Claude Code JSONL format at top level, `sessions/codex/` holds the OpenAI Codex rollout adapter, and `sessions/opencode/` holds the read-only OpenCode SQLite adapter.
- `files/` — file browser backend: `paths` (path safety), `listing` (directory listing + `IgnoreChecker`), `search`, `content` (read, classify, version), `write` (conflict-checked save), `watch` (shared directory watcher + dirty-file registry); `commands/files.rs` is the thin command layer. See "File browser".
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

Six tab kinds:
- `session` — Claude session, has `mode: 'history' | 'terminal'` (resume vs. live).
- `action` — running script with `status: 'running' | 'exited'`.
- `terminal` — bare shell PTY.
- `providerPicker` — opens instead of a new session when more than one provider is enabled (see "Providers").
- `note` — one note (`noteId`), title is the note's first line. Never a live process, so it closes without a guard (through `closeNoteTab` in `useTabBarActions`, which releases the draft), cannot be renamed, is deduped by `noteId` in `openNoteTab` (its id `note:<id>` is set when the tab opens and kept by `repointNoteTabs` after a recreate, so never look a tab up by `noteTabId(noteId)`) and is **not persisted** (`writeTabsToLocalStorage` saves only session tabs). See "Notes".
- `file` — one project file (`path` relative to the project root, `title` = file name). Id is `file:<projectId>:<path>` (`fileTabId`), so `openFileTab` dedupes by project + path. Never a live process, **not persisted**, cannot be renamed (`canRename` excludes it) and travels through a detach as `path` only. A dirty one closes through `UnsavedFilesDialog`, not `ConfirmDialog`. See "File browser".

Closing a tab with an active process (`session+terminal`, `action`, `terminal`) **must** route through
the `ConfirmDialog` owned by `useTabBarActions.tsx`. Helpers there: `isActiveProcess()` +
`closeWithGuard()`, which first sends a dirty `file` tab through `useUnsavedFilesPrompt`. Close triggers: X button, middle-click on tab, Ctrl/Cmd+W (global capture-phase
listener).

### Header project row and pane bar

The old tab bar is split in two. The window header (`layout/AppHeader.tsx`, 44 px, variants `main`,
`project` and `session`) hosts `center/HeaderProjectRow.tsx`: one button per project group of the
**focused pane** (`usePaneTabs(focusedPaneId)`), so it follows pane focus. It calls
`useTabBarActions(tabs, undefined, { closeShortcut: false })`; the header needs the menus and
overlays but must not register a second Ctrl/Cmd+W listener. Each pane gets a `center/PaneBar.tsx`
below it with the sessions of the pane's selected project, the `+`/`$` buttons and the status of the
active tab (activity label or "Tylko odczyt" for history mode). While the settings view is open the
header shows a breadcrumb ("Ustawienia / <category>") instead of the project row, and the main
window shows "N aktywne sesje" (detached windows: "N aktywne") for live session/shell tabs and drawer
terminals. `project` windows show the project breadcrumb; `session` windows show the logo, the
project row of the focused pane and the "N aktywne" count; both window kinds also have the pane bar.

Both bars share `useTabBarActions.tsx` (close guards, rename, context menus, detach, and the
Ctrl+W listener, owned by `PaneBar`). Only `PaneBar` renders `TabItem.tsx`; the header row draws its
own project chips.

Pane geometry is in `lib/paneGeometry.ts` and `lib/drawerGeometry.ts`. `PANE_BAR_HEIGHT` (48) is
the single bar height; it feeds `PaneLayout`, `computePaneLayers`, `usePaneDrag` (`overTabBar`,
`canSplit`), `PaneResizers` (minimum pane height) and the drawer layout. A pane is a card: the
frame rect `paneFrameRect` is the pane rect inset by `PANE_GAP / 2` (`PANE_GAP` 8), and
`paneBarRect` / `paneContentRect` further inset it by `PANE_BORDER` (1) and split it at
`barHeight`. `PaneLayout` draws, in this order, per-pane surface divs (`data-pane-surface`, rounded
`bg-bg-elev`, behind everything), the bars, the content layers, drawer chrome, and last the frames
(`data-pane-frame`, `z-20`, border only). Frames sit **over** the layers on purpose: a
`box-shadow: 0 0 0 6px var(--color-bg)` in the ground colour trims the square corners of the xterm
canvases into the card's rounded corners. The frame of the focused pane is `border-focus`, but only
when there is more than one pane. The container has `margin-top: -PANE_GAP / 2` so the card touches
the header. Surfaces, bars and frames are siblings of the layers, never wrappers (see the content-layer
gotchas).

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
  `DRAWER_HEADER_HEIGHT` (36 px, shared by the open and the collapsed header; `computeCollapsedDrawerLayout`); the hidden terminals keep their open-size
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

`AppShell` and `DetachedShell` share one close guard (`layout/useWindowCloseGuard.tsx`):
`onCloseRequested` asks about unsaved files, settles notes, then prompts while any tab holds a live
process. The main window's confirm path calls `freezeTabPersistence()` **before** it drops the tabs. Dropping
them is what kills the PTYs, and an unfrozen persistence subscriber would save the emptied list and
erase the `live` marks the next start needs.

## Detached windows

Two window modes beyond the main shell, both routed by `lib/windowMode.ts` (`?view=…` in the
webview URL) and rendered by `layout/DetachedShell.tsx`:

- `session` — seeded with one session tab (`lib/detachSession.ts`, label `session-<id>`), but the
  window is a full pane host: its per-pane `PaneBar` carries the `+`/`$` buttons and splits work
  exactly as in the main window. Header variant `session`.
- `group` — every tab of one project (`lib/detachGroup.ts`, label `project-<id>`); the tab list
  travels as base64 JSON in the query string. Header variant `project`.

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
by `exit`. A `Gdk-Message: Error reading events from display` / `Lost connection to Wayland
compositor` is normal when the journal shows a power-off in the same second; otherwise the compositor
dropped the app because its main thread stopped reading events (see the main-thread gotcha below).

## Keyboard shortcuts (global)

- `Ctrl/Cmd+K` — focus sidebar search (`Sidebar.tsx`, document listener **with `capture: true`** so it wins over xterm's textarea while a session/terminal is focused).
- `Ctrl/Cmd+W` — close active tab (`useTabBarActions.tsx`, mounted by `PaneBar`; `HeaderProjectRow` passes `closeShortcut: false`; document listener **with `capture: true`** so it wins over xterm's textarea).
- `Ctrl/Cmd+T` — toggle the session terminal drawer, or open a terminal tab outside a session (`AppShell.tsx`). While the drawer has focus, `Ctrl/Cmd+Shift+O` / `Ctrl/Cmd+Shift+E` split right / down and `Ctrl/Cmd+Alt+arrows` move between splits (`useTerminalDrawerShortcuts.ts`, capture-phase).

Pattern when adding a new global shortcut that may conflict with xterm: register on `document` in `useEffect` with `{ capture: true }`, then `preventDefault()` + `stopPropagation()`.

Every global handler (including `useMouseNavigation`, and the `TabSwitcher` keyup, which closes the switcher without committing) starts with `if (useStore.getState().settingsOpen) return;`: the settings view sits over the still-mounted shell, and capture listeners on `document` would otherwise keep acting on hidden tabs. The shortcut recorder in `ShortcutsCategory` and the Esc handlers of dialogs/`SettingsView` are deliberately not gated.

## Settings view

Settings is not a dialog. `AppShell` renders `SettingsView` (`components/settings/`) as an absolute
layer (`top-11`, under the header) over the shell, whose columns are wrapped in
`<div inert={settingsOpen}>`. Nothing is unmounted, so every pane, terminal, PTY and scrollback
stays alive; `inert` takes the hidden columns out of the tab order and the pointer, and the header
stays usable (its breadcrumb shows the open category). Store: `settingsOpen`, `settingsCategory`,
`openSettings(category?)`, `setSettingsCategory`, `closeSettings` (`settingsSlice`).

- **Focus**: when `settingsOpen` flips on, `AppShell` remembers `document.activeElement` (unless it
  is `body`) in `focusBeforeSettings` and blurs it, so xterm stops swallowing keys; when it flips
  off it re-focuses that element if it is still connected. `SettingsView` closes on Esc (skipped
  when `e.defaultPrevented` or a `[role="dialog"]` is open) and via "Wróć do sesji".
- **Shortcuts are paused** while it is open (see "Keyboard shortcuts"): every global capture
  handler returns early on `settingsOpen`. New global handlers must do the same.
- **Pages**: `lib/settingsCategories.ts` defines the groups (Aplikacja, Agenci, Integracje), the
  categories and their `keywords`. The search box filters the nav through `filterSettingsCategories`
  (diacritics and case insensitive, `ł` folded) against the label and the keywords, so **a new
  setting needs its label and description added to its category's `keywords`** or search will not
  find it. The "Nowe" badge on Terminal is cleared by `markTerminalCategorySeen()`
  (localStorage `abeoncode.settings.terminalSeen`).
- **Controls**: pages are built from `controls.tsx` (`SettingsPage`, `SettingsSection`,
  `SettingsRow`, `Segmented`, `Switch`, `Stepper`, `SelectField`, `FIELD_CLASS`, button classes);
  reuse them instead of restyling.

## Terminal appearance

The Terminal settings page (`categories/TerminalCategory.tsx`, with a live `TerminalPreview` and a
`CustomPaletteEditor` that takes an xterm.js theme JSON via `parseXtermTheme`) edits seven persisted
settings: `terminalFontId` (`geistMono` | `jetbrainsMono` | `ibmPlexMono` | `system`),
`terminalFontSize` (10–20), `terminalLineHeight` (1.4 | 1.5 | 1.65), `terminalPaletteId`
(`grafit` | `grafitHighContrast` | `legacy` | `custom`), `terminalCustomPalette`,
`terminalCursorStyle` (`block` | `bar` | `underline`) and `terminalCursorBlink`. They are in
`PERSISTED_KEYS` and the serialize/deserialize switches like the rest, with validators in
`lib/terminalAppearance.ts`; `resetTerminalAppearance` restores `TERMINAL_DEFAULTS`.

- `lib/terminalAppearance.ts` owns fonts, palettes and `terminalOptions(appearance, appTheme,
  accent)`. In the light theme the palette is always `LIGHT_COLORS`, whatever palette is picked.
- `terminal/useTerminalAppearance.ts` selects the seven settings (with `useShallow`) for
  `TerminalView`, which builds `options` from them and the current `data-theme`/accent.
- **Live update**: changing a setting must not remount a terminal. `TerminalView` assigns
  `term.options.*` in an effect and refits (only when visible and measurable), so the PTY gets the
  new size through `onResize`. After the spawn it also syncs the PTY size when `term.cols/rows`
  moved while spawning.
- **Fonts**: bundled with `@fontsource/*` (imported in `main.tsx`: Geist Sans for the UI, Geist
  Mono / JetBrains Mono / IBM Plex Mono for terminals), so nothing depends on the system. xterm
  measures glyphs once per font, and a webfont loads lazily, so the effect waits for
  `document.fonts.load(...)` and then toggles `fontFamily` (fallback first, then the real one) to
  force a re-measure before the last refit. Without it the cells keep the fallback font's width.

## Notes

Short plain-text notes, per project or global, edited in the right column (`NotesPanel`, opened from
`ProjectToolbar`) or in a `note` tab. Agents add and read them with `abeon-code note` and the
`abeon-notes` skill. Spec: `docs/superpowers/specs/2026-11-08-notes-side-panel-design.md`.

- **No titles**: the first non-blank line is the title (`noteTitle` in `lib/noteText.ts`, used for
  tiles and tab titles). The `title` column stays in the schema but is always `''` on purpose:
  migration 007 folded old titles into `content` and sets it to `''`, and `notes_repo` only inserts `''`
  (the column is NOT NULL without a default) and never reads or updates it, because dev and installed builds share one SQLite DB and an older build still expects the
  column. Do not drop it or start using it. Migrations run in an IMMEDIATE transaction for the same
  reason (two builds can start against the DB at once).
- **Store owns everything** (`store/notesSlice.ts`): panel mode (`notesPanelOpen`, `notesScope`,
  `notesView` list/editor), the per-scope lists (`notesLists`, keyed `global` / `project:<id>`) and
  `noteDrafts`: note content, save status and panel mode live in the store. Components keep only view
  state (e.g. the `NoteTabView` load status and confirm dialogs).
- **One draft per note, shared by panel and tabs**: drafts are keyed by a UUID (a new note has no id
  yet) and found by `noteId` **or** `replacesNoteId` (`draftKeyForNote`). The panel editor and a `note`
  tab for the same note edit the same draft, so they cannot diverge. `NoteTabView` gets its draft from
  `ensureNoteDraft`.
- **Autosave** (`editNoteDraft` -> `scheduleSave`, `NOTE_SAVE_DEBOUNCE_MS` = 700 ms): every save goes
  through a per-draft promise chain (`saveChains`), so a create can never race the update that follows
  it and `flushNoteDraft` just awaits the chain. A save that hits `not_found` (note deleted elsewhere)
  recreates the note, sets `replacesNoteId` and re-points its tabs (`repointNoteTabs`); when the
  content being saved is blank it recreates nothing: the draft becomes a blank new draft
  (`noteId: null`, `replacesNoteId` kept so tabs still find it, status `idle`) and typing later
  recreates the note. A failed
  save leaves the draft in `error` with the content kept; `flushNoteDraft` then returns `false`.
- **Flush points** (all await `flushNoteDraft`/`flushAllNoteDrafts`/`settleNoteDraftsForExit` and
  refuse to continue on `false`): back to the list, closing the panel, "open in tab", closing a tab,
  detaching a group (`lib/detachGroup.ts`, which then re-reads the group's tabs, because the flush
  may have re-pointed a note tab to a recreated note), closing the main or a detached window
  (`AppShell`/`DetachedShell`, with a `ConfirmDialog` when notes cannot be saved), and in the update
  **after the download, before `install()`** in `AppShell`. The update runs download → checks →
  install → relaunch with nothing in between the last two, so that one settle covers both (on Windows
  `install()` exits the process, which is why nothing may wait until after it). A new flush point
  needs the same treatment or the last 700 ms of typing is lost.
- **Exit settles, detach only flushes**: the window-close handlers and the update flush call
  `settleNoteDraftsForExit`, which flushes non-blank drafts but deletes a blank draft that has a
  `noteId` (an emptied note is never stored; the draft turns into a blank new draft so an open tab
  keeps working). Their guard is `hasNotesToSettle`, which also covers a blank note already autosaved
  as `''`. Detach uses `flushAllNoteDrafts`, which saves blanks as they are, because the note stays
  open in the new window.
- **Empty notes are deleted on release**: `releaseNoteDraft(key, from)` drops the draft when no other
  holder (panel view or another note tab) still needs it, and a blank saved note is deleted from the
  DB (a `not_found` from the delete counts as success, the note is already gone), a blank never-saved
  draft is simply discarded. `deleteNoteById` treats `not_found` the same way. Releasing while another holder exists only
  flushes. `hasUnsavedNotes` ignores a blank unsaved draft.
- **Lists are merged, not replaced**: `mergeFetched` keeps a local note when it is newer than the
  fetched one, so a reload cannot show stale content over an autosave in flight. `reloadNotes`
  also refreshes clean drafts (no edits, not saving) from the fetched content (and retitles that note's tabs) and leaves dirty ones
  alone. Each load takes a token (`loadTokens`) and a stale response is dropped.
- **`notes://changed`** (`NotesChangedEvent`: `createdNoteId`, `external`, `sourceWindow`): the
  `create_note`/`update_note`/`delete_note` commands emit it with the calling window's label, and
  `lib/useNotesSync.ts` (mounted in `AppShell` and `DetachedShell`) ignores events from its own window
  and reloads for the rest. The CLI is a separate process, so after `note add` it sends
  `IpcRequest::NotesChanged` over the supervisor socket (`supervisor/ipc.rs`), and the router
  (`supervisor/runtime.rs`) re-emits it as an `external` event with no source window. Only the `main`
  window toasts „Dodano notatkę” for an external create. The ping is best effort and unix-only: with
  the app closed the note is still in the DB and the CLI still succeeds.
- **Panel placement**: `RightPanel` mounts `NotesPanel` while the panel is open and keeps the rest
  of the column mounted but `hidden` + `inert`. A subscriber in `store/index.ts` closes the panel
  when the last tab closes (`activeTabId` goes `null`), because the panel needs a project context.
- **CLI** (`src-tauri/src/cli/notes.rs`, reached from the `abeon-code` wrapper as
  `abeon-code note add|list [--global] [--limit N]`): the wrapper appends `--cwd "$(pwd -P)"` and
  the project is the registered project with the longest path prefix of it (`resolve_project`); no
  match is an error unless `--global`. The note comes from stdin (heredoc, max `MAX_NOTE_BYTES`),
  the output formats are what the skill documents (`abeon-code: note added …`,
  `--- note <id> · <date> ---`), so change them together with `cli/skill.rs`.
- **`wrapper_features` marker**: `cli/installer.rs` writes `wrapper_features="note"` into the wrapper.
  The `abeon-notes` skill greps for it before calling `abeon-code note`, because an outdated wrapper
  would not know `note` and start the app instead. Adding a new wrapper subcommand means extending
  that list (the skill's `grep 'wrapper_features=.*note'` stays valid when features are appended).
- **Skills**: `cli/skill.rs` installs `abeon-open-session` and `abeon-notes` into
  `~/.claude/skills`; "Zainstaluj skill" in Settings reinstalls the wrapper first, then both skills,
  and shows the skills root directory.

## File browser

A „Pliki” button in `ProjectToolbar` turns the right column into a file tree of the active tab's
project (`FilesPanel`, mutually exclusive with `NotesPanel`), with a search-by-name box. A file opens
in a `file` tab: text in a CodeMirror editor, Markdown as a rendered preview with „Edytuj”/„Podgląd”,
images read-only, binary/over 1 MiB as a message. Spec:
`docs/superpowers/specs/2026-11-11-file-browser-design.md`; manual QA list:
`docs/superpowers/specs/2026-11-11-file-browser-qa-checklist.md`.

- **Path safety**: every command takes a project id and a path relative to `project.path`, never an
  absolute one; the frontend never sees `project.path` for these calls. `files/paths.rs`
  (`resolve_existing`, `resolve_for_write`) rejects `..`, absolute paths and symlinks that leave the
  canonical root. A path component `.git` is refused in any letter case and also when spelled with
  zero-width characters (U+200B–U+200D, U+FEFF), also after symlink resolution (the tree and search
  never list it). On Windows a component containing `:` (alternate data streams) or ending in a dot
  or a space is refused too (`cfg(windows)`, never run here). A write to a missing file
  canonicalises the parent. Any new command that touches the disk must go through these two
  functions.
- **Reading** (`files/content.rs`): non-regular files (FIFO, directory) are refused before `open`, so
  a FIFO cannot hang the thread. The kinds are `text` (valid UTF-8, no NUL, ≤ 1 MiB), `image`
  (png/jpg/jpeg/gif/webp/svg ≤ 10 MiB, sent as a data URL; `IMAGE_TYPES` is the one table),
  `binary` and `tooLarge`. Every kind carries a `version` (`<mtime nanos>-<size>`, taken from the
  opened handle; negative nanos for a pre-epoch mtime), so a binary or too-large buffer knows its
  version from the first read. `read_project_file` returns that plus `watch_dir`
  (`FileReadResponse`): the project-relative directory where the bytes really live — the target's
  directory for a symlinked file, the real directory for a file reached through a symlinked
  directory, the path's own directory otherwise. The frontend decodes in `lib/fileText.ts`: a BOM is
  kept, CRLF is turned into LF for the editor and the predominant ending (LF on a tie) is written
  back on save.
- **Writing** (`files/write.rs`): `write_file(path, content, expected_version, force)`. A version
  mismatch is `AppError::Conflict` (`code: 'conflict'` in the frontend) unless `force`; `None`
  expected means "the file must not exist". Content over 1 MiB is refused in `commands/files.rs`.
  Strategy: temp file in the same directory + fsync + rename, keeping permissions and group, by
  default. **In place** (write from offset 0, then `set_len`, then fsync, opened with `O_NOFOLLOW`)
  for a file with several hard links, owned by another user, in a non-writable directory or itself
  not writable, and when creating the temp file, copying the mode and group onto it, or the rename
  fails, so a single-file bind mount or a container's `.env` keeps its inode. Exceptions: when that
  failure is a full disk or exceeded quota the save fails and the original is untouched (falling
  back would truncate it), and a read-only file is never replaced (`PermissionDenied`, also with
  `force`). A new file (saving a buffer whose file was deleted) goes only through temp + a
  no-clobber rename, so a file that appeared meanwhile is a conflict and is never replaced. The
  version is re-checked right before the rename and again on the opened handle for an in-place
  write. Mode and group (setuid/setgid included) are copied after the content is written. The
  returned version is the version of the bytes written, taken from the handle; on Windows it is
  read from the path after the file is closed (`settled_version`), because the close may stamp a
  new last-write time — that branch has never run on Windows.
- **Listing and search** (`files/listing.rs`, `search.rs`): directories first, then files,
  case-insensitive; `ignored` comes from `git2` (`IgnoreChecker`), with repository discovery capped
  at the project root's parent. A project that is only a subfolder of a larger repository therefore
  gets no ignore data (same as the Git panel). Listing a file is `invalid_path`. A repository that
  fails to open (broken config) lists without ignore data and is logged once per repository path for
  the life of the process. Search is by file name (a `/` in the query matches the relative path),
  ranks exact name, prefix, other, then shorter path (ties by lowercase, then exact path); it skips
  gitignored directories but not ignored files (so `.env` is found), uses a built-in skip list
  outside a repository, does not follow directory symlinks, walks breadth-first (a capped walk keeps
  shallow paths), stops after 200 000 visited entries, and returns the best 200 of all matches it
  collected (`truncated` is set when there were more matches or the walk hit the cap). **Search
  cancellation**: every request carries a per-window `sequence` (`filesSlice` counts up from
  `Date.now()`, so a reloaded page starts above anything it sent before). `SearchGenerations` keeps
  the newest sequence per window label; a walk stops at its next directory read once a higher
  sequence arrives from the same window (it resolves with what it found and `truncated: true`), and a
  request older than the newest one returns at once, empty and truncated. Clearing the query,
  closing the panel or following another project sends a blank search with a higher sequence while
  a walk may still run. The frontend keeps its debounce and its stale-response token. The tree
  renders at most 2000 rows per directory (`TREE_RENDER_LIMIT`).
- **Directory watches** (`files/watch.rs`): `FileWatches` owns **one** shared `notify` watcher. The
  registry is keyed by (window label, project id, relative dir); the OS watch for an absolute
  directory is added with the first live entry and removed with the last. Events are routed by path
  and by parent directory, access events are ignored, and each entry has a fixed 150 ms throttle
  before it emits `files://dir-changed` (`{ projectId, relDir }`) **to its own window only**
  (`emit_to`). A removed or renamed directory marks its entries and the watched subdirectories below
  it dead (they trigger once more, then stay silent). A `watch` call for a live key is a no-op; for a
  dead key it replaces the slot and re-adds the OS watch (`unwatch` first, so notify forgets the old
  inode); while the directory is still missing, `resolve_existing` refuses the call with
  `not_found` and the slot stays dead. The frontend makes these calls (see the re-arm rules below).
  A re-arm of a live slot needs no OS call. A queue overflow (rescan) triggers every live entry.
  **Window generations**: the `Destroyed` hook calls `retire_window` synchronously (bumps the label's
  generation) and then `drop_window(label, generation)` on `spawn_blocking`, never on the main
  thread; the drop removes only slots and the dirty count recorded under that generation or
  earlier, so a window re-created under the same label keeps the watches it set up before the
  deferred drop ran. When a `watch` replaces a slot (a dead one or one of an older generation), the
  replaced slot's directory goes through the same release as a removal (OS unwatch when no live slot
  uses it), also when the new slot is dropped again or points elsewhere. On macOS every live entry is
  triggered once after each OS-level watch or unwatch, because the shared FSEvents stream restarts
  (never run on macOS). Only directories are watched, non-recursively: a file tab watches the
  directory its bytes live in (`watch_dir`).
- **Frontend watch counts** live in module-level Maps in `filesSlice.ts` behind
  `retainDirWatch`/`releaseDirWatch` (not in store state): the panel retains the root and every
  expanded directory of the attached project, every file buffer retains its watch directory
  (`BufferRuntime.relDir`: the path's directory until the first read, then the `watch_dir` each read
  reports — a re-pointed link moves the hold exactly once, retain new before release old, and a read
  that resolves after the buffer was dropped moves nothing), and the Rust watch is set up or torn
  down on the 0↔1 transitions (serialised per key by `enqueueWatch`).
  **Re-arm**: because a deleted and recreated directory leaves a dead slot, `armWatch` calls
  `watchProjectDir` again for a held directory after every successful listing of it and after every
  successful version check of a buffer in it (on the same per-key chain, at most one call queued per
  key). A failed `watch`, and a listing or version check that fails with `not_found`, mark the key in
  `failedWatches`, so the next retain also re-arms it. Collapsing a directory releases its expanded
  descendants too, and so does a listing that no longer contains an expanded directory (removed or
  turned into a file): it and its expanded descendants leave `expanded` (`pruneExpanded`).
  Switching the active tab to another project re-attaches the panel (`followFilesProject`).
- **Re-check without events**: a dead watch delivers nothing, so `recheckFiles` runs the disk check
  of every open buffer and re-lists every directory the panel holds (root and expanded, only while
  the panel is open). `useFilesSync` calls it on the window `focus` event (the same trigger
  `GitSection` uses for its git refresh) and when the active tab becomes a file tab, throttled to one
  run per `FILES_RECHECK_INTERVAL_MS` (2 s) plus one trailing run. **Coalescing** (`coalesce` in
  `filesSlice.ts`): while a listing of a directory runs, further requests for it (events, re-check,
  expand, retry) collapse into one follow-up run after it; the re-check itself is coalesced the same
  way, so neither can build a growing queue. **Retry timer**: while the panel is open and a held
  directory has a listing in error or a lost watch, or an open buffer's watch directory is lost, a
  single 3 s timer (`FILES_RETRY_INTERVAL_MS`) re-lists those directories and runs those buffers'
  disk checks until nothing is in error or lost; it stops at once when that is so or the panel
  closes, and does not exist otherwise. So a directory deleted and recreated while the window keeps
  focus recovers within 3 s with the panel open.
- **`useFilesSync`** (mounted in `AppShell` and `DetachedShell`) listens with
  `getCurrentWindow().listen`, not the global `listen`: a targeted `emit_to` reaches the global
  listener of every window. On an event it re-lists a directory that has a listing
  (`reloadFileDir`; the IPC call always runs, only the store write is skipped when the entries are
  identical), schedules a 500 ms debounced `refreshGit` while the panel is open (the tree colours
  come from `gitSlice`, not a new git query; `gitStatusByPath`) and calls `checkFilesOnDisk`, which
  checks the buffers whose watch directory is that directory, and also those whose path is in it (so
  a re-pointed link is still noticed when its own directory is watched by the panel). Every save that reaches the disk also schedules that debounced
  `refreshGit` for its project, panel open or not (`onFileSaved` listener exported by `filesSlice`),
  so a save and the directory event it causes end in one git refresh.
- **Buffers** (`filesSlice.fileBuffers`, keyed by tab id, dropped by a `store/index.ts` subscriber
  when the tab leaves `tabs[]`, so a buffer survives a pane move): one promise queue per tab
  (`BufferRuntime.queue`) serialises load, save, reload and disk check, and the runtime object's
  identity (`isAlive`) plus `readToken` turn stale work into a no-op after a close or a newer read.
  This is why a save never raises its own „Plik zmienił się na dysku” bar: the disk check queued
  behind it compares against the version the save just stored. `saveFileBuffer` returns
  `saved | conflict | error | clean`; with `force` it never takes the clean shortcut.
  `reloadFileBuffer` returns `reloaded | kept | error` (`kept`: the user typed meanwhile or the
  tab was closed, so the disk text was not applied).
- **Disk-change rules**: clean buffer, changed file → silent reload. Dirty buffer → `disk:
  'changed'` bar with „Wczytaj ponownie” / „Zostaw moje”. **„Zostaw moje”** (`keepFileBuffer`,
  async, on the tab's queue) reads the file once and takes that text as the new `savedContent` and
  that read's version, so undoing back to the old text stays dirty and typing the disk text is
  clean; when the file is no longer text, or the read fails, `savedContent` becomes `null` (unknown
  baseline, never equal to the text, so the buffer stays dirty) and a failed read keeps the observed
  version as before. Deleted file → `disk: 'deleted'`, bar „Plik został usunięty”; a version check that
  fails with `not_found` (the parent directory is gone) counts as deleted too. Edited text is kept,
  and an **unedited** buffer whose file comes back (an agent switching branches, `git checkout`)
  reloads silently without a bar. Image, binary and too-large tabs show the deleted bar as well,
  without the save hint (they cannot be saved). A deleted buffer with content counts as dirty
  (`isFileDirty`), so closing it asks. Saving a deleted buffer whose path reappeared conflicts, stays dirty and shows
  the conflict dialog; „Nadpisz” writes with `force`. Saving never creates parent directories.
- **Dirty registry**: every window reports `dirtyFileTabIds(...).length` with `set_dirty_file_count`
  (once at store init and on every `fileBuffers` change; `store/index.ts` remembers the count only
  after the call succeeds, and failed calls are retried on the next change). Rust keeps it per window
  label; `dirty_files_in_other_windows` sums the other **live** windows (the label list comes from
  `webview_windows()`), so a count set after a window died never blocks an update.
- **Editor** (`CodeEditor.tsx`): the only file that imports CodeMirror (`@codemirror/*`,
  `@lezer/highlight`), loaded through `React.lazy` in `FileTabView`, so the app shell and every other
  tab do not pay for it. Languages load lazily by file name (`@codemirror/language-data`; `.env*`
  uses the legacy `properties` mode). `lineSeparator` is `"\n"` (the buffer is LF-normalised), so a
  `clipboardInputFilter` turns `\r\n` into `\n` in pasted and dropped text (otherwise the `\r` stays
  in the buffer and a CRLF file is saved with `\r\r\n`); a lone `\r` is left alone.
  `Ctrl/Cmd+S` is a CodeMirror keymap entry, not a global listener. The theme is built from CSS
  variables and re-built by a `MutationObserver` on `data-theme`; the mono font comes from the
  `font-mono` class on the container (`.cm-scroller` inherits), and `globals.css` gives
  `.cm-panels` the UI font so the search panel does not inherit the mono one. Compartments are
  created once per editor. The editor remembers the text it last reported (`lastEmittedRef`) and
  ignores a `value` equal to it, so a keystroke serialises the document once. Any other `value` is an
  external reload, applied as the minimal `diffRange` replacement, which keeps the scroll position and
  caret, with `addToHistory: false` and the history compartment reset, so Ctrl+Z after a reload cannot
  undo into the older text. **Tests mock `./CodeEditor`** (a textarea
  with the same props) because jsdom cannot host CodeMirror; the real editor is covered only by
  `CodeEditor.test.tsx`.
- **Unsaved-file guard points**: `useUnsavedFilesPrompt` (hook returning `{ prompt(tabIds),
  dialog }`, one prompt at a time) + `UnsavedFilesDialog` (Zapisz / Odrzuć zmiany / Anuluj). While
  „Zapisz” runs, only „Anuluj” and Escape stay enabled: cancelling resolves the prompt with `false`
  (the tab or window stays open), the queued save still finishes, and its late result is ignored
  because the hook settles only the request id it is waiting for. So a save that never resolves
  cannot make a window unclosable; the next close request opens the dialog again. A failed save
  keeps the dialog open and gives the keyboard back to „Zapisz”: `saveDirtyFiles` returns the failed
  tabs with `conflict` or `error`, and the dialog names conflicting files („Plik <ścieżka> zmienił
  się na dysku” / „Pliki <ścieżki> zmieniły się na dysku”, then „Otwórz zakładkę pliku i wybierz
  „Wczytaj ponownie” albo „Zostaw moje”, a potem zapisz.” — the steps the tab bar offers; „Nadpisz”
  exists only in the conflict dialog of a save from the tab) or shows „Nie udało się zapisać
  wszystkich plików.” for other errors. When the listed files come from more than one project, each
  entry (and each name in the conflict text) is „<projekt>: <ścieżka>”. Used
  at: tab close (`closeWithGuard`), group detach (`detachWithGuard` in `useTabBarActions`, **not**
  `lib/detachGroup.ts`), closing the main or a detached window (`useWindowCloseGuard`, shared by
  both shells: `onCloseRequested` asks **before** the notes settle step and the live-process
  confirm; each shell keeps its own live-process dialog and confirm path), and the update
  (`holdForUnsavedFiles` in `AppShell`, before the download and again after it, before the notes
  settle step and `install()`, each followed by the `dirtyFilesInOtherWindows` check that refuses
  with „Masz niezapisane pliki w innym oknie…”; a failed check also holds the update). A refusal
  after the download leaves the update downloaded but not installed and „Zaktualizuj” retries
  (`lib/updater.ts` downloads once per update object: the plugin's `download()` would fetch again
  and orphan the first bytes, and `install()` needs them). Files the user
  discarded in the first pass are not asked about again unless their content changed. A new
  code path that drops tabs or closes a window must add the guard.
- **„Wstaw ścieżkę do sesji”** types the relative path plus a space into `activeAgentPtyId` and
  refuses a path with C0, DEL or C1 control characters („Ścieżka zawiera niedozwolone znaki”): the
  bytes go to a live terminal, so a name containing a newline or an escape sequence would be
  executed.
- **Panel placement**: `RightPanel` mounts `FilesPanel` next to `NotesPanel` and hides the rest of
  the column (`hidden` + `inert`) while either is open; `openFilesPanel` first awaits
  `closeNotesPanel` (refused when the notes flush fails) and `openNotesPanel` closes the files panel.
  A `store/index.ts` subscriber closes the panel when the last tab closes. `FileTree` renders one
  memoised `FileTreeDir` per shown directory (it selects only its own listing and expanded children)
  and memoised rows with stable path-taking callbacks, so the context menu, a git refresh or a
  listing elsewhere re-renders only the rows that changed.
- **Known limits**: no arrow-key navigation in the tree (Tab, Enter and Space only); search results
  are not git-coloured; the project-subfolder-of-a-repo ignore gap above; switching a
  Markdown tab to preview unmounts the editor, which loses its undo history (the buffer is kept);
  file tabs are not restored after a restart; no file operations (create, rename, delete); `Ctrl/Cmd+S`
  saves only while the editor has focus. With the panel closed, a tab whose directory was deleted
  and recreated keeps the deleted bar until the next re-check (window focus, activating a file tab);
  the tab's „Spróbuj ponownie” exists only for a file that failed to load, it does not refresh a
  stale tab. The tree's „Spróbuj ponownie” re-lists a directory at once (the retry timer does it every
  3 s anyway).

## Supervisor agent

A background Claude session ("Agent sterujący") that answers the other sessions' `AskUserQuestion`
menus and end-of-turn questions, and gates production actions. Levels: Off, Relay (only forwards),
Assistant, Autonomous. Spec: `docs/superpowers/specs/2026-10-28-supervisor-agent-design.md`.

- **Module map** (`src-tauri/src/supervisor/`): `settings`, `guard` (production rules, redaction),
  `provenance` (who authored a prompt), `approvals`, `presence`, `hook_io`, `transcript`, `core`
  (state machine; `core/production.rs` guard flow, `core/operations.rs`), `effects` (side-effect
  trait), `events`, `tools` + `mcp` (the `abeoncode` MCP server the supervisor calls), `ipc`,
  `entry` (`hook`/`mcp` subcommands), `runtime` (wiring, tick, wake-up, attention filter),
  `workdir`, `process` (PTY lifecycle, backoff), `claude_md`; `test_support` is test-only. Commands
  in `commands/supervisor.rs`. Frontend: `components/supervisor/*`, `lib/supervisorProcess.ts`,
  `lib/usePresenceReporter.ts`, `lib/useSupervisorSnapshot.ts`, `store/supervisorSlice.ts`.
- **Panel stays mounted**: `AppShell` always renders `SupervisorPanel`; while closed it is
  `invisible` + `inert`, and the "Rozmowa" layer stays mounted the same way under the other panel
  tabs. Never render the panel or its `TerminalView` conditionally: every mount builds a new xterm and
  replays up to 1 MB from `supervisorProcess` (2–3 s per click in the packaged app). `visibility:
  hidden`, not `display: none`, keeps the container measurable, so the xterm and the PTY stay fitted
  while hidden and a reveal never resizes the PTY (no full Claude redraw). The keyboard reaches the
  terminal only through `takeFocus`, and focus left inside a part that gets hidden is blurred.
- **Socket**: `$XDG_RUNTIME_DIR/abeoncode/supervisor.sock` (fallback
  `<data_local_dir>/pl.cyberstudio.abeoncode/run/supervisor.sock`), dir `0700`, socket `0600`. A live
  socket is never stolen; a dead one is unlinked; a second instance runs inert. `ipc`, `entry` and
  `mcp` are `#[cfg(unix)]`. `abeoncode hook <channel>` and `abeoncode mcp` are handled in
  `run()` before `diagnostics::init()`; with no server a hook prints nothing and exits 0. When a hook
  client disconnects mid-request (Esc in the session kills the hook process), the server drops the
  request's future, so a held menu's card disappears at once.
- **Held menus**: a `Menu` whose decision window (120 s after grace) runs out is escalated only if
  the supervisor drained its event; an event it never took is released to the TUI menu
  (`released_to_user`).
- **Per-session hooks**: `<app_data>/supervisor/session-hooks.json` is passed via `--settings` only to
  AbeonCode-spawned Claude sessions, and only while the level is not Off. It merges with the user's
  global hooks. SessionStart 15 s, Stop 15 s, UserPromptSubmit 15 s, PreToolUse `AskUserQuestion`
  600 s, PreToolUse `Bash|mcp__.*` 15 s. The command embeds `current_exe()`; the file is rewritten on
  every start.
- **Session id changes**: those sessions get `ABEONCODE_PTY_ID=<pty id>` in their environment and
  `hook session` forwards it (`IpcRequest::Hook.pty_id`). Only a `SessionStart` hook binds: when
  `/clear` or an in-TUI `/resume` puts a new session id on the same PTY, it rebinds the registry and
  the core forgets the old session (queued injections, open questions and held menus, escalations,
  tokens, provenance). `SessionPtyRegistry::claim` accepts only PTY ids the app issued to hooked
  Claude sessions (never shells) and keeps every session id on the PTY it was first bound to (the
  history goes with the PTY on `pty_kill`), so a forged hook cannot move a session onto another
  terminal. A claim that would displace a different session from its PTY also needs a real Enter
  (`\r`) in that PTY within the 10 s submit window (a real `/clear` or `/resume` is always confirmed
  with Enter there); without it nothing is rebound, displaced or announced. A session whose
  `SessionStart` was lost has no PTY, so its prompts are Agent. Each
  rebind emits `supervisor:session-rebound` `{ ptyId, sessionId }`; `useSupervisorSnapshot` (both
  window shells) relinks the session tab whose `ptyId` matches via `linkNewSession`, so the question
  card, presence and attention follow the new id. Every agent tab records its `ptyId`
  (`markSessionPtyStarted`), and `ResumedTerminal` (`TabContent.tsx`) freezes the `--resume` id at
  mount, so relinking a live tab never remounts `TerminalView` or respawns its PTY.
- **Known residual**: hook payloads cannot be authenticated against the session's own tools (same env and uid), so a forged `UserPromptSubmit` within 10 s of a real Enter in the same terminal still counts as Human.
- **Not a sandbox**: the guard is a tripwire against agent and supervisor mistakes; an unguarded `Write` followed by `bash script.sh`, or a nested `claude -p`, bypasses it.
- **Resume elsewhere**: `/resume A` in another terminal is refused while A is still homed on its first live PTY, so A's prompts count as Agent there.
- **Remote resumes**: sessions resumed from the mobile app (`spawn_claude_resume`) run without the per-session hooks, so the supervisor neither sees nor guards them.
- **Supervisor workdir** (`<app_data>/supervisor`): `CLAUDE.md` (regenerated), `preferences.md`
  (created once, the supervisor may edit it), `mcp.json`, `.claude/settings.json`. The process runs
  with `--permission-mode dontAsk` (plus `--strict-mcp-config` while Discord is off, see below) and
  never skip-permissions; settings carry no
  `ask` key, allow `mcp__abeoncode__*` and `Read(//<abs root>/**)` (the absolute `//` syntax), deny
  Bash/Web/Task/Agent, `AskUserQuestion` and the plan-mode tools (the wake-up `\r` would answer such
  a menu blindly) and credential directories, disable the user's plugins, and turn Remote Control
  and push notifications off. `open_session` accepts only paths of registered projects.
- **Readiness**: only the supervisor's own `SessionStart` hook with a matching session id marks it
  ready. Nothing is typed into its PTY before that, and queued events survive.
- **Wake-up**: plain text `[abeon] nowe zdarzenia`, written only after a 5 s window with no keystrokes
  in the supervisor PTY. Text and `\r` are two writes ~250 ms apart; the answer prefix for sessions
  is `[agent sterujący] `. Injected text is capped at `MAX_INITIAL_PROMPT_BYTES`, and
  `PtyManager::write`/`resize` clone the handle and drop the global map lock before touching the PTY,
  so a session that stops reading stdin cannot stall `pty_write` for the other terminals.
- **Provenance** (`UserPromptSubmit`): typed injection with no keystroke since (or exact text) ->
  Supervisor; prompt the app passed on the CLI -> Agent; Enter (`\r` outside escape sequences and
  bracketed paste; `\n` from Ctrl+J or a raw paste does not count) within 10 s in the session's known
  PTY -> Human; otherwise, including a session with no known PTY, Agent. `pty_write` feeds
  `input_activity`, which ignores terminal reports (focus, cursor position, device status) so they
  never count as typing.
- **Guard** (`PreToolUse` on `Bash|mcp__.*`): applies whenever the level is not Off and the origin is
  not Human; a session with no prompt record (never prompted, or forgotten after a rebind) is Agent.
  Built-in Bash rules: `git push` to `main`/`master`, `task release`, `gh pr merge` and
  `bkt pr merge`; extra `bash:` rules are labelled `reguła: <pattern>` so command text never reaches
  the notification title. The parser (`guard.rs`) is quote-aware, joins `\`-newline continuations,
  strips wrappers (sudo, env, timeout, flock, setsid, doas, ionice, systemd-run, `uv run`,
  `poetry run`, `pipx run`, npx, bunx, …) and caps `eval` / `<shell> -c` / `env -S` nesting at 8
  levels. Segments are split quote-unaware first (so `$(…)` inside double quotes is still seen); a
  second, quote-aware pass re-reads every segment that the first split cut inside quotes, so a quoted
  script reaches classification intact. Inline scripts of `python*`/`pypy*`, `node`, `bun`, `perl`,
  `ruby`, `php` and `lua` are classified with their quotes blanked out; short-option clusters are
  scanned until a value-taking letter (`ruby -rtime -e`, `perl -Mautodie -e`, `env -vS`). Fail
  closed: a segment that classifies as nothing, whose program is not `git`, `gh`, `bkt`, `echo` or
  `printf`, and whose raw text has the word `git` (or `…/git`) followed by `push` is `git push → ?`
  (only when no exact push label was found), which always needs approval; so are a script piped into
  a shell or an interpreter and nesting past the cap. A blocked action creates an approval (expires after 24 h) shown in the panel's "Do
  decyzji" tab; the user approves in the app or by a coded Discord DM reply (below). An approval mints a one-shot token for the exact
  action fingerprint (cwd + normalised command, or tool + canonical args), valid 30 min, and the
  app then types an approval notice into the session so it retries (a rejection notice on reject). A Human prompt revokes the session's tokens.
  Confirm-style bandzior tools are guarded only when `confirm` is truthy (previews pass). Detail
  shown to the user is redacted.
- **Attention filter**: the supervisor's own `Notification` markers are dropped by workdir or session
  id (`runtime::attention_filter`), so it never raises a sidebar badge or desktop notification.
  The other way round, a held `Menu` entering grace and every escalation emit the regular
  `session-attention` event for that session (`Effects::attention`), because a held hook keeps
  Claude's own `Notification` hook silent.
- **Decision log**: table `supervisor_decisions` (migration 006), pruned to 30 days at start. Kinds:
  `answered`, `relayed`, `escalated`, `guard_blocked`, `approved`, `rejected`, `session_opened`,
  `released_to_user`. Read it in the panel's "Dziennik" tab or with
  `sqlite3 ~/.config/AbeonCode/abeoncode.db "select datetime(created_at/1000,'unixepoch'), kind, decision from supervisor_decisions order by created_at desc limit 20"`.
- **Discord spawn** (`process::prepare_launch`, `discord/`): with `supervisorDiscordEnabled` and a
  passing preflight (Bun + bot token) the supervisor gets `--channels
  plugin:discord@claude-plugins-official` and **no** `--strict-mcp-config`, which hides plugin MCP
  servers too, so the channel would never start. A failed preflight launches exactly as without
  Discord and records the Polish blocker (`SupervisorProcess::discord_link`). The core's
  `discord_active` is true only while a supervisor launched with the channel **and** a stored DM chat
  id (`supervisorDiscordChatId`) runs. `runtime::link_discord_chat` (at start, when Discord is
  switched on, after a token save) derives the id with `POST /users/@me/channels` for `allowFrom[0]`,
  stores it and restarts once; it does nothing when an id is stored and only logs REST errors.
  Settings changes go through `runtime::transition`: Discord toggled with the level on restarts, a
  level-only change rewrites the workdir with the Discord context of the last launch.
- **Bun on `PATH`**: the plugin server runs on Bun, which the installer adds to `PATH` only in
  `~/.zshrc`, and the app's PTY env comes from `<shell> -lc 'env -0'`, a login non-interactive
  shell that skips `~/.zshrc`. `discord/preflight.rs` tries `PATH`, then `$BUN_INSTALL/bin/bun`, then
  `~/.bun/bin/bun`, and prepends the found directory to the supervisor's `PATH` only; without it the
  plugin fails with `Executable not found in $PATH: "bun"`.
- **Failure cache**: Claude Code caches a failed plugin start for 15 minutes across all sessions
  under the key `plugin:discord:discord` in `~/.claude/mcp-needs-auth-cache.json`. Before each
  Discord launch the app removes only that key (atomic read-modify-write, other keys untouched); an
  error is logged and the launch goes on.
- **Plugin scope**: an enabled plugin starts its server and logs in with the bot token in every Claude
  session, so the setup turns `discord@claude-plugins-official` off in the global `enabledPlugins`
  (after the user confirms), and the workdir's `.claude/settings.json` enables it, and allows
  `mcp__plugin_discord_discord__*`, only for a Discord launch. Without `--strict-mcp-config` the
  user's global MCP servers load too; `dontAsk` denies their tools and `mcp__bandzior` has an
  explicit deny rule.
- **DM approvals** (`discord/poll.rs`, `discord/replies.rs`): every 10 s, only while an approval is
  pending and Discord is enabled, linked and has a token, the app reads the DM over REST (paged from
  the oldest pending request, at most 10 pages) and accepts `zatwierdzam <KOD>` / `odrzucam <KOD>`
  only from non-bot authors in `allowFrom`, posted after the request was created, with the exact
  4-character code. Each line of a message is checked on its own and must be exactly that reply, so
  `A: tak` + newline + `zatwierdzam K7QX` approves while `A: tak, zatwierdzam K7QX` does not. A match
  resolves the approval and reacts ✅/❌. The token is never logged.
- **Routing**: present with `supervisorDiscordMuteWhenPresent` on -> app; otherwise Discord when the
  channel is live (`discord_active`); otherwise app. When the user goes from present to away while
  the channel is live, or the channel goes live while routing already says Discord (relaunch while
  away, Discord switched on, chat linked later), open app escalations and pending approvals switch
  to `discord` and reach the supervisor as one `Forwarded` event (one DM); escalations whose session
  no longer waits for the user (the supervisor already relayed an answer) stay in the app list and
  are not forwarded. A menu the app escalates itself on timeout while away is forwarded the same way.
- **Live channel limit (accepted)**: `discord_active` means a supervisor launched with the channel
  and a linked chat id, not a connected plugin. If the plugin dies at runtime (revoked token,
  network) routing still says Discord until the next relaunch; the Settings status shows `botError`
  for a revoked token.
- **Discord buttons** (`discord/buttons.rs`, `gateway.rs`, `registry.rs`, `render.rs`,
  `interactions.rs`, `jobs.rs`; spec `docs/superpowers/specs/2026-11-01-supervisor-discord-buttons-design.md`):
  the supervisor posts batches with `mcp__abeoncode__discord_post` (app-rendered Components V2
  message, keys assigned by the app) and reports text answers with `mcp__abeoncode__discord_answered`;
  `reply` is only for conversation and the fallback text layout. The app runs its own gateway
  connection with `intents: 0` (interactions only); a tap becomes `discordAnswer` (with `open_keys`)
  or resolves the approval directly. The registry of posted messages is in memory, so after a restart
  old buttons answer „Nieaktualne”. Messages are PATCHed when a settle signal arrives
  (`DiscordSync`: approval resolved or expired, `discord_answered`, `send_to_session`, a Human prompt,
  dismissed escalation, rebind). `custom_id`s start with `abeon:`: the app's gateway ignores
  non-`abeon:` buttons, and the plugin handles only its own `perm:` buttons, so neither answers the
  other's clicks. Settings show a status row for the buttons connection. `claude_md.rs` teaches all
  of it: a validation error is corrected and retried once, and the text layout is the fallback only
  when the buttons are offline or the retry fails.

## Gotchas

- **Heavy Tauri commands must be `#[tauri::command(async)]`** — a plain `#[tauri::command] fn` runs
  inline on the GTK main thread, which also reads the Wayland socket. COSMIC (smithay) silently
  disconnects a client whose socket fills up, and the kernel buffer holds only ~280 pointer-motion
  frames, so a ~0.3 s stall while the mouse moves kills the app (GTK `_exit(1)`, no `exit` line).
  Anything that scans session files, runs git, spawns processes or waits on the clipboard goes on the
  thread pool; cheap SQLite CRUD and order-sensitive PTY calls (`pty_write`, `pty_resize`,
  `pty_kill`) stay sync.
- **Never call `term.dispose()`** in `TerminalView.tsx` — triggers a webkit2gtk crash. The cleanup path kills the PTY, detaches listeners, and lets the `Terminal` object be GC'd with its container. See note around line 127.
- **Content layers must never change DOM parent** — `PaneLayout` keeps every tab layer a direct sibling in one container and only moves it via inline `left/top/width/height`. Wrapping layers per pane (or re-keying them) remounts `TerminalView`, whose cleanup kills the live PTY.
- **Content layers must also keep their relative order** — `computePaneLayers` sorts them by id.
  React moves reordered keyed siblings with `insertBefore`, which detaches the node for a moment and
  resets xterm's scroll position and focus.
- **Never type into the supervisor PTY before it is ready** — Claude's workspace-trust dialog defaults to "No, exit", so a stray `\r` (or the wake-up text) kills the supervisor session. Readiness comes only from its `SessionStart` hook.
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
