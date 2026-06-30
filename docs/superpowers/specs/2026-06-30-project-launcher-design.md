# Project Launcher (Ctrl+Shift+N) — Design

**Date:** 2026-06-30
**Status:** Approved (design) — pending spec review before planning
**Scope:** DesktopApp only (`DesktopApp/src`).

## Goal

Add a `Ctrl+Shift+N` quick launcher: a centered overlay with a search box on top
(focused immediately on open) and a list of projects below. The user types to
filter projects, and launches work in the highlighted project without leaving the
keyboard:

- `Enter` — start a new session in the highlighted project.
- `Ctrl+Enter` — open a new terminal in the highlighted project.

This complements the existing per-project sidebar buttons (`New session` /
terminal) and the active-project shortcuts (`mod+n` / `mod+t`), giving a
project-agnostic launcher that does not require the target project to be expanded
or active.

## Interaction model

Search-driven palette with a focused text input (unlike `TabSwitcher`, which is a
hold-Ctrl MRU cycler with no input).

**Open:**
- `Ctrl+Shift+N` (rebindable, default `mod+shift+n`) — open the overlay; if it is
  already open, close it (toggle). On open, the query is reset to empty and the
  search input receives focus immediately.

**Navigate (while open, handled on the input):**
- Typing — filters the project list; the selection resets to the first row on
  every query change.
- `ArrowDown` / `ArrowUp` — move the highlight, clamped to `[0, length-1]` (no
  wrap).
- **Hover** a row — moves the highlight to that row.

**Commit:**
- `Enter` — `openNewSessionTab(selected.id)`, then close.
- `Ctrl+Enter` / `Cmd+Enter` — `openNewTerminalTab(selected.id)`, then close.
- **Click** a row — same as `Enter` (start a new session), then close.
- `Escape` — close without launching.
- **Click the backdrop** — close without launching.

**Selection start:** The first row is highlighted by default and the highlight
returns to the first row whenever the filtered list changes. The user may move it
down with `ArrowDown` before committing.

