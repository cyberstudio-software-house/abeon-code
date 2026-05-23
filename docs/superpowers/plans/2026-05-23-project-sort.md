# Project Sort (Manual / Alpha / Activity) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add sortable project list with three modes (manual, alphabetical, last activity), persisted via the Spec A settings layer, with activity data refreshed on window focus.

**Architecture:** Backend exposes a single `get_projects_activity` command returning `HashMap<i64, i64>` (project_id → max mtime of `.claude/projects/<dir>/*.jsonl`). Frontend stores activity in `projectsSlice`, sorts via a pure selector based on `sortMode` (from `settingsSlice`, auto-persisted), and refreshes activity on `tauri://focus`.

**Tech Stack:** Rust (rusqlite, std::fs, tauri 2.x) backend; React 18 + Zustand + TypeScript frontend; existing settings persistence layer from Spec A.

**Spec reference:** `docs/superpowers/specs/2026-05-23-project-sort.md`
**Prerequisite:** Spec A (settings persistence) — DONE (commit `cb9da8a`).

---

## File Structure

**Backend (Rust):**
- **Create:** `src-tauri/src/commands/activity.rs` — `get_projects_activity` Tauri command (~30 lines + tests).
- **Modify:** `src-tauri/src/commands/mod.rs` — register `pub mod activity;`.
- **Modify:** `src-tauri/src/lib.rs` — register command in `generate_handler!`.

**Frontend (TypeScript):**
- **Modify:** `src/lib/tauri.ts` — add `getProjectsActivity` wrapper.
- **Modify:** `src/store/settingsSlice.ts` — add `sortMode` field + `setSortMode` action + `SortMode` type.
- **Modify:** `src/store/index.ts` — extend `Persisted`, `PERSISTED_KEYS`, `pickPersistedFields`, `applyPersistedToState`, `serializeValue`, `deserializeValue` to include `sortMode`.
- **Modify:** `src/store/projectsSlice.ts` — add `activity` field + `loadActivity` action + `selectSortedProjects` selector.
- **Modify:** `src/components/shared/Icon.tsx` — add `sort` icon (arrows up-down).
- **Create:** `src/components/sidebar/SortMenu.tsx` — popover button with 3 mode options.
- **Modify:** `src/components/sidebar/Sidebar.tsx` — render `SortMenu`, mount loadActivity, listen `tauri://focus`, use `selectSortedProjects`.

---

## Task 1: Backend — `get_projects_activity` command (TDD)

**Files:**
- Create: `src-tauri/src/commands/activity.rs`
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/lib.rs`

The command lists projects from DB, builds `~/.claude/projects/<claude_dir>/` path for each, reads dir entries, filters `*.jsonl`, takes the max `mtime`, and returns a `HashMap<i64, i64>` (project_id → mtime in milliseconds). Projects without sessions or whose claude_dir doesn't exist are simply not included in the map.

The directory iteration pattern matches `src-tauri/src/sessions/reader.rs:24-36` exactly — same `fs::read_dir + filter_map + filter ext==jsonl + metadata().modified()` flow.

### Test design

The tests need a tempdir to host fake `.claude/projects/<dir>/` directories. We can use `tempfile::TempDir` and inject the claude root path via a helper function. To keep tests deterministic, we'll override the claude root via an optional parameter.

Look at how `sessions::reader::list_sessions` is tested — but actually it isn't unit-tested with file I/O. So we need to design the function to be testable.

**Design decision:** The pure logic (scan a claude dir, find max mtime) is extracted into a helper `max_jsonl_mtime(dir: &Path) -> Option<i64>`. The Tauri command composes this with DB lookups. The helper is tested directly; the command is a thin wrapper.

### Implementation

- [ ] **Step 1: Add module declaration**

Edit `src-tauri/src/commands/mod.rs`:

```rust
pub mod projects;
pub mod sessions;
pub mod pty;
pub mod actions;
pub mod git;
pub mod settings;
pub mod activity;
```

- [ ] **Step 2: Write the failing tests**

Create `src-tauri/src/commands/activity.rs` with ONLY the helper signature and tests at first:

```rust
use std::collections::HashMap;
use std::path::Path;
use std::fs;
use tauri::State;
use crate::error::AppResult;
use crate::state::AppState;
use crate::db::projects_repo;
use crate::sessions::encoding::encode_project_path;

/// Returns the max mtime (in ms since UNIX epoch) of all *.jsonl files in `dir`,
/// or None if `dir` does not exist or contains no *.jsonl files.
fn max_jsonl_mtime(dir: &Path) -> Option<i64> {
    todo!("Task 1 Step 4")
}

