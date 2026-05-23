# Settings Persistence Migration (localStorage → SQLite) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate user-settings persistence from `localStorage` to the existing SQLite `settings` table, with `localStorage` retained as a synchronous read cache. Zero functional change for the user; opens the door for backend reads and durable settings.

**Architecture:** SQLite is the canonical store, `localStorage` is the instant-load cache. On boot we (1) hydrate state synchronously from `localStorage` (preserves current zero-flash boot), (2) asynchronously fetch from SQLite and reconcile per Case 1-4 from the spec, (3) on every state change we diff vs `prevSnapshot` and write only changed keys to both stores. First-run migration copies localStorage → SQLite once, idempotent via the `migrated_v2` flag stored as a row in `settings`.

**Tech Stack:** Rust (rusqlite, r2d2, tauri 2.x, serde, thiserror) on the backend; React 18 + Zustand + TypeScript on the frontend.

**Spec reference:** `docs/superpowers/specs/2026-05-23-settings-persistence-sqlite.md`

---

## File Structure

**Backend (Rust):**
- **Create:** `src-tauri/src/db/settings_repo.rs` — `get / get_all / set / delete` on the `settings` table.
- **Modify:** `src-tauri/src/db/mod.rs` — register `pub mod settings_repo;`.
- **Modify:** `src-tauri/src/commands/settings.rs` — add 4 Tauri commands wrapping the repo.
- **Modify:** `src-tauri/src/lib.rs` — register the 4 new commands in `generate_handler!`.

**Frontend (TypeScript):**
- **Modify:** `src/lib/tauri.ts` — add 4 wrapper methods (`getSetting`, `getAllSettings`, `setSetting`, `deleteSetting`).
- **Modify:** `src/store/index.ts` — refactor in 3 incremental steps (extract helpers; add SQLite writes to subscribe; add async hydration + reconcile).

**No changes to:** the existing `001_initial.sql` (table exists already), `settingsSlice.ts` (the slice contract is unchanged — only the persistence wrapper changes).

---

## Task 1: Backend — `settings_repo` module (TDD)

**Files:**
- Create: `src-tauri/src/db/settings_repo.rs`
- Modify: `src-tauri/src/db/mod.rs` (one-line module declaration)

The repository uses `&Connection` (matching the `projects_repo.rs` style, which is the older and more flexible pattern in this codebase). All operations on the existing `settings` table from `migrations/001_initial.sql`.

- [ ] **Step 1: Add module declaration**

Edit `src-tauri/src/db/mod.rs` to add the new module next to existing repos:

```rust
pub mod projects_repo;
pub mod actions_repo;
pub mod session_titles_repo;
pub mod settings_repo;
```

