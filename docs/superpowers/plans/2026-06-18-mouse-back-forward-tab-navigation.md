# Mouse Back/Forward Tab Navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the mouse back/forward buttons switch between tabs like a browser's back/forward buttons — moving through a navigation-history cursor, switching instantly with no overlay.

**Architecture:** A new pure module `src/lib/navHistory.ts` holds all history math (push / step / prune). `tabsSlice` gains `navHistory: string[]` + `navIndex: number` plus `goBack`/`goForward` actions; every user-driven tab activation pushes onto history, while back/forward only moves the cursor. A null-rendering hook `useMouseNavigation` (mounted in `AppShell`) listens for mouse buttons 3/4 on the document capture phase and calls the store actions.

**Tech Stack:** React 19, Zustand 5, TypeScript, Vitest + jsdom + @testing-library/react.

## Global Constraints

- Identifiers in English only; user-facing UI text in Polish.
- No comments unless the WHY is non-obvious; existing code rarely has comments — match that.
- Commits: Conventional Commits 1.0.0 (`feat(scope):`, ...), scope `desktop`. No co-author trailer.
- Global document listeners that may conflict with xterm register on `document` in `useEffect` with `{ capture: true }`, then `preventDefault()` + `stopPropagation()`.
- `navHistory` / `navIndex` are ephemeral session state — **not** persisted (not in `PERSISTED_KEYS`, not in `writeTabsToLocalStorage`), exactly like `mruOrder`.
- `npm run lint` (= `tsc -b --noEmit`) must report zero errors. Tests run with `npm test`.

---

### Task 1: Pure navigation-history module

**Files:**
- Create: `DesktopApp/src/lib/navHistory.ts`
- Test: `DesktopApp/src/lib/navHistory.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type NavState = { history: string[]; index: number }`
  - `pushNav(state: NavState, id: string): NavState`
  - `stepBack(state: NavState): { index: number; targetId: string } | null`
  - `stepForward(state: NavState): { index: number; targetId: string } | null`
  - `pruneNav(state: NavState, removedId: string): NavState`

- [ ] **Step 1: Write the failing test**

Create `DesktopApp/src/lib/navHistory.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { pushNav, stepBack, stepForward, pruneNav } from './navHistory';

describe('pushNav', () => {
  it('appends a new id and moves the cursor to the end', () => {
    expect(pushNav({ history: ['a', 'b'], index: 1 }, 'c')).toEqual({ history: ['a', 'b', 'c'], index: 2 });
  });

  it('truncates the forward branch when pushing from the middle', () => {
    expect(pushNav({ history: ['a', 'b', 'c', 'd'], index: 1 }, 'e')).toEqual({ history: ['a', 'b', 'e'], index: 2 });
  });

  it('is a no-op when the id already sits at the cursor', () => {
    const state = { history: ['a', 'b'], index: 1 };
    expect(pushNav(state, 'b')).toBe(state);
  });

  it('pushes onto an empty history', () => {
    expect(pushNav({ history: [], index: 0 }, 'a')).toEqual({ history: ['a'], index: 0 });
  });
});

describe('stepBack', () => {
  it('moves the cursor back and returns the target', () => {
    expect(stepBack({ history: ['a', 'b', 'c'], index: 2 })).toEqual({ index: 1, targetId: 'b' });
  });

  it('returns null at the start boundary', () => {
    expect(stepBack({ history: ['a', 'b'], index: 0 })).toBeNull();
  });
});

describe('stepForward', () => {
  it('moves the cursor forward and returns the target', () => {
    expect(stepForward({ history: ['a', 'b', 'c'], index: 0 })).toEqual({ index: 1, targetId: 'b' });
  });

  it('returns null at the end boundary', () => {
    expect(stepForward({ history: ['a', 'b'], index: 1 })).toBeNull();
  });
});

describe('pruneNav', () => {
  it('removes a non-current id and keeps the cursor on the same entry', () => {
    expect(pruneNav({ history: ['a', 'b', 'c', 'd'], index: 3 }, 'b')).toEqual({ history: ['a', 'c', 'd'], index: 2 });
  });

  it('falls back toward the previous entry when the current id is removed', () => {
    expect(pruneNav({ history: ['a', 'b', 'c'], index: 2 }, 'c')).toEqual({ history: ['a', 'b'], index: 1 });
  });

  it('removes every occurrence of a repeated id', () => {
    expect(pruneNav({ history: ['a', 'b', 'a'], index: 2 }, 'a')).toEqual({ history: ['b'], index: 0 });
  });

  it('clamps to a valid state when the history becomes empty', () => {
    expect(pruneNav({ history: ['a'], index: 0 }, 'a')).toEqual({ history: [], index: 0 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd DesktopApp && npx vitest run src/lib/navHistory.test.ts`
