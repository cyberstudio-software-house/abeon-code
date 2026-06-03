# Detached Session Window Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a tab context menu whose "Otwórz w nowym oknie" action moves a session into a separate OS window that shows only the session thread + right panel (Actions/Git/Usage), no sidebar, with the existing TitleBar.

**Architecture:** A second Tauri `WebviewWindow` loads the same `index.html` with URL query params identifying the session. `App.tsx` and the store boot branch on a parsed "window mode": in session mode they render `DetachedSessionShell` (TitleBar + `TabContent` + `RightPanel`) and seed the store with exactly one active session tab, skipping tab restore/persistence. The detached window resumes the session as a live terminal; closing the window ends the session (with the existing ConfirmDialog guard). No new Rust code — only a capability JSON change.

**Tech Stack:** Tauri 2 (`@tauri-apps/api/webviewWindow`), React 19, Zustand 5, Vitest + jsdom + @testing-library/react, Tailwind 4.

---

## File Structure

**New files:**
- `src/lib/windowMode.ts` — pure: `parseWindowMode`, `buildSessionWindowUrl`, `sessionWindowLabel`, `WindowMode` type.
- `src/lib/windowMode.test.ts` — unit tests for the above.
- `src/lib/tabProcess.ts` — pure: `isTabLiveProcess(tab, runningActions)`.
- `src/lib/tabProcess.test.ts` — unit tests.
- `src/lib/detachSession.ts` — Tauri orchestration: create/focus the session window, then close the source tab.
- `src/components/layout/DragHandle.tsx` — `DragHandle` + `clamp` extracted from `AppShell` for reuse.
- `src/components/center/TabContextMenu.tsx` — presentational right-click menu (3 items).
- `src/components/center/TabContextMenu.test.tsx` — render/callback tests.
- `src/components/layout/DetachedSessionShell.tsx` — the stripped layout for the detached window.

**Modified files:**
- `src/store/tabsSlice.ts` — add exported pure `sessionTabFromMode(mode)`.
- `src/store/index.ts` — boot branch on window mode; suppress persistence in detached window.
- `src/App.tsx` — render `DetachedSessionShell` when in session window mode.
- `src/components/layout/AppShell.tsx` — import shared `DragHandle`/`clamp`.
- `src/components/center/TabBar.tsx` — `onContextMenu`, menu state, wire to detach/rename/close; use `isTabLiveProcess`.
- `src-tauri/capabilities/default.json` — apply capability to `session-*` windows; add window/webview permissions.

---

## Task 1: Extract shared DragHandle + clamp

Reuse the resizer in both `AppShell` and `DetachedSessionShell` without duplicating ~50 lines. Pure refactor, no behavior change.

**Files:**
- Create: `src/components/layout/DragHandle.tsx`
- Modify: `src/components/layout/AppShell.tsx`

- [ ] **Step 1: Create the shared module**

Create `src/components/layout/DragHandle.tsx`:

```tsx
import { useCallback, useEffect, useRef } from 'react';

export function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

type DragHandleProps = {
  onDrag: (deltaX: number) => void;
  ariaLabel: string;
};

export function DragHandle({ onDrag, ariaLabel }: DragHandleProps) {
  const startX = useRef<number | null>(null);
  const onDragRef = useRef(onDrag);
  onDragRef.current = onDrag;
  const handlersRef = useRef<{ move: (e: MouseEvent) => void; up: () => void } | null>(null);

  const detach = useCallback(() => {
    if (handlersRef.current) {
      window.removeEventListener('mousemove', handlersRef.current.move);
      window.removeEventListener('mouseup', handlersRef.current.up);
      handlersRef.current = null;
    }
    startX.current = null;
  }, []);

  useEffect(() => detach, [detach]);

  const onMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    startX.current = e.clientX;
    const move = (ev: MouseEvent) => {
      if (startX.current === null) return;
      const delta = ev.clientX - startX.current;
      startX.current = ev.clientX;
      onDragRef.current(delta);
    };
    const up = () => detach();
    handlersRef.current = { move, up };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={ariaLabel}
      onMouseDown={onMouseDown}
      className="w-px cursor-col-resize bg-border hover:bg-accent transition-colors flex-shrink-0"
    />
  );
}
```

- [ ] **Step 2: Update AppShell to use the shared module**

In `src/components/layout/AppShell.tsx`:

Add to the imports block (after the `formatWindowTitle` import):

```tsx
import { DragHandle, clamp } from './DragHandle';
```

Delete the local `DragHandleProps` type, the local `DragHandle` function (lines ~18–64), and the local `clamp` function (lines ~66–68). Leave `LEFT_MIN/LEFT_MAX/RIGHT_MIN/RIGHT_MAX` constants and the rest untouched.