- [ ] **Step 2: Create the test file (will fail to compile — that's expected)**

Create `src-tauri/src/db/settings_repo.rs` with ONLY the test module at first:

```rust
use rusqlite::{params, Connection};
use std::collections::HashMap;
use crate::error::AppResult;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_pool;
    use tempfile::NamedTempFile;

    fn pool() -> crate::db::DbPool {
        let f = NamedTempFile::new().unwrap();
        let path = f.path().to_path_buf();
        std::mem::forget(f);
        init_pool(&path).unwrap()
    }

    #[test]
    fn set_get_roundtrip() {
        let p = pool();
        let c = p.get().unwrap();
        set(&c, "theme", "dark").unwrap();
        assert_eq!(get(&c, "theme").unwrap(), Some("dark".to_string()));
    }

    #[test]
    fn set_overwrites() {
        let p = pool();
        let c = p.get().unwrap();
        set(&c, "theme", "dark").unwrap();
        set(&c, "theme", "light").unwrap();
        assert_eq!(get(&c, "theme").unwrap(), Some("light".to_string()));
    }

    #[test]
    fn get_missing_returns_none() {
        let p = pool();
        let c = p.get().unwrap();
        assert_eq!(get(&c, "nonexistent").unwrap(), None);
    }

    #[test]
    fn get_all_returns_all_rows() {
        let p = pool();
        let c = p.get().unwrap();
        set(&c, "theme", "dark").unwrap();
        set(&c, "leftWidth", "260").unwrap();
        set(&c, "migrated_v2", "1").unwrap();
        let all = get_all(&c).unwrap();
        assert_eq!(all.len(), 3);
        assert_eq!(all.get("theme"), Some(&"dark".to_string()));
        assert_eq!(all.get("leftWidth"), Some(&"260".to_string()));
        assert_eq!(all.get("migrated_v2"), Some(&"1".to_string()));
    }

    #[test]
    fn delete_removes_row() {
        let p = pool();
        let c = p.get().unwrap();
        set(&c, "theme", "dark").unwrap();
        delete(&c, "theme").unwrap();
        assert_eq!(get(&c, "theme").unwrap(), None);
    }

    #[test]
    fn delete_missing_is_noop() {
        let p = pool();
        let c = p.get().unwrap();
        delete(&c, "nonexistent").unwrap();
    }
}
```

- [ ] **Step 3: Run tests — expect compilation failure**

```bash
cd src-tauri && cargo test --lib db::settings_repo
```

Expected: compile error — `get`, `set`, `get_all`, `delete` not defined.

- [ ] **Step 4: Implement the four functions**

Add to the top of `src-tauri/src/db/settings_repo.rs` (above the test module):

```rust
pub fn get(conn: &Connection, key: &str) -> AppResult<Option<String>> {
    let mut stmt = conn.prepare("SELECT value FROM settings WHERE key = ?")?;
    let mut rows = stmt.query(params![key])?;
    match rows.next()? {
        Some(row) => Ok(Some(row.get(0)?)),
        None => Ok(None),
    }
}

pub fn get_all(conn: &Connection) -> AppResult<HashMap<String, String>> {
    let mut stmt = conn.prepare("SELECT key, value FROM settings")?;
    let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
    let mut map = HashMap::new();
    for row in rows {
        let (k, v) = row?;
        map.insert(k, v);
    }
    Ok(map)
}

pub fn set(conn: &Connection, key: &str, value: &str) -> AppResult<()> {
    conn.execute(
        "INSERT INTO settings(key, value) VALUES(?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

pub fn delete(conn: &Connection, key: &str) -> AppResult<()> {
    conn.execute("DELETE FROM settings WHERE key = ?", params![key])?;
    Ok(())
}
```

- [ ] **Step 5: Run tests — expect all pass**

```bash
cd src-tauri && cargo test --lib db::settings_repo
```

Expected: `test result: ok. 6 passed; 0 failed`.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/db/settings_repo.rs src-tauri/src/db/mod.rs
git commit -m "feat(db): add settings_repo with key/value CRUD"
```

---

## Task 2: Backend — Tauri commands and handler registration

**Files:**
- Modify: `src-tauri/src/commands/settings.rs` (append 4 commands)
- Modify: `src-tauri/src/lib.rs` (register handlers)

The existing `commands/settings.rs` only has `get_git_user`. We extend it with the persistence commands. They take `State<AppState>` and delegate to the repo. All values are strings — frontend handles serialization of complex types.

- [ ] **Step 1: Add the 4 commands to `commands/settings.rs`**

Append at the bottom of `src-tauri/src/commands/settings.rs` (after the existing `read_git_config` helper):

```rust
use std::collections::HashMap;
use tauri::State;
use crate::state::AppState;
use crate::db::settings_repo;

#[tauri::command]
pub fn get_setting(state: State<AppState>, key: String) -> AppResult<Option<String>> {
    let c = state.db.get()?;
    settings_repo::get(&c, &key)
}

#[tauri::command]
pub fn get_all_settings(state: State<AppState>) -> AppResult<HashMap<String, String>> {
    let c = state.db.get()?;
    settings_repo::get_all(&c)
}

#[tauri::command]
pub fn set_setting(state: State<AppState>, key: String, value: String) -> AppResult<()> {
    let c = state.db.get()?;
    settings_repo::set(&c, &key, &value)
}

#[tauri::command]
pub fn delete_setting(state: State<AppState>, key: String) -> AppResult<()> {
    let c = state.db.get()?;
    settings_repo::delete(&c, &key)
}
```

- [ ] **Step 2: Register the commands in `lib.rs`**

Edit `src-tauri/src/lib.rs`. Inside the `tauri::generate_handler![ ... ]` macro (currently lines 30-55), add the four new command paths next to the existing `commands::settings::get_git_user`:

```rust
            commands::settings::get_git_user,
            commands::settings::get_setting,
            commands::settings::get_all_settings,
            commands::settings::set_setting,
            commands::settings::delete_setting,
```

Keep the rest of the `generate_handler!` list intact (do not remove any existing entries).

- [ ] **Step 3: Build the backend to verify it compiles**

```bash
cd src-tauri && cargo build
```

Expected: clean build, no warnings about unused imports.

- [ ] **Step 4: Run all backend tests to ensure no regressions**

```bash
cd src-tauri && cargo test
```

Expected: all existing tests pass (including the 6 added in Task 1).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands/settings.rs src-tauri/src/lib.rs
git commit -m "feat(commands): expose settings CRUD via tauri commands"
```

---

## Task 3: Frontend — Tauri wrapper methods

**Files:**
- Modify: `src/lib/tauri.ts`

Adds typed wrappers around the new commands. Frontend treats all values as strings — serialization to/from typed objects happens in `store/index.ts`.

- [ ] **Step 1: Add the 4 wrapper methods**

Edit `src/lib/tauri.ts`. Inside the `tauri` object (after `countSessions` on line 55), append:

```ts
  getSetting: (key: string) =>
    invoke<string | null>('get_setting', { key }),
  getAllSettings: () =>
    invoke<Record<string, string>>('get_all_settings'),
  setSetting: (key: string, value: string) =>
    invoke<void>('set_setting', { key, value }),
  deleteSetting: (key: string) =>
    invoke<void>('delete_setting', { key }),
```

Make sure to leave a trailing comma on `countSessions` and on `deleteSetting` (this matches the existing trailing-comma convention in the file).

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/lib/tauri.ts
git commit -m "feat(tauri): add frontend wrappers for settings CRUD"
```

---

## Task 4: Frontend — Extract helpers in `store/index.ts` (pure refactor)

**Files:**
- Modify: `src/store/index.ts`

This task is a **pure refactor** — behavior unchanged, only localStorage is touched, exactly like today. We extract typed helpers (`PERSISTED_KEYS`, `pickPersistedFields`, `serialize`, `deserialize`, `diffKeys`) so subsequent tasks have clean primitives to build on.

Goal of this task: the helpers exist and are used by the existing load+subscribe code, but **no SQLite involvement yet**.

- [ ] **Step 1: Replace the bottom half of `src/store/index.ts`**

Open `src/store/index.ts`. Keep lines 1-18 (imports + store creation). Replace **everything from line 20 to the end** (the `PERSIST_KEY` declaration, the `Persisted` type, `loadPersisted`, the apply block, and the `subscribe` call) with the following block:

```ts
const PERSIST_KEY = 'abeoncode.settings';

type EffortLevelStr = 'low' | 'medium' | 'high';
type CustomModelLite = { id: string; modelId: string; label: string };

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
};