Expected: FAIL — `Failed to resolve import "./navHistory"`.

- [ ] **Step 3: Write minimal implementation**

Create `DesktopApp/src/lib/navHistory.ts`:

```ts
export type NavState = { history: string[]; index: number };

export function pushNav(state: NavState, id: string): NavState {
  if (state.history[state.index] === id) return state;
  const history = state.history.slice(0, state.index + 1);
  history.push(id);
  return { history, index: history.length - 1 };
}

export function stepBack(state: NavState): { index: number; targetId: string } | null {
  if (state.index <= 0) return null;
  const index = state.index - 1;
  return { index, targetId: state.history[index] };
}

export function stepForward(state: NavState): { index: number; targetId: string } | null {
  if (state.index >= state.history.length - 1) return null;
  const index = state.index + 1;
  return { index, targetId: state.history[index] };
}

export function pruneNav(state: NavState, removedId: string): NavState {
  const removedAtOrBefore = state.history.slice(0, state.index + 1).filter(x => x === removedId).length;
  const history = state.history.filter(x => x !== removedId);
  const index = Math.max(0, Math.min(state.index - removedAtOrBefore, history.length - 1));
  return { history, index };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd DesktopApp && npx vitest run src/lib/navHistory.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add DesktopApp/src/lib/navHistory.ts DesktopApp/src/lib/navHistory.test.ts
git commit -m "feat(desktop): add pure navigation-history helpers for tab back/forward"
```

---

### Task 2: Navigation history in tabsSlice

**Files:**
- Modify: `DesktopApp/src/store/tabsSlice.ts`
- Test: `DesktopApp/src/store/tabsSlice.test.ts`

**Interfaces:**
- Consumes: `pushNav`, `stepBack`, `stepForward`, `pruneNav`, `type NavState` from `../lib/navHistory`; existing `moveToFront` helper.
- Produces (added to `TabsSlice`):
  - state: `navHistory: string[]`, `navIndex: number`
  - actions: `goBack: () => void`, `goForward: () => void`

- [ ] **Step 1: Write the failing tests**

Append to `DesktopApp/src/store/tabsSlice.test.ts`:

