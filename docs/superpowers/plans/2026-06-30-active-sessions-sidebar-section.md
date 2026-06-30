# Active Sessions Sidebar Section Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a sidebar section above the projects list that surfaces sessions which are running or waiting for the user across all projects, toggleable in Settings.

**Architecture:** A new Tauri command `list_active_sessions` scans every project's recent sessions (Claude + Codex), keeps non-idle ones, and returns lightweight `ActiveSession` rows. The frontend stores them in `sessionsSlice`, refreshes them on the existing activity-poll cadence, merges them with the in-memory `attentionSessions` set, and renders a collapsible `ActiveSessionsPanel` in the sidebar gated by a new `showActiveSessions` setting.

**Tech Stack:** Rust (Tauri 2, r2d2/SQLite, ts-rs), React 19 + TypeScript, Zustand 5, Vitest + jsdom, cargo tests.

## Global Constraints

- Identifiers in English only; user-facing UI text in Polish.
- No code comments unless WHY is non-obvious; match surrounding style.
- Every Rust command has a matching wrapper in `src/lib/tauri.ts`; components never call `invoke` directly.
- Types crossing IPC are defined in Rust with `#[derive(TS)]`, `#[serde(rename_all = "camelCase")]`, `#[ts(export, export_to = "../../src/types/")]`; regenerate with `cargo test` (NOT `cargo build`).
- Zustand array/object selectors must use `useShallow` (or `useMemo`) to avoid infinite re-renders.
- Commits: Conventional Commits 1.0.0, scope `desktop`/`sidebar`/`settings` where useful; NO co-author trailer.
- Lint must be clean: `npm run lint` (= `tsc -b --noEmit`) reports zero errors.
- Run frontend tests with `npm test`; Rust tests with `npm run test:rust` (run npm/cargo from `DesktopApp/`).

---

### Task 1: Extract `list_project_sessions` helper (backend refactor)

Pure refactor: pull the Claude+Codex listing+title-merge body out of `list_sessions` into a reusable helper, so Task 3 can reuse it. No behavior change — verified by the existing test suite.

**Files:**
- Modify: `DesktopApp/src-tauri/src/commands/sessions.rs` (the `list_sessions` command, ~lines 39–62)

**Interfaces:**
- Produces: `fn list_project_sessions(c: &r2d2::PooledConnection<r2d2_sqlite::SqliteConnectionManager>, proj: &Project, window: usize) -> AppResult<Vec<SessionMeta>>` — returns the top-`window` merged Claude+Codex sessions for one project, titles applied, sorted by `last_modified` desc.

- [ ] **Step 1: Add the helper and rewrite `list_sessions` to call it**

Replace the existing `list_sessions` function body with:

```rust
fn list_project_sessions(
    c: &r2d2::PooledConnection<r2d2_sqlite::SqliteConnectionManager>,
    proj: &Project,
    window: usize,
) -> AppResult<Vec<SessionMeta>> {
    let dir = session_dir(proj)?;
    let project_id = proj.id;
    let claude = catch(move || reader::list_sessions(project_id, &dir, window, 0))?;
    let codex_dir = codex::reader::codex_root()?;
    let proj_path = proj.path.clone();
    let codex_list = catch(move || Ok(codex::reader::list_for_cwd(&codex_dir, &proj_path, project_id, window)))?;
    let mut sessions = merge_session_lists(claude, codex_list, window, 0);
    let titles = session_titles_repo::get_all(c, project_id);
    for s in &mut sessions {
        if let Some(t) = titles.get(&s.id) {
            s.title = t.clone();
        }
    }
    Ok(sessions)
}

#[tauri::command]
pub fn list_sessions(
    state: State<AppState>,
    project_id: i64,
    limit: usize,
    offset: usize,
) -> AppResult<Vec<SessionMeta>> {
    let c = state.db.get()?;
    let proj = projects_repo::get(&c, project_id)?;
    let window = offset + limit;
    let sessions = list_project_sessions(&c, &proj, window)?;
    Ok(sessions.into_iter().skip(offset).take(limit).collect())
}
```

- [ ] **Step 2: Run the backend tests to verify nothing broke**