#[tauri::command]
pub fn get_projects_activity(_state: State<AppState>) -> AppResult<HashMap<i64, i64>> {
    todo!("Task 1 Step 5")
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;
    use std::fs::File;
    use std::io::Write;
    use std::time::{Duration, SystemTime};
    use filetime::{FileTime, set_file_mtime};

    fn touch_jsonl(dir: &Path, name: &str, mtime_secs: u64) {
        let path = dir.join(format!("{name}.jsonl"));
        let mut f = File::create(&path).unwrap();
        f.write_all(b"{}").unwrap();
        let ft = FileTime::from_unix_time(mtime_secs as i64, 0);
        set_file_mtime(&path, ft).unwrap();
    }

    #[test]
    fn max_jsonl_mtime_picks_newest() {
        let tmp = TempDir::new().unwrap();
        touch_jsonl(tmp.path(), "old", 1_700_000_000);
        touch_jsonl(tmp.path(), "new", 1_800_000_000);
        let got = max_jsonl_mtime(tmp.path());
        assert_eq!(got, Some(1_800_000_000_000));
    }

    #[test]
    fn max_jsonl_mtime_ignores_non_jsonl() {
        let tmp = TempDir::new().unwrap();
        touch_jsonl(tmp.path(), "session", 1_800_000_000);
        // Drop a non-jsonl file with newer mtime.
        let other = tmp.path().join("notes.txt");
        let mut f = File::create(&other).unwrap();
        f.write_all(b"hello").unwrap();
        set_file_mtime(&other, FileTime::from_unix_time(1_900_000_000, 0)).unwrap();
        let got = max_jsonl_mtime(tmp.path());
        assert_eq!(got, Some(1_800_000_000_000));
    }

    #[test]
    fn max_jsonl_mtime_returns_none_when_empty() {
        let tmp = TempDir::new().unwrap();
        let got = max_jsonl_mtime(tmp.path());
        assert_eq!(got, None);
    }

    #[test]
    fn max_jsonl_mtime_returns_none_when_dir_missing() {
        let tmp = TempDir::new().unwrap();
        let missing = tmp.path().join("does-not-exist");
        let got = max_jsonl_mtime(&missing);
        assert_eq!(got, None);
    }
}
```

- [ ] **Step 3: Add `filetime` to dev-dependencies**

Edit `src-tauri/Cargo.toml`. Find the `[dev-dependencies]` section (or add it after `[dependencies]` if not present). Add:

```toml
[dev-dependencies]
tempfile = "3"
filetime = "0.2"
```

If `tempfile` is already listed (it is — used by `db/projects_repo.rs` tests), keep it. Just add `filetime`.

Then run `cargo build --tests` once to fetch the dep:

```bash
cd src-tauri && cargo build --tests
```

- [ ] **Step 4: Run tests — expect compile/todo failures**

```bash
cd src-tauri && cargo test --lib commands::activity
```

Expected: failures (panics from `todo!()`).

- [ ] **Step 5: Implement `max_jsonl_mtime`**

Replace the `todo!` in `max_jsonl_mtime` with:

```rust
fn max_jsonl_mtime(dir: &Path) -> Option<i64> {
    if !dir.exists() {
        return None;
    }
    let entries = fs::read_dir(dir).ok()?;
    let mut max_ms: Option<i64> = None;
    for entry in entries.filter_map(|e| e.ok()) {
        let path = entry.path();
        if path.extension().map(|x| x != "jsonl").unwrap_or(true) {
            continue;
        }
        let modified = match entry.metadata().and_then(|m| m.modified()) {
            Ok(t) => t,
            Err(_) => continue,
        };
        let ms = match modified.duration_since(std::time::UNIX_EPOCH) {
            Ok(d) => d.as_millis() as i64,
            Err(_) => continue,
        };
        max_ms = Some(max_ms.map_or(ms, |cur| cur.max(ms)));
    }
    max_ms
}
```

- [ ] **Step 6: Run tests — expect all helper tests pass**

```bash
cd src-tauri && cargo test --lib commands::activity::tests::max_jsonl_mtime
```

Expected: 4 tests pass.

- [ ] **Step 7: Implement the command**

Replace the `todo!` in `get_projects_activity` with:

```rust
#[tauri::command]
pub fn get_projects_activity(state: State<AppState>) -> AppResult<HashMap<i64, i64>> {
    let claude_root = dirs::home_dir()
        .ok_or_else(|| crate::error::AppError::Other("no home dir".into()))?
        .join(".claude")
        .join("projects");
    let c = state.db.get()?;
    let projects = projects_repo::list(&c)?;
    let mut out: HashMap<i64, i64> = HashMap::new();
    for p in projects {
        let dir = claude_root.join(&p.claude_dir);
        if let Some(mtime_ms) = max_jsonl_mtime(&dir) {
            out.insert(p.id, mtime_ms);
        }
    }
    Ok(out)
}
```

Note: `encode_project_path` is not needed here because the projects table already stores `claude_dir` (the encoded form), populated when projects are added via `commands/projects.rs:24`.

- [ ] **Step 8: Run full activity test suite + build**

```bash
cd src-tauri && cargo test --lib commands::activity
cd src-tauri && cargo build
```

Expected: 4 tests pass, build clean (no warnings about unused imports — the `encode_project_path` import is in fact unused, so REMOVE it from the imports block before this build).

Re-check `src-tauri/src/commands/activity.rs` top:

```rust
use std::collections::HashMap;
use std::path::Path;
use std::fs;
use tauri::State;
use crate::error::AppResult;
use crate::state::AppState;
use crate::db::projects_repo;
```

(Drop the `encode_project_path` import that was originally in step 2's skeleton — it turned out unused.)

Rebuild:

```bash
cd src-tauri && cargo build
```

- [ ] **Step 9: Register the command in `lib.rs`**

Edit `src-tauri/src/lib.rs`. Inside `tauri::generate_handler![ ... ]`, after the last `commands::settings::*` line (probably `commands::settings::delete_setting`), add:

```rust
            commands::activity::get_projects_activity,