const PERSISTED_KEYS = [
  'theme', 'leftWidth', 'rightWidth', 'displayName',
  'defaultModelId', 'modelEfforts', 'customModels',
  'projectsBasePath', 'skipPermissions',
] as const satisfies readonly (keyof Persisted)[];

type PersistedKey = typeof PERSISTED_KEYS[number];

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

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
  };
}

function serializeValue(key: PersistedKey, value: unknown): string {
  if (value === undefined || value === null) return '';
  switch (key) {
    case 'leftWidth':
    case 'rightWidth':
      return String(value as number);
    case 'skipPermissions':
      return value ? 'true' : 'false';
    case 'modelEfforts':
    case 'customModels':
      return JSON.stringify(value);
    default:
      return String(value);
  }
}

function deserializeValue(key: PersistedKey, raw: string): unknown {
  if (raw === '') return undefined;
  switch (key) {
    case 'leftWidth':
      return clamp(Number(raw), 200, 420);
    case 'rightWidth':
      return clamp(Number(raw), 220, 480);
    case 'skipPermissions':
      return raw === 'true';
    case 'modelEfforts':
    case 'customModels':
      try { return JSON.parse(raw); } catch { return undefined; }
    default:
      return raw;
  }
}

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  const keys = Object.keys(v as object).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify((v as Record<string, unknown>)[k])).join(',') + '}';
}

