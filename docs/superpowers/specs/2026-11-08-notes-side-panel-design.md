# Notes in the right panel, note tabs and AI access — design

Date: 2026-11-08 · App: `DesktopApp/` · Scope: notes stop opening in a separate window. The
„Notatki” button turns the right panel into a notes panel (tile list → full-panel editor), a note
can be opened as a tab in the centre, notes lose their titles and save automatically, and Claude
sessions can add and read notes through the `abeon-code` command and a skill.

Supersedes parts of `2026-09-16-notes-module-design.md`: the separate window, the title field,
explicit saving (`Zapisz`) and the unsaved-changes guards all go away. Storage (SQLite table
`notes`) and the project / global scopes stay.

## Why

The user takes quick notes during conversations with clients. What matters is how few steps lie
between the click and typing, and that nothing typed is ever lost. A separate window gets in the
way; a title field is friction nobody needs; a `Zapisz` button is a way to lose text.

Longer writing („muszę napisać większą część, albo skupić się na samym pisaniu”) belongs in a
centre tab. And the agent in a session should be able to write a note („dodaj notatkę z informacją
o…”) and read them back („zrób to, co zanotowałem po rozmowie z klientem”).

## Decisions agreed with the user

1. The **right** panel switches to notes. Clicking „Notatki” in the project toolbar
   (Terminal / Edytor / Notatki) replaces the whole right panel; a close button restores it.
2. At the top: „+ Nowa” and a close button (✕). Below: the notes as **tiles** showing part of their
   content. **No titles** — the content is enough.
3. Clicking a tile opens the note **in the right panel, in edit mode, replacing the list**
   (mockup variant A): „← Notatki” back, open-as-tab, delete, then a textarea filling the panel.
4. A note can also be opened **as a tab in the centre**, for longer or focused writing.
5. The AI can **add** notes and **read** them.

The user also accepted these proposals when they were played back (they are not the builder's to
change): autosave with a „Zapisano” indicator instead of a save button; „+ Nowa” goes straight to
an empty editor with the caret in it; an empty new note is not saved; the project / global switch
stays; the list follows the active tab's project while an open note stays open; existing titles
become the first line of the content; the separate notes window is removed entirely; the note tab
lives in the current project group with the first line as its title; open-as-tab returns the panel
to the list; plain text, no Markdown; the AI part goes through `abeon-code` + a skill installed from
Ustawienia → CLI, resolves the project from the session's directory (subdirectories too), creates a
global note only when asked, refuses outside a registered project, works with the app closed, does
not edit or delete notes; the open list refreshes and a short „Dodano notatkę” toast appears when the
AI adds one; AI notes look the same as the user's.

Mockups (local, gitignored): `.superpowers/brainstorm/3998029-1794175316/content/notes-panel.html`.

## Goals

- From „Notatki” to typing a new note: two clicks („Notatki”, „+ Nowa”), caret already in place.
- Every keystroke ends up in the database without any explicit action.
- Notes are readable at a glance as tiles, newest first.
- One editing model in both places (panel and tab).
- A Claude session can add a note to its project (or a global one) and list the notes with their
  full content.

## Non-goals

- Markdown, formatting, attachments, search, tags, pinning, sorting options.
- A global keyboard shortcut for a quick note (possible later).
- AI editing or deleting notes.
- Skill support for Codex / OpenCode (the CLI works for any agent; only the Claude skill is
  installed).
- The AI part on Windows (same platform scope as `abeon-code session`).
- Restoring note tabs after an app restart (terminal and action tabs are not restored either).
- Marking notes written by the AI.

## Anti-goals (a failure even if everything else works)

- **Losing typed text**: on going back to the list, opening as a tab, closing the panel, switching
  projects, closing the tab, closing the window or quitting the app shortly after typing, or after
  a failed save.
- Opening notes costs the right panel its state: a half-typed commit message, the Git tab
  selection, ClickUp state or scroll positions must survive a round trip through the notes panel.
- Two editors of the same note in one window overwriting each other.
- The CLI hanging the agent's Bash tool, or starting the GUI app.

## 1. Data model