```ts
describe('tabsSlice navHistory', () => {
  beforeEach(() => {
    useStore.setState({ tabs: [], activeTabId: null, mruOrder: [], navHistory: [], navIndex: 0 });
  });

  const term = (id: string) => ({ kind: 'terminal' as const, id, projectId: 1, title: id });

  it('setActive pushes onto the navigation history', () => {
    useStore.setState({ tabs: [term('t1'), term('t2')] });
    useStore.getState().setActive('t1');
    useStore.getState().setActive('t2');
    expect(useStore.getState().navHistory).toEqual(['t1', 't2']);
    expect(useStore.getState().navIndex).toBe(1);
  });

  it('goBack moves the cursor without mutating navHistory', () => {
    useStore.setState({ tabs: [term('t1'), term('t2')], navHistory: ['t1', 't2'], navIndex: 1, mruOrder: ['t2', 't1'] });
    useStore.getState().goBack();
    expect(useStore.getState().activeTabId).toBe('t1');
    expect(useStore.getState().navIndex).toBe(0);
    expect(useStore.getState().navHistory).toEqual(['t1', 't2']);
    expect(useStore.getState().mruOrder[0]).toBe('t1');
  });

  it('goForward returns to the later tab', () => {
    useStore.setState({ tabs: [term('t1'), term('t2')], navHistory: ['t1', 't2'], navIndex: 0 });
    useStore.getState().goForward();
    expect(useStore.getState().activeTabId).toBe('t2');
    expect(useStore.getState().navIndex).toBe(1);
  });

  it('goBack at the start boundary is a no-op', () => {
    useStore.setState({ tabs: [term('t1')], navHistory: ['t1'], navIndex: 0, activeTabId: 't1' });
    useStore.getState().goBack();
    expect(useStore.getState().activeTabId).toBe('t1');
    expect(useStore.getState().navIndex).toBe(0);
  });

  it('activating a tab after goBack discards the forward branch', () => {
    useStore.setState({ tabs: [term('t1'), term('t2'), term('t3')], navHistory: ['t1', 't2'], navIndex: 1 });
    useStore.getState().goBack();              // cursor -> t1
    useStore.getState().setActive('t3');       // new navigation from t1
    expect(useStore.getState().navHistory).toEqual(['t1', 't3']);
    expect(useStore.getState().navIndex).toBe(1);
  });

  it('closeTab prunes the closed tab from navHistory', () => {
    useStore.setState({ tabs: [term('t1'), term('t2')], activeTabId: 't2', navHistory: ['t1', 't2'], navIndex: 1, mruOrder: ['t2', 't1'] });
    useStore.getState().closeTab('t2');
    expect(useStore.getState().navHistory).toEqual(['t1']);
    expect(useStore.getState().navIndex).toBe(0);
  });

  it('openSessionTab pushes the new tab onto navHistory', () => {
    useStore.getState().openSessionTab(1, 'sess', 'Session');
    expect(useStore.getState().navHistory).toEqual(['session:sess']);
    expect(useStore.getState().navIndex).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd DesktopApp && npx vitest run src/store/tabsSlice.test.ts`
Expected: FAIL — `goBack`/`goForward` are not functions and `navHistory` is `undefined`.

- [ ] **Step 3: Add imports and the helper hook into the slice**

In `DesktopApp/src/store/tabsSlice.ts`, add the import near the top (after the existing `import type { AppState } from './index';` line):

```ts
import { pushNav, stepBack, stepForward, pruneNav } from '../lib/navHistory';
```

- [ ] **Step 4: Extend the `TabsSlice` type**

In the `TabsSlice` type (currently lines 13–28), add the two state fields next to `mruOrder` and the two actions:

```ts
  mruOrder: string[];
  navHistory: string[];
  navIndex: number;
```

and inside the actions block:

```ts
  setActive: (id: string) => void;
  goBack: () => void;
  goForward: () => void;
```

- [ ] **Step 5: Initialize the new state**

In `createTabsSlice`, next to `mruOrder: [],` (line 51) add:

```ts
  navHistory: [],
  navIndex: 0,
```

- [ ] **Step 6: Wire `pushNav` into every user-navigation path**

Replace each activation `set(...)` so it also writes `navHistory`/`navIndex` via `pushNav`. A local helper keeps it DRY — add it just below `moveToFront` (line 46):

```ts
const withNav = (get: () => TabsSlice, id: string) => {
  const nav = pushNav({ history: get().navHistory, index: get().navIndex }, id);
  return { navHistory: nav.history, navIndex: nav.index };
};
```

Then update the activation actions:

`openSessionTab` — both branches:

```ts
  openSessionTab: (projectId, sessionId, title, provider) => {
    const id = sessionTabId(sessionId);
    const existing = get().tabs.find(t => t.id === id || (t.kind === 'session' && t.linkedSessionId === sessionId));
    if (existing) { set({ activeTabId: existing.id, mruOrder: moveToFront(get().mruOrder, existing.id), ...withNav(get, existing.id) }); return; }
    set({
      tabs: [...get().tabs, { kind: 'session', id, projectId, sessionId, title, mode: 'history', ...(provider ? { provider } : {}) }],
      activeTabId: id,
      mruOrder: moveToFront(get().mruOrder, id),
      ...withNav(get, id),
    });
  },
```