```

CRITICAL: the working tree has unrelated user WIP in `src-tauri/src/lib.rs`. Use the same `git stash` technique that worked in Spec A Task 2:

```bash
git stash push -- src-tauri/src/lib.rs
# Now lib.rs is at HEAD baseline. Edit it to add the one new handler line.
```

After editing, verify the diff is JUST one added line:

```bash
git diff src-tauri/src/lib.rs
```

- [ ] **Step 10: Run full backend tests + build**

```bash
cd src-tauri && cargo test
cd src-tauri && cargo build
```

Expected: all tests pass (including the 4 new ones). Clean build.

- [ ] **Step 11: Commit, then restore the user's WIP**

Stage and commit only the new + modified files (not lib.rs WIP):

```bash
git add src-tauri/src/commands/activity.rs src-tauri/src/commands/mod.rs src-tauri/src/lib.rs src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "feat(activity): add get_projects_activity command for sort-by-activity"
git stash pop
```

Verify after:

```bash
git show --stat HEAD
git diff HEAD -- src-tauri/src/lib.rs
git status --short
```

Expected:
- `git show --stat HEAD` lists exactly: `Cargo.toml` (+1 line for filetime), `Cargo.lock` (new locked entries), `commands/activity.rs` (new), `commands/mod.rs` (+1 line), `lib.rs` (+1 line).
- `git diff HEAD -- src-tauri/src/lib.rs` shows the user's `rename_session` line as unstaged WIP.
- `git status --short` shows the user's 16+2 pre-existing WIP files unchanged.

---

## Task 2: Frontend — `tauri.getProjectsActivity()` wrapper

**Files:**
- Modify: `src/lib/tauri.ts`

- [ ] **Step 1: Add the wrapper method**

Edit `src/lib/tauri.ts`. Inside the `tauri` object, after the last existing method (likely `deleteSetting` from Spec A), append:

```ts
  getProjectsActivity: () =>
    invoke<Record<number, number>>('get_projects_activity'),
```

Ensure trailing comma matches existing convention.

NOTE: The Rust returns `HashMap<i64, i64>`. Serde serializes this as `{"<id>": <mtime>}` where keys are stringified ints. TypeScript `Record<number, number>` is the closest semantic match — when accessed via `obj[5]`, JS auto-coerces the numeric key to string lookup, so this works at runtime. (Use `Number(k)` if iterating keys explicitly.)

- [ ] **Step 2: Handle the user's WIP in tauri.ts**

The working tree has WIP in `src/lib/tauri.ts` (a `renameSession` method + `shell` variant in `PtyKindClient`). Use git stash:

```bash
git stash push -- src/lib/tauri.ts
# Now make the one-line addition to the clean baseline.
# Edit the file.
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
cd /home/pszweda/projects/cyberstudio/AbeonCode && npx tsc --noEmit
```

If errors related to consumers of WIP methods (e.g., `renameSession` not found): that's expected — stash temporarily separated wrapper from consumers. Don't fix the WIP-side; we'll restore it via stash pop.

The check we care about: does our new line type-check on its own? Yes if the file compiles in isolation (just the stashed baseline + our line). If you see errors UNRELATED to our line, ignore them — they'll resolve after stash pop.

- [ ] **Step 4: Commit, then restore WIP**

```bash
git add src/lib/tauri.ts
git commit -m "feat(tauri): add getProjectsActivity wrapper"
git stash pop
```

- [ ] **Step 5: Final verification**

```bash
npx tsc --noEmit
```

Expected: exit code 0 (WIP restored, our addition coexists with WIP renameSession + shell variant).

```bash
git show --stat HEAD
git diff HEAD -- src/lib/tauri.ts
```

Expected: 1 file in commit (just our 2 lines for the new method). WIP unstaged.

---

## Task 3: Frontend — `SortMode` type + `settingsSlice` field + persistence wiring

**Files:**
- Modify: `src/store/settingsSlice.ts`
- Modify: `src/store/index.ts`

This task introduces the `sortMode` field through the entire settings layer:
- Type definition.
- Slice field + setter.
- `PERSISTED_KEYS` registration.
- `Persisted` type, `pickPersistedFields`, `applyPersistedToState`, `serializeValue`, `deserializeValue` all updated.

After this task, the user can call `useStore.getState().setSortMode('alpha')` and it will be persisted, but UI doesn't render any sorted list yet (Task 4 wires the selector, Task 6 wires the UI).

- [ ] **Step 1: Add `SortMode` type and slice field**

Edit `src/store/settingsSlice.ts`. At the top of the file, with other type imports, add:

```ts
export type SortMode = 'manual' | 'alpha' | 'activity';
```

In the `SettingsSlice` type, add (between any existing field — convention is to keep settings grouped, so place near `displayName`):

```ts
  sortMode: SortMode;
