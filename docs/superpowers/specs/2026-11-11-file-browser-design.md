# Project file browser — design

Date: 2026-11-11 · App: `DesktopApp/` · Scope: a „Pliki” button turns the right panel into a file
tree of the current project with a search-by-name box. Clicking a file opens it as a tab in the
centre: text files in edit mode, Markdown as a rendered preview with a switch to editing.

## Why

The user works in AbeonCode with agent sessions and leaves it for small file chores:

- „czasem chcę np. uzupełnić plik .env albo sprawdzić co jest tam ustawione” — look into a config
  file, fill in a value, save;
- „czasem muszę też wyszukać jakiś plik” — find a file by name;
- „przyda się też podgląd markdown, bo dużo dokumentów jest w tym formacie” — read project docs.

Success: these three chores are done without leaving the app. This is **not** an IDE; the agent
writes the code, the user peeks and makes small edits.

## Decisions agreed with the user

1. Clicking a file opens it **as a new tab** in the centre.
2. Text files open **in edit mode** by default.
3. Markdown opens as a **rendered preview**; an „Edytuj” button switches to the source, „Podgląd”
   switches back.
4. Search is **by file name**, not by content.
5. The tree **only opens existing files**. No create, duplicate, rename or delete.
6. Layout as in the approved mockup
   (`.superpowers/brainstorm/658267-1794435607/content/file-browser-layout.html`, gitignored, may be
   gone): tree in the **right panel**, replacing it the way the notes panel does; search box above
   the tree; a save button and unsaved-changes marker in the file tab; files ignored by Git shown
   dimmed; files changed in Git coloured with a status letter.

Everything below this section that is not listed above is a call made while writing this document
(marked „call”); the user saw most of them as stated assumptions and did not object.

## Goals

- Browse the project directory tree (root = `project.path`) in the right panel.
- Find a file by a fragment of its name across the whole project.
- Open a text file in a tab, edit it, save it explicitly.
- Read Markdown rendered; edit it on demand.
- See `.env` and other gitignored files (that is the main use case).

## Non-goals

- File operations: create, duplicate, rename, move, delete.
- Search in file contents.
- IDE features: completion, linting, multi-cursor, go-to-definition, formatting.
- A Git diff inside the editor (the Git panel already shows diffs).
- Restoring file tabs after an app restart.
- Files outside the project root.
- MobileApp / remote bridge access to files.

## Anti-goals

- **Losing or corrupting a file.** A half-written `.env` on disk, or silently overwriting what the
  agent just wrote, is a failure even if everything else works.
- **Reaching outside the project.** No command may read or write a path that resolves outside
  `project.path`.
- **Stalling the app.** A big directory or file must never block the GTK main thread (see the
  main-thread gotcha in `DesktopApp/CLAUDE.md`).

## Behaviour

### Files panel (right column)

- A „Pliki” button joins Terminal / Edytor / Notatki in `ProjectToolbar`. It toggles the files
  panel for the project of the active tab. The files panel and the notes panel are mutually
  exclusive: opening one closes the other (closing notes goes through its existing flush path and
  is refused when the flush fails). Like notes, the panel closes when the last tab closes. The rest
  of the right column stays mounted, `hidden` + `inert`, exactly as with `NotesPanel`.
- Header: „Pliki” and a close button (✕). Below: the search box, then the tree.
- Tree: directories first, then files, both sorted case-insensitively. Directories load lazily on
  expand. Expanded state is kept in the store per project while the app runs (call), not persisted.
- All entries are listed, including dotfiles and gitignored files. `.git` is not listed at all
  (call). Gitignored entries are dimmed. Entries with a Git status get the colour and letter the
  Git panel already uses for that status; the data comes from the existing `gitSlice` status, not
  from a new Git query (call). That status is refreshed today only on project change and window
  focus, so while the files panel is open it is also refreshed, debounced, after directory-watcher
  events and after a save from a file tab.
- `ProjectToolbar` is hidden while either panel is open, so „Pliki” only opens the panel; the ✕ in
  the panel header closes it.
- Clicking a directory expands or collapses it. Clicking a file opens its tab (or focuses the
  existing one). The entry of the active file tab is highlighted.
- The tree is live: a directory watcher refreshes expanded directories when entries appear or
  vanish (call). Only expanded directories are watched, non-recursively, so `node_modules` costs
  nothing until it is opened.
- Context menu on an entry (call): „Kopiuj ścieżkę” (relative to the project root) and „Wstaw
  ścieżkę do sesji” (types the relative path into the active agent session, same mechanism as the
  existing „insert into active session”; disabled without one).