function diffKeys(prev: Persisted, next: Persisted): PersistedKey[] {
  return PERSISTED_KEYS.filter(k => stableStringify(prev[k]) !== stableStringify(next[k]));
}

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
  if (Object.keys(patch).length > 0) useStore.setState(patch);
}

function loadFromLocalStorage(): Persisted {
  try {
    const raw = localStorage.getItem(PERSIST_KEY);
    return raw ? JSON.parse(raw) as Persisted : {};
  } catch {
    return {};
  }
}

function writeLocalStorage(snapshot: Persisted) {
  try {
    localStorage.setItem(PERSIST_KEY, JSON.stringify(snapshot));
  } catch {
    /* storage full or unavailable */
  }
}

// --- Boot: sync hydrate from localStorage ---
applyPersistedToState(loadFromLocalStorage());

// --- prevSnapshot tracks last persisted state for diffing ---
let prevSnapshot: Persisted = pickPersistedFields(useStore.getState());

// --- Subscribe: on any state change, diff + write localStorage ---
useStore.subscribe((state) => {
  const next = pickPersistedFields(state);
  const changed = diffKeys(prevSnapshot, next);
  if (changed.length === 0) return;
  writeLocalStorage(next);
  prevSnapshot = next;
});
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Run the app and verify nothing is broken**

```bash
npm run tauri:dev
```

