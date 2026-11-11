# Project File Browser Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A „Pliki” panel in the right column (tree + search by name) and a `file` tab kind that edits text files, previews Markdown and shows images.

**Architecture:** A new Rust module `files/` (path safety, listing, search, read, write, directory watches) exposed through `commands/files.rs`. A new Zustand slice `filesSlice` owns the panel, the tree, the search and one buffer per file tab. Disk changes arrive as one debounced "directory changed" event; the frontend re-lists that directory and re-checks the version of open files in it, so a tab's own save never looks like an external change.

**Tech Stack:** Rust (`git2`, `notify`, `tempfile`, `base64` — all already dependencies), React 19, Zustand 5, CodeMirror 6 (new), `react-markdown` (existing `components/history/Markdown.tsx`).

**Spec:** `docs/superpowers/specs/2026-11-11-file-browser-design.md` — read it first; this plan does not repeat its behaviour rules.

## Global Constraints

- All paths below are relative to `DesktopApp/`. Run npm/cargo from there. Read `DesktopApp/CLAUDE.md` before starting.
- Work directly on local `main`; commit after every task; no push. Conventional Commits, scope `desktop`, no co-author trailer, no tool attribution.
- Identifiers in English. UI text in Polish, exactly as quoted in the spec and in this plan.
- No code comments.
- Every Tauri command is `#[tauri::command(async)]`, registered in `src-tauri/src/lib.rs`, and wrapped in `src/lib/tauri.ts`; components never call `invoke` directly.
- IPC types are defined in Rust with `#[derive(TS)]`; run `cargo test` to generate `src/types/*.ts`; never hand-edit them. Tagged enums: `rename_all = "camelCase"` on the tag, snake_case struct-variant fields.
- Commands take `project_id` + a path relative to the project root, never an absolute path.
- Zustand selectors returning arrays/objects use `useShallow`.
- Limits: text file 1 MiB (`1_048_576` bytes); image 10 MiB (plan-level call, the spec gives no image limit); search 200 results; search walk stops after 200 000 visited entries (`truncated: true`).
- Markdown extensions: `md`, `markdown`, `mdx`. Image extensions: `png`, `jpg`, `jpeg`, `gif`, `webp`, `svg`.
- Fallback skip list outside a Git repo: `node_modules`, `vendor`, `target`, `dist`, `build`, `.venv`, `__pycache__`. `.git` is never listed or walked.
- Rust tests: `cargo test --manifest-path src-tauri/Cargo.toml files::`. Frontend tests: `npx vitest run --maxWorkers=3 <file>` (plain `npm test` flakes under load). `npm run lint` must stay at zero errors.
- No file content in logs.

## Review Focus

1. A directory with tens of thousands of entries (an expanded `node_modules`) — the panel stays responsive: the tree renders at most 2000 entries per directory with a „pokazano pierwsze 2000” line (Task 8).
2. A symlinked directory that points to its own ancestor — search terminates; symlinked directories are never descended into (Task 3).
3. A file the user cannot read, or a project root that vanished — the tab / panel shows an error with „Spróbuj ponownie”, nothing throws (Tasks 4, 8, 10).
4. File names with spaces, `#`, `%` and non-ASCII letters — list, search, open and save round-trip; names that are not valid UTF-8 are skipped in listings (Tasks 2, 3).
5. `Ctrl+S` pressed twice quickly, or a save while a reload is in flight — saves are serialised per buffer and the second one writes the newest content against the first one's new version (Task 9).

## File Structure

```
src-tauri/src/files/mod.rs        module root, constants (limits, skip list)
src-tauri/src/files/paths.rs      resolve a relative path safely under the project root
src-tauri/src/files/listing.rs    list one directory, ignored flags
src-tauri/src/files/search.rs     walk + rank by name
src-tauri/src/files/content.rs    classify + read, file version
src-tauri/src/files/write.rs      atomic write, in-place fallback, conflict check
src-tauri/src/files/watch.rs      per-window directory watches, dirty-file registry
src-tauri/src/domain/files.rs     ts-rs types
src-tauri/src/commands/files.rs   command handlers

src/store/filesSlice.ts           panel, tree, search, buffers
src/lib/fileText.ts               line endings, BOM, file-kind helpers, tab id
src/lib/useFilesSync.ts           subscribes to directory-changed events
src/components/files/FilesPanel.tsx
src/components/files/FileTree.tsx
src/components/files/FileSearchResults.tsx
src/components/files/FileEntryMenu.tsx
src/components/files/FileTabView.tsx
src/components/files/CodeEditor.tsx      the only file importing CodeMirror
src/components/dialogs/UnsavedFilesDialog.tsx
```

---

### Task 1: Path safety

**Files:**
- Create: `src-tauri/src/files/mod.rs`, `src-tauri/src/files/paths.rs`
- Modify: `src-tauri/src/lib.rs` (`mod files;`)