Run (from `DesktopApp/`): `npm run test:rust`
Expected: PASS — all existing tests in `commands/sessions.rs` (incl. `merge_tests`, `roster_tests`) green.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/commands/sessions.rs
git commit -m "refactor(desktop): extract list_project_sessions from list_sessions"
```

---

### Task 2: `ActiveSession` type + `active_from_metas` filter (backend)

Define the IPC payload type and a pure, unit-testable function that turns a project's session metas into active-session rows (drops idle, keeps both providers).

**Files:**
- Modify: `DesktopApp/src-tauri/src/domain/session.rs` (add struct after `SessionMeta`)
- Modify: `DesktopApp/src-tauri/src/commands/sessions.rs` (top `use`, add fn + test module)
- Generated: `DesktopApp/src/types/ActiveSession.ts`

**Interfaces:**
- Produces: `pub struct ActiveSession { session_id: String, project_id: i64, project_name: String, title: String, activity: SessionActivity, last_modified: i64, provider: Provider }` (re-exported via `domain::session::*`).
- Produces: `fn active_from_metas(project_id: i64, project_name: &str, sessions: Vec<SessionMeta>) -> Vec<ActiveSession>`.

- [ ] **Step 1: Write the failing test**

Append to `DesktopApp/src-tauri/src/commands/sessions.rs`:

```rust
#[cfg(test)]
mod active_tests {
    use super::*;
    use crate::domain::{Provider, SessionActivity, SessionMeta};

    fn meta(id: &str, provider: Provider, activity: SessionActivity) -> SessionMeta {
        SessionMeta {
            id: id.into(), project_id: 7, title: format!("title-{id}"), message_count: 1,
            last_modified: 100, git_branch: None, cwd: None, activity, provider,
        }
    }

