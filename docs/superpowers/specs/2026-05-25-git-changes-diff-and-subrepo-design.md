# Git changes panel: per-file diff modal + sub-repository support

**Date:** 2026-05-25
**Status:** Approved
**Scope:** Right-panel Git section (`src/components/right/Git*.tsx`) + Rust git layer (`src-tauri/src/git/`, `src-tauri/src/commands/git.rs`).

## Goal

Three improvements to the changes list in the right panel:

1. Clicking a file opens a diff viewer (large modal with a file list on the left, unified diff on the right).
2. When the project root is not a git repository, scan one level down and aggregate any sub-repositories found. Show them as separate, collapsible sections.
3. Remove the three placeholder buttons (`diff`, `stash`, `commit…`) underneath the file list.

## Non-goals

- Side-by-side diff view (unified only).
- Persisting collapse state across reloads.
- Staging / unstaging from the modal.
- Cross-repo navigation inside the modal sidebar.
- Recursive sub-repo discovery deeper than one level.
- Submodule support (`.gitmodules`).

## Backend changes

### Domain types — `src-tauri/src/domain/git.rs`

Replace the single-status shape with a list of repos:

```rust
pub struct GitRepo {
    pub label: String,        // "." for root repo; directory name for sub-repos
    pub branch: Option<String>,
    pub ahead: usize,
    pub behind: usize,
    pub files: Vec<GitFile>,
}

pub struct GitStatus {
    pub repos: Vec<GitRepo>,
    pub is_repo: bool,        // = !repos.is_empty(); kept for FE clarity
}
```

`GitFile` stays unchanged; its `path` is relative to its owning repo.

New diff result types in the same module:

```rust
pub enum DiffResult {
    Text { hunks: Vec<DiffHunk> },
    Binary,
    TooLarge { size: usize },
}

pub struct DiffHunk {
    pub header: String,           // "@@ -10,7 +10,9 @@"
    pub old_start: usize,
    pub new_start: usize,
    pub lines: Vec<DiffLine>,
}

pub struct DiffLine {
    pub kind: String,             // "context" | "add" | "del"
    pub old_lineno: Option<usize>,
    pub new_lineno: Option<usize>,
    pub content: String,
}
```

All types use `#[derive(TS)]` with `export_to = "../../src/types/"`. `DiffResult` is a tagged enum (`#[serde(rename_all = "camelCase")]` on the variant tag, snake_case struct fields preserved by ts-rs).

### Repo discovery — `src-tauri/src/git/mod.rs`

Replace the body of `status(path)`:

1. `Repository::open(path)`. If success: `repos = vec![repo_status(repo, ".")?]`.
2. Otherwise: `read_dir(path)`; for each entry that is a directory and does not start with `.`, attempt `Repository::open(child)`. Collect successes.
3. Sort sub-repos alphabetically by `label`.
4. Return `GitStatus { repos, is_repo: !repos.is_empty() }`.

Extract the current body of `status()` (branch + ahead/behind + statuses + diff stats) into helper:

```rust
fn repo_status(repo: Repository, label: &str) -> AppResult<GitRepo>
```

Rationale for `Repository::open` (strict) over `Repository::discover` (walks up): we want `~/projects/foo/bar` to be detected as a repo only if `bar/.git` exists directly, not because some ancestor is a repo.

### New diff command — `src-tauri/src/commands/git.rs`

```rust
#[tauri::command]
pub fn git_diff_file(
    state: State<AppState>,
    project_id: i64,
    repo_label: String,
    file_path: String,
) -> AppResult<DiffResult>
```

Implementation:

1. Load project via `projects_repo::get(&conn, project_id)`.
2. Resolve repo path: `project.path` if `repo_label == "."`, else `project.path.join(&repo_label)`.
3. `Repository::open(repo_path)`.
4. Pre-check file size: if working-tree file exists and `metadata().len() > 2 * 1024 * 1024`, return `DiffResult::TooLarge`.
5. Build `DiffOptions` with `pathspec(&file_path)`.
6. `diff_tree_to_workdir_with_index(head_tree, opts)` — produces unified working-tree-vs-HEAD diff (covers staged + unstaged combined).
7. Inspect `diff.deltas().next()`:
   - If `flags().is_binary()` → `DiffResult::Binary`.
   - If no delta (no changes) → `DiffResult::Text { hunks: vec![] }`.