### Search

- Typing in the box replaces the tree with a flat result list from the whole project; clearing it
  brings the tree back with its expanded state intact.
- Matching: case-insensitive substring of the **file name**; when the query contains `/`, it is
  matched against the relative path instead (call). Directories are not results.
- Ranking (call): exact name, then name prefix, then other matches; ties by shorter relative path.
  At most 200 results, with a „pokazano pierwsze 200” line when cut.
- The walk skips `.git` and any **gitignored directory** (`node_modules`, `vendor`, `target`, …)
  but includes gitignored **files** that sit in non-ignored directories, so `.env` is found (call).
  In a project that is not a Git repository nothing is skipped except `.git` and a built-in list:
  `node_modules`, `vendor`, `target`, `dist`, `build`, `.venv`, `__pycache__`.
- Each result shows the file name and, below it, its directory. ↑/↓ move the selection, Enter opens,
  Esc clears the query. Requests are debounced, and a stale response is dropped (same token pattern
  as `notesSlice.loadTokens`).
- No global shortcut in v1 (call); the box is focused when the panel opens.

### File tab

- New tab kind `file`: `{ kind: 'file'; id; projectId; path; title }`, `path` relative to the
  project root, `title` = file name. Deduplicated by project + path: opening an already open file
  focuses its tab. Not persisted across restarts, never a live process, cannot be renamed.
- The tab picks a mode from what the backend reports:
  - **text** → editor (edit mode);
  - **Markdown** (`.md`, `.markdown`, `.mdx`) → rendered preview with „Edytuj”; in edit mode the bar
    shows „Podgląd” and the save button. Preview renders the current buffer, so unsaved edits are
    visible in it. Switching modes never discards the buffer;
  - **image** (`png`, `jpg`, `jpeg`, `gif`, `webp`, `svg`) → the picture, fitted, read-only (call);
  - **too large** (over 1 MiB) or **binary** → a message with the file size, no content (call);
  - **gone / unreadable** → an error message with „Spróbuj ponownie”.
- Editor (call): **CodeMirror 6**, a new dependency. Reasons: line numbers and syntax colours as in
  the approved mockup, native undo, in-file search (`Ctrl/Cmd+F`), and it handles a 1 MiB file
  without the lag of a highlighted `<textarea>`. Languages loaded lazily by extension; an unknown
  extension is plain text. Theme follows the app theme and the terminal font setting is **not**
  used; the UI mono font is. No autocompletion, no linting.
- Markdown preview reuses `components/history/Markdown.tsx`. Relative links and images inside a
  document are left to the builder; opening a relative `.md` link as another file tab is welcome
  but not required.
- **Saving is explicit**: „Zapisz” button and `Ctrl/Cmd+S` while the tab has focus. No autosave
  (unlike notes: a half-typed `.env` value saved in the background can break a running app). A
  dirty tab shows „●” in its title and „Niezapisane zmiany” in the bar; after a save „Zapisano”
  briefly. The save button is disabled while clean.
- Line endings and a trailing newline are preserved as read: the file's line ending (LF or CRLF)
  is detected on load and used on save. A file with **mixed** endings is saved with the
  predominant one (LF on a tie), which rewrites the odd lines (call; no per-line preservation).
  Encoding: UTF-8 only; a file that is not valid UTF-8 counts as binary (call). A UTF-8 BOM is
  kept.
- **Closing a dirty tab** asks through the existing `ConfirmDialog` in `useTabBarActions`:
  „Zapisz” / „Odrzuć zmiany” / „Anuluj”. The same guard covers every path that drops tabs: closing
  the main window or a detached window, and before update install / relaunch (the places that
  already settle notes).
- **Update with dirty files in another window** (call): every window has its own store, and
  `relaunch` closes them all, so the main window cannot see a dirty buffer in a detached window.
  Each window reports its dirty-file count to a small registry in Rust (cleared when the window is
  destroyed). Before `downloadAndInstall` and `relaunch` the main window handles its own dirty
  tabs with the dialog above and then reads the registry: when another window still has unsaved
  files the update is **refused** with „Masz niezapisane pliki w innym oknie. Zapisz je lub zamknij
  to okno i spróbuj ponownie.” No cross-window save dialog.
- **Detached windows**: file tabs work there. Detaching a project group with a dirty file tab first
  asks to save or discard (call); the tab then travels as `path` only and reloads from disk.

### File changed or deleted on disk

Each open file tab watches its file.