```

In the actions section of `SettingsSlice`:

```ts
  setSortMode: (mode: SortMode) => void;
```

In the `createSettingsSlice` defaults, add (near `theme: 'dark'`):

```ts
  sortMode: 'manual',
```

In the actions implementation:

```ts
  setSortMode: (sortMode) => set({ sortMode }),
```

- [ ] **Step 2: Verify slice type-checks**

```bash
npx tsc --noEmit
```

Expected: no errors. The slice now has `sortMode` + `setSortMode`, but `store/index.ts` doesn't persist it yet — that's the next steps.

- [ ] **Step 3: Update `store/index.ts` persistence wiring**

Edit `src/store/index.ts`. Five integration points to update:

**(a) `Persisted` type** — add `sortMode`:

```ts
type Persisted = {
  theme?: 'dark' | 'light' | 'system';
  leftWidth?: number;
  rightWidth?: number;
  displayName?: string;
  defaultModelId?: string;
  modelEfforts?: Record<string, EffortLevelStr>;
  customModels?: CustomModelLite[];
  projectsBasePath?: string;
  skipPermissions?: boolean;
  sortMode?: 'manual' | 'alpha' | 'activity';
};
```

**(b) `PERSISTED_KEYS`** — append `'sortMode'`:

```ts
const PERSISTED_KEYS = [
  'theme', 'leftWidth', 'rightWidth', 'displayName',
  'defaultModelId', 'modelEfforts', 'customModels',
  'projectsBasePath', 'skipPermissions',
  'sortMode',
] as const satisfies readonly (keyof Persisted)[];
```

**(c) `pickPersistedFields`** — add the field:

```ts
function pickPersistedFields(state: AppState): Persisted {
  return {
    theme: state.theme,
    leftWidth: state.leftWidth,
    rightWidth: state.rightWidth,
    displayName: state.displayName,
    defaultModelId: state.defaultModelId,
    modelEfforts: state.modelEfforts as Record<string, EffortLevelStr>,
    customModels: state.customModels,
    projectsBasePath: state.projectsBasePath,
    skipPermissions: state.skipPermissions,
    sortMode: state.sortMode,
  };
}
```

**(d) `applyPersistedToState`** — extend the patch logic:

```ts
function applyPersistedToState(p: Persisted) {
  const patch: Partial<AppState> = {};
  if (p.theme !== undefined) patch.theme = p.theme;
  if (typeof p.leftWidth === 'number') patch.leftWidth = clamp(p.leftWidth, 200, 420);
  if (typeof p.rightWidth === 'number') patch.rightWidth = clamp(p.rightWidth, 220, 480);
  if (p.displayName) patch.displayName = p.displayName;
  if (p.defaultModelId) patch.defaultModelId = p.defaultModelId;
  if (p.modelEfforts) patch.modelEfforts = p.modelEfforts as AppState['modelEfforts'];
  if (p.customModels) patch.customModels = p.customModels as AppState['customModels'];
  if (p.projectsBasePath) patch.projectsBasePath = p.projectsBasePath;
  if (p.skipPermissions !== undefined) patch.skipPermissions = p.skipPermissions;
  if (p.sortMode === 'manual' || p.sortMode === 'alpha' || p.sortMode === 'activity') {
    patch.sortMode = p.sortMode;
  }
  if (Object.keys(patch).length > 0) useStore.setState(patch);
}
```

**(e) `serializeValue` / `deserializeValue`** — string union handled by `default` branch already (String(value) → raw, raw → raw with TS-cast at boundary). No code change needed because `'sortMode'` is not a special case (it's a string union, not number/boolean/JSON). Trace:

- `serializeValue('sortMode', 'alpha')` → `default` branch → `String('alpha')` → `'alpha'`. ✓
- `deserializeValue('sortMode', 'alpha')` → `default` branch → returns raw `'alpha'`. ✓
- In `applyPersistedToState`, the `(p.sortMode === ...)` guard validates the deserialized string before assigning. ✓

So no changes to serialize/deserialize. Good.

- [ ] **Step 4: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/store/settingsSlice.ts src/store/index.ts
git commit -m "feat(settings): add sortMode field with persistence wiring"
```