- Migration `007_notes_untitled.sql`: fold the title into the content without touching
  `updated_at` (order is kept):
  - empty / whitespace-only title → content unchanged;
  - empty content → content = title;
  - otherwise content = title + `\n` + content.

  Then set `title = ''` on every row. The column **stays** (unused, always `''`), it is not
  dropped *(my call)*: `tauri dev` and the installed app share `~/.config/AbeonCode/abeoncode.db`,
  so a dropped column would break notes in any older build that touches the file. An older build
  then shows untitled notes whose content starts with the old title, and can still create notes.
  New code writes `''` into `title` and never reads it. Keep `idx_notes_project_updated`.
- Migrations are guarded only by the version number (`db/mod.rs`), and the CLI (section 4) can now
  open the database at the same moment as the app. The migration runner must take the write lock
  first (`BEGIN IMMEDIATE`) and re-check the version inside the transaction, so `007` never runs
  twice.
- `Note` (Rust, ts-rs exported): `id`, `projectId`, `content`, `createdAt`, `updatedAt`.
- Commands: `list_notes(projectId | null)`, `create_note(projectId | null, content)`,
  `update_note(id, content)`, `delete_note(id)`. Typed wrappers in `lib/tauri.ts`. They become
  `#[tauri::command(async)]`: a second process now writes the same database, so a command may wait
  on the SQLite lock, and that wait must not happen on the main thread.
- An empty note is never stored. A new note gets its row on the first non-whitespace character. An
  existing note whose content is whitespace-only when its editor closes (back, close panel, close
  tab, switch note) is deleted without a confirmation, because there is nothing left to lose
  *(my call; Google Keep behaves the same)*.

## 2. Right panel: notes mode

### Entering and leaving

- „Notatki” in `ProjectToolbar` switches the right panel of **this window** into notes mode (main
  window and detached windows alike, since they all render `RightPanel`). In notes mode the whole
  panel, the toolbar included, is replaced by the notes panel (mockup).
- ✕ leaves notes mode. If an editor is open, the pending save is flushed first.
- Notes mode, the open note and the pending save live in the store, not in component state: in the
  main window `RightPanel` unmounts whenever there is no active tab (`AppShell.tsx`), and the save
  must still be flushed then.
- The normal sections stay **mounted and hidden** while notes mode is on, so their state survives
  (anti-goal above). The builder must check which sections keep state in components rather than in
  the store before deciding whether hiding is enough or unmounting is safe.
- Notes mode is in-memory, per window; the app always starts in the normal right panel *(my
  call)*.
- `ProjectToolbar` (and so the „Notatki” button) only exists while a project tab is active. If
  notes mode is on and no project tab remains, flush, then leave notes mode.

### List view

Layout from top to bottom (mockup 1):

1. A bar: label „Notatki”, „+ Nowa” (accent), ✕ „Zamknij panel”.
2. The scope switch „Projektowe / Globalne”, as today. „+ Nowa” creates in the selected scope.
   Whether the selection is remembered while the app runs is the builder's call.
3. Tiles, single column, scrolling, newest `updatedAt` first. Each tile shows the start of the
   content with its line breaks, clamped to about four lines, plus the change date (e.g. „dziś,
   14:32”, „wczoraj, 16:47”, „3 lis, 09:12”). A whitespace-only start is not possible (empty notes
   are not stored). Tiles are buttons: click / Enter opens the note in the editor.
4. States: loading, load error with „Spróbuj ponownie”, empty („Brak notatek projektowych” /
   „Brak notatek globalnych”).

The list shows the notes of the **active tab's project** and follows it when the active tab
changes to another project.

### Editor view (variant A)

- The editor replaces the list inside the right panel: a bar with „← Notatki”, ⧉ „Otwórz w
  zakładce”, 🗑 „Usuń”; a textarea filling the rest; a save status line.
- „+ Nowa” opens an empty editor with the caret in the textarea. Opening an existing note puts the
  caret at the end of the text *(my call)*.
- While the editor is open, a change of the active tab's project does not close it; „← Notatki”
  then shows the new project's list.