**Ordering:** Projects appear in the same order as the sidebar
(`selectSortedProjects` — manual / alpha / activity, per the user's sort setting),
so the launcher and the sidebar stay consistent.

**Search scope:** Case-insensitive substring match over project `name` **and**
`path` — identical to the existing sidebar search.

## Edge cases

- **No projects / no matches** → the list shows an empty-state row ("— brak —")
  and `Enter` / `Ctrl+Enter` are no-ops.
- **Reusing `openNewSessionTab`** preserves the multi-provider behavior: when more
  than one provider is enabled, it opens a `providerPicker` tab instead of
  launching directly. The launcher does not special-case this.
- **`Ctrl+Shift+N` is rebindable** via Settings → Skróty (it joins the `SHORTCUTS`
  registry, so conflict detection and reset-to-default work automatically). The
  default `mod+shift+n` maps to `Ctrl+Shift+N` on Windows/Linux and
  `Cmd+Shift+N` on macOS, consistent with the other `mod+…` shortcuts.
- **xterm focus:** the open listener is registered on the document in capture
  phase, the mandated pattern for global shortcuts that may conflict with xterm.

## Architecture

### 1. `src/lib/shortcuts.ts` — register the rebindable shortcut

Extend the `ShortcutId` union with `'openProjectLauncher'` and append to
`SHORTCUTS`:

```ts
{ id: 'openProjectLauncher', label: 'Szukaj projektu',
  description: 'Otwiera szybką wyszukiwarkę projektów (nowa sesja / terminal)',
  defaultBinding: 'mod+shift+n' }
```

`matchesBinding` already parses `mod+shift+n` (mods `{mod, shift}`, key `n`); no
parser changes are needed. `ShortcutsTab` in `SettingsDialog` maps over
`SHORTCUTS`, so the new shortcut appears in Settings, is rebindable, and is
included in conflict detection without further changes. The default does not
collide with `mod+n` / `mod+t` / `mod+w` / `mod+k`.

### 2. `src/lib/projectLauncher.ts` — pure filtering logic (new, testable)

Mirrors the `lib/tabSwitcher.ts` pattern (pure helpers extracted from the
overlay component for Vitest coverage):

- `filterProjects(projects: Project[], query: string): Project[]` — when `query`
  is blank, returns the input unchanged (preserving sidebar order); otherwise
  keeps projects whose lowercased `name` or `path` contains the lowercased,
  trimmed query.
- `clampIndex(index: number, length: number): number` — clamps to
  `[0, max(0, length - 1)]`; returns `0` for an empty list.

### 3. `src/components/center/ProjectLauncher.tsx` — overlay (new)

Mounted once in `AppShell` (app-global; works regardless of which tab/terminal
has focus). Projects are selected from the store with `useShallow`
(`selectSortedProjects`).

State (local):
- `open: boolean`
- `query: string`
- `index: number` — selection within the filtered list

Global open listener — `keydown` on the document, capture phase
(`{ capture: true }`):
- `matchesShortcut(e, 'openProjectLauncher', overrides)` → `preventDefault()` +
  `stopPropagation()`, toggle `open`; on open reset `query = ''` and `index = 0`.

Input handling (the overlay's search `<input>`, focused on open):
- `autoFocus` plus an explicit focus via ref in `useLayoutEffect` keyed on `open`,
  guaranteeing the input is focused the instant the overlay mounts.
- `onChange` → update `query`, reset `index = 0`.
- `onKeyDown` (each handled key calls `stopPropagation()`):
  - `ArrowDown` → `index = clampIndex(index + 1, list.length)`.
  - `ArrowUp` → `index = clampIndex(index - 1, list.length)`.
  - `Enter` (no Ctrl/Cmd) → if a row is selected, `openNewSessionTab(sel.id)` +
    close.
  - `Enter` with `ctrlKey || metaKey` → `openNewTerminalTab(sel.id)` + close.
  - `Escape` → close.

Rendering (when `open`):
- Backdrop `fixed inset-0 z-50` with a dim layer (`bg-black/40`), content aligned
  toward the top like a command palette (e.g. `flex items-start justify-center`
  with `pt-[15vh]`). Backdrop `onMouseDown` → close; inner panel
  `onMouseDown` → `stopPropagation`.
- Panel: a search input row at the top (search icon + input, styled like the
  sidebar search), then a scrollable list (`max-h`, `overflow-y-auto`,
  `scroll-thin`).
- Each row: project color dot (`getProjectColor(project)`), project `name`, and a
  muted, truncated `path`. The selected row is tinted with the project color
  (`${color}33`), matching `TabSwitcher`.
- Row `onMouseEnter` → set `index` to that row's position.
- Row `onMouseDown` → `openNewSessionTab(id)` + close (mouse parity with `Enter`).
- Footer hint line: `Enter — nowa sesja · Ctrl+Enter — terminal · Esc`.
- Empty list → a single muted "— brak —" row.
- Returns `null` when `!open`.

UI text in Polish per project convention.

Terminal-via-mouse is intentionally omitted (keyboard `Ctrl+Enter` covers it) to
keep the first version lean.

### 4. `src/components/layout/AppShell.tsx` — mount

Render `<ProjectLauncher />` alongside the existing `<TabSwitcher />`.

## Data flow

```
Ctrl+Shift+N (keydown, capture)
  └─> ProjectLauncher: toggle open, reset query="", index=0
        input focused (autoFocus + ref)
        typing → setQuery → filterProjects → index reset to 0
        Arrow / hover → clampIndex (local only)
        Enter        → openNewSessionTab(sel.id) + close
        Ctrl+Enter   → openNewTerminalTab(sel.id) + close
        click row    → openNewSessionTab(sel.id) + close
        Escape / backdrop → close
```

The store actions (`openNewSessionTab` / `openNewTerminalTab`) are reused as-is;
no store changes are required.

## Testing

- **`lib/projectLauncher.test.ts`** (Vitest): `filterProjects` matches by name,
  by path, is case-insensitive, trims, and returns the input order for a blank
  query; `clampIndex` handles empty list, lower bound, and upper bound.
- **`ProjectLauncher` behavior** is interaction-heavy (document key events +
  focused input); the pure selection/filter math is covered by the helper above.
  An optional jsdom component test can cover `Enter` / `Ctrl+Enter` dispatch and
  the index-reset-on-query behavior, proportional to the rest of the repo.
- **Manual verification:** open with `Ctrl+Shift+N` from a focused terminal
  (xterm does not swallow it); immediate input focus; filter by name and by path;
  first row highlighted and re-highlighted after each keystroke; `ArrowDown` then
  `Enter` launches a session in the right project; `Ctrl+Enter` opens a terminal;
  multi-provider case opens the provider picker; `Escape` / backdrop close;
  rebinding the shortcut in Settings works and conflicts are detected.

## Out of scope (YAGNI)

- Terminal launch via mouse (a per-row terminal button) — keyboard only in v1.
- Fuzzy / multi-token matching or match highlighting (plain substring for now).
- Launching by session, action, or arbitrary command — projects only.
- Persisting the launcher's last query or recent-projects ordering.