**Interfaces:**
- Produces:
  - `files::paths::resolve_existing(root: &Path, rel: &str) -> AppResult<PathBuf>` — canonical path of an existing entry, guaranteed under canonical `root`. `rel == ""` is the root.
  - `files::paths::resolve_for_write(root: &Path, rel: &str) -> AppResult<PathBuf>` — like above when the file exists; when it does not, canonicalises the parent (which must exist and be under root) and appends the file name.
  - Constants in `files/mod.rs`: `MAX_TEXT_BYTES`, `MAX_IMAGE_BYTES`, `SEARCH_LIMIT`, `SEARCH_VISIT_CAP`, `FALLBACK_SKIP_DIRS`, `MARKDOWN_EXTENSIONS`, `IMAGE_EXTENSIONS` with the values from Global Constraints.
- Errors: `AppError::InvalidPath { path, reason }` for every rejection; `AppError::NotFound` when the entry (or the parent, for write) does not exist.

- [ ] **Step 1: Write failing tests** in `paths.rs` (`#[cfg(test)]`, `tempfile::tempdir`):
  - `resolves_nested_file` — `a/b.txt` → canonical path under root.
  - `empty_rel_is_root`.
  - `rejects_parent_traversal` — `../x`, `a/../../x` → `InvalidPath`.
  - `rejects_absolute_path` — `/etc/passwd` → `InvalidPath`.
  - `rejects_symlink_leaving_root` — symlink `out -> <other tempdir>`; `out/secret` → `InvalidPath` (unix only).
  - `allows_symlink_inside_root`.
  - `write_target_may_be_missing` — `a/new.txt` with existing `a/` → path returned; `missing/new.txt` → `NotFound`.
  - `write_rejects_git_dir` and `existing_rejects_git_dir` — any component equal to `.git` → `InvalidPath`.
- [ ] **Step 2: Run** `cargo test --manifest-path src-tauri/Cargo.toml files::paths` — FAIL (module missing).
- [ ] **Step 3: Implement** both functions. Reject before touching the disk when `rel` is absolute or has a `..` / `.git` component; then canonicalise and check `starts_with(canonical_root)`.
- [ ] **Step 4: Run** the same command — PASS.
- [ ] **Step 5: Commit** `feat(desktop): add safe project-relative path resolution`.

### Task 2: Directory listing with ignored flags

**Files:**
- Create: `src-tauri/src/files/listing.rs`, `src-tauri/src/domain/files.rs`
- Modify: `src-tauri/src/domain/mod.rs` (export)

**Interfaces:**
- Consumes: `paths::resolve_existing`.
- Produces (`domain/files.rs`, all `#[derive(Serialize, TS)]`, `#[serde(rename_all = "camelCase")]`, exported to `../src/types/`):
  - `enum FileEntryKind { Dir, File }` (serialised `"dir"` / `"file"`; a symlink reports the kind of its target, a broken symlink is `File`).
  - `struct FileEntry { name: String, kind: FileEntryKind, ignored: bool }`.
- Produces: `files::listing::list_dir(root: &Path, rel: &str) -> AppResult<Vec<FileEntry>>` — directories first, then files, each group sorted case-insensitively; `.git` omitted; names that are not valid UTF-8 omitted.
- Produces: `files::listing::IgnoreChecker` with `IgnoreChecker::for_dir(root: &Path, dir: &Path) -> IgnoreChecker` and `is_ignored(&self, path: &Path, is_dir: bool) -> bool`. It discovers the Git repository containing `dir` with the project root's parent as ceiling (so a repo above the project is not used, and nested repos inside a multi-repo root work); with no repository it reports `false` for everything. Task 3 reuses it.

- [ ] **Step 1: Write failing tests** (init repos with `git2::Repository::init`):
  - `sorts_dirs_first_case_insensitive` — entries `b.txt`, `A.txt`, `zdir/`, `Adir/` → `Adir, zdir, A.txt, b.txt`.
  - `omits_git_dir`.
  - `flags_ignored_entries` — `.gitignore` with `.env` and `node_modules/`; `.env` and `node_modules` have `ignored: true`, `.env.example` `false`.
  - `no_repo_means_nothing_ignored`.
  - `nested_repo_uses_its_own_rules` — root without a repo, `svc/` is a repo ignoring `secret.txt`; listing `svc` flags it.
  - `handles_special_names` — `with space.txt`, `zażółć.md`, `a#b%.txt` are returned verbatim.
  - `symlink_reports_target_kind` (unix).
- [ ] **Step 2: Run** `cargo test --manifest-path src-tauri/Cargo.toml files::listing` — FAIL.
- [ ] **Step 3: Implement** `IgnoreChecker` (wraps `Option<git2::Repository>`, uses `is_path_ignored` with a workdir-relative path, trailing `/` for directories) and `list_dir`.
- [ ] **Step 4: Run** — PASS; confirm `src/types/FileEntry.ts` and `FileEntryKind.ts` were generated.
- [ ] **Step 5: Commit** `feat(desktop): list project directories with ignored flags`.

### Task 3: Search by file name

**Files:**
- Create: `src-tauri/src/files/search.rs`
- Modify: `src-tauri/src/domain/files.rs`

**Interfaces:**
- Consumes: `IgnoreChecker`, constants from `files/mod.rs`.
- Produces: `struct FileSearchResponse { results: Vec<String>, truncated: bool }` (camelCase, TS) — `results` are paths relative to the root with `/` separators.
- Produces: `files::search::search_files(root: &Path, query: &str, limit: usize, visit_cap: usize) -> AppResult<FileSearchResponse>`.