    #[test]
    fn active_from_metas_drops_idle_keeps_both_providers() {
        let metas = vec![
            meta("a", Provider::Claude, SessionActivity::Running),
            meta("b", Provider::Codex, SessionActivity::WaitingUser),
            meta("c", Provider::Claude, SessionActivity::Idle),
            meta("d", Provider::Codex, SessionActivity::WaitingTool),
        ];
        let rows = active_from_metas(7, "Proj", metas);
        let ids: Vec<&str> = rows.iter().map(|r| r.session_id.as_str()).collect();
        assert_eq!(ids, vec!["a", "b", "d"]);
        assert!(rows.iter().all(|r| r.project_id == 7 && r.project_name == "Proj"));
        assert_eq!(rows[1].provider, Provider::Codex);
        assert_eq!(rows[0].title, "title-a");
    }
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd src-tauri && cargo test active_from_metas_drops_idle_keeps_both_providers 2>&1 | tail -20`
Expected: FAIL to compile — `cannot find function active_from_metas` / `cannot find type ActiveSession`.

- [ ] **Step 3: Add the `ActiveSession` struct**

In `DesktopApp/src-tauri/src/domain/session.rs`, add immediately after the `SessionMeta` struct:

```rust
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/types/")]
#[serde(rename_all = "camelCase")]
pub struct ActiveSession {
    pub session_id: String,
    #[ts(type = "number")]
    pub project_id: i64,
    pub project_name: String,
    pub title: String,
    pub activity: SessionActivity,
    #[ts(type = "number")]
    pub last_modified: i64,
    pub provider: Provider,
}
```

- [ ] **Step 4: Add the filter function and import**

In `DesktopApp/src-tauri/src/commands/sessions.rs`, change the domain import line:

```rust
use crate::domain::{Project, Provider, SessionMeta, SessionHistory, SessionActivity, ActiveSession};
```

Then add the function near `merge_session_lists`:

```rust
fn active_from_metas(project_id: i64, project_name: &str, sessions: Vec<SessionMeta>) -> Vec<ActiveSession> {
    sessions
        .into_iter()
        .filter(|s| s.activity != SessionActivity::Idle)
        .map(|s| ActiveSession {
            session_id: s.id,
            project_id,
            project_name: project_name.to_string(),
            title: s.title,
            activity: s.activity,
            last_modified: s.last_modified,
            provider: s.provider,
        })
        .collect()
}
```

- [ ] **Step 5: Run the test (also generates the TS type)**

Run (from `DesktopApp/`): `npm run test:rust`
Expected: PASS, including `active_from_metas_drops_idle_keeps_both_providers`.

- [ ] **Step 6: Verify the generated TS type exists**

Run (from `DesktopApp/`): `cat src/types/ActiveSession.ts`
Expected: a generated `export type ActiveSession = { sessionId: string, projectId: number, projectName: string, title: string, activity: SessionActivity, lastModified: number, provider: Provider, };`

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/domain/session.rs src-tauri/src/commands/sessions.rs src/types/ActiveSession.ts
git commit -m "feat(desktop): add ActiveSession type and active_from_metas filter"
```

---

### Task 3: `list_active_sessions` command (backend)

Wire the per-project scan into a testable snapshot function plus the Tauri command, and register it.

**Files:**
- Modify: `DesktopApp/src-tauri/src/commands/sessions.rs` (add const, snapshot fn, command, test)
- Modify: `DesktopApp/src-tauri/src/lib.rs` (register command)

**Interfaces:**
- Consumes: `list_project_sessions` (Task 1), `active_from_metas` + `ActiveSession` (Task 2).
- Produces: command `list_active_sessions(state) -> AppResult<Vec<ActiveSession>>`; helper `active_sessions_snapshot(c) -> AppResult<Vec<ActiveSession>>`.

- [ ] **Step 1: Write the failing test**

Add a test to the existing `roster_tests` module in `DesktopApp/src-tauri/src/commands/sessions.rs` (it already has the `pool()` helper):

```rust
    #[test]
    fn active_sessions_snapshot_empty_db_is_empty() {
        let p = pool();
        let c = p.get().unwrap();
        assert!(active_sessions_snapshot(&c).unwrap().is_empty());
    }
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd src-tauri && cargo test active_sessions_snapshot_empty_db_is_empty 2>&1 | tail -20`
Expected: FAIL to compile — `cannot find function active_sessions_snapshot`.

- [ ] **Step 3: Add the const, snapshot fn, and command**

In `DesktopApp/src-tauri/src/commands/sessions.rs`, near the `ROSTER_SESSIONS_PER_PROJECT` const add:

```rust
const ACTIVE_SCAN_WINDOW: usize = 30;
```

Then add (e.g. just after `roster_snapshot`):

```rust
pub fn active_sessions_snapshot(
    c: &r2d2::PooledConnection<r2d2_sqlite::SqliteConnectionManager>,
) -> AppResult<Vec<ActiveSession>> {
    let mut out = Vec::new();
    for proj in projects_repo::list(c)? {
        let sessions = match list_project_sessions(c, &proj, ACTIVE_SCAN_WINDOW) {
            Ok(s) => s,
            Err(_) => continue,
        };
        out.extend(active_from_metas(proj.id, &proj.name, sessions));
    }
    Ok(out)
}

#[tauri::command]
pub fn list_active_sessions(state: State<AppState>) -> AppResult<Vec<ActiveSession>> {
    let c = state.db.get()?;
    active_sessions_snapshot(&c)
}
```

- [ ] **Step 4: Register the command in `lib.rs`**

In `DesktopApp/src-tauri/src/lib.rs`, inside `tauri::generate_handler![...]`, add a line right after `commands::sessions::list_sessions,`:

```rust
            commands::sessions::list_active_sessions,
```

- [ ] **Step 5: Run backend tests**

Run (from `DesktopApp/`): `npm run test:rust`
Expected: PASS, including `active_sessions_snapshot_empty_db_is_empty`.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/commands/sessions.rs src-tauri/src/lib.rs
git commit -m "feat(desktop): add list_active_sessions command"
```

---

### Task 4: `listActiveSessions` IPC wrapper (frontend)

**Files:**
- Modify: `DesktopApp/src/lib/tauri.ts` (type import + wrapper)

**Interfaces:**
- Consumes: command `list_active_sessions`, type `ActiveSession`.
- Produces: `tauri.listActiveSessions(): Promise<ActiveSession[]>`.

- [ ] **Step 1: Add `ActiveSession` to the type import**

In `DesktopApp/src/lib/tauri.ts`, add `ActiveSession` to the existing `import type { ... } from '../types';` line (insert after `SessionMeta`):

```ts
import type { Project, SessionMeta, ActiveSession, SessionActivity, SessionHistory, HistoryBlock, Action, ActionInput, ActionPatch, DetectedScript, GitStatus, GitUser, ShellInfo, EditorInfo, DiffResult, UsageSummary, DetectedModel, Provider, ProviderInfo } from '../types';
```

- [ ] **Step 2: Add the wrapper**

In `DesktopApp/src/lib/tauri.ts`, add directly below the `getProjectsActivity` wrapper:

```ts
  listActiveSessions: () => invoke<ActiveSession[]>('list_active_sessions'),
```

- [ ] **Step 3: Verify types compile**

Run (from `DesktopApp/`): `npm run lint`
Expected: zero errors.

- [ ] **Step 4: Commit**

```bash
git add src/lib/tauri.ts
git commit -m "feat(desktop): add listActiveSessions IPC wrapper"
```

---

### Task 5: `showActiveSessions` setting + persistence

**Files:**
- Modify: `DesktopApp/src/store/settingsSlice.ts` (type, default, setter)
- Modify: `DesktopApp/src/store/index.ts` (Persisted type, PERSISTED_KEYS, pick, serialize, deserialize, apply)
- Test: `DesktopApp/src/store/settingsSlice.test.ts`

**Interfaces:**
- Produces: state `showActiveSessions: boolean` (default `true`); action `setShowActiveSessions(v: boolean): void`.

- [ ] **Step 1: Write the failing test**

Append to `DesktopApp/src/store/settingsSlice.test.ts`:

```ts
describe('settingsSlice showActiveSessions', () => {
  beforeEach(() => { useStore.setState({ showActiveSessions: true }); });

  it('defaults to true and toggles via setter', () => {
    expect(useStore.getState().showActiveSessions).toBe(true);
    useStore.getState().setShowActiveSessions(false);
    expect(useStore.getState().showActiveSessions).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run (from `DesktopApp/`): `npm test -- settingsSlice`
Expected: FAIL — `setShowActiveSessions is not a function`.

- [ ] **Step 3: Add to the slice type**

In `DesktopApp/src/store/settingsSlice.ts`, add to the `SettingsSlice` type (near `notificationTrigger`):

```ts
  showActiveSessions: boolean;
```

and to the actions section (near `setNotificationTrigger`):

```ts
  setShowActiveSessions: (v: boolean) => void;
```

- [ ] **Step 4: Add default + setter to the slice creator**

In the `createSettingsSlice` object, add the default (near `notificationTrigger: 'both',`):

```ts
  showActiveSessions: true,
```

and the setter (near `setNotificationTrigger`):

```ts
  setShowActiveSessions: (showActiveSessions) => set({ showActiveSessions }),
```

- [ ] **Step 5: Wire persistence in `index.ts`**

In `DesktopApp/src/store/index.ts` make five edits:

5a. In the `Persisted` type (near `notificationTrigger?`):

```ts
  showActiveSessions?: boolean;
```

5b. In `PERSISTED_KEYS` (after `'notificationTrigger',`):

```ts
  'showActiveSessions',
```

5c. In `pickPersistedFields` return object (after `notificationTrigger: state.notificationTrigger,`):

```ts
    showActiveSessions: state.showActiveSessions,
```

5d. In `serializeValue`, add to the boolean case list (with `notificationsEnabled`):

```ts
    case 'notificationsEnabled':
    case 'showActiveSessions':
      return value ? 'true' : 'false';
```

and the same addition in `deserializeValue`:

```ts
    case 'notificationsEnabled':
    case 'showActiveSessions':
      return raw === 'true';
```

5e. In `applyPersistedToState` (after the `notificationsEnabled` line):

```ts
  if (p.showActiveSessions !== undefined) patch.showActiveSessions = p.showActiveSessions;
```

- [ ] **Step 6: Run the test**

Run (from `DesktopApp/`): `npm test -- settingsSlice`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/store/settingsSlice.ts src/store/index.ts src/store/settingsSlice.test.ts
git commit -m "feat(settings): add showActiveSessions persisted setting"
```

---

### Task 6: `activeSessions` state + `refreshActiveSessions` + poll wiring

**Files:**
- Modify: `DesktopApp/src/store/sessionsSlice.ts` (type, default, action, poll tick)
- Test: `DesktopApp/src/store/sessionsSlice.test.ts`

**Interfaces:**
- Consumes: `tauri.listActiveSessions()` (Task 4), `ActiveSession` (Task 2).
- Produces: state `activeSessions: ActiveSession[]` (default `[]`); action `refreshActiveSessions(): Promise<void>`.

- [ ] **Step 1: Write the failing test**

Append to `DesktopApp/src/store/sessionsSlice.test.ts`:

```ts
describe('sessionsSlice activeSessions', () => {
  beforeEach(() => { useStore.setState({ activeSessions: [] }); });

  it('refreshActiveSessions stores the fetched rows', async () => {
    const rows = [{
      sessionId: 'a', projectId: 1, projectName: 'P', title: 'T',
      activity: 'running' as const, lastModified: 5, provider: 'claude' as const,
    }];
    const spy = vi.spyOn(tauri, 'listActiveSessions').mockResolvedValue(rows);
    await useStore.getState().refreshActiveSessions();
    expect(useStore.getState().activeSessions).toEqual(rows);
    spy.mockRestore();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run (from `DesktopApp/`): `npm test -- sessionsSlice`
Expected: FAIL — `refreshActiveSessions is not a function`.

- [ ] **Step 3: Add the type members**

In `DesktopApp/src/store/sessionsSlice.ts`, change the type import to include `ActiveSession`:

```ts
import type { SessionActivity, SessionMeta, ActiveSession } from '../types';
```

and add to the `SessionsSlice` type (near `refreshActivity`):

```ts
  activeSessions: ActiveSession[];
  refreshActiveSessions: () => Promise<void>;
```

- [ ] **Step 4: Add the default + action**

In `createSessionsSlice`, add the default (near `attentionSessions: new Set...`):

```ts
  activeSessions: [],
```

and the action (near `refreshActivity`):

```ts
  refreshActiveSessions: async () => {
    try {
      const items = await tauri.listActiveSessions();
      set({ activeSessions: items });
    } catch (err) {
      console.error('[sessions] refreshActiveSessions failed', err);
    }
  },
```

- [ ] **Step 5: Wire into the poll tick**

In `startActivityPolling`, inside the `tick` function (after the `loadActivity()` call):

```ts
      (get() as AppState).loadActivity().catch(() => {});
      get().refreshActiveSessions().catch(() => {});
```

- [ ] **Step 6: Run the test**

Run (from `DesktopApp/`): `npm test -- sessionsSlice`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/store/sessionsSlice.ts src/store/sessionsSlice.test.ts
git commit -m "feat(sidebar): track active sessions in store with poll refresh"
```

---

### Task 7: `buildActiveSessionRows` pure logic + tests

Pure function that merges backend active sessions with the attention set, attaches project color, dedupes, and sorts by urgency then recency. Used by the panel via `useMemo` (avoids the `useShallow` fresh-object re-render gotcha).

**Files:**
- Create: `DesktopApp/src/lib/activeSessions.ts`
- Test: `DesktopApp/src/lib/activeSessions.test.ts`

**Interfaces:**
- Consumes: `ActiveSession`, `SessionMeta`, `Project`, `Provider`, `SessionActivity`, `getProjectColor`.
- Produces: type `ActiveSessionRow = { sessionId, projectId, projectName, title, activity, lastModified, provider, color, attention }`; function `buildActiveSessionRows(activeSessions, attentionSessions, sessionsByProject, projects): ActiveSessionRow[]`.

- [ ] **Step 1: Write the failing test**

Create `DesktopApp/src/lib/activeSessions.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildActiveSessionRows } from './activeSessions';
import type { ActiveSession, Project, SessionMeta } from '../types';

function active(id: string, activity: ActiveSession['activity'], lastModified: number): ActiveSession {
  return { sessionId: id, projectId: 1, projectName: 'Proj', title: `T-${id}`, activity, lastModified, provider: 'claude' };
}
function project(id: number, color: string | null): Project {
  return { id, name: `P${id}`, path: `/p${id}`, claudeDir: `d${id}`, color, sortOrder: 0, createdAt: 0 };
}
function sessionMeta(id: string, projectId: number, activity: SessionMeta['activity']): SessionMeta {
  return { id, projectId, title: `S-${id}`, messageCount: 1, lastModified: 9, gitBranch: null, cwd: null, activity, provider: 'codex' };
}

describe('buildActiveSessionRows', () => {
  it('sorts waiting before running, and by recency within a tier', () => {
    const rows = buildActiveSessionRows(
      [active('run-old', 'running', 100), active('wait', 'waitingUser', 50), active('run-new', 'running', 300)],
      new Set(),
      {},
      [project(1, '#abcdef')],
    );
    expect(rows.map(r => r.sessionId)).toEqual(['wait', 'run-new', 'run-old']);
  });

  it('marks attention rows, floats them to the top, and dedupes', () => {
    const rows = buildActiveSessionRows(
      [active('a', 'running', 100)],
      new Set(['a']),
      {},
      [project(1, '#abcdef')],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].attention).toBe(true);
  });

  it('attaches the project color', () => {
    const rows = buildActiveSessionRows([active('a', 'running', 1)], new Set(), {}, [project(1, '#123456')]);
    expect(rows[0].color).toBe('#123456');
  });

  it('includes an attention-only session resolved from sessionsByProject', () => {
    const rows = buildActiveSessionRows(
      [],
      new Set(['z']),
      { 1: { items: [sessionMeta('z', 1, 'idle')], hasMore: false } },
      [project(1, null)],
    );
    expect(rows.map(r => r.sessionId)).toEqual(['z']);
    expect(rows[0].attention).toBe(true);
    expect(rows[0].provider).toBe('codex');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run (from `DesktopApp/`): `npm test -- activeSessions`
Expected: FAIL — cannot resolve `./activeSessions`.

- [ ] **Step 3: Implement the module**

Create `DesktopApp/src/lib/activeSessions.ts`:

```ts
import type { ActiveSession, Project, Provider, SessionActivity, SessionMeta } from '../types';
import { getProjectColor } from './projectColors';

export type ActiveSessionRow = {
  sessionId: string;
  projectId: number;
  projectName: string;
  title: string;
  activity: SessionActivity;
  lastModified: number;
  provider: Provider;
  color: string;
  attention: boolean;
};

type SessionsByProject = Record<number, { items: SessionMeta[]; hasMore: boolean }>;

function urgencyRank(row: ActiveSessionRow): number {
  if (row.attention) return 0;
  if (row.activity === 'waitingUser' || row.activity === 'waitingTool') return 1;
  if (row.activity === 'running') return 2;
  return 3;
}

export function buildActiveSessionRows(
  activeSessions: ActiveSession[],
  attentionSessions: Set<string>,
  sessionsByProject: SessionsByProject,
  projects: Project[],
): ActiveSessionRow[] {
  const projById = new Map(projects.map(p => [p.id, p]));
  const colorFor = (projectId: number) => {
    const p = projById.get(projectId);
    return p ? getProjectColor(p) : getProjectColor({ id: projectId, color: null });
  };
  const byId = new Map<string, ActiveSessionRow>();

  for (const s of activeSessions) {
    byId.set(s.sessionId, {
      sessionId: s.sessionId,
      projectId: s.projectId,
      projectName: s.projectName,
      title: s.title,
      activity: s.activity,
      lastModified: s.lastModified,
      provider: s.provider,
      color: colorFor(s.projectId),
      attention: attentionSessions.has(s.sessionId),
    });
  }

  for (const id of attentionSessions) {
    if (byId.has(id)) continue;
    for (const bucket of Object.values(sessionsByProject)) {
      const found = bucket.items.find(x => x.id === id);
      if (!found) continue;
      byId.set(id, {
        sessionId: found.id,
        projectId: found.projectId,
        projectName: projById.get(found.projectId)?.name ?? '',
        title: found.title,
        activity: found.activity,
        lastModified: found.lastModified,
        provider: found.provider,
        color: colorFor(found.projectId),
        attention: true,
      });
      break;
    }
  }

  return [...byId.values()].sort(
    (a, b) => urgencyRank(a) - urgencyRank(b) || b.lastModified - a.lastModified,
  );
}
```

- [ ] **Step 4: Run the test**

Run (from `DesktopApp/`): `npm test -- activeSessions`
Expected: PASS (all four cases).

- [ ] **Step 5: Commit**

```bash
git add src/lib/activeSessions.ts src/lib/activeSessions.test.ts
git commit -m "feat(sidebar): add buildActiveSessionRows merge+sort logic"
```

---

### Task 8: `ActiveSessionsPanel` component + visibility tests

**Files:**
- Create: `DesktopApp/src/components/sidebar/ActiveSessionsPanel.tsx`
- Test: `DesktopApp/src/components/sidebar/ActiveSessionsPanel.test.tsx`

**Interfaces:**
- Consumes: `buildActiveSessionRows`, `ActiveSessionRow` (Task 7); store fields `showActiveSessions`, `activeSessions`, `attentionSessions`, `sessionsByProject`, `projects`, `openSessionTab`, `clearAttention`.
- Produces: `ActiveSessionsPanel` (default-less named export) — renders `null` when disabled or empty.

- [ ] **Step 1: Write the failing test**

Create `DesktopApp/src/components/sidebar/ActiveSessionsPanel.test.tsx`:

```tsx
import { describe, it, expect, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { ActiveSessionsPanel } from './ActiveSessionsPanel';
import { useStore } from '../../store';
import type { ActiveSession, Project } from '../../types';

function active(id: string): ActiveSession {
  return { sessionId: id, projectId: 1, projectName: 'Proj', title: `T-${id}`, activity: 'running', lastModified: 1, provider: 'claude' };
}
function project(): Project {
  return { id: 1, name: 'Proj', path: '/p', claudeDir: 'd', color: null, sortOrder: 0, createdAt: 0 };
}

describe('ActiveSessionsPanel visibility', () => {
  beforeEach(() => {
    useStore.setState({
      showActiveSessions: true, activeSessions: [], attentionSessions: new Set(),
      sessionsByProject: {}, projects: [project()],
    });
  });

  it('renders nothing when there are no active sessions', () => {
    const { container } = render(<ActiveSessionsPanel />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when showActiveSessions is false', () => {
    useStore.setState({ showActiveSessions: false, activeSessions: [active('a')] });
    const { container } = render(<ActiveSessionsPanel />);
    expect(container.firstChild).toBeNull();
  });

  it('renders the header with a count when there is an active session', () => {
    useStore.setState({ activeSessions: [active('a')] });
    const { getByText } = render(<ActiveSessionsPanel />);
    expect(getByText('Aktywne')).toBeTruthy();
    expect(getByText('1')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run (from `DesktopApp/`): `npm test -- ActiveSessionsPanel`
Expected: FAIL — cannot resolve `./ActiveSessionsPanel`.

- [ ] **Step 3: Implement the component**

Create `DesktopApp/src/components/sidebar/ActiveSessionsPanel.tsx`:

```tsx
import { useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../../store';
import { buildActiveSessionRows, type ActiveSessionRow } from '../../lib/activeSessions';
import { ACTIVITY_TEXT, ACTIVITY_LABEL } from '../../lib/activity';
import { PROVIDER_ICON } from '../../lib/providers';
import { formatRelative } from '../../lib/format';
import { Icon } from '../shared/Icon';

export function ActiveSessionsPanel() {
  const showActiveSessions = useStore(s => s.showActiveSessions);
  const activeSessions = useStore(useShallow(s => s.activeSessions));
  const attentionSessions = useStore(s => s.attentionSessions);
  const sessionsByProject = useStore(s => s.sessionsByProject);
  const projects = useStore(useShallow(s => s.projects));
  const openTab = useStore(s => s.openSessionTab);
  const clearAttention = useStore(s => s.clearAttention);
  const [collapsed, setCollapsed] = useState(false);

  const rows = useMemo(
    () => buildActiveSessionRows(activeSessions, attentionSessions, sessionsByProject, projects),
    [activeSessions, attentionSessions, sessionsByProject, projects],
  );

  if (!showActiveSessions || rows.length === 0) return null;

  return (
    <div className="mt-3">
      <button
        onClick={() => setCollapsed(c => !c)}
        className="w-full flex items-center justify-between text-[10px] tracking-[0.14em] uppercase text-muted font-medium px-1"
      >
        <span className="flex items-center gap-1.5">
          <Icon name="chevR" className={`w-2.5 h-2.5 transition-transform ${collapsed ? '' : 'rotate-90'}`} strokeWidth={2.5} />
          Aktywne
        </span>
        <span className="font-mono tabular-nums">{rows.length}</span>
      </button>
      {!collapsed && (
        <ul className="mt-1 space-y-0.5 max-h-48 overflow-y-auto scroll-thin">
          {rows.map(row => (
            <ActiveSessionRowItem
              key={row.sessionId}
              row={row}
              onClick={() => { openTab(row.projectId, row.sessionId, row.title, row.provider); clearAttention(row.sessionId); }}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function ActiveSessionRowItem({ row, onClick }: { row: ActiveSessionRow; onClick: () => void }) {
  return (
    <li
      onClick={onClick}
      className="pr-2 py-1 pl-1 text-[12px] cursor-pointer flex items-center gap-2 text-fg hover:bg-bg-elev rounded"
      title={`${row.projectName} — ${ACTIVITY_LABEL[row.activity]}`}
    >
      <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: row.color }} />
      {row.attention ? (
        <span className="shrink-0 inline-flex" title="Czeka na Twoją odpowiedź">
          <Icon name="bell" className="w-3 h-3 text-accent" aria-label="Czeka na Twoją odpowiedź" />
        </span>
      ) : (
        <span className="shrink-0 inline-flex" title={ACTIVITY_LABEL[row.activity]}>
          <Icon name={PROVIDER_ICON[row.provider]} className={`w-3 h-3 ${ACTIVITY_TEXT[row.activity]}`} strokeWidth={2.5} />
        </span>
      )}
      <span className="truncate flex-1 min-w-0">{row.title}</span>
      <span className="text-[10px] text-muted truncate max-w-[72px] shrink-0">{row.projectName}</span>
      <span className="font-mono text-[10px] text-muted shrink-0">{formatRelative(row.lastModified)}</span>
    </li>
  );
}
```

- [ ] **Step 4: Run the test**

Run (from `DesktopApp/`): `npm test -- ActiveSessionsPanel`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/sidebar/ActiveSessionsPanel.tsx src/components/sidebar/ActiveSessionsPanel.test.tsx
git commit -m "feat(sidebar): add ActiveSessionsPanel component"
```

---

### Task 9: Render the panel in the sidebar + refresh on focus

**Files:**
- Modify: `DesktopApp/src/components/sidebar/Sidebar.tsx`

**Interfaces:**
- Consumes: `ActiveSessionsPanel` (Task 8), `refreshActiveSessions` (Task 6).

- [ ] **Step 1: Import the panel and the refresh action**

In `DesktopApp/src/components/sidebar/Sidebar.tsx`, add the import (near the other sidebar imports):

```ts
import { ActiveSessionsPanel } from './ActiveSessionsPanel';
```

and add a selector near `const loadActivity = useStore(s => s.loadActivity);`:

```ts
  const refreshActiveSessions = useStore(s => s.refreshActiveSessions);
```

- [ ] **Step 2: Refresh active sessions on mount + focus**

Replace the existing activity effect body so both calls fire together:

```ts
  useEffect(() => {
    loadActivity();
    refreshActiveSessions();
    let unlisten: (() => void) | null = null;
    const win = getCurrentWebviewWindow();
    win.onFocusChanged(({ payload: focused }) => {
      if (focused) { loadActivity(); refreshActiveSessions(); }
    }).then(fn => { unlisten = fn; });
    return () => { if (unlisten) unlisten(); };
  }, [loadActivity, refreshActiveSessions]);
```

- [ ] **Step 3: Render the panel between search and the projects list**

In the returned JSX, insert `<ActiveSessionsPanel />` between the search `<div>` (the one containing the input) and the projects `<ul className="mt-3 ...">`:

```tsx
      </div>

      <ActiveSessionsPanel />

      <ul className="mt-3 space-y-0.5 overflow-y-auto scroll-thin flex-1 pb-3">
```

- [ ] **Step 4: Verify lint + full test suite**

Run (from `DesktopApp/`): `npm run lint && npm test`
Expected: zero lint errors; all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/components/sidebar/Sidebar.tsx
git commit -m "feat(sidebar): show active sessions panel above projects"
```

---

### Task 10: Settings toggle in the General tab

**Files:**
- Modify: `DesktopApp/src/components/dialogs/SettingsDialog.tsx` (`GeneralTab`)

**Interfaces:**
- Consumes: `showActiveSessions`, `setShowActiveSessions` (Task 5).

- [ ] **Step 1: Read the setting in `GeneralTab`**

In `DesktopApp/src/components/dialogs/SettingsDialog.tsx`, inside `GeneralTab`, add near the other `useStore` selectors:

```ts
  const showActiveSessions = useStore(s => s.showActiveSessions);
  const setShowActiveSessions = useStore(s => s.setShowActiveSessions);
```

- [ ] **Step 2: Add the toggle block**

Insert this block immediately before `<NotificationsSection />` in `GeneralTab`'s returned JSX:

```tsx
      <div className="space-y-2">
        <label className="block text-[10px] text-muted uppercase tracking-wider mb-1">
          Pasek boczny
        </label>
        <label className="flex items-center gap-2 text-[12px] cursor-pointer">
          <input
            type="checkbox"
            checked={showActiveSessions}
            onChange={e => setShowActiveSessions(e.target.checked)}
          />
          Pokaż aktywne sesje nad projektami
        </label>
      </div>
```

- [ ] **Step 3: Verify lint**

Run (from `DesktopApp/`): `npm run lint`
Expected: zero errors.

- [ ] **Step 4: Manual smoke check (optional but recommended)**

Run (from `DesktopApp/`): `npm run tauri dev`
Expected: With a running/waiting session, an "Aktywne" section appears above the projects list; toggling the new setting in Ustawienia → Ogólne hides/shows it; clicking a row opens the session tab.

- [ ] **Step 5: Commit**

```bash
git add src/components/dialogs/SettingsDialog.tsx
git commit -m "feat(settings): toggle for active sessions sidebar section"
```

---

## Self-Review

**Spec coverage:**
- Inclusion criteria (running + waiting + attention) → Task 2 (`active_from_metas` keeps non-idle) + Task 7 (`buildActiveSessionRows` merges `attentionSessions`, ranks bell first).
- All projects, both providers → Task 1/3 (`list_project_sessions` merges Claude+Codex per project; `active_sessions_snapshot` iterates all projects).
- Refresh on poll + focus → Task 6 (poll tick) + Task 9 (mount + focus).
- Setting, default on, General tab → Task 5 (persisted default `true`) + Task 10 (toggle).
- Flat list, project color per row, urgency sort → Task 7 (sort + color) + Task 8 (row with color dot + project name).
- Empty/disabled → hidden → Task 8 (`return null`) covered by tests.
- Resilience (skip broken project) → Task 3 (`Err(_) => continue`).
- Tests: Rust filter + empty-db (Tasks 2,3); frontend logic + visibility (Tasks 7,8); slice tests (Tasks 5,6).

**Placeholder scan:** No TBD/TODO; every code step contains full code and exact commands.

**Type consistency:** `ActiveSession` fields match across Rust struct (Task 2), generated TS (Task 2/4), and `buildActiveSessionRows` consumption (Task 7). `list_project_sessions`, `active_from_metas`, `active_sessions_snapshot`, `list_active_sessions`, `refreshActiveSessions`, `showActiveSessions`/`setShowActiveSessions`, `buildActiveSessionRows`/`ActiveSessionRow`, `ActiveSessionsPanel` names are used identically wherever referenced.