- [ ] **Step 3: Verify type-check passes**

Run: `npm run lint`
Expected: zero errors.

- [ ] **Step 4: Verify existing tests still pass**

Run: `npx vitest run`
Expected: all pass (no test referenced the local DragHandle).

- [ ] **Step 5: Commit**

```bash
git add src/components/layout/DragHandle.tsx src/components/layout/AppShell.tsx
git commit -m "refactor(desktop): extract shared DragHandle for layout reuse"
```

---

## Task 2: windowMode pure helpers

Single source of truth for parsing/serializing the detached-window URL.

**Files:**
- Create: `src/lib/windowMode.ts`
- Test: `src/lib/windowMode.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/windowMode.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseWindowMode, buildSessionWindowUrl, sessionWindowLabel } from './windowMode';

describe('parseWindowMode', () => {
  it('returns null when no view param', () => {
    expect(parseWindowMode('')).toBeNull();
    expect(parseWindowMode('?foo=bar')).toBeNull();
  });

  it('returns null when required params missing', () => {
    expect(parseWindowMode('?view=session')).toBeNull();
    expect(parseWindowMode('?view=session&projectId=3')).toBeNull();
    expect(parseWindowMode('?view=session&sessionId=abc')).toBeNull();
  });

  it('returns null when projectId is not numeric', () => {
    expect(parseWindowMode('?view=session&projectId=x&sessionId=abc')).toBeNull();
  });

  it('parses a minimal session mode', () => {
    expect(parseWindowMode('?view=session&projectId=3&sessionId=abc&title=Hi&fresh=false')).toEqual({
      view: 'session', projectId: 3, sessionId: 'abc', title: 'Hi', fresh: false,
    });
  });

  it('parses linkedSessionId and fresh=true', () => {
    expect(parseWindowMode('?view=session&projectId=3&sessionId=new-1&linkedSessionId=real-9&title=Hi&fresh=true')).toEqual({
      view: 'session', projectId: 3, sessionId: 'new-1', linkedSessionId: 'real-9', title: 'Hi', fresh: true,
    });
  });

  it('round-trips through buildSessionWindowUrl', () => {
    const url = buildSessionWindowUrl({ projectId: 7, sessionId: 's1', linkedSessionId: 's2', title: 'My session', fresh: false });
    const search = url.slice(url.indexOf('?'));
    expect(parseWindowMode(search)).toEqual({
      view: 'session', projectId: 7, sessionId: 's1', linkedSessionId: 's2', title: 'My session', fresh: false,
    });
  });
});

describe('sessionWindowLabel', () => {
  it('prefixes and sanitizes to a valid Tauri label', () => {
    expect(sessionWindowLabel('abc-123')).toBe('session-abc-123');
    expect(sessionWindowLabel('a/b c.d')).toBe('session-a_b_c_d');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/windowMode.test.ts`
Expected: FAIL — module `./windowMode` not found.

- [ ] **Step 3: Write the implementation**

Create `src/lib/windowMode.ts`:

```ts
export type WindowMode = {
  view: 'session';
  projectId: number;
  sessionId: string;
  linkedSessionId?: string;
  title: string;
  fresh: boolean;
};

export function parseWindowMode(search: string): WindowMode | null {
  const q = new URLSearchParams(search);
  if (q.get('view') !== 'session') return null;
  const projectIdRaw = q.get('projectId');
  const sessionId = q.get('sessionId');
  if (!projectIdRaw || !sessionId) return null;
  const projectId = Number(projectIdRaw);
  if (!Number.isFinite(projectId)) return null;
  const linkedSessionId = q.get('linkedSessionId') ?? undefined;
  const title = q.get('title') ?? 'Sesja';
  const fresh = q.get('fresh') === 'true';
  return {
    view: 'session',
    projectId,
    sessionId,
    ...(linkedSessionId ? { linkedSessionId } : {}),
    title,
    fresh,
  };
}

export function buildSessionWindowUrl(p: {
  projectId: number;
  sessionId: string;
  linkedSessionId?: string;
  title: string;
  fresh: boolean;
}): string {
  const q = new URLSearchParams();
  q.set('view', 'session');
  q.set('projectId', String(p.projectId));
  q.set('sessionId', p.sessionId);
  if (p.linkedSessionId) q.set('linkedSessionId', p.linkedSessionId);
  q.set('title', p.title);
  q.set('fresh', p.fresh ? 'true' : 'false');
  return `index.html?${q.toString()}`;
}

export function sessionWindowLabel(sessionId: string): string {
  return `session-${sessionId.replace(/[^a-zA-Z0-9-]/g, '_')}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/windowMode.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/lib/windowMode.ts src/lib/windowMode.test.ts