8. Parse via `diff.foreach` with `file_cb`, `hunk_cb`, `line_cb`:
   - `hunk_cb` pushes a new `DiffHunk` and captures header / old_start / new_start.
   - `line_cb` maps `line.origin()` to `kind` (`' '` → context, `'+'` → add, `'-'` → del) and copies `line.content()` (UTF-8 via `from_utf8_lossy`).
9. Untracked file fallback: untracked files are not in `diff_tree_to_workdir_with_index`. Detect via `repo.status_file(Path::new(&file_path))` returning `Status::WT_NEW`; if so, read the file from disk, split into lines, and return one synthetic `DiffHunk { header: "@@ -0,0 +1,N @@", old_start: 0, new_start: 1, lines: [...] }` where each line has `kind: "add"`, `old_lineno: None`, `new_lineno: Some(i+1)`.

Register the command in `src-tauri/src/lib.rs`.

### IPC wrapper — `src/lib/tauri.ts`

```ts
gitDiffFile: (projectId: number, repoLabel: string, filePath: string) =>
  invoke<DiffResult>('git_diff_file', { projectId, repoLabel, filePath }),
```

`DiffResult` imported from `src/types/`. The tagged-enum decoding follows the `PtyKindClient` convention already documented in CLAUDE.md.

## Frontend changes

### `src/components/right/GitSection.tsx`

Logic split by repo count:

- `status.repos.length === 0` (i.e. `!status.is_repo`) → existing "Nie jest repozytorium git" message.
- `status.repos.length === 1` → render exactly like today: branch chip at top, flat `GitFileList`.
- `status.repos.length >= 2` → render a `GitRepoGroup` per repo, each collapsible.

Local state (component-scoped, not in Zustand):

```ts
const [diffTarget, setDiffTarget] = useState<{ repoLabel: string; filePath: string } | null>(null);
const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
```

Remove the action-buttons block (current lines 43–47: `diff` / `stash` / `commit…`).

Mount `<DiffDialog>` conditionally when `diffTarget` is set, passing `projectId` + `diffTarget` + files of the active repo for sidebar navigation + `onClose`.

### `src/components/right/GitRepoGroup.tsx` (new)

Props: `{ repo: GitRepo; collapsed: boolean; onToggle(): void; onSelectFile(filePath: string): void }`.

Header (clickable, toggles collapse):
- Chevron icon (right when collapsed, down when expanded).
- `repo.label` in `text-fg font-medium`.
- Inline branch chip (smaller variant of current chip).
- Ahead/behind indicators.
- File count.

Body (when expanded): `<GitFileList files={repo.files} onSelect={onSelectFile} />`.

### `src/components/right/GitFileList.tsx` + `GitFileRow.tsx`

Add `onSelect?(filePath: string)` prop. `GitFileRow` calls `onSelect(file.path)` in its `onClick`. Row does not know its repo — the parent (`GitSection` or `GitRepoGroup`) composes the diff target from the repo label it owns.

### `src/components/dialogs/DiffDialog.tsx` (new)

Layout: large modal (`max-w-[1400px]`, `h-[85vh]`), two columns.

Props:
```ts
{
  projectId: number;
  repoLabel: string;
  files: GitFile[];          // files of the active repo
  initialFilePath: string;
  onClose(): void;
}
```

Left sidebar (~280px):
- Header showing `repoLabel` if `repoLabel !== "."`.
- File list reusing `GitFileRow` (with active-state styling).
- Active row highlighted (`bg-bg-elev`).
- Clicking a row updates the active file and re-fetches the diff.
- `ArrowUp` / `ArrowDown` keyboard navigation across the list (listener guards against stealing keys from inputs via `document.activeElement` check).

Right panel (diff content):
- Monospace, two columns of line numbers (old / new) with `tabular-nums text-muted`.
- Lines styled by `kind`:
  - `context` — no background.
  - `add` — `bg-success/10`, leading `+`.
  - `del` — `bg-danger/10`, leading `-`.
- Hunk headers (`@@ -10,7 +10,9 @@`) rendered as separators (`bg-bg-elev text-muted text-[10.5px]`).
- States:
  - Loading → "Wczytywanie diffa…".
  - `Binary` variant → "Plik binarny — diff niedostępny".
  - `TooLarge` variant → "Plik za duży (X MB) — diff pominięty".
  - Empty `hunks` → "Brak zmian tekstowych".

Modal behavior:
- Closes on `Escape`, `×` button, backdrop click — matching `SettingsDialog` conventions in the same folder.
- `Escape` listener registered with `capture: true` so it pre-empts the global `Ctrl+W` handler in `TabBar.tsx`.