Rules the tests pin: trimmed empty query → empty response. Case-insensitive. Query without `/` matches the file name as a substring; with `/` it matches the relative path as a substring. Rank: 0 = name equals query, 1 = name starts with query, 2 = other; ties by relative-path length, then alphabetically. Directories are never results. The walk never enters `.git`, never enters a directory `IgnoreChecker` flags, never enters a symlinked directory; outside any repository it also skips `FALLBACK_SKIP_DIRS`. Ignored files in non-ignored directories are results. `truncated` is true when more than `limit` matched or `visit_cap` entries were visited.

- [ ] **Step 1: Write failing tests:**
  - `finds_ignored_env_file` — repo ignoring `.env`; query `env` returns `.env` and `.env.example`.
  - `skips_ignored_directories` — `node_modules/pkg/env.js` not returned.
  - `ranks_exact_then_prefix_then_substring` — files `env`, `env.d.ts`, `src/myenv.ts`, query `env` → that order.
  - `shorter_path_wins_ties` — `a/x.ts` before `a/b/c/x.ts`.
  - `slash_query_matches_path` — query `config/app` finds `src/config/app.ts`.
  - `case_insensitive` — query `README` finds `readme.md`.
  - `fallback_skip_list_without_repo` — `vendor/x.php` skipped, `src/x.php` found.
  - `does_not_follow_directory_symlinks` — `loop -> .` (unix); search returns and finds each real file once.
  - `truncates_at_limit` — 5 matches, limit 3 → 3 results, `truncated`.
  - `truncates_at_visit_cap` — visit cap 2 on a larger tree → `truncated`.
  - `blank_query_returns_nothing`.
- [ ] **Step 2: Run** `cargo test --manifest-path src-tauri/Cargo.toml files::search` — FAIL.
- [ ] **Step 3: Implement.** Iterative walk with an explicit stack; one `IgnoreChecker` per repository boundary is enough (re-create it when a directory contains `.git`).
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(desktop): search project files by name`.

### Task 4: Reading and classifying a file

**Files:**
- Create: `src-tauri/src/files/content.rs`
- Modify: `src-tauri/src/domain/files.rs`

**Interfaces:**
- Produces:
  ```rust
  #[serde(tag = "kind", rename_all = "camelCase")]
  pub enum FileContent {
      Text { content: String, version: String, size: u64 },
      Image { data_url: String, version: String, size: u64 },
      Binary { size: u64 },
      TooLarge { size: u64 },
  }
  ```
- Produces: `files::content::file_version(path: &Path) -> AppResult<Option<String>>` — `None` when the file does not exist, otherwise `"<mtime_nanos>-<size>"`.
- Produces: `files::content::read_file(path: &Path) -> AppResult<FileContent>` (`path` already resolved). A directory → `InvalidPath`.

Classification order: image extension → `Image` if `size <= MAX_IMAGE_BYTES` else `TooLarge` (MIME from the extension, `image/svg+xml` for svg, base64 data URL); otherwise `size > MAX_TEXT_BYTES` → `TooLarge`; bytes containing NUL or not valid UTF-8 → `Binary`; else `Text` with the content **byte-exact** (BOM and line endings untouched).

- [ ] **Step 1: Write failing tests:** `reads_text_exactly` (content `"\u{feff}a\r\nb"` round-trips), `empty_file_is_text`, `nul_byte_is_binary`, `invalid_utf8_is_binary`, `over_limit_is_too_large` (write `MAX_TEXT_BYTES + 1` bytes), `png_is_image_data_url` (starts with `data:image/png;base64,`), `svg_mime`, `version_changes_after_write`, `version_none_for_missing`, `directory_is_invalid_path`, `unreadable_file_is_io_error` (unix, chmod 000, skip when running as root).
- [ ] **Step 2: Run** `cargo test --manifest-path src-tauri/Cargo.toml files::content` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(desktop): read and classify project files`.

### Task 5: Writing a file

**Files:**
- Create: `src-tauri/src/files/write.rs`
- Modify: `src-tauri/src/error.rs` (new variant)

**Interfaces:**
- Produces: `AppError::Conflict(String)` with wire code `"conflict"`.
- Produces: `files::write::write_file(path: &Path, content: &str, expected_version: Option<&str>, force: bool) -> AppResult<String>` — returns the new version. `path` comes from `paths::resolve_for_write` (already the real file, symlinks resolved).

Rules: unless `force`, compare `file_version(path)` with `expected_version` (`None` = "I expect the file not to exist"); a mismatch → `Conflict`, nothing written. Strategy, as the spec's "In-place fallback": new file → temp + rename. Existing file → in place (truncate, write, fsync) when it has more than one hard link, or its owner differs from the current user, or its directory is not writable; otherwise temp file in the same directory (`tempfile::NamedTempFile::new_in`), write, fsync, copy the original permissions, rename; if creating the temp file or the rename fails, fall back to in place. If the in-place write fails too, return the IO error.