`openNewSessionTab` — the picker branch:

```ts
      set({
        tabs: [...get().tabs, { kind: 'providerPicker', id, projectId, title: 'New session' }],
        activeTabId: id,
        mruOrder: moveToFront(get().mruOrder, id),
        ...withNav(get, id),
      });
```

`startSessionTab`:

```ts
    set({
      tabs: [...get().tabs, { kind: 'session', id, projectId, sessionId, title: 'New session', mode: 'terminal', fresh: true, provider }],
      activeTabId: id,
      mruOrder: moveToFront(get().mruOrder, id),
      ...withNav(get, id),
    });
```

`openNewTerminalTab`:

```ts
    set({
      tabs: [...get().tabs, { kind: 'terminal', id, projectId, title: 'Terminal' }],
      activeTabId: id,
      mruOrder: moveToFront(get().mruOrder, id),
      ...withNav(get, id),
    });
```

`setActive`:

```ts
  setActive: (id) => set({ activeTabId: id, mruOrder: moveToFront(get().mruOrder, id), ...withNav(get, id) }),
```

`upsertActionTab` — apply `withNav` in both branches (after computing `mruOrder`):

```ts
  upsertActionTab: (tab) => {
    const existing = get().tabs.find(t => t.id === tab.id);
    const mruOrder = moveToFront(get().mruOrder, tab.id);
    const nav = withNav(get, tab.id);
    if (existing) {
      set({ tabs: get().tabs.map(t => t.id === tab.id ? tab : t), activeTabId: tab.id, mruOrder, ...nav });
    } else {
      set({ tabs: [...get().tabs, tab], activeTabId: tab.id, mruOrder, ...nav });
    }
  },
```

- [ ] **Step 7: Map the id rename in `chooseProvider`**

`chooseProvider` swaps the picker id for a new session id; mirror the existing `mruOrder` rename for `navHistory` (do **not** push — it is the same logical entry):

```ts
    set({
      tabs: get().tabs.map(t => t.id === tabId
        ? { kind: 'session' as const, id, projectId: picker.projectId, sessionId, title: 'New session', mode: 'terminal' as const, fresh: true, provider }
        : t),
      activeTabId: id,
      mruOrder: get().mruOrder.map(x => x === tabId ? id : x),
      navHistory: get().navHistory.map(x => x === tabId ? id : x),
    });
```

- [ ] **Step 8: Prune in `closeTab`**

```ts
  closeTab: (id) => {
    const tabs = get().tabs.filter(t => t.id !== id);
    const mruOrder = get().mruOrder.filter(x => x !== id);
    const activeTabId = get().activeTabId === id ? (tabs[tabs.length - 1]?.id ?? null) : get().activeTabId;
    const nav = pruneNav({ history: get().navHistory, index: get().navIndex }, id);
    set({ tabs, activeTabId, mruOrder, navHistory: nav.history, navIndex: nav.index });
  },
```

- [ ] **Step 9: Add the `goBack` / `goForward` actions**

Add next to `setActive` in `createTabsSlice`:

```ts
  goBack: () => {
    const step = stepBack({ history: get().navHistory, index: get().navIndex });
    if (!step) return;
    set({ navIndex: step.index, activeTabId: step.targetId, mruOrder: moveToFront(get().mruOrder, step.targetId) });
  },
  goForward: () => {
    const step = stepForward({ history: get().navHistory, index: get().navIndex });
    if (!step) return;
    set({ navIndex: step.index, activeTabId: step.targetId, mruOrder: moveToFront(get().mruOrder, step.targetId) });
  },
```

- [ ] **Step 10: Run tests to verify they pass**

Run: `cd DesktopApp && npx vitest run src/store/tabsSlice.test.ts`
Expected: PASS (existing mruOrder tests plus the new navHistory describe block).

- [ ] **Step 11: Type-check**

Run: `cd DesktopApp && npm run lint`
Expected: zero errors.

- [ ] **Step 12: Commit**

```bash
git add DesktopApp/src/store/tabsSlice.ts DesktopApp/src/store/tabsSlice.test.ts
git commit -m "feat(desktop): track tab navigation history with goBack/goForward"
```

