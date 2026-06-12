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
- `store/` — Zustand slices, one per domain: `settingsSlice`, `projectsSlice`, `sessionsSlice`, `tabsSlice`, `actionsSlice`, `gitSlice`. Composed in `store/index.ts`.
- `lib/tauri.ts` — **single typed wrapper** over `invoke()`/`listen()`. Every IPC call lives here; do not call `invoke` directly from components.
- `types/` — TS types, several are ts-rs-generated from Rust (`PtyKind.ts`, `GitStatus.ts`, etc.) — do not edit by hand.
- `components/`
  - `layout/AppShell.tsx` — three-column shell with draggable resizers; persists widths via store.
  - `layout/TitleBar.tsx` — custom titlebar.
  - `sidebar/` — left column: project list, sessions, sort menu, search.
  - `center/` — middle column: `TabBar` + `TabContent` + `CenterPanel`. **Tabs are managed here.**
  - `right/` — right column: Git status, Actions list, runnable scripts.
  - `terminal/TerminalView.tsx` — xterm wrapper for any PTY (claude, action, shell).
  - `history/` — session history viewer (markdown blocks).
  - `dialogs/` — modal dialogs (`ConfirmDialog`, `SettingsDialog`, `AddProjectDialog`, `AddActionDialog`).
  - `shared/` — `Icon`, `IconBtn`, `Kbd`.

### Backend (`src-tauri/src/`)
- `commands/` — Tauri command handlers grouped by domain: `projects.rs`, `sessions.rs`, `pty.rs`, `actions.rs`, `git.rs`, `settings.rs`, `activity.rs`. Registered in `lib.rs`.
- `db/` — SQLite migrations + queries.
- `pty/` — PTY spawning and lifecycle (claude / action / shell variants).
- `sessions/` — JSONL session reading and watch; Claude Code format at top level, `sessions/codex/` holds the OpenAI Codex rollout reader/parser/activity.
- `git/` — git2 wrappers.
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

`src/store/tabsSlice.ts` is the source of truth. Three tab kinds:
- `session` — Claude session, has `mode: 'history' | 'terminal'` (resume vs. live).
- `action` — running script with `status: 'running' | 'exited'`.
- `terminal` — bare shell PTY.

Closing a tab with an active process (`session+terminal`, `action`, `terminal`) **must** route through the `ConfirmDialog` in `TabBar.tsx`. Helpers there: `isActiveProcess()` + `closeWithGuard()`. Close triggers: X button, middle-click on tab, Ctrl/Cmd+W (global capture-phase listener).

## Providers

The app drives two AI CLIs, selected per session via `domain::Provider` (`claude` | `codex`):

- **Spawn**: `PtyKind::Agent { provider, … }` → `build_agent_command` in `commands/pty.rs`. Claude pre-assigns ids (`--session-id`/`--resume`); Codex cannot (`codex` / `codex resume <id>`), so fresh Codex tabs use a `new-<uuid>` placeholder linked later by `sessionsSlice.refreshActivity` (provider-matched).
- **Discovery**: Claude reads `~/.claude/projects/<encoded>/`; Codex reads global `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl(.zst)` filtered by `session_meta.cwd == project.path` (`sessions/codex/reader.rs`, mtime-keyed meta+title caches).
- **History**: codex rollout `response_item`s map to the shared `HistoryBlock`; codex block uuids are synthetic `cx-<physical_line>-<block_idx>` (append-only stable; watcher counts physical lines to match).
- **Settings**: `enabledProviders` (persisted); >1 enabled → "New session" opens a `providerPicker` tab. The CLI settings tab holds provider toggles (`detect_providers` checks binaries on the shell PATH) and per-provider title-gen models; the Models tab shows a section per enabled provider (Codex: `codexModelId`/`codexCustomModels`, '' = Auto; detection via `detect_codex_models` scanning recent rollouts' `turn_context.model`).
- **v1 limits (by design)**: remote bridge/roster is Claude-only; usage/cost tracking Claude-only; codex `.zst` watcher appends update activity only (no block parsing). Title generation dispatches per provider (`claude -p` / `codex exec --ephemeral` from a temp dir so no rollout is persisted).

## Keyboard shortcuts (global)

- `Ctrl/Cmd+K` — focus sidebar search (`Sidebar.tsx`, document listener **with `capture: true`** so it wins over xterm's textarea while a session/terminal is focused).
- `Ctrl/Cmd+W` — close active tab (`TabBar.tsx`, document listener **with `capture: true`** so it wins over xterm's textarea).

Pattern when adding a new global shortcut that may conflict with xterm: register on `document` in `useEffect` with `{ capture: true }`, then `preventDefault()` + `stopPropagation()`.

## Gotchas

- **Never call `term.dispose()`** in `TerminalView.tsx` — triggers a webkit2gtk crash. The cleanup path kills the PTY, detaches listeners, and lets the `Terminal` object be GC'd with its container. See note around line 127.
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