- 🗑 asks through `ConfirmDialog` („Usuń notatkę” / „Usunąć tę notatkę? Tej operacji nie można
  cofnąć.”), then returns to the list. For an unsaved new note it just discards and returns.
- ⧉ flushes the save, opens the note as a centre tab (section 3) and returns the panel to the list.

### Autosave

- Debounced save while typing (around 0.5–1 s after the last keystroke — builder's call), plus an
  immediate flush on every way out of the editor: back, ⧉, ✕, project change, unmount, window close
  request and app quit.
- Status line: „Zapisywanie…”, „✓ Zapisano”, or on failure „Nie udało się zapisać” with a retry.
  A failed save keeps the text in memory and is retried on the next change or the retry click;
  leaving the editor with an unsaved failure must not drop the text silently (the builder decides
  how: keep it in the store and retry, or warn).
- Closing a window or quitting while a save is pending waits for that save. Today the close
  handlers (`AppShell.tsx`, `DetachedShell.tsx`) only intercept closing while a process runs, and
  Rust does nothing on exit. They must also intercept while a note save is pending or a draft is
  unsaved: `preventDefault`, flush, then `destroy()`. The updater's `relaunch()` bypasses those
  handlers, so it must flush notes before relaunching.

### One draft per note per window

The panel editor and a note tab must never hold separate copies of the same note in one window:
the draft lives in the store, keyed by note id, and both editors bind to it. Across windows
(detached windows have their own store) last write wins; an editor without pending changes reloads
the note when it learns that notes changed (section 4).

## 3. Note tab in the centre

- New tab kind `note`: `{ kind: 'note'; id; projectId; noteId; title }`. `projectId` is the project
  group the tab joins: for a project note, the note's own project (it may differ from the active
  tab's project when the panel editor stayed open across a project change); for a global note, the
  active tab's project *(my call)*.
- Title: the first non-empty line of the content, trimmed and shortened; it updates while typing.
- Opening the same note again in a window activates its existing tab instead of opening a second
  one.
- The tab renders the same editor (shared draft, autosave, status, delete) with room to write: a
  readable column width and a comfortable font size are the builder's call. A small label says
  whether the note is project or global.
- Closing the tab flushes the save; no confirmation (`isActiveProcess` stays false for note tabs).
  An emptied note is deleted on close, as in the panel.
- Deleting the note (from the tab or from the panel) closes every tab of that note in the window.
- The tab takes part in panes, splits, drag, the tab switcher and MRU like any other tab. It
  travels with its group when a project group is detached. `buildDetachPayload`
  (`lib/detachGroup.ts`) and `tabsFromGroupMode` (`store/tabsSlice.ts`) currently turn every unknown
  kind into a `providerPicker` without a type error, so both need an explicit `note` branch. The
  note is flushed before the payload is built, because the new window loads it from the database.
  Single-tab detach stays session-only, as it is today.
- Not persisted across restarts (only session tabs are; see `writeTabsToLocalStorage`).

## 4. AI access: `abeon-code note`

### Commands

- The app binary gets a headless subcommand, handled in `run()` before `diagnostics::init()` like
  `hook` / `mcp`: it never starts the GUI and never talks to the single-instance plugin.
  - `note add [--global] --cwd <dir>`: content on stdin; trimmed; rejects empty content and content
    above a size cap (builder's call); prints one line, e.g.
    `abeon-code: note added (id 42) to project <name>` or `… as a global note`.
  - `note list [--global] --cwd <dir> [--limit N]`: prints the notes newest first with their full
    content, an unambiguous delimiter between notes, and each note's id and date. Project notes by
    default; `--global` lists the global ones. Exact text format is the builder's call.
- The `abeon-code` wrapper (`cli/installer.rs`) gains a `note` branch that runs the binary
  **synchronously** (no `setsid`/`nohup`, stdout/stderr and the exit code passed through), passes
  `--cwd "$(pwd -P)"`, and strips the caller's Claude env markers like the `session` branch.
- Project resolution: canonicalise `--cwd`, pick the registered project whose canonical path is
  that directory or its closest ancestor (path-component boundaries, longest match). No match:
  non-zero exit and `abeon-code: <dir> is not inside an AbeonCode project` on stderr; nothing is
  written. With `--global` no project is resolved, so it works from any directory *(my call)*.
- Database: the same file as the app (`db::db_path()`), opened through the same pool setup and
  migration runner (made concurrency-safe in section 1). rusqlite's default 5 s busy timeout covers
  a lock held by the app.
- Platforms: Linux and macOS, the same as `abeon-code session` (the wrapper is bash, the subcommand
  dispatch in `run()` and the IPC socket are `#[cfg(unix)]`). Windows is a non-goal *(my call)*.
- An outdated wrapper must not be called with `note`: its fallback branch would `exec` the GUI with
  the path `<cwd>/note` and block the agent. The new wrapper carries a detectable marker (e.g. a
  `wrapper_features="note"` line), and the skill checks
  `grep -q 'wrapper_features=.*note' "$(command -v abeon-code)"` before its first call. On failure it
  tells the user to reinstall from Ustawienia → CLI. Reinstalling the skill also rewrites the
  wrapper (`install_claude_skill`).

### Skill

- A second skill, `abeon-notes`, installed next to `abeon-open-session` by the same „Zainstaluj
  skill” action (and kept current on reinstall) *(my call to keep it separate, so each triggers on
  its own description)*.
- Triggers (Polish and English): „dodaj notatkę”, „zanotuj”, „zapisz w notatkach”, „przeczytaj
  notatki”, „co zanotowałem”, „notatki z rozmowy”, "add a note", "read my notes".
- It teaches: notes have no titles (the first line acts as one, so lead with the gist); write in the
  user's language; one note per request unless asked; add `--global` only when the user says the
  note is global; heredoc with a random quoted delimiter (same rule as the session skill); read with
  `note list` before acting on "what I noted"; report the outcome in one line; on
  `command not found` or an outdated wrapper, point the user to Ustawienia → CLI.

### The app learns about outside changes

- Within about two seconds of a CLI write, every open notes list in every window refreshes, editors
  without pending changes reload their note, and the main window shows the toast „Dodano notatkę”
  for a note created outside the app (not for the app's own saves).
- Mechanism is the builder's call. Suggested: after committing, the CLI makes a best-effort request
  over the app's existing local socket (`supervisor/ipc.rs`). The server runs in every primary Unix
  instance, also with the supervisor Off. The app then emits a `notes-changed` event; no socket means
  the app is closed and nothing needs refreshing. Accepted limits: an older running app silently
  drops the unknown request (closed `IpcRequest` enum), and a second instance that lost the socket
  (e.g. `tauri dev` next to the installed app) gets no notifications. Its lists refresh on their
  next load. Polling is an acceptable fallback if it stays off the main thread.

## 5. Removing the notes window

Delete `NotesShell`, `openNotesWindow`, the `notes` window mode in `lib/windowMode.ts`, the branch in
`App.tsx`, and `notes-project-*` from `src-tauri/capabilities/default.json`. Replace
`NotesWorkspace` / `NoteList` / `NoteEditor` / `noteDraft` and their tests with the new components.
The 2026-09-16 decisions on unsaved-change guards no longer apply.

## Constraints

- UI text in Polish, identifiers in English, no code comments.
- Every IPC call through `lib/tauri.ts`; types crossing IPC via ts-rs (`cargo test` regenerates
  them).
- Notes CRUD is cheap SQLite and may stay a sync command; nothing new may block the main thread
  (see the Wayland gotcha in `DesktopApp/CLAUDE.md`).
- A note tab is a normal content layer in `PaneLayout`; the layer rules (never change DOM parent,
  keep relative order) apply.
- No new window labels.
- Tests: Vitest for the panel, editor, autosave, tab and store logic; cargo for the migration,
  repo, project resolution and CLI argument parsing; the wrapper script tests in `installer.rs`
  extended for the `note` branch. Run Vitest with `--maxWorkers=3` (known flakes under load).

## Left to the builder

Debounce timing, tile line clamp and date format, editor column width and font size in the tab, tab
title length, CLI output format and size cap, toast wording beyond „Dodano notatkę”, whether the
scope selection is remembered, the wrapper marker format, and the outside-change notification
mechanism (within the requirements above).