- [ ] **Step 1: Write failing tests** (unix-only ones behind `#[cfg(unix)]`):
  - `writes_and_returns_new_version` — new version equals `file_version` afterwards and differs from the old one.
  - `conflict_when_version_differs` — file modified after read; write with the stale version → `Conflict`, disk content unchanged.
  - `force_overwrites_on_conflict`.
  - `creates_missing_file_when_expected_none`.
  - `conflict_when_file_appeared` — expected `None`, file exists → `Conflict`.
  - `keeps_permissions` — mode `0o600` survives.
  - `keeps_inode_for_hard_linked_file` — second hard link still reads the new content.
  - `writes_in_place_when_directory_read_only` — dir `0o555`, file `0o644` → write succeeds, inode unchanged.
  - `leaves_no_temp_files` — directory listing afterwards contains only the target.
  - `content_is_byte_exact` — `"a\r\nb\n"` round-trips.
- [ ] **Step 2: Run** `cargo test --manifest-path src-tauri/Cargo.toml files::write` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(desktop): write project files atomically with conflict detection`.

### Task 6: Watches, dirty registry, commands and wrappers

**Files:**
- Create: `src-tauri/src/files/watch.rs`, `src-tauri/src/commands/files.rs`
- Modify: `src-tauri/src/state.rs`, `src-tauri/src/commands/mod.rs`, `src-tauri/src/lib.rs`, `src-tauri/src/domain/files.rs`, `src/lib/tauri.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–5; `db::projects_repo::get(&conn, id)` for `project.path`.
- Produces (Rust): `AppState.file_watches: Arc<FileWatches>`.
  - `FileWatches::watch(&self, app: &AppHandle, window_label: &str, project_id: i64, rel_dir: &str, abs_dir: PathBuf) -> AppResult<()>` — idempotent per `(window, project, dir)`; non-recursive `notify` watch; emits `files://dir-changed` **to that window only**, debounced 150 ms per directory.
  - `FileWatches::unwatch(&self, window_label, project_id, rel_dir)`, `FileWatches::drop_window(&self, window_label)`.
  - `FileWatches::set_dirty(&self, window_label, count: u32)`, `FileWatches::dirty_elsewhere(&self, window_label) -> u32`.
  - `struct FilesDirChangedEvent { project_id: i64, rel_dir: String }` (camelCase, TS).
- Produces (commands, exact names):
  `list_project_dir(project_id, rel_path) -> Vec<FileEntry>`, `search_project_files(project_id, query) -> FileSearchResponse`, `read_project_file(project_id, rel_path) -> FileContent`, `project_file_version(project_id, rel_path) -> Option<String>`, `write_project_file(project_id, rel_path, content, expected_version: Option<String>, force: bool) -> String`, `watch_project_dir(window, project_id, rel_path)`, `unwatch_project_dir(window, project_id, rel_path)`, `set_dirty_file_count(window, count: u32)`, `dirty_files_in_other_windows(window) -> u32`.
- Produces (`src/lib/tauri.ts`): `listProjectDir`, `searchProjectFiles`, `readProjectFile`, `projectFileVersion`, `writeProjectFile(projectId, relPath, content, expectedVersion: string | null, force: boolean)`, `watchProjectDir`, `unwatchProjectDir`, `setDirtyFileCount`, `dirtyFilesInOtherWindows`, `onFilesDirChanged(cb: (e: FilesDirChangedEvent) => void)`.
- `lib.rs`: on `WindowEvent::Destroyed` call `file_watches.drop_window(label)` (clears watches and the dirty count).

- [ ] **Step 1: Write failing tests** in `watch.rs` for the parts that need no `AppHandle` (split the registry from the emitter): `dirty_elsewhere_sums_other_windows` (main 0, `project-1` 2, `session-x` 1 → from main: 3; from `project-1`: 1), `drop_window_clears_dirty_and_watches`, `watch_is_idempotent` (two `watch` calls keep one entry; one `unwatch` removes it).
- [ ] **Step 2: Run** `cargo test --manifest-path src-tauri/Cargo.toml files::watch` — FAIL.
- [ ] **Step 3: Implement** `watch.rs`, the commands, state field, registration, window-destroyed hook, and the `tauri.ts` wrappers. `project_file_version` and `write_project_file` use `resolve_for_write`; the rest `resolve_existing`. Follow `sessions/watcher.rs` for the `notify` usage.
- [ ] **Step 4: Run** `npm run test:rust` and `npm run lint` — PASS, zero errors; `src/types/FileContent.ts`, `FileSearchResponse.ts`, `FilesDirChangedEvent.ts` exist.
- [ ] **Step 5: Commit** `feat(desktop): expose project file commands and directory watches`.

### Task 7: `file` tab kind

**Files:**
- Create: `src/lib/fileText.ts`, `src/lib/fileText.test.ts`
- Modify: `src/store/tabsSlice.ts`, `src/store/tabsSlice.test.ts`, `src/lib/windowMode.ts`, `src/lib/detachGroup.ts`, `src/components/center/TabItem.tsx`, `src/components/center/TabSwitcher.tsx`, `src/components/center/PaneBar.tsx`, `src/components/center/useTabBarActions.tsx`, `src/components/center/TabContent.tsx`