(or whatever the project's dev command is — check `package.json` `scripts.dev` if `tauri:dev` is not present.)

In the running app:
1. Toggle the theme in settings.
2. Resize the sidebar.
3. Quit and reopen the app.
4. Confirm: theme + sidebar width are preserved (same behavior as before the refactor).

- [ ] **Step 4: Commit**

```bash
git add src/store/index.ts
git commit -m "refactor(store): extract typed persistence helpers"
```

---

## Task 5: Frontend — Add SQLite writes to subscribe (additive)

**Files:**
- Modify: `src/store/index.ts`

We now extend the existing subscribe so that every changed key is **also** sent to SQLite. localStorage continues to be written as the source of truth for now. This is additive — if SQLite write fails, the app still works exactly as today.

- [ ] **Step 1: Update the subscribe block to also write to SQLite**

Edit `src/store/index.ts`. Replace the existing `useStore.subscribe(...)` block (the one added in Task 4) with:

```ts
useStore.subscribe((state) => {
  const next = pickPersistedFields(state);
  const changed = diffKeys(prevSnapshot, next);
  if (changed.length === 0) return;

  // 1. Instant cache to localStorage
  writeLocalStorage(next);

  // 2. Durable write to SQLite per changed key (fire-and-forget)
  for (const key of changed) {
    const value = serializeValue(key, next[key]);
    tauri.setSetting(key, value).catch(err => {
      console.error('[settings] setSetting failed', key, err);
    });
  }

  prevSnapshot = next;
});
```

This requires importing `tauri` at the top of `src/store/index.ts`. Add the import next to the existing imports:

```ts
import { tauri } from '../lib/tauri';
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Run the app and verify SQLite writes happen**

```bash
npm run tauri:dev
```

1. Open the app, toggle the theme (e.g., dark → light).
2. Open a terminal in the project root and inspect the DB:

   ```bash
   sqlite3 ~/.config/AbeonCode/abeoncode.db "SELECT * FROM settings;"
   ```

   Expected: a row `theme | light` (and possibly other rows that got written when the subscribe fired for other state changes during boot).

3. Open browser devtools console: confirm no `[settings] setSetting failed` errors are logged.

- [ ] **Step 4: Commit**

```bash
git add src/store/index.ts
git commit -m "feat(store): dual-write settings to SQLite alongside localStorage"
```

---

## Task 6: Frontend — Async hydration + reconcile (Cases 1-4)

**Files:**
- Modify: `src/store/index.ts`

Finally, on boot we async-load from SQLite and reconcile per spec section 4. After this task, SQLite is the canonical store: existing users get migrated once (Case 1), recovery from cleared localStorage works (Case 3), fresh installs use defaults (Case 4), and steady state is no-op (Case 2).

`★ Insight ─────────────────────────────────────`
- Two subtle correctness issues we have to handle here, both stemming from the fact that the subscribe handler is active during `hydrateFromSqlite`:
  - **Migration race:** if the user changes a setting in the ~50 ms migration window, the cached `localSnapshot` is stale by the time we write each key. Fix: read `pickPersistedFields(useStore.getState())` at migration time and write THAT, so the latest value wins.
  - **Reconcile cascade:** in Case 2/3 we apply SQLite values to state, which fires the subscribe. If `prevSnapshot` still holds the localStorage values, the subscribe sees a diff and writes SQLite values back to SQLite (and localStorage). To suppress this, we pre-set `prevSnapshot` to the post-reconcile state BEFORE applying.
- The migration flag (`migrated_v2`) is stored as a `settings` row itself — same table, same API. No new schema needed.
`─────────────────────────────────────────────────`

- [ ] **Step 1: Append the hydration IIFE at the end of `src/store/index.ts`**

Append at the end of `src/store/index.ts` (after the `useStore.subscribe` block):

```ts
const MIGRATION_FLAG_KEY = 'migrated_v2';

function persistedFromRawMap(raw: Record<string, string>): Persisted {
  const out: Persisted = {};
  for (const key of PERSISTED_KEYS) {
    const v = raw[key];
    if (v === undefined) continue;
    const parsed = deserializeValue(key, v);
    if (parsed === undefined) continue;
    (out as Record<string, unknown>)[key] = parsed;
  }
  return out;
}

async function hydrateFromSqlite(): Promise<void> {
  let raw: Record<string, string>;
  try {
    raw = await tauri.getAllSettings();
  } catch (err) {
    console.error('[settings] hydrateFromSqlite: getAllSettings failed', err);
    return;
  }

  const sqliteHasMigrationFlag = raw[MIGRATION_FLAG_KEY] === '1';
  const sqliteSnapshot = persistedFromRawMap(raw);
  const localSnapshot = loadFromLocalStorage();

  // Case 1: first boot post-migration — SQLite empty, localStorage has data.
  // Use CURRENT state (not the cached localSnapshot) to win any race where the
  // user changed a setting during the async window.
  if (!sqliteHasMigrationFlag && Object.keys(localSnapshot).length > 0) {
    const currentState = pickPersistedFields(useStore.getState());
    for (const key of PERSISTED_KEYS) {
      const value = currentState[key];
      if (value === undefined) continue;
      const serialized = serializeValue(key, value);
      try {
        await tauri.setSetting(key, serialized);
      } catch (err) {
        console.error('[settings] migration setSetting failed', key, err);
      }
    }
    try {
      await tauri.setSetting(MIGRATION_FLAG_KEY, '1');
    } catch (err) {
      console.error('[settings] migration flag setSetting failed', err);
    }
    // State is already up-to-date; refresh prevSnapshot in case it changed mid-migration.
    prevSnapshot = pickPersistedFields(useStore.getState());
    return;
  }

  // Case 4: fresh install — both empty. Nothing to reconcile.
  if (!sqliteHasMigrationFlag && Object.keys(sqliteSnapshot).length === 0) {
    return;
  }

  // Case 2 / Case 3: SQLite has data, possibly differs from localStorage.
  // SQLite is canonical. To prevent the subscribe handler from re-writing the
  // hydrated values back to SQLite as a "diff", we PRE-SET prevSnapshot to the
  // future state BEFORE applying it.
  const currentState = pickPersistedFields(useStore.getState());
  const futureState: Persisted = { ...currentState, ...sqliteSnapshot };
  prevSnapshot = futureState;
  applyPersistedToState(sqliteSnapshot);
  writeLocalStorage(futureState);
}

void hydrateFromSqlite();
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Test Case 4 (fresh install)**

```bash
# Clear both storages
rm -rf ~/.config/AbeonCode/abeoncode.db
# In the running app's devtools console (or before opening): clear localStorage for the app origin.
# In a real terminal session, easiest: quit app, then:
sqlite3 ~/.config/AbeonCode/abeoncode.db ".tables"  # will recreate empty file via app
```

Then:
```bash
npm run tauri:dev
```

Expected:
- App opens with defaults (dark theme, 260px sidebar, etc.).
- After ~50ms, no visible UI flicker.
- `sqlite3 ~/.config/AbeonCode/abeoncode.db "SELECT * FROM settings;"` shows zero rows until user changes a setting.

- [ ] **Step 4: Test Case 1 (migration from localStorage)**

This simulates an existing user upgrading.

```bash
# Wipe SQLite settings only, keep localStorage:
sqlite3 ~/.config/AbeonCode/abeoncode.db "DELETE FROM settings;"
```

Then start the app:
```bash
npm run tauri:dev
```

Before reopening, confirm localStorage has data by inspecting via devtools or by checking the previous app session left settings in place.

Expected on boot:
- App displays with the same settings as the previous session (no visible change).
- After ~50-100ms (the async migration), SQLite now contains all settings:

   ```bash
   sqlite3 ~/.config/AbeonCode/abeoncode.db "SELECT key, value FROM settings ORDER BY key;"
   ```

   Should list `migrated_v2 | 1`, plus one row per non-default value (theme, leftWidth, etc.).

- [ ] **Step 5: Test Case 3 (recovery from cleared localStorage)**

Pre-condition: SQLite has settings from Step 4 (post-migration).

```bash
# In the app's devtools console while it's NOT running:
# Easier: clear localStorage by opening a different browser instance — but for Tauri WebView,
# the simplest is to delete the WebView cache dir. On Linux:
rm -rf ~/.local/share/AbeonCode/  # or wherever Tauri stores WebView data — check your platform
```

Alternative: open devtools in the running app, run `localStorage.clear()`, then restart the app from the command line.

Expected on boot:
- Initial render uses defaults (because localStorage was empty).
- Within ~50ms, settings hydrate from SQLite: theme, sidebar widths, etc. snap to the values stored in SQLite.
- A brief flash of defaults is acceptable — this is the documented Case 3 behavior.

- [ ] **Step 6: Test Case 2 (steady state)**

Pre-condition: both SQLite and localStorage populated with identical data from Step 4.

```bash
npm run tauri:dev
```

Expected:
- No visible behavior change from before — instant render from localStorage, async reconcile is a no-op.
- Devtools console shows no errors.
- Toggle theme → confirm: `sqlite3 ~/.config/AbeonCode/abeoncode.db "SELECT value FROM settings WHERE key='theme';"` returns the new theme.

- [ ] **Step 7: Test diff-based save (regression check)**

Run the app, open devtools.

In the React/Zustand devtools (or by adding a temporary log to the subscribe handler), confirm that:
- Toggling only the theme triggers exactly **one** `setSetting('theme', ...)` invoke.
- It does NOT trigger setSetting for the 8 other persisted keys.

A quick way to verify: temporarily wrap the `for (const key of changed)` loop with `console.log('[settings] writing', changed)` and observe in devtools.

- [ ] **Step 8: Commit**

```bash
git add src/store/index.ts
git commit -m "feat(store): hydrate settings from SQLite with reconcile + one-time migration"
```

---

## Task 7: Manual end-to-end verification

**Goal:** confirm the full spec is met by running through every scenario from Section 9 of the spec one final time.

- [ ] **Step 1: Fresh install scenario**

```bash
rm -f ~/.config/AbeonCode/abeoncode.db
# Wipe Tauri WebView storage (path depends on OS; on Linux usually under ~/.local/share/AbeonCode/)
rm -rf ~/.local/share/AbeonCode/
npm run tauri:dev
```

Expected: app starts with all defaults (dark theme, default model, leftWidth=260, rightWidth=300, etc.).

- [ ] **Step 2: Migration scenario**

Pre-condition: a previous-version build's localStorage data exists. To simulate:
1. Open app from Step 1 (fresh).
2. Change theme to `light`, displayName to `test`, set a custom projects base path.
3. Quit app.
4. Wipe only SQLite to simulate "old user, no migration yet":

   ```bash
   sqlite3 ~/.config/AbeonCode/abeoncode.db "DELETE FROM settings;"
   ```

5. Restart app.

Expected:
- App opens with `light` theme, `test` displayName, custom base path (preserved via localStorage).
- After mount, SQLite gets populated:

   ```bash
   sqlite3 ~/.config/AbeonCode/abeoncode.db "SELECT key, value FROM settings ORDER BY key;"
   ```

   Includes `migrated_v2=1` plus the three changed values.

- [ ] **Step 3: Persistence-across-restart scenario**

1. With migrated state from Step 2, change `theme` back to `dark`.
2. Quit app.
3. Verify SQLite write:

   ```bash
   sqlite3 ~/.config/AbeonCode/abeoncode.db "SELECT value FROM settings WHERE key='theme';"
   ```

   Expected: `dark`.
4. Restart app.

Expected: theme is `dark` immediately on launch (from localStorage cache, then confirmed by reconcile no-op).

- [ ] **Step 4: Recovery scenario (cleared localStorage)**

1. With state from Step 3, clear localStorage (devtools → `localStorage.clear()` then restart, or wipe Tauri WebView data dir).
2. Restart app.

Expected: initial paint with defaults; within ~50ms settings hydrate from SQLite (theme=dark, displayName=test, etc.).

- [ ] **Step 5: Diff-save regression check**

1. Open the app from Step 4 state.
2. Open devtools console.
3. Temporarily add `console.log('changed:', changed)` inside the subscribe handler in `src/store/index.ts` (line ~end of file).
4. In the running app, toggle theme.
5. Confirm: console logs `changed: ['theme']` — exactly one key.
6. **Revert the temporary log line before committing anything further.**

- [ ] **Step 6: Failure mode (SQLite locked)**

1. Open two SQLite connections holding a write lock (one quick way: `sqlite3 ~/.config/AbeonCode/abeoncode.db` and run `BEGIN EXCLUSIVE;`).
2. In the running app, change theme.

Expected:
- App UI shows the new theme (state + localStorage updated).
- Devtools console logs `[settings] setSetting failed theme ...`.
- App does NOT crash, no error toast (intentional — spec section 2).
- Release the SQLite lock (`COMMIT;` or quit the sqlite3 process). On next setting change, writes succeed again.

- [ ] **Step 7: Final commit (if anything was touched)**

If the manual scenarios required no code changes, this task ends here. If a bug was found in Tasks 4-6, fix it and commit with:

```bash
git add src/store/index.ts  # or whichever files
git commit -m "fix(store): <describe the bug uncovered during manual verification>"
```

---

## Self-Review Notes

Run through the spec one more time against the plan:

- **Sec 1 (Cel):** ✓ Tasks 1-6 implement the dual-write architecture; Task 7 confirms no functional change.
- **Sec 2 (Decyzje):** ✓ Each row maps to specific task steps: SQLite repo (T1), localStorage cache (T4 retains current behavior), schema (T1), save strategy (T5 diff-based), migration (T6 Case 1), backend reads (commands generic per T2), error handling (T5+T6 use `console.error` + fire-and-forget).
- **Sec 3 (Architektura):** ✓ Task 1 = backend repo, Task 2 = commands, Task 4-6 = frontend store rewrite in 3 steps.
- **Sec 4 (Reconciliation):** ✓ All 4 cases handled in `hydrateFromSqlite()` (Task 6).
- **Sec 5 (Save flow):** ✓ Task 5 implements the subscribe with diff.
- **Sec 6 (Files):** ✓ Every listed file has a task that creates or modifies it.
- **Sec 7 (Serializacja):** ✓ `serializeValue` / `deserializeValue` in Task 4 cover all 7 field types.
- **Sec 8 (Edge cases):** ✓ All handled or explicitly out-of-scope; SQLite locked test is in Task 7.
- **Sec 9 (Testy):** ✓ Backend tests (T1), manual scenarios (T6+T7).
- **Sec 10 (Out of scope):** Plan correctly does not include cleanup of localStorage, backend reads, typed registry, multi-window sync, atomic multi-key tx, reset UI.
- **Sec 11 (Spec B wpływ):** Spec B will land after this plan is merged; not in scope here.

No placeholders. No "TBD". Code blocks are complete and executable. Type names consistent (`Persisted`, `PersistedKey`, `PERSISTED_KEYS`) across tasks.