- Changed on disk, buffer clean → reload silently, keeping the scroll position where possible.
- Changed on disk, buffer dirty → a bar in the tab: „Plik zmienił się na dysku” with „Wczytaj
  ponownie” (drop my edits) and „Zostaw moje”.
- Saving checks the on-disk version against the one that was loaded. On a mismatch nothing is
  written and a dialog offers „Nadpisz” / „Wczytaj ponownie” / „Anuluj”.
- Deleted on disk → a bar „Plik został usunięty”; the buffer stays, and saving recreates the file.
- The tab's own save must not trigger its own „changed on disk” bar.

## Backend (Rust)

New `commands/files.rs`, registered in `lib.rs`, wrapped in `lib/tauri.ts`, types via ts-rs. All
commands are `#[tauri::command(async)]`. Suggested surface (names are the builder's to adjust):

- `list_dir(project_id, rel_path)` → entries `{ name, kind: dir|file|symlink, ignored }`.
- `search_files(project_id, query, limit)` → `{ results: [{ rel_path }], truncated }`.
- `read_file(project_id, rel_path)` → `{ kind: text|image|binary|tooLarge, content?, size, version }`
  where `version` identifies the on-disk state (mtime + size, or a content hash).
- `write_file(project_id, rel_path, content, expected_version, force)` → new `version`, or a
  `conflict` error when the disk version differs and `force` is false.
- watch / unwatch for directories and files, emitting events to the calling window; `notify` is
  already a dependency.

Rules:

- **Path safety**: commands take a project id and a relative path, never an absolute path. The
  resolved path is canonicalised and must stay under the canonical `project.path`; `..`, absolute
  paths and symlinks that lead outside are rejected. For a write to a deleted file the parent
  directory is the one canonicalised. There is a precedent path-traversal fix in the ClickUp code.
- **Atomic write**: write to a temp file in the same directory, fsync, then rename over the target,
  keeping the original file's permissions. Symlinked targets are written through to the real file.
- **In-place fallback** (call): rename replaces the inode, which is wrong or impossible in some
  cases, so the file is instead rewritten in place (truncate, write, fsync) when: the file has
  more than one hard link; it is owned by another user; its directory is not writable; or the
  temp-file creation or the rename fails (a single file bind-mounted into a container, a file
  locked by another process on Windows). In place is not atomic, but it keeps the inode the
  container or the other links see, and these files are small. Only when the in-place write also
  fails does the save fail, with the OS error shown and the buffer kept dirty. A new file (saving
  a buffer whose file was deleted) is always created through temp + rename.
- **Ignored detection**: via `git2` (already a dependency), handling a project root that holds
  several repositories or none.
- **Images** reach the webview as a data URL or through whatever the app already uses for local
  assets; builder's choice.
- No file content is ever written to the diagnostics log.

## Frontend

- `store/filesSlice.ts`: panel open flag, per-project expanded directories and loaded listings,
  search state, and per-file-tab buffers (content, loaded version, dirty flag, mode, save status)
  keyed by tab id, so a buffer survives a pane move. Buffers are dropped when the tab closes.
- `components/files/`: `FilesPanel`, tree, search results, `FileTabView`, editor wrapper.
- `Tab` union gains `file`; every exhaustive switch over tab kinds follows (tab icon, context menu,
  `sessionTabFromMode` / detach serialisation, `writeTabsToLocalStorage` skip, close guard).
- `Ctrl/Cmd+S` is handled inside the editor, not as a global capture listener.
- Zustand array/object selectors use `useShallow`.

## Left to the builder

- Component and command names, the exact store shape, event names.
- How CodeMirror languages are chunked, and which languages ship (at least: dotenv/properties,
  JSON, YAML, TOML, Markdown, JS/TS, PHP, Rust, Python, HTML, CSS, shell, SQL).
- Watcher debouncing and how watches are shared between windows.
- Visual details within the Grafit design tokens already in the app.

## Testing

- Rust: path-safety cases (`..`, absolute, symlink out of the root), atomic write keeps
  permissions and line endings, conflict detection, search skipping and ranking, binary / too-large
  classification, ignored flags in a repo, in a multi-repo root and outside any repo.
- Frontend (Vitest): tab dedupe, Markdown preview ↔ edit keeps the buffer, dirty close guard, the
  on-disk change cases, panel exclusivity with notes, search keyboard handling and stale-response
  drop.
- Manual QA on the packaged app: a large repo with `node_modules`, editing `.env` while an agent
  session writes files, detached window.