**Interfaces:**
- Produces (`tabsSlice`): union member `{ kind: 'file'; id: string; projectId: number; path: string; title: string }`; `openFileTab(projectId: number, path: string): string` (returns the tab id, dedupes, activates).
- Produces (`lib/fileText.ts`):
  - `fileTabId(projectId: number, path: string): string` → `` `file:${projectId}:${path}` ``
  - `fileName(path: string): string`, `fileDir(path: string): string` (`''` for a root file)
  - `isMarkdownPath(path: string): boolean`
  - `type Eol = 'lf' | 'crlf'`
  - `decodeFileText(raw: string): { text: string; eol: Eol; hasBom: boolean }` — strips a leading `﻿`, normalises to `\n`; `eol` is the predominant ending, `lf` on a tie or when there are none.
  - `encodeFileText(text: string, eol: Eol, hasBom: boolean): string`.
- `windowMode.ts` tab descriptor gains `{ kind: 'file'; id: string; path: string; title: string }`; `detachGroup.ts` and `sessionTabFromMode` map it both ways.
- A `file` tab cannot be renamed (same exclusions as `note` in `PaneBar` and the context menu) and is skipped by `writeTabsToLocalStorage` (it already saves only session tabs — add a test that pins it). `TabItem` icon: `Icon name="file"` (add the glyph to `shared/Icon` if missing); `TabSwitcher` marker `▤`.
- `TabContent` renders a placeholder `<div data-file-tab={tab.id} />` for now; Task 10 replaces it.

- [ ] **Step 1: Write failing tests.**
  `fileText.test.ts`: `decode` of `"﻿a\r\nb\r\nc\n"` → `{ text: 'a\nb\nc\n', eol: 'crlf', hasBom: true }`; tie `"a\r\nb\n"` → `lf`; no newline → `lf`; `encode(decode(x))` equals `x` for pure-LF, pure-CRLF, BOM and no-trailing-newline inputs; `isMarkdownPath('docs/A.MD')` true, `'a.md.txt'` false; `fileName('a/b/c.ts')` `'c.ts'`, `fileDir('c.ts')` `''`.
  `tabsSlice.test.ts`: `openFileTab` adds `{ kind: 'file', id: 'file:1:src/a.ts', title: 'a.ts' }` and activates it; a second call adds nothing and re-activates; the same path in project 2 is a different tab; file tabs are absent from the persisted tabs JSON; `sessionTabFromMode` round-trips a file descriptor.
- [ ] **Step 2: Run** `npx vitest run --maxWorkers=3 src/lib/fileText.test.ts src/store/tabsSlice.test.ts` — FAIL.
- [ ] **Step 3: Implement.** Let `npm run lint` find every exhaustive switch over `Tab['kind']`.
- [ ] **Step 4: Run** the tests and `npm run lint` — PASS.
- [ ] **Step 5: Commit** `feat(desktop): add the file tab kind`.

### Task 8: Files panel — store, tree, search

**Files:**
- Create: `src/store/filesSlice.ts`, `src/store/filesSlice.test.ts`, `src/lib/useFilesSync.ts`, `src/components/files/FilesPanel.tsx`, `FileTree.tsx`, `FileSearchResults.tsx`, `FileEntryMenu.tsx`, `src/components/files/FilesPanel.test.tsx`
- Modify: `src/store/index.ts`, `src/store/notesSlice.ts` (`openNotesPanel` closes the files panel), `src/components/right/RightPanel.tsx`, `src/components/right/ProjectToolbar.tsx` (+ its test: 4 buttons, grid `grid-cols-4`), `src/components/layout/AppShell.tsx`, `src/components/layout/DetachedShell.tsx` (mount `useFilesSync`)

**Interfaces:**
- Consumes: Task 6 wrappers, `openFileTab`, `gitSlice` status, `closeNotesPanel(): Promise<boolean>`, `activeAgentPtyId` + `tauri.ptyWrite`.
- Produces (`filesSlice`, panel part):
  ```ts
  type DirListing = { status: 'loading' | 'ready' | 'error'; entries: FileEntry[] };
  type FileSearch = { query: string; status: 'idle' | 'loading' | 'ready' | 'error'; results: string[]; truncated: boolean; selected: number };
  filesPanelOpen: boolean;
  fileTrees: Record<number, { expanded: string[]; listings: Record<string, DirListing> }>;   // key '' = root
  fileSearch: FileSearch;
  openFilesPanel(): Promise<void>;      // awaits closeNotesPanel(); stays closed when it returns false
  closeFilesPanel(): void;
  toggleFileDir(projectId: number, relDir: string): Promise<void>;
  reloadFileDir(projectId: number, relDir: string): Promise<void>;
  setFileSearchQuery(projectId: number, query: string): void;   // debounce FILE_SEARCH_DEBOUNCE_MS = 150
  moveFileSearchSelection(delta: 1 | -1): void;
  ```
  Exported `TREE_RENDER_LIMIT = 2000`. Stale list/search responses are dropped with per-key tokens (pattern: `notesSlice.loadTokens`).
- Watch bookkeeping (internal, used again by Task 9): `retainDirWatch(projectId, relDir)` / `releaseDirWatch(projectId, relDir)` — reference counted; the first retain calls `watchProjectDir`, the last release `unwatchProjectDir`. A directory is retained while expanded (the root while the panel is open).
- `useFilesSync()` subscribes `onFilesDirChanged`: reloads the listing if that directory is loaded, calls `refreshGit(projectId)` debounced 500 ms while the panel is open, and calls `checkFilesOnDisk(projectId, relDir)` (a no-op stub until Task 9).
- A subscriber in `store/index.ts` closes the files panel when `activeTabId` becomes `null` (next to the notes one).