git commit -m "feat(desktop): add windowMode URL helpers for detached session window"
```

---

## Task 3: isTabLiveProcess pure helper + TabBar refactor

Extract the "is this tab a live process" rule so both `TabBar` and the detached window's close guard share it.

**Files:**
- Create: `src/lib/tabProcess.ts`
- Test: `src/lib/tabProcess.test.ts`
- Modify: `src/components/center/TabBar.tsx:98-103`

- [ ] **Step 1: Write the failing test**

Create `src/lib/tabProcess.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { isTabLiveProcess } from './tabProcess';
import type { Tab } from '../store/tabsSlice';

const sessionHistory: Tab = { kind: 'session', id: 's1', projectId: 1, sessionId: 'a', title: 't', mode: 'history' };
const sessionTerminal: Tab = { kind: 'session', id: 's2', projectId: 1, sessionId: 'b', title: 't', mode: 'terminal' };
const shell: Tab = { kind: 'terminal', id: 't1', projectId: 1, title: 'Terminal' };
const action: Tab = { kind: 'action', id: 'a1', projectId: 1, actionId: 5, title: 'Build', status: 'running' };

describe('isTabLiveProcess', () => {
  it('session in history mode is not live', () => {
    expect(isTabLiveProcess(sessionHistory, {})).toBe(false);
  });
  it('session in terminal mode is live', () => {
    expect(isTabLiveProcess(sessionTerminal, {})).toBe(true);
  });
  it('shell terminal is live', () => {
    expect(isTabLiveProcess(shell, {})).toBe(true);
  });
  it('action is live only when running', () => {
    expect(isTabLiveProcess(action, { 5: { status: 'running' } as never })).toBe(true);
    expect(isTabLiveProcess(action, { 5: { status: 'exited' } as never })).toBe(false);
    expect(isTabLiveProcess(action, {})).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/tabProcess.test.ts`
Expected: FAIL — module `./tabProcess` not found.

- [ ] **Step 3: Write the implementation**

Create `src/lib/tabProcess.ts`:

```ts
import type { Tab } from '../store/tabsSlice';
import type { RunningAction } from '../store/actionsSlice';

export function isTabLiveProcess(
  tab: Tab,
  runningActions: Record<number, RunningAction | undefined>,
): boolean {
  if (tab.kind === 'action') return runningActions[tab.actionId]?.status === 'running';
  return (tab.kind === 'session' && tab.mode === 'terminal') || tab.kind === 'terminal';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/tabProcess.test.ts`
Expected: PASS.

- [ ] **Step 5: Refactor TabBar to use it**

In `src/components/center/TabBar.tsx`, add to imports (after the `actionStatus` import):

```tsx
import { isTabLiveProcess } from '../../lib/tabProcess';
```

Replace the `isActiveProcess` function (lines ~98–103):

```tsx
  const isActiveProcess = (id: string) => {
    const t = tabs.find(x => x.id === id);
    if (!t) return false;
    if (t.kind === 'action') return runningActions[t.actionId]?.status === 'running';
    return (t.kind === 'session' && t.mode === 'terminal') || t.kind === 'terminal';
  };
```

with:

```tsx
  const isActiveProcess = (id: string) => {
    const t = tabs.find(x => x.id === id);
    return t ? isTabLiveProcess(t, runningActions) : false;
  };
```

- [ ] **Step 6: Verify lint + tests**

Run: `npm run lint && npx vitest run src/lib/tabProcess.test.ts`
Expected: zero lint errors; tests PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/tabProcess.ts src/lib/tabProcess.test.ts src/components/center/TabBar.tsx
git commit -m "refactor(desktop): extract isTabLiveProcess helper"
```

---

## Task 4: sessionTabFromMode in tabsSlice

Pure conversion from a parsed window mode to the single seeded session tab.

**Files:**
- Modify: `src/store/tabsSlice.ts`
- Test: `src/store/tabsSlice.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/store/tabsSlice.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { sessionTabFromMode } from './tabsSlice';

describe('sessionTabFromMode', () => {
  it('builds a terminal-mode session tab for a real session', () => {
    expect(sessionTabFromMode({ view: 'session', projectId: 2, sessionId: 'real-1', title: 'Hi', fresh: false })).toEqual({
      kind: 'session', id: 'session:real-1', projectId: 2, sessionId: 'real-1', title: 'Hi', mode: 'terminal',
    });
  });

  it('carries linkedSessionId and fresh flag', () => {
    expect(sessionTabFromMode({ view: 'session', projectId: 2, sessionId: 'new-1', linkedSessionId: 'real-9', title: 'Hi', fresh: true })).toEqual({
      kind: 'session', id: 'session:new-1', projectId: 2, sessionId: 'new-1', linkedSessionId: 'real-9', title: 'Hi', mode: 'terminal', fresh: true,
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/store/tabsSlice.test.ts`
Expected: FAIL — `sessionTabFromMode` is not exported.

- [ ] **Step 3: Write the implementation**

In `src/store/tabsSlice.ts`, add the import at the top (after the existing `import type { StateCreator }` line):

```ts
import type { WindowMode } from '../lib/windowMode';
```

Then add this exported function immediately after the `sessionTabId` definition (after line ~23):

```ts
export function sessionTabFromMode(mode: WindowMode): Extract<Tab, { kind: 'session' }> {
  return {
    kind: 'session',
    id: sessionTabId(mode.sessionId),
    projectId: mode.projectId,
    sessionId: mode.sessionId,
    ...(mode.linkedSessionId ? { linkedSessionId: mode.linkedSessionId } : {}),
    title: mode.title,
    mode: 'terminal',
    ...(mode.fresh ? { fresh: true } : {}),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/store/tabsSlice.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/store/tabsSlice.ts src/store/tabsSlice.test.ts
git commit -m "feat(desktop): add sessionTabFromMode tab seeding helper"
```

---

## Task 5: Conditional store boot for detached window

In session window mode: seed exactly one active tab and suppress all localStorage/SQLite persistence (so the detached window never clobbers the main window's tabs/settings).

**Files:**
- Modify: `src/store/index.ts:246-285`

- [ ] **Step 1: Add imports**

In `src/store/index.ts`, after the existing `import { tauri } from '../lib/tauri';` line, add:

```ts
import { parseWindowMode } from '../lib/windowMode';
import { sessionTabFromMode } from './tabsSlice';

const windowMode = parseWindowMode(window.location.search);
```

- [ ] **Step 2: Branch the boot tab restore**

Replace the boot block (lines ~246–256):

```ts
// --- Boot: sync hydrate from localStorage ---
applyPersistedToState(loadFromLocalStorage());

// --- Boot: restore persisted tabs ---
const savedTabs = loadTabsFromLocalStorage();
if (savedTabs && savedTabs.tabs.length > 0) {
  useStore.setState({
    tabs: savedTabs.tabs.map(t => ({ ...t, mode: 'history' as const })),
    activeTabId: savedTabs.activeTabId,
  });
}
```

with:

```ts
// --- Boot: sync hydrate from localStorage ---
applyPersistedToState(loadFromLocalStorage());

// --- Boot: seed the single session in a detached window, else restore tabs ---
if (windowMode) {
  const tab = sessionTabFromMode(windowMode);
  useStore.setState({ tabs: [tab], activeTabId: tab.id });
} else {
  const savedTabs = loadTabsFromLocalStorage();
  if (savedTabs && savedTabs.tabs.length > 0) {
    useStore.setState({
      tabs: savedTabs.tabs.map(t => ({ ...t, mode: 'history' as const })),
      activeTabId: savedTabs.activeTabId,
    });
  }
}
```

- [ ] **Step 3: Suppress persistence in the detached window**

Replace the `useStore.subscribe((state) => { ... })` body opening (line ~264) so the whole handler early-returns in detached mode. Change:

```ts
useStore.subscribe((state) => {
  // Settings persistence
  const next = pickPersistedFields(state);
```

to:

```ts
useStore.subscribe((state) => {
  // Detached session windows are ephemeral consumers: never persist tabs or
  // settings from here, or they would overwrite the main window's state.
  if (windowMode) return;

  // Settings persistence
  const next = pickPersistedFields(state);
```

- [ ] **Step 4: Verify lint + existing store tests**

Run: `npm run lint && npx vitest run`
Expected: zero lint errors; all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/store/index.ts
git commit -m "feat(desktop): seed single session and skip persistence in detached window"
```

---

## Task 6: TabContextMenu presentational component

Three items mirroring `ProjectManageMenu` styling. "Otwórz w nowym oknie" only enabled for sessions.

**Files:**
- Create: `src/components/center/TabContextMenu.tsx`
- Test: `src/components/center/TabContextMenu.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `src/components/center/TabContextMenu.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TabContextMenu } from './TabContextMenu';

const noop = () => {};

describe('TabContextMenu', () => {
  it('renders all three items', () => {
    render(<TabContextMenu canDetach onDetach={noop} onRename={noop} onClose={noop} onCloseMenu={noop} />);
    expect(screen.getByText('Otwórz w nowym oknie')).toBeInTheDocument();
    expect(screen.getByText('Zmień nazwę')).toBeInTheDocument();
    expect(screen.getByText('Zamknij')).toBeInTheDocument();
  });

  it('fires onDetach then onCloseMenu', () => {
    const onDetach = vi.fn(); const onCloseMenu = vi.fn();
    render(<TabContextMenu canDetach onDetach={onDetach} onRename={noop} onClose={noop} onCloseMenu={onCloseMenu} />);
    fireEvent.click(screen.getByText('Otwórz w nowym oknie'));
    expect(onDetach).toHaveBeenCalledOnce();
    expect(onCloseMenu).toHaveBeenCalledOnce();
  });

  it('disables detach when canDetach is false', () => {
    const onDetach = vi.fn();
    render(<TabContextMenu canDetach={false} onDetach={onDetach} onRename={noop} onClose={noop} onCloseMenu={noop} />);
    fireEvent.click(screen.getByText('Otwórz w nowym oknie'));
    expect(onDetach).not.toHaveBeenCalled();
  });

  it('fires onRename then onCloseMenu', () => {
    const onRename = vi.fn(); const onCloseMenu = vi.fn();
    render(<TabContextMenu canDetach onDetach={noop} onRename={onRename} onClose={noop} onCloseMenu={onCloseMenu} />);
    fireEvent.click(screen.getByText('Zmień nazwę'));
    expect(onRename).toHaveBeenCalledOnce();
    expect(onCloseMenu).toHaveBeenCalledOnce();
  });

  it('fires onClose then onCloseMenu', () => {
    const onClose = vi.fn(); const onCloseMenu = vi.fn();
    render(<TabContextMenu canDetach onDetach={noop} onRename={noop} onClose={onClose} onCloseMenu={onCloseMenu} />);
    fireEvent.click(screen.getByText('Zamknij'));
    expect(onClose).toHaveBeenCalledOnce();
    expect(onCloseMenu).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/center/TabContextMenu.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `src/components/center/TabContextMenu.tsx`:

```tsx
import { Icon } from '../shared/Icon';

type Props = {
  canDetach: boolean;
  onDetach: () => void;
  onRename: () => void;
  onClose: () => void;
  onCloseMenu: () => void;
};

export function TabContextMenu({ canDetach, onDetach, onRename, onClose, onCloseMenu }: Props) {
  return (
    <div role="menu" className="py-1">
      <button
        role="menuitem"
        disabled={!canDetach}
        onClick={() => { if (!canDetach) return; onDetach(); onCloseMenu(); }}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-[11.5px] text-fg hover:bg-bg-elev disabled:opacity-40 disabled:hover:bg-transparent disabled:cursor-default"
      >
        <Icon name="external-link" className="w-3 h-3" strokeWidth={2} />
        <span>Otwórz w nowym oknie</span>
      </button>
      <button
        role="menuitem"
        onClick={() => { onRename(); onCloseMenu(); }}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-[11.5px] text-fg hover:bg-bg-elev"
      >
        <Icon name="pencil" className="w-3 h-3" strokeWidth={2} />
        <span>Zmień nazwę</span>
      </button>
      <button
        role="menuitem"
        onClick={() => { onClose(); onCloseMenu(); }}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-[11.5px] text-danger hover:bg-danger/10"
      >
        <Icon name="x" className="w-3 h-3" strokeWidth={2} />
        <span>Zamknij</span>
      </button>
    </div>
  );
}
```

> **Note:** verify the icon names exist in `src/components/shared/Icon.tsx`. If `external-link` or `x` are absent, pick the closest existing names (e.g. an arrow/expand icon and a close/trash icon). Do NOT invent new icon assets in this task — substitute existing ones.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/center/TabContextMenu.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/center/TabContextMenu.tsx src/components/center/TabContextMenu.test.tsx
git commit -m "feat(desktop): add tab context menu component"
```

---

## Task 7: detachSession orchestration

Create-or-focus the session window, then close the source tab once created.

**Files:**
- Create: `src/lib/detachSession.ts`

- [ ] **Step 1: Write the implementation**

Create `src/lib/detachSession.ts`:

```ts
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import type { Tab } from '../store/tabsSlice';
import { buildSessionWindowUrl, sessionWindowLabel } from './windowMode';

export async function detachSessionTab(
  tab: Extract<Tab, { kind: 'session' }>,
  closeTab: (id: string) => void,
): Promise<void> {
  const label = sessionWindowLabel(tab.sessionId);

  // Guard against two PTYs for the same session: focus an existing window.
  const existing = await WebviewWindow.getByLabel(label);
  if (existing) {
    await existing.setFocus();
    return;
  }

  const url = buildSessionWindowUrl({
    projectId: tab.projectId,
    sessionId: tab.sessionId,
    linkedSessionId: tab.linkedSessionId,
    title: tab.title,
    fresh: tab.fresh ?? false,
  });

  const win = new WebviewWindow(label, {
    url,
    title: tab.title,
    width: 1100,
    height: 760,
    minWidth: 720,
    minHeight: 500,
    titleBarStyle: 'overlay',
    hiddenTitle: true,
  });

  win.once('tauri://created', () => { closeTab(tab.id); });
  win.once('tauri://error', (e) => { console.error('[detach] window create failed', e); });
}
```

- [ ] **Step 2: Verify type-check**

Run: `npm run lint`
Expected: zero errors. (If TS flags `titleBarStyle`/`hiddenTitle`, confirm against `@tauri-apps/api` window options types and adjust casing — the JS enum values are lowercase.)

- [ ] **Step 3: Commit**

```bash
git add src/lib/detachSession.ts
git commit -m "feat(desktop): add detachSessionTab window orchestration"
```

---

## Task 8: Wire context menu into TabBar

Right-click a tab → cursor-anchored menu → detach/rename/close, mirroring the click-outside pattern from `ProjectItem`.

**Files:**
- Modify: `src/components/center/TabBar.tsx`

- [ ] **Step 1: Add imports**

In `src/components/center/TabBar.tsx`, after the `isTabLiveProcess` import added in Task 3, add:

```tsx
import { TabContextMenu } from './TabContextMenu';
import { detachSessionTab } from '../../lib/detachSession';
import type { Tab } from '../../store/tabsSlice';
```

- [ ] **Step 2: Add menu state + click-outside effect**

Inside `TabBar`, after the existing `const [editingId, setEditingId] = useState<string | null>(null);` line, add:

```tsx
  const [ctxMenu, setCtxMenu] = useState<{ tab: Tab; x: number; y: number } | null>(null);
```

After the existing close-shortcut `useEffect` (the one ending around line ~132), add a click-outside effect:

```tsx
  useEffect(() => {
    if (!ctxMenu) return;
    const onDocClick = () => setCtxMenu(null);
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [ctxMenu]);
```

- [ ] **Step 3: Add the context-menu trigger to each tab**

In `renderTab`, add an `onContextMenu` handler to the outer tab `<div>` (alongside `onClick`/`onMouseDown`):

```tsx
      onContextMenu={(e) => {
        e.preventDefault();
        setCtxMenu({ tab: t, x: e.clientX, y: e.clientY });
      }}
```

- [ ] **Step 4: Render the menu**

In the returned JSX, add the menu render right before the `{pendingClose && (` block (inside the outer fragment):

```tsx
      {ctxMenu && (
        <div className="fixed z-50" style={{ left: ctxMenu.x, top: ctxMenu.y }} onMouseDown={(e) => e.stopPropagation()}>
          <div className="w-48 rounded-md border border-border bg-bg shadow-lg">
            <TabContextMenu
              canDetach={ctxMenu.tab.kind === 'session'}
              onDetach={() => {
                if (ctxMenu.tab.kind === 'session') void detachSessionTab(ctxMenu.tab, closeTab);
              }}
              onRename={() => setEditingId(ctxMenu.tab.id)}
              onClose={() => closeWithGuard(ctxMenu.tab.id)}
              onCloseMenu={() => setCtxMenu(null)}
            />
          </div>
        </div>
      )}
```

> The wrapper's `onMouseDown` stops propagation so clicking inside the menu does not trigger the document click-outside listener before the item's `onClick` runs.

- [ ] **Step 5: Verify lint + tests**

Run: `npm run lint && npx vitest run`
Expected: zero lint errors; all tests PASS.

- [ ] **Step 6: Manual smoke (main window)**

Run: `npm run tauri dev`
- Right-click a session tab → menu appears at cursor with all three items.
- Right-click a `terminal`/`action` tab → "Otwórz w nowym oknie" is disabled (dimmed).
- "Zmień nazwę" enters inline rename; "Zamknij" closes (with guard if live); clicking elsewhere dismisses the menu.

(Detach itself is verified in Task 11 after capabilities are granted.)

- [ ] **Step 7: Commit**

```bash
git add src/components/center/TabBar.tsx
git commit -m "feat(desktop): add right-click context menu to tabs"
```

---

## Task 9: DetachedSessionShell layout

The stripped layout: TitleBar + `TabContent` (renders the single seeded session) + `RightPanel`, with the right resizer and a window-close guard.

**Files:**
- Create: `src/components/layout/DetachedSessionShell.tsx`

- [ ] **Step 1: Write the implementation**

Create `src/components/layout/DetachedSessionShell.tsx`:

```tsx
import { useCallback, useEffect, useState } from 'react';
import { flushSync } from 'react-dom';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { TitleBar } from './TitleBar';
import { TabContent } from '../center/TabContent';
import { RightPanel } from '../right/RightPanel';
import { DragHandle, clamp } from './DragHandle';
import { ConfirmDialog } from '../dialogs/ConfirmDialog';
import { useStore } from '../../store';
import { tauri } from '../../lib/tauri';
import { formatWindowTitle } from '../../lib/windowTitle';
import { isTabLiveProcess } from '../../lib/tabProcess';

const RIGHT_MIN = 220;
const RIGHT_MAX = 480;

export function DetachedSessionShell() {
  const rightWidth = useStore(s => s.rightWidth);
  const setRightWidth = useStore(s => s.setRightWidth);
  const loadProjects = useStore(s => s.loadProjects);
  const startActivityPolling = useStore(s => s.startActivityPolling);
  const stopActivityPolling = useStore(s => s.stopActivityPolling);

  const activeTabTitle = useStore(s => s.tabs.find(t => t.id === s.activeTabId)?.title ?? null);
  const activeProjectName = useStore(s => {
    const tab = s.tabs.find(t => t.id === s.activeTabId);
    return tab ? (s.projects.find(p => p.id === tab.projectId)?.name ?? null) : null;
  });

  const [confirming, setConfirming] = useState(false);

  useEffect(() => { void loadProjects(); }, [loadProjects]);

  useEffect(() => {
    startActivityPolling();
    return () => stopActivityPolling();
  }, [startActivityPolling, stopActivityPolling]);

  useEffect(() => {
    void tauri.setWindowTitle(formatWindowTitle(activeTabTitle, activeProjectName));
  }, [activeTabTitle, activeProjectName]);

  // Closing the window ends the session. Prompt when the PTY is live; the
  // confirm path unmounts TabContent (flushSync) so TerminalView's cleanup
  // kills the PTY before the window closes — otherwise the process orphans.
  useEffect(() => {
    const win = getCurrentWebviewWindow();
    let unlisten: (() => void) | null = null;
    win.onCloseRequested((event) => {
      const state = useStore.getState();
      const tab = state.tabs.find(t => t.id === state.activeTabId);
      if (tab && isTabLiveProcess(tab, state.runningActions)) {
        event.preventDefault();
        setConfirming(true);
      }
    }).then(fn => { unlisten = fn; });
    return () => { if (unlisten) unlisten(); };
  }, []);

  const onRightDrag = useCallback(
    (delta: number) => setRightWidth(clamp(rightWidth - delta, RIGHT_MIN, RIGHT_MAX)),
    [rightWidth, setRightWidth],
  );

  const confirmClose = () => {
    const state = useStore.getState();
    if (state.activeTabId) {
      flushSync(() => state.closeTab(state.activeTabId!));
    }
    void getCurrentWebviewWindow().close();
  };

  return (
    <div className="flex flex-col h-full w-full overflow-hidden bg-bg">
      <TitleBar />
      <div className="flex flex-1 min-h-0">
        <div className="flex-1 h-full min-w-0">
          <TabContent />
        </div>
        <DragHandle onDrag={onRightDrag} ariaLabel="Resize right panel" />
        <div style={{ width: rightWidth }} className="h-full flex-shrink-0">
          <RightPanel />
        </div>
      </div>
      {confirming && (
        <ConfirmDialog
          title="Zamknąć sesję?"
          message="Zamknięcie okna zakończy aktywną sesję."
          onCancel={() => setConfirming(false)}
          onConfirm={confirmClose}
        />
      )}
    </div>
  );
}
```

> **Note:** confirm the exact names `startActivityPolling` / `stopActivityPolling` and `setRightWidth` exist on the store (they are used in `AppShell.tsx`). If `react-dom`'s `flushSync` import path differs in this project's React 19 setup, match how other files import from `react-dom`.

- [ ] **Step 2: Verify type-check**

Run: `npm run lint`
Expected: zero errors.

- [ ] **Step 3: Commit**

```bash
git add src/components/layout/DetachedSessionShell.tsx
git commit -m "feat(desktop): add DetachedSessionShell layout"
```

---

## Task 10: App.tsx renders the detached shell in session mode

**Files:**
- Modify: `src/App.tsx`

- [ ] **Step 1: Update App.tsx**

Replace the contents of `src/App.tsx` with:

```tsx
import { useEffect } from 'react';
import { Toaster } from 'sonner';
import { ThemeProvider } from './components/layout/ThemeProvider';
import { AppShell } from './components/layout/AppShell';
import { DetachedSessionShell } from './components/layout/DetachedSessionShell';
import { ErrorBoundary } from './components/layout/ErrorBoundary';
import { SettingsDialog } from './components/dialogs/SettingsDialog';
import { useStore } from './store';
import { installMiddleClickPasteGuard } from './lib/middleClickPasteGuard';
import { parseWindowMode } from './lib/windowMode';

const windowMode = parseWindowMode(window.location.search);

export default function App() {
  const settingsOpen = useStore(s => s.settingsOpen);

  useEffect(() => installMiddleClickPasteGuard(), []);

  return (
    <ThemeProvider>
      <ErrorBoundary>
        {windowMode ? <DetachedSessionShell /> : <AppShell />}
      </ErrorBoundary>
      {!windowMode && settingsOpen && <SettingsDialog />}
      <ErrorBoundary>
        <Toaster
          richColors
          position="bottom-right"
          toastOptions={{
            style: { borderRadius: 0, fontFamily: "'Geist', sans-serif" },
          }}
        />
      </ErrorBoundary>
    </ThemeProvider>
  );
}
```

- [ ] **Step 2: Verify lint + tests**

Run: `npm run lint && npx vitest run`
Expected: zero lint errors; all tests PASS.

- [ ] **Step 3: Commit**

```bash
git add src/App.tsx
git commit -m "feat(desktop): render detached shell when in session window mode"
```

---

## Task 11: Grant capabilities for detached windows

Apply the capability to `session-*` windows and allow runtime window creation + the window commands the feature uses.

**Files:**
- Modify: `src-tauri/capabilities/default.json`

- [ ] **Step 1: Update the capability file**

Replace `src-tauri/capabilities/default.json` with:

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "description": "Capability for app windows (main + detached session windows)",
  "windows": ["main", "session-*"],
  "permissions": [
    "core:default",
    "core:window:allow-set-title",
    "core:window:allow-close",
    "core:window:allow-set-focus",
    "core:window:allow-get-all-windows",
    "core:webview:allow-create-webview-window",
    "core:webview:allow-get-all-webviews",
    "opener:default",
    "dialog:allow-open",
    "fs:allow-read-text-file",
    "fs:allow-exists"
  ]
}
```

- [ ] **Step 2: Full manual verification (the core acceptance test)**

Run: `npm run tauri dev`

Verify the end-to-end flow:
1. Open a session as a live terminal in the main window; right-click its tab → "Otwórz w nowym oknie".
2. A new OS window opens showing: TitleBar, the session thread (live terminal) in the center, and the right panel (Actions / Git / Usage). No project list, no tab bar.
3. The source tab disappears from the main window.
4. Type in the detached terminal — the session is interactive (resumed).
5. Right-click the same session again is not possible (tab gone). Re-open it from the sidebar and detach again → focuses the existing detached window instead of opening a second one.
6. Drag the right-panel resizer in the detached window — it resizes.
7. Detach a **fresh** ("New session") tab → the detached window spawns a fresh claude session.
8. Close the detached window via the OS close button → ConfirmDialog "Zamknąć sesję?" appears; confirm → window closes and the claude process terminates (verify no orphaned process, e.g. `pgrep -af claude`).
9. The main window keeps working throughout (its tabs, sidebar, right panel unaffected).

Expected: all nine behaviors hold. If window creation fails with a permissions error in the console, re-check the capability identifiers in Step 1.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/capabilities/default.json
git commit -m "feat(desktop): grant capabilities for detached session windows"
```

---

## Task 12: Final verification sweep

**Files:** none (verification only)

- [ ] **Step 1: Lint**

Run: `npm run lint`
Expected: zero errors.

- [ ] **Step 2: Full frontend test suite**

Run: `npx vitest run`
Expected: all tests PASS, including the new `windowMode`, `tabProcess`, `tabsSlice`, and `TabContextMenu` suites.

- [ ] **Step 3: Rust tests (sanity — no backend changes expected)**

Run: `npm run test:rust`
Expected: PASS (unchanged).

- [ ] **Step 4: Production build smoke**

Run: `npm run tauri build` (or at minimum `npm run build` for the frontend bundle)
Expected: build succeeds; the `index.html?view=session…` URL resolves in the bundled app (already verified in dev at Task 11).

---

## Notes / Known limitations (intentional, per spec)

- A detached window holds exactly one session; there is no tab bar inside it.
- Closing the detached window ends the session (no re-dock to the main window).
- Settings changed in a detached window (e.g. right-panel width) are not persisted — the window is ephemeral by design.
- Re-detaching the same session focuses the existing window rather than spawning a second PTY.