---

### Task 3: Mouse-button listener hook

**Files:**
- Create: `DesktopApp/src/hooks/useMouseNavigation.ts`
- Modify: `DesktopApp/src/components/layout/AppShell.tsx`
- Test: `DesktopApp/src/hooks/useMouseNavigation.test.ts`

**Interfaces:**
- Consumes: `useStore` from `../store`; `goBack`/`goForward` actions from Task 2.
- Produces: `useMouseNavigation(): void` — mounts a document-level capture-phase `mousedown` listener; button 3 → `goBack()`, button 4 → `goForward()`.

- [ ] **Step 1: Write the failing test**

Create `DesktopApp/src/hooks/useMouseNavigation.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useMouseNavigation } from './useMouseNavigation';
import { useStore } from '../store';

const term = (id: string) => ({ kind: 'terminal' as const, id, projectId: 1, title: id });

describe('useMouseNavigation', () => {
  beforeEach(() => {
    useStore.setState({
      tabs: [term('t1'), term('t2')],
      activeTabId: 't2',
      mruOrder: ['t2', 't1'],
      navHistory: ['t1', 't2'],
      navIndex: 1,
    });
  });

  it('mouse button 3 navigates back', () => {
    renderHook(() => useMouseNavigation());
    act(() => { document.dispatchEvent(new MouseEvent('mousedown', { button: 3, bubbles: true })); });
    expect(useStore.getState().activeTabId).toBe('t1');
  });

  it('mouse button 4 navigates forward', () => {
    useStore.setState({ activeTabId: 't1', navIndex: 0 });
    renderHook(() => useMouseNavigation());
    act(() => { document.dispatchEvent(new MouseEvent('mousedown', { button: 4, bubbles: true })); });
    expect(useStore.getState().activeTabId).toBe('t2');
  });

  it('ignores other mouse buttons', () => {
    renderHook(() => useMouseNavigation());
    act(() => { document.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true })); });
    expect(useStore.getState().activeTabId).toBe('t2');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd DesktopApp && npx vitest run src/hooks/useMouseNavigation.test.ts`
Expected: FAIL — `Failed to resolve import "./useMouseNavigation"`.

- [ ] **Step 3: Write the hook**

Create `DesktopApp/src/hooks/useMouseNavigation.ts`:

```ts
import { useEffect } from 'react';
import { useStore } from '../store';

export function useMouseNavigation(): void {
  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      if (e.button === 3) {
        e.preventDefault();
        e.stopPropagation();
        useStore.getState().goBack();
      } else if (e.button === 4) {
        e.preventDefault();
        e.stopPropagation();
        useStore.getState().goForward();
      }
    };
    document.addEventListener('mousedown', onMouseDown, { capture: true });
    return () => document.removeEventListener('mousedown', onMouseDown, { capture: true });
  }, []);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd DesktopApp && npx vitest run src/hooks/useMouseNavigation.test.ts`
Expected: PASS (all three cases).

- [ ] **Step 5: Mount the hook in AppShell**

In `DesktopApp/src/components/layout/AppShell.tsx`, add the import alongside the other local imports (e.g. after line 16 `import { shouldNotify } from '../../lib/attention';`):

```ts
import { useMouseNavigation } from '../../hooks/useMouseNavigation';
```

Then call it in the `AppShell` component body, near the top alongside the other hooks (before the `return (` at line 196):

```ts
  useMouseNavigation();
```

- [ ] **Step 6: Type-check**

Run: `cd DesktopApp && npm run lint`
Expected: zero errors.

- [ ] **Step 7: Commit**

```bash
git add DesktopApp/src/hooks/useMouseNavigation.ts DesktopApp/src/hooks/useMouseNavigation.test.ts DesktopApp/src/components/layout/AppShell.tsx
git commit -m "feat(desktop): wire mouse back/forward buttons to tab navigation"
```

---

### Task 4: Settings discoverability entry

**Files:**
- Modify: `DesktopApp/src/lib/shortcuts.ts`
- Test: `DesktopApp/src/lib/shortcuts.test.ts`