UI (spec sections "Files panel" and "Search"): header „Pliki” + ✕ (`aria-label="Zamknij pliki"`); search input placeholder „Szukaj pliku…”, focused on open; tree rows `role="treeitem"`; ignored rows dimmed; Git colour + letter from the same helper `GitFileRow` uses; active file tab's row highlighted; truncated lines „pokazano pierwsze 2000” / „pokazano pierwsze 200”; no results „Brak wyników”; listing error „Nie udało się wczytać katalogu” + „Spróbuj ponownie”. Context menu items „Kopiuj ścieżkę” and „Wstaw ścieżkę do sesji” (disabled, `title="Brak aktywnej sesji"`, without `activeAgentPtyId`; it writes the relative path followed by one space, no Enter). `RightPanel`: mount `FilesPanel` while open; the default column is `hidden` + `inert` while **either** panel is open.

- [ ] **Step 1: Write failing store tests** (mock `lib/tauri`): opening the panel loads the root and retains its watch; `openFilesPanel` closes notes first and stays closed when `closeNotesPanel` resolves `false`; `openNotesPanel` closes the files panel; `toggleFileDir` expands + loads + retains, a second toggle collapses + releases and keeps the listing; a stale listing response is dropped; `setFileSearchQuery` debounces and drops a stale response; clearing the query keeps `expanded`; selection clamps to the result range; the panel closes when the last tab closes.
- [ ] **Step 2: Write failing component tests:** rows render dirs before files with dim class on ignored; clicking a file calls `openFileTab(projectId, 'src/a.ts')`; typing shows the flat list with the directory under each name; `ArrowDown` + `Enter` opens the second result; `Escape` clears the query; a 2001-entry listing renders 2000 rows and the limit line; listing error shows the retry button and retry reloads; „Wstaw ścieżkę do sesji” is disabled without a session and writes `'src/a.ts '` with one.
- [ ] **Step 3: Run** `npx vitest run --maxWorkers=3 src/store/filesSlice.test.ts src/components/files src/components/right` — FAIL.
- [ ] **Step 4: Implement** store part, sync hook, components, toolbar button („Pliki”, `Icon name="folder"`), `RightPanel` change.
- [ ] **Step 5: Run** the same tests and `npm run lint` — PASS.
- [ ] **Step 6: Commit** `feat(desktop): add the project files panel with search`.

### Task 9: File buffers — load, edit, save, disk changes

**Files:**
- Modify: `src/store/filesSlice.ts`, `src/store/filesSlice.test.ts`, `src/store/index.ts`

**Interfaces:**
- Consumes: `readProjectFile`, `writeProjectFile`, `projectFileVersion`, `setDirtyFileCount`, `decodeFileText` / `encodeFileText`, `isMarkdownPath`, `fileDir`, watch bookkeeping from Task 8.
- Produces:
  ```ts
  type FileBufferView = { kind: 'text' } | { kind: 'image'; dataUrl: string } | { kind: 'binary'; size: number } | { kind: 'tooLarge'; size: number };
  type FileBuffer = {
    tabId: string; projectId: number; path: string;
    status: 'loading' | 'ready' | 'error'; error?: string;
    view: FileBufferView;
    content: string; savedContent: string; eol: Eol; hasBom: boolean;
    version: string | null;                    // null = file does not exist on disk
    mode: 'edit' | 'preview';                  // initial: 'preview' for Markdown, else 'edit'
    saveStatus: 'idle' | 'saving' | 'saved' | 'error'; saveError?: string;
    disk: 'same' | 'changed' | 'deleted';
  };
  fileBuffers: Record<string, FileBuffer>;                       // keyed by tab id
  loadFileBuffer(tabId: string): Promise<void>;                  // idempotent while loading/ready; retries from 'error'
  editFileBuffer(tabId: string, content: string): void;
  setFileBufferMode(tabId: string, mode: 'edit' | 'preview'): void;
  saveFileBuffer(tabId: string, opts?: { force?: boolean }): Promise<'saved' | 'conflict' | 'error' | 'clean'>;
  reloadFileBuffer(tabId: string): Promise<void>;                // drops edits
  keepFileBuffer(tabId: string): void;                           // "Zostaw moje": disk -> 'same', adopt the current disk version
  dropFileBuffer(tabId: string): void;
  checkFilesOnDisk(projectId: number, relDir: string): Promise<void>;
  saveDirtyFiles(tabIds: string[]): Promise<boolean>;            // false when any save is not 'saved'/'clean'
  export function isFileDirty(b: FileBuffer): boolean;           // view text && content !== savedContent, or disk === 'deleted' with content
  export function dirtyFileTabIds(state): string[];
  ```