- [ ] **Step 6: Smoke test the persistence**

Optional but recommended:

```bash
npm run tauri:dev
```

In the running app, open devtools console and run:

```js
useStore.getState().setSortMode('alpha');
useStore.getState().sortMode;  // should print 'alpha'
```

Quit, restart, repeat the second line — should still be `'alpha'`. Verify in SQLite:

```bash
sqlite3 ~/.config/AbeonCode/abeoncode.db "SELECT * FROM settings WHERE key='sortMode';"
```

Should print `sortMode|alpha`. Confirms the existing persistence layer picked up the new key without modification — exactly what we wanted from the Spec A architecture.

Reset to `'manual'` for clean state going forward:

```js
useStore.getState().setSortMode('manual');
```

---

## Task 4: Frontend — `projectsSlice` activity state + `selectSortedProjects`

**Files:**
- Modify: `src/store/projectsSlice.ts`

Adds:
- `activity: Record<number, number>` state field.
- `loadActivity()` async action with in-flight guard.
- `selectSortedProjects(state: AppState): Project[]` pure selector exported from the file.

- [ ] **Step 1: Add activity field and loader**

Edit `src/store/projectsSlice.ts`. Update the type and creator:

Replace the current `ProjectsSlice` type with:

```ts
export type ProjectsSlice = {
  projects: Project[];
  activity: Record<number, number>;
  expandedProjectIds: Set<number>;
  loadProjects: () => Promise<void>;
  loadActivity: () => Promise<void>;
  addProject: (name: string, path: string) => Promise<Project>;
  removeProject: (id: number) => Promise<void>;
  toggleProjectExpanded: (id: number) => void;
};
```

Replace the `createProjectsSlice` body with:

```ts
let activityInFlight = false;

export const createProjectsSlice: StateCreator<ProjectsSlice> = (set, get) => ({
  projects: [],
  activity: {},
  expandedProjectIds: new Set(),
  loadProjects: async () => set({ projects: await tauri.listProjects() }),
  loadActivity: async () => {
    if (activityInFlight) return;
    activityInFlight = true;
    try {
      const activity = await tauri.getProjectsActivity();
      set({ activity });
    } catch (err) {
      console.error('[projects] loadActivity failed', err);
    } finally {
      activityInFlight = false;
    }
  },
  addProject: async (name, path) => {
    const p = await tauri.addProject(name, path);
    set({ projects: [...get().projects, p] });
    return p;
  },
  removeProject: async (id) => {
    await tauri.removeProject(id);
    set({ projects: get().projects.filter(p => p.id !== id) });
  },
  toggleProjectExpanded: (id) => {
    const next = new Set(get().expandedProjectIds);
    if (next.has(id)) next.delete(id); else next.add(id);
    set({ expandedProjectIds: next });
  },
});
```

The `activityInFlight` module-level flag is intentional — it lives outside Zustand's reactive state because reading/writing it does not need to trigger re-renders.

- [ ] **Step 2: Add `selectSortedProjects` at the bottom of the file**

Append at the end of `src/store/projectsSlice.ts` (after `createProjectsSlice`):

```ts
import type { AppState } from './index';

export function selectSortedProjects(state: AppState): Project[] {
  const arr = [...state.projects];
  switch (state.sortMode) {
    case 'manual':
      return arr.sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt - b.createdAt);
    case 'alpha':
      return arr.sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
      );
    case 'activity': {
      const act = state.activity;
      return arr.sort((a, b) => (act[b.id] ?? 0) - (act[a.id] ?? 0));
    }
  }
}
```

NOTE on the circular import: `src/store/index.ts` imports `createProjectsSlice` from `./projectsSlice`, and `projectsSlice.ts` now imports `AppState` from `./index`. TypeScript handles `import type` from a circular module at compile time (the type-only import is erased and creates no runtime cycle). This pattern is standard for Zustand slice + selector co-location.