**Interfaces:**
- Consumes: existing `FIXED_SHORTCUTS`, `formatBinding`.
- Produces: a `FIXED_SHORTCUTS` row for mouse navigation and a `formatBinding` case for the `mousenav` token.

- [ ] **Step 1: Write the failing test**

Create `DesktopApp/src/lib/shortcuts.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { FIXED_SHORTCUTS, formatBinding } from './shortcuts';

describe('mouse navigation shortcut', () => {
  it('exposes a fixed shortcut row for mouse back/forward', () => {
    const row = FIXED_SHORTCUTS.find(s => s.binding === 'mousenav');
    expect(row).toBeDefined();
    expect(row!.label).toBe('Nawigacja zakładek');
  });

  it('formats the mousenav token into a readable badge', () => {
    expect(formatBinding('mousenav')).toBe('Mysz ←/→');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd DesktopApp && npx vitest run src/lib/shortcuts.test.ts`
Expected: FAIL — no `mousenav` row, and `formatBinding('mousenav')` returns `'MOUSENAV'`.

- [ ] **Step 3: Add the FIXED_SHORTCUTS row**

In `DesktopApp/src/lib/shortcuts.ts`, extend `FIXED_SHORTCUTS` (currently lines 19–22):

```ts
export const FIXED_SHORTCUTS = [
  { label: 'Akcja 1–9', description: 'Uruchamia akcję o podanym numerze', binding: 'mod+1…9' },
  { label: 'Przełącz zakładki', description: 'Cyklicznie po ostatnio używanych (Shift = wstecz)', binding: 'ctrl+tab' },
  { label: 'Nawigacja zakładek', description: 'Przyciski myszy wstecz/następny — po historii oglądania', binding: 'mousenav' },
];
```

- [ ] **Step 4: Add the formatBinding case**

In `formatBinding` (the `.map` callback, lines 67–76), add a case before the final `return p.toUpperCase();`:

```ts
      if (p === 'mousenav') return 'Mysz ←/→';
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd DesktopApp && npx vitest run src/lib/shortcuts.test.ts`
Expected: PASS (both cases).

- [ ] **Step 6: Type-check**

Run: `cd DesktopApp && npm run lint`
Expected: zero errors.

- [ ] **Step 7: Commit**

```bash
git add DesktopApp/src/lib/shortcuts.ts DesktopApp/src/lib/shortcuts.test.ts
git commit -m "feat(desktop): document mouse tab navigation in settings shortcuts"
```

---

### Task 5: Full suite + manual verification

**Files:** none (verification only).

- [ ] **Step 1: Run the whole frontend suite**

Run: `cd DesktopApp && npm test`
Expected: all tests pass (including the new `navHistory`, `tabsSlice`, `useMouseNavigation`, `shortcuts` cases).

- [ ] **Step 2: Type-check the whole project**

Run: `cd DesktopApp && npm run lint`
Expected: zero errors.

- [ ] **Step 3: Manual verification (`npm run tauri dev`)**

Confirm by hand (a mouse with back/forward buttons required):
- Open several tabs across ≥2 projects; click between them; mouse-back walks the viewing history in reverse, mouse-forward returns along the same path.
- Activating a different tab after going back discards the forward branch (forward then does nothing).
- Back/forward are no-ops at the history boundaries and with 0/1 tab.
- Close the current tab and a non-current tab — back/forward stay consistent (never land on a closed tab).
- Back/forward work while an xterm terminal/session tab is focused (capture-phase listener wins).
- Settings → shortcuts list shows the "Nawigacja zakładek / Mysz ←/→" row.

---

## Notes for the implementer

- `withNav(get, id)` reads the *current* slice state inside each action, so it must be called while building the `set(...)` payload (as shown), not cached earlier.
- `goBack`/`goForward` deliberately do **not** call `withNav` — traversal moves the cursor only; pushing there would corrupt the history.
- Button numbering: in the WebView, `MouseEvent.button === 3` is "back" (X1) and `4` is "forward" (X2). `preventDefault` suppresses any default WebView back/forward navigation.