- Behaviour pinned by the tests: `loadFileBuffer` retains the watch of `fileDir(path)`, `dropFileBuffer` releases it. `checkFilesOnDisk` compares `projectFileVersion` with `buffer.version` for every ready buffer in that directory: equal → nothing; `null` → `disk: 'deleted'`, `version: null`; different + clean → silent reload; different + dirty → `disk: 'changed'`. `saveFileBuffer` on a clean buffer returns `'clean'` without IPC (unless `disk === 'deleted'`); sends `encodeFileText(content, eol, hasBom)` with `expectedVersion = version`; on success sets `savedContent`, `version`, `disk: 'same'`, `saveStatus: 'saved'`; `{ code: 'conflict' }` → `'conflict'`, buffer untouched, `disk: 'changed'`; other errors → `saveStatus: 'error'`, `saveError` = message, content kept. Saves are serialised per tab through a promise chain (pattern: `notesSlice.saveChains`). `keepFileBuffer` stores the current disk version so the next save succeeds without `force`. A store subscriber reports `dirtyFileTabIds(state).length` through `setDirtyFileCount` whenever it changes, and drops buffers whose tab vanished.

- [ ] **Step 1: Write failing tests:** load of text / Markdown (mode `preview`) / image / binary / tooLarge / IO error; CRLF+BOM file: `content` is LF without BOM and the save sends the original bytes back; edit → dirty; save → clean with the new version; save of a clean buffer makes no IPC call; conflict leaves content and sets `disk: 'changed'`; `force` overwrites; failed save keeps content and `saveStatus: 'error'`; two `saveFileBuffer` calls in a row send two writes in order and the second uses the first one's returned version; an edit made while a save is in flight leaves the buffer dirty; `checkFilesOnDisk`: same / clean-changed (reloads) / dirty-changed / deleted; after an own save `checkFilesOnDisk` does nothing; saving a `deleted` buffer sends `expectedVersion: null`; `keepFileBuffer` then save succeeds; `setFileBufferMode` keeps `content`; `dropFileBuffer` releases the directory watch; dirty count reported on change; `saveDirtyFiles` returns `false` when one save conflicts.
- [ ] **Step 2: Run** `npx vitest run --maxWorkers=3 src/store/filesSlice.test.ts` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the test and `npm run lint` — PASS.
- [ ] **Step 5: Commit** `feat(desktop): add file buffers with explicit save and disk-change tracking`.

### Task 10: File tab view and editor

**Files:**
- Create: `src/components/files/CodeEditor.tsx`, `src/components/files/FileTabView.tsx`, `src/components/files/FileTabView.test.tsx`
- Modify: `package.json` (dependencies), `src/components/center/TabContent.tsx`, `src/components/center/TabItem.tsx` (dirty „●”)

**Interfaces:**
- Consumes: the buffer API from Task 9; `components/history/Markdown.tsx` (read its props first).
- Produces: `CodeEditor` props `{ value: string; path: string; onChange(value: string): void; onSave(): void; focused: boolean }`. It is the **only** module that imports CodeMirror. Packages: `codemirror`, `@codemirror/state`, `@codemirror/view`, `@codemirror/commands`, `@codemirror/search`, `@codemirror/language`, `@codemirror/language-data` (its `LanguageDescription.matchFilename` + `.load()` gives lazy per-language chunks; no match = plain text; map `.env*` file names to the `properties` mode). Line numbers, history, search (`Mod-f`), `Mod-s` → `onSave` with `preventDefault`. No autocompletion, no lint. Colours from the app's CSS variables so both themes work; the UI mono font. `value` is applied to the editor only when it differs from the document (external reload), preserving the scroll position.
- Produces: `FileTabView` props `{ tab: Extract<Tab, { kind: 'file' }>; visible: boolean; focused: boolean }`; calls `loadFileBuffer(tab.id)` on mount.

UI text: bar buttons „Zapisz” (with `Ctrl+S` hint, disabled while clean or saving), „Edytuj”, „Podgląd”; status „Niezapisane zmiany”, „Zapisywanie…”, „Zapisano” (2 s), save error text from `saveError`; bars „Plik zmienił się na dysku” + „Wczytaj ponownie” / „Zostaw moje” and „Plik został usunięty” (saving recreates it); conflict dialog title „Plik zmienił się na dysku”, message „Zapis nadpisze zmiany wprowadzone poza edytorem.”, buttons „Nadpisz” / „Wczytaj ponownie” / „Anuluj”; messages „Plik jest za duży, aby go otworzyć (<size>)”, „Plik binarny (<size>)”, load error „Nie udało się otworzyć pliku” + „Spróbuj ponownie”. Size formatted as B / KB / MB with one decimal. Markdown: preview renders `buffer.content`; „Edytuj” ↔ „Podgląd” call `setFileBufferMode`. Image: `<img>` fitted with `object-contain`. `TabItem` shows „●” after the title when `isFileDirty` for that tab.