If TypeScript complains about the circular type-only import (it usually doesn't, but ESLint/lint sometimes does), the workaround is to define the selector parameter as `state: ProjectsSlice & SettingsSlice` instead:

```ts
import type { SettingsSlice } from './settingsSlice';

export function selectSortedProjects(state: ProjectsSlice & SettingsSlice): Project[] {
  // ... same body
}
```

This avoids the circular dependency entirely. Use whichever works on first compile.

- [ ] **Step 3: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no errors. If the `AppState` import causes a circular issue, switch to the `ProjectsSlice & SettingsSlice` variant from Step 2 above.

- [ ] **Step 4: Commit**

```bash
git add src/store/projectsSlice.ts
git commit -m "feat(projects): add activity state, loadActivity, and selectSortedProjects"
```

---

## Task 5: Frontend — Sort icon + `SortMenu` component

**Files:**
- Modify: `src/components/shared/Icon.tsx`
- Create: `src/components/sidebar/SortMenu.tsx`

Adds the visual sort icon (used in the SortMenu button) and the popover component itself. Not yet wired into Sidebar — that's Task 6.

- [ ] **Step 1: Add `sort` icon**

Edit `src/components/shared/Icon.tsx`. Add a new entry to the `paths` record (after `refresh`, alphabetical-ish order). The icon is two stacked arrows (one up, one down) — minimalist match for the existing style:

```ts
  sort:     <g><path d="M7 4v16"/><polyline points="3 8 7 4 11 8"/><path d="M17 4v16"/><polyline points="13 16 17 20 21 16"/></g>,
```

This draws two vertical lines with arrow-tip polylines at opposing ends — convey "sort with two opposite directions". Consistent visual weight with the other icons (24x24 viewBox, stroke="currentColor").

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no errors. The `IconName` union now includes `'sort'`.

- [ ] **Step 3: Create `SortMenu.tsx`**

Create `src/components/sidebar/SortMenu.tsx`:

```tsx
import { useEffect, useRef, useState } from 'react';
import { useStore } from '../../store';
import { Icon } from '../shared/Icon';
import type { SortMode } from '../../store/settingsSlice';

type Option = { mode: SortMode; label: string };

const OPTIONS: Option[] = [
  { mode: 'manual',   label: 'Ręcznie' },
  { mode: 'alpha',    label: 'Alfabetycznie' },
  { mode: 'activity', label: 'Ostatnia aktywność' },
];

export function SortMenu() {
  const sortMode = useStore(s => s.sortMode);
  const setSortMode = useStore(s => s.setSortMode);
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  return (
    <div ref={containerRef} className="relative">
      <button
        onClick={() => setOpen(o => !o)}
        className="text-muted hover:text-fg transition-colors p-0.5"
        aria-label="Sortuj projekty"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <Icon name="sort" className="w-3.5 h-3.5" strokeWidth={2} />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full mt-1 z-10 bg-bg-elev border border-border rounded-md shadow-lg py-1 min-w-[180px]"
        >
          {OPTIONS.map(opt => (
            <button
              key={opt.mode}
              role="menuitemradio"
              aria-checked={sortMode === opt.mode}
              onClick={() => { setSortMode(opt.mode); setOpen(false); }}
              className={`w-full flex items-center justify-between gap-2 px-3 py-1.5 text-[12px] text-left transition-colors ${
                sortMode === opt.mode ? 'text-fg' : 'text-muted hover:text-fg'
              }`}
            >
              <span>{opt.label}</span>
              {sortMode === opt.mode && (
                <span className="text-[11px]" aria-hidden="true">✓</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
```

Design notes:
- Uses `bg-bg-elev`, `border-border`, `text-fg`, `text-muted` — matches the existing palette tokens (used elsewhere in `Sidebar.tsx`, `ProjectItem.tsx`).
- Click-outside closes the menu (standard popover pattern).
- ARIA roles: `menu` + `menuitemradio` for accessibility.
- Polish labels ("Ręcznie" / "Alfabetycznie" / "Ostatnia aktywność") match the user's UI language (see `Sidebar.tsx:42` "Projekty", `AddProjectButton`, etc.).

- [ ] **Step 4: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/components/shared/Icon.tsx src/components/sidebar/SortMenu.tsx
git commit -m "feat(sidebar): add sort icon and SortMenu popover component"
```

---

## Task 6: Frontend — Wire into Sidebar + focus listener

**Files:**
- Modify: `src/components/sidebar/Sidebar.tsx`

Final wiring: render `SortMenu` in the header, mount-load activity, listen to `tauri://focus`, and use the selector to drive the list.

- [ ] **Step 1: Read the current Sidebar.tsx**

```bash
cat src/components/sidebar/Sidebar.tsx
```

Note the existing structure — `useStore` calls at the top, `useEffect` for `load()`, the keyboard handler for `⌘K`, the `filtered` projects logic.

- [ ] **Step 2: Update imports + state at top of Sidebar.tsx**

Open `src/components/sidebar/Sidebar.tsx`. Replace its current imports with:

```tsx
import { useCallback, useEffect, useRef, useState } from 'react';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { useStore } from '../../store';
import { selectSortedProjects } from '../../store/projectsSlice';
import { ProjectItem } from './ProjectItem';
import { SidebarFooter } from './SidebarFooter';
import { SortMenu } from './SortMenu';
import { Icon } from '../shared/Icon';
import { Kbd } from '../shared/Kbd';
import { AddProjectDialog } from '../dialogs/AddProjectDialog';
```

(Adds: `getCurrentWebviewWindow` from `@tauri-apps/api/webviewWindow`, `selectSortedProjects` from the projects slice, `SortMenu` component.)

NOTE on the Tauri event API: in Tauri 2.x, `tauri://focus` is a window-scoped event. The generic `listen()` from `@tauri-apps/api/event` listens on the global event bus and does NOT pick up per-window events. Use `getCurrentWebviewWindow().listen(...)` (or its typed shortcut `.onFocusChanged()`) to receive window focus.

- [ ] **Step 3: Replace the body of the `Sidebar` component**

Replace the entire `Sidebar` function in `src/components/sidebar/Sidebar.tsx` with:

```tsx
export function Sidebar() {
  const projects = useStore(selectSortedProjects);
  const load = useStore(s => s.loadProjects);
  const loadActivity = useStore(s => s.loadActivity);
  const [query, setQuery] = useState('');
  const [addOpen, setAddOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { load(); }, [load]);

  // Load activity on mount + refresh when the window regains focus.
  useEffect(() => {
    loadActivity();
    let unlisten: (() => void) | null = null;
    const win = getCurrentWebviewWindow();
    win.onFocusChanged(({ payload: focused }) => {
      if (focused) loadActivity();
    }).then(fn => { unlisten = fn; });
    return () => { if (unlisten) unlisten(); };
  }, [loadActivity]);

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
      e.preventDefault();
      inputRef.current?.focus();
    }
  }, []);

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  const filtered = query.trim()
    ? projects.filter(p =>
        p.name.toLowerCase().includes(query.toLowerCase()) ||
        p.path.toLowerCase().includes(query.toLowerCase())
      )
    : projects;

  return (
    <aside className="h-full bg-bg px-2.5 pt-[18px] pb-2.5 text-[13px] flex flex-col">
      <div className="flex items-center justify-between">
        <div className="text-[10px] tracking-[0.14em] uppercase text-muted font-medium">
          Projekty
        </div>
        <div className="flex items-center gap-1">
          <SortMenu />
          <button
            onClick={() => setAddOpen(true)}
            className="text-muted hover:text-fg transition-colors p-0.5"
            aria-label="Dodaj projekt"
          >
            <Icon name="plus" className="w-3.5 h-3.5" strokeWidth={2} />
          </button>
        </div>
      </div>
      {addOpen && <AddProjectDialog onClose={() => setAddOpen(false)} />}

      <div className="mt-2.5 flex items-center gap-2 px-2.5 py-[7px] bg-bg-elev border border-border rounded-md">
        <Icon name="search" className="w-[13px] h-[13px] text-muted" />
        <input
          ref={inputRef}
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Szukaj projektu lub sesji…"
          className="bg-transparent outline-none text-[12px] text-fg flex-1 placeholder:text-muted"
        />
        <Kbd>⌘K</Kbd>
      </div>

      <ul className="mt-3 space-y-0.5 overflow-y-auto scroll-thin flex-1 pb-3">
        {filtered.length === 0 && <li className="text-muted text-[12px] px-2.5">— pusto —</li>}
        {filtered.map(p => <ProjectItem key={p.id} project={p} />)}
      </ul>

      <SidebarFooter />
    </aside>
  );
}
```

Key changes vs. baseline:
- `useStore(selectSortedProjects)` instead of `useStore(s => s.projects)` — list now sorted by mode.
- New `useEffect` calling `loadActivity()` on mount + setting up `tauri://focus` listener with cleanup.
- Header now wraps `+` and `<SortMenu />` in a `flex items-center gap-1` container.

NOTE about the user's WIP: `src/components/sidebar/Sidebar.tsx` is NOT in the modified files list per the initial git status — so there's no WIP to stash. Verify by running `git diff src/components/sidebar/Sidebar.tsx` BEFORE editing; expect empty output.

- [ ] **Step 4: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 5: Smoke test the dev server**

```bash
npm run tauri:dev
```

In the running app:
1. Confirm the sort icon appears in the "Projekty" header, next to `+`.
2. Click the icon → popover opens with 3 options, active mode has checkmark.
3. Switch to `Alfabetycznie` → project list reorders alphabetically.
4. Switch to `Ostatnia aktywność` → project list reorders by activity (most-recent first).
5. Switch back to `Ręcznie` → original order restored.
6. Quit and restart the app → previously selected mode persists.

If smoke test reveals visual issues (popover positioning, z-index, click-outside not firing), iterate inline before committing. If smoke is impractical, rely on `tsc` and trust the test plan for Task 7.

- [ ] **Step 6: Commit**

```bash
git add src/components/sidebar/Sidebar.tsx
git commit -m "feat(sidebar): integrate SortMenu, sort projects, refresh activity on focus"
```

---

## Task 7: Manual end-to-end verification

**Goal:** Validate the full spec by running through every scenario from Spec B section 9.

These steps cannot be subagent-driven — they require launching the desktop app and observing behavior.

- [ ] **Step 1: Three-mode visual sort check**

Launch:
```bash
npm run tauri:dev
```

Default: `'manual'`. Confirm list matches the DB order (use `sqlite3 ~/.config/AbeonCode/abeoncode.db "SELECT name FROM projects ORDER BY sort_order ASC, created_at ASC;"` to cross-check).

Switch to `Alfabetycznie`. Sorted A→Z, case-insensitive.

Switch to `Ostatnia aktywność`. Project with most recent JSONL mtime on top.

- [ ] **Step 2: Polish character sort**

Pre-condition: add a test project named "Łódź" (or rename an existing one via DB if needed). With `Alfabetycznie` active, confirm "Łódź" sorts near "L" (`Lublin`-zone), NOT at the end of the list (which would indicate locale-naive ASCII sort).

- [ ] **Step 3: Persistence across restart**

Select `Ostatnia aktywność`. Verify:
```bash
sqlite3 ~/.config/AbeonCode/abeoncode.db "SELECT value FROM settings WHERE key='sortMode';"
```
Expected: `activity`.

Quit app, restart. Mode should still be `'Ostatnia aktywność'`. Lista wciąż posortowana wg aktywności.

- [ ] **Step 4: Refresh on focus**

In the running app, switch to `Ostatnia aktywność`. Find a project NOT at the top of the list. Open a terminal (outside the app) and `touch` a JSONL file in its claude_dir:

```bash
touch "$HOME/.claude/projects/<some-encoded-dir>/<some-uuid>.jsonl"
```

Click anywhere outside the app (or use OS focus management) to BLUR the app, then focus it again. The project whose JSONL was touched should now be at the top of the list — proves `tauri://focus` listener works.

- [ ] **Step 5: Project without sessions**

Add a new project to a folder that has never been used with Claude Code (so `~/.claude/projects/<encoded>/` doesn't exist). Switch to `Ostatnia aktywność`. The new project should appear at the END of the list (mtime = 0).

- [ ] **Step 6: Stable sort tie-breaking**

If you have multiple projects all without sessions (or all with identical mtime), `Ostatnia aktywność` should preserve their original (manual/DB) order rather than randomizing. Verify by toggling between `Ręcznie` and `Ostatnia aktywność` — projects without sessions should appear in the same relative order in both modes (just shoved to the end in `activity` mode).

- [ ] **Step 7: Final state and any necessary fixup commit**

If all scenarios pass, no further commit needed.

If a manual scenario uncovered a bug, fix the affected file (likely `Sidebar.tsx`, `SortMenu.tsx`, or the selector in `projectsSlice.ts`), then:

```bash
git add <affected file>
git commit -m "fix(sidebar): <describe what was broken>"
```

---

## Self-Review Notes

Run through Spec B against the plan:

- **Sec 1 (Cel):** ✓ All 3 modes implemented across Tasks 1-6. Refresh on focus in Task 6.
- **Sec 2 (Decyzje):** ✓ Each row mapped:
  - Tryby → SortMode type (Task 3).
  - Manual semantyka → selector (Task 4 Step 2 `case 'manual'`).
  - Activity definition → Task 1 `max_jsonl_mtime` helper.
  - Payload type → `HashMap<i64, i64>` (Task 1) + `Record<number, number>` (Task 2).
  - Projects bez sesji → Task 1 omits from map, Task 4 selector uses `?? 0`.
  - UI placement → Task 5 SortMenu + Task 6 Sidebar header.
  - Kierunek → encoded in selector (Task 4 Step 2).
  - Architektura → Task 1 (backend) + Task 4 (frontend selector).
  - Persistencja → Task 3 (sortMode in PERSISTED_KEYS).
  - Refresh → Task 6 `useEffect` with `listen('tauri://focus', ...)`.
  - Drag-and-drop → out of scope, not touched anywhere.
- **Sec 3 (Architektura):** ✓ Diagram matches Tasks 1, 4, 5, 6 flows.
- **Sec 4 (Pliki):** ✓ Every listed file has a task.
- **Sec 5 (Selektor):** ✓ Task 4 Step 2 contains the exact code from spec.
- **Sec 6 (Save flow):** ✓ Task 3 wires sortMode into PERSISTED_KEYS; existing Spec A subscribe handles the rest.
- **Sec 7 (loadActivity):** ✓ Task 4 Step 1 contains the exact code with `activityInFlight` guard.
- **Sec 8 (Edge cases):** ✓ All covered in selector (`?? 0`), `max_jsonl_mtime` (None when missing), `activityInFlight` flag. Stable sort tie-break verified in Task 7 Step 6.
- **Sec 9 (Testy):** ✓ Rust tests in Task 1 Step 2 cover the max-mtime helper. Manual scenarios in Task 7.
- **Sec 10 (Out of scope):** Plan does NOT include drag-and-drop, FLIP animation, secondary sort keys, direction toggle, session sort, or backend cache. ✓

No placeholders, no "TBD". Type names consistent: `SortMode` (settingsSlice.ts and SortMenu.tsx), `Persisted.sortMode`, `state.sortMode`, `state.activity: Record<number, number>`. Function names consistent: `selectSortedProjects`, `loadActivity`, `getProjectsActivity`, `setSortMode`.