Data fetching:
- On open / when active file changes: `tauri.gitDiffFile(projectId, repoLabel, filePath)` with an in-flight token to ignore stale responses if the user clicks quickly.
- No caching; tied to component lifetime.

### `src/store/gitSlice.ts`

No structural changes. `gitByProject: Record<number, GitStatus>` keeps its shape; `GitStatus` itself changes type. `refreshGit` unchanged.

Diff data is intentionally **not** cached in the store — it is fetched on-click in `DiffDialog` only. Caching would risk staleness against the next `refreshGit` call without an invalidation mechanism.

## Tests

### Rust (`cargo test`)

- `git::status`:
  - Root-is-repo case: tempdir with `.git`, asserts `repos.len() == 1`, `repos[0].label == "."`.
  - Sub-repo case: tempdir with two `.git`-bearing subfolders, asserts `repos.len() == 2`, sorted alphabetically, labels match folder names.
  - Empty case: tempdir with neither root `.git` nor sub-repos → `repos.is_empty()`, `is_repo == false`.
  - Mixed case: tempdir where root has `.git` and a child also has `.git` → returns only the root (`repos.len() == 1`).
- `git_diff_file`:
  - Fixture repo with a known modified file → asserts hunk count and at least one `add` + one `del` line.
  - Binary file → returns `DiffResult::Binary`.
  - Untracked file → returns synthetic hunk of all `+` lines.
  - File > 2 MB → returns `DiffResult::TooLarge`.

### Frontend (`npm test`)

- `GitRepoGroup`: toggling header collapses/expands body; calls `onSelectFile` with file path on row click.
- `GitSection`: renders flat list for 1 repo; renders groups for 2 repos; opens `DiffDialog` when row clicked.
- `DiffDialog`:
  - Renders Loading state initially.
  - Renders "Plik binarny" for `Binary` result.
  - Renders "Plik za duży" for `TooLarge` result.
  - Renders "Brak zmian tekstowych" for empty `hunks`.
  - Navigates files via `ArrowDown`.

## Risks & open items

- **Untracked file as "diff"**: showing all lines as additions is a convention (matches `git diff --no-index`-like behavior). Acceptable.
- **`Repository::open` cost**: for a project containing many subdirectories, opening each is O(n). One-level scan only, and the count is small in practice — not optimizing.
- **Re-render storm on collapse**: collapse state is a single `Record<string, boolean>` in `GitSection`. Toggling re-renders the whole section. Acceptable for typical repo counts (1–5).
- **ts-rs regeneration**: after editing `domain/git.rs`, `cargo test` must be run once to update `src/types/`. Documented in CLAUDE.md already.
- **Lint baseline**: the project has 2 pre-existing lint errors (`vite.config.ts(5,1)`, `tsconfig.json(24,18)`). Implementation must not add new ones.

## File-level plan summary

**Modify:**
- `src-tauri/src/domain/git.rs` — extend types.
- `src-tauri/src/git/mod.rs` — refactor `status()` + extract `repo_status()` + discovery loop.
- `src-tauri/src/commands/git.rs` — add `git_diff_file`.
- `src-tauri/src/lib.rs` — register new command.
- `src/lib/tauri.ts` — add wrapper.
- `src/components/right/GitSection.tsx` — render-by-count logic, remove buttons, host modal.
- `src/components/right/GitFileList.tsx` — accept `onSelect`.
- `src/components/right/GitFileRow.tsx` — invoke `onSelect` on click.

**Create:**
- `src/components/right/GitRepoGroup.tsx`.
- `src/components/dialogs/DiffDialog.tsx`.

**Regenerated by ts-rs:**
- `src/types/GitStatus.ts`, `src/types/GitFile.ts` (no manual edits), plus new `src/types/GitRepo.ts`, `src/types/DiffResult.ts`, `src/types/DiffHunk.ts`, `src/types/DiffLine.ts`.

## Acceptance

- Right panel shows a single flat list when project root is a repo.
- Right panel shows two collapsible sections labeled `frontend` and `backend` when project root is not a repo but `frontend/.git` and `backend/.git` exist.
- Clicking a file row opens a large modal with that file's unified diff and the file list of its repo on the left.
- The three buttons under the changes list are gone.
- `npm run lint`, `npm test`, `npm run test:rust` all pass (with no new errors beyond the documented lint baseline).