- [ ] **Step 1: Write failing tests** with `vi.mock('./CodeEditor')` replacing it by a `<textarea>` that forwards `onChange` and calls `onSave` on a button: text file renders the editor with the content; Markdown renders the preview and no editor, „Edytuj” shows the editor, an edit then „Podgląd” renders the edited text; save button disabled when clean, enabled after an edit, click calls `saveFileBuffer`; „Niezapisane zmiany” shown while dirty; `disk: 'changed'` shows the bar and „Wczytaj ponownie” calls `reloadFileBuffer`, „Zostaw moje” `keepFileBuffer`; a `'conflict'` result opens the dialog and „Nadpisz” saves with `{ force: true }`; `disk: 'deleted'` shows its bar; tooLarge / binary / image / error states render their message, and „Spróbuj ponownie” calls `loadFileBuffer`; the tab title shows „●” while dirty.
- [ ] **Step 2: Run** `npx vitest run --maxWorkers=3 src/components/files/FileTabView.test.tsx` — FAIL.
- [ ] **Step 3: Install** the CodeMirror packages (`npm install <the seven packages>`), implement `CodeEditor`, `FileTabView`, wire `TabContent`.
- [ ] **Step 4: Run** the tests, `npm run lint` and `npm run build` — PASS; the build output shows language modes as separate chunks, not in the main bundle.
- [ ] **Step 5: Verify in the real app** (`npm run tauri dev`): open `.env` (colours, line numbers, edit, `Ctrl+S`, `Ctrl+F`), a `.md` (preview ↔ edit), a `.png`, a `.rs`; switch the app theme; note the result in the task report.
- [ ] **Step 6: Commit** `feat(desktop): open project files in editor tabs with markdown preview`.

### Task 11: Unsaved-file guards

**Files:**
- Create: `src/components/dialogs/UnsavedFilesDialog.tsx`, `src/components/dialogs/UnsavedFilesDialog.test.tsx`
- Modify: `src/components/center/useTabBarActions.tsx` (+ test), `src/components/layout/AppShell.tsx`, `src/components/layout/DetachedShell.tsx`, `src/lib/detachGroup.ts`, `src/lib/detachSession.ts` if it can carry file tabs (+ their tests)

**Interfaces:**
- Consumes: `dirtyFileTabIds`, `saveDirtyFiles`, `dropFileBuffer`, `dirtyFilesInOtherWindows`.
- Produces: `UnsavedFilesDialog` props `{ files: string[]; onSave(): void; onDiscard(): void; onCancel(): void; busy?: boolean; error?: string }` — title „Niezapisane zmiany”, the file names listed, buttons „Zapisz” (focused), „Odrzuć zmiany”, „Anuluj”; Esc = cancel; `error` text „Nie udało się zapisać wszystkich plików.” shown when a save failed (the dialog stays open).

Guard points (each: collect the dirty file tabs in scope → none: proceed; else show the dialog; „Zapisz” runs `saveDirtyFiles` and proceeds only on `true`; „Odrzuć zmiany” proceeds; „Anuluj” aborts):
1. Closing a file tab (X, middle click, Ctrl/Cmd+W, context menu) in `useTabBarActions`; a clean file tab closes at once. Closing drops its buffer.
2. Closing the main window and a detached window — in the existing `onCloseRequested` handlers, before the notes settle step.
3. Detaching a project group or session window that would carry dirty file tabs — before the hand-over. The tab travels as `path` only.
4. `runUpdate` in `AppShell` — before `downloadAndInstall` and again before `relaunch`: first the dialog for this window's dirty files, then `dirtyFilesInOtherWindows()`; when it is `> 0` abort and show (existing toast/error surface of the update flow) „Masz niezapisane pliki w innym oknie. Zapisz je lub zamknij to okno i spróbuj ponownie.”

- [ ] **Step 1: Write failing tests:** dialog renders names and fires the three callbacks, Esc cancels; closing a clean file tab closes immediately; closing a dirty one opens the dialog — save+success closes, save+failure keeps tab and shows the error, discard closes without a write, cancel keeps it; Ctrl+W on a dirty file tab opens the dialog; window close with a dirty file is prevented until the dialog resolves; detach with a dirty file asks first; `runUpdate` aborts with the message when `dirtyFilesInOtherWindows` resolves `2`, and proceeds when `0`.
- [ ] **Step 2: Run** `npx vitest run --maxWorkers=3 src/components/dialogs/UnsavedFilesDialog.test.tsx src/components/center src/components/layout src/lib` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same tests and `npm run lint` — PASS.
- [ ] **Step 5: Commit** `feat(desktop): guard unsaved files on close, detach and update`.

### Task 12: Documentation and full verification

**Files:**
- Modify: `DesktopApp/CLAUDE.md`

- [ ] **Step 1: Document** in `CLAUDE.md`: `files/` in both folder maps, `filesSlice` in the slice list, the sixth tab kind `file` (dedupe id, not persisted, not renamable, dirty close guard), and a new "File browser" section covering: the spec path; directory-changed event → re-list + version check (why a save never triggers its own "changed" bar); reference-counted directory watches; explicit save and the guard points (a new path that drops tabs must add the guard); the dirty-file registry behind the update refusal; rename vs in-place write rules; `CodeEditor` as the only CodeMirror import and the mocked-editor test pattern; path-safety rule (project id + relative path only).
- [ ] **Step 2: Run everything:** `npm run lint`, `npx vitest run --maxWorkers=3`, `npm run test:rust` — all PASS.
- [ ] **Step 3: Manual pass** in `npm run tauri dev` over the spec's manual QA list: a large repo with `node_modules` (expand it, search), edit `.env` while a session writes files (bar appears, conflict dialog on save), a file bind-mounted or hard-linked, detached window with a dirty file, update refusal message. Record what was and was not checked.
- [ ] **Step 4: Commit** `docs(desktop): document the file browser`.
