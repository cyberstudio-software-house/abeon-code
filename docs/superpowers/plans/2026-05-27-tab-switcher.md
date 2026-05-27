# Tab Switcher (Ctrl+Tab) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Ctrl+Tab MRU tab switcher with a visual overlay that lists open tabs grouped by project, committed on Ctrl release (with mouse hover/click support while Ctrl is held).

**Architecture:** MRU order lives in the Zustand `tabsSlice` as `mruOrder: string[]` (source of truth, ephemeral). A single `TabSwitcher` overlay mounted in `AppShell` snapshots the MRU-ordered tabs on open, cycles a local selection index without touching the store, and commits via `setActive` on Ctrl release / row click. Pure ordering + index math is extracted to `src/lib/tabSwitcher.ts` for unit testing; grouping reuses the existing `tabGrouping` helpers.

**Tech Stack:** React 19, Zustand 5, TypeScript, Tailwind 4, Vitest + jsdom.

---

## File Structure

- **Create** `src/lib/tabSwitcher.ts` — pure helpers: `orderTabsByMru`, `wrapIndex`.
- **Create** `src/lib/tabSwitcher.test.ts` — unit tests for the helpers.
- **Modify** `src/store/tabsSlice.ts` — add `mruOrder` field + maintenance in `setActive`/open paths/`closeTab`/`upsertActionTab`.
- **Create** `src/store/tabsSlice.test.ts` — unit tests for `mruOrder` maintenance.
- **Create** `src/components/center/TabSwitcher.tsx` — the overlay component + global key handler.
- **Modify** `src/components/layout/AppShell.tsx` — mount `<TabSwitcher />`.
- **Modify** `src/lib/shortcuts.ts` — `FIXED_SHORTCUTS` entry + `ctrl` token in `formatBinding`.

---

## Task 1: Pure switcher helpers (`tabSwitcher.ts`)

**Files:**
- Create: `src/lib/tabSwitcher.ts`
- Test: `src/lib/tabSwitcher.test.ts`

`orderTabsByMru` returns tabs ordered by `mruOrder` (most-recent first), with any
tab not present in `mruOrder` appended in its natural array order — this is what
makes the switcher work after an app restart, when `mruOrder` is empty but
persisted session tabs exist. `wrapIndex` wraps a (possibly negative) index into
`[0, length)`.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/tabSwitcher.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { orderTabsByMru, wrapIndex } from './tabSwitcher';
import type { Tab } from '../store/tabsSlice';

const term = (id: string): Tab => ({ kind: 'terminal', id, projectId: 1, title: id });

describe('orderTabsByMru', () => {
  it('orders tabs by mru, most recent first', () => {
    const tabs = [term('a'), term('b'), term('c')];
    expect(orderTabsByMru(tabs, ['c', 'a', 'b']).map(t => t.id)).toEqual(['c', 'a', 'b']);
  });

  it('appends tabs missing from mruOrder in array order', () => {
    const tabs = [term('a'), term('b'), term('c')];
    expect(orderTabsByMru(tabs, ['b']).map(t => t.id)).toEqual(['b', 'a', 'c']);
  });

  it('ignores ids in mruOrder that no longer exist', () => {
    const tabs = [term('a'), term('b')];
    expect(orderTabsByMru(tabs, ['gone', 'b', 'a']).map(t => t.id)).toEqual(['b', 'a']);
  });

  it('falls back to array order when mruOrder is empty', () => {
    const tabs = [term('a'), term('b')];
    expect(orderTabsByMru(tabs, []).map(t => t.id)).toEqual(['a', 'b']);
  });
});

describe('wrapIndex', () => {
  it('wraps positive overflow', () => { expect(wrapIndex(3, 3)).toBe(0); });
  it('wraps negative to the end', () => { expect(wrapIndex(-1, 3)).toBe(2); });
  it('leaves in-range values untouched', () => { expect(wrapIndex(1, 3)).toBe(1); });
  it('returns 0 for empty length', () => { expect(wrapIndex(1, 0)).toBe(0); });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- src/lib/tabSwitcher.test.ts`
Expected: FAIL — cannot resolve `./tabSwitcher` (module does not exist yet).

- [ ] **Step 3: Implement the helpers**

Create `src/lib/tabSwitcher.ts`:

```ts
import type { Tab } from '../store/tabsSlice';

export function orderTabsByMru(tabs: Tab[], mruOrder: string[]): Tab[] {
  const byId = new Map(tabs.map(t => [t.id, t] as const));
  const seen = new Set<string>();
  const ordered: Tab[] = [];
  for (const id of mruOrder) {
    const t = byId.get(id);
    if (t && !seen.has(id)) {
      ordered.push(t);
      seen.add(id);
    }
  }
  for (const t of tabs) {
    if (!seen.has(t.id)) {
      ordered.push(t);
      seen.add(t.id);
    }
  }
  return ordered;
}

export function wrapIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  return ((index % length) + length) % length;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- src/lib/tabSwitcher.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/tabSwitcher.ts src/lib/tabSwitcher.test.ts
git commit -m "feat(tabs): add MRU ordering helpers for tab switcher"
```

---

## Task 2: MRU order in `tabsSlice`

**Files:**
- Modify: `src/store/tabsSlice.ts`
- Test: `src/store/tabsSlice.test.ts`

Add `mruOrder: string[]` (index 0 = most recent). A `moveToFront` helper dedupes
and promotes an id. `setActive`, all open paths, and `upsertActionTab` promote
their tab; `closeTab` removes it. `activeTabId` fallback on close is unchanged.

- [ ] **Step 1: Write the failing tests**

Create `src/store/tabsSlice.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from './index';

describe('tabsSlice mruOrder', () => {
  beforeEach(() => {
    useStore.setState({ tabs: [], activeTabId: null, mruOrder: [] });
  });

  it('setActive moves the tab to the front of mruOrder', () => {
    useStore.setState({
      tabs: [
        { kind: 'terminal', id: 't1', projectId: 1, title: 'a' },
        { kind: 'terminal', id: 't2', projectId: 1, title: 'b' },
      ],
      mruOrder: ['t1', 't2'],
    });
    useStore.getState().setActive('t2');
    expect(useStore.getState().mruOrder).toEqual(['t2', 't1']);
    expect(useStore.getState().activeTabId).toBe('t2');
  });

  it('setActive does not duplicate an already-front tab', () => {
    useStore.setState({ mruOrder: ['t1', 't2'] });
    useStore.getState().setActive('t1');
    expect(useStore.getState().mruOrder).toEqual(['t1', 't2']);
  });

  it('openSessionTab promotes a new tab to the front', () => {
    useStore.setState({ mruOrder: ['t1'] });
    useStore.getState().openSessionTab(1, 'sess', 'Session');
    expect(useStore.getState().mruOrder[0]).toBe('session:sess');
  });

  it('openSessionTab focusing an existing tab promotes it', () => {
    useStore.setState({
      tabs: [
        { kind: 'session', id: 'session:sess', projectId: 1, sessionId: 'sess', title: 'S', mode: 'history' },
        { kind: 'terminal', id: 't2', projectId: 1, title: 'b' },
      ],
      mruOrder: ['t2', 'session:sess'],
    });
    useStore.getState().openSessionTab(1, 'sess', 'S');
    expect(useStore.getState().mruOrder).toEqual(['session:sess', 't2']);
  });

  it('closeTab removes the tab from mruOrder', () => {
    useStore.setState({
      tabs: [
        { kind: 'terminal', id: 't1', projectId: 1, title: 'a' },
        { kind: 'terminal', id: 't2', projectId: 1, title: 'b' },
      ],
      activeTabId: 't1',
      mruOrder: ['t1', 't2'],
    });
    useStore.getState().closeTab('t1');
    expect(useStore.getState().mruOrder).toEqual(['t2']);
  });

  it('upsertActionTab promotes the action tab to the front', () => {
    useStore.setState({ mruOrder: ['t1'] });
    useStore.getState().upsertActionTab({
      kind: 'action', id: 'action:5', projectId: 1, actionId: 5, title: 'Build', status: 'running',
    });
    expect(useStore.getState().mruOrder[0]).toBe('action:5');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- src/store/tabsSlice.test.ts`
Expected: FAIL — `mruOrder` is `undefined` (assertions on `mruOrder` fail).

- [ ] **Step 3: Add the `mruOrder` field, helper, and type**

In `src/store/tabsSlice.ts`, add `mruOrder` to the type (after `activeTabId`):

```ts
export type TabsSlice = {
  tabs: Tab[];
  activeTabId: string | null;
  mruOrder: string[];
  openSessionTab: (projectId: number, sessionId: string, title: string) => void;
```

Add the helper just below the existing `sessionTabId` constant:

```ts
const sessionTabId = (sessionId: string) => `session:${sessionId}`;

const moveToFront = (order: string[], id: string) => [id, ...order.filter(x => x !== id)];
```

Set the initial value (after `activeTabId: null,`):

```ts
export const createTabsSlice: StateCreator<TabsSlice> = (set, get) => ({
  tabs: [],
  activeTabId: null,
  mruOrder: [],
```

- [ ] **Step 4: Maintain `mruOrder` in every mutator**

Replace the bodies of these methods in `src/store/tabsSlice.ts`.

`openSessionTab`:

```ts
  openSessionTab: (projectId, sessionId, title) => {
    const id = sessionTabId(sessionId);
    const existing = get().tabs.find(t => t.id === id || (t.kind === 'session' && t.linkedSessionId === sessionId));
    if (existing) { set({ activeTabId: existing.id, mruOrder: moveToFront(get().mruOrder, existing.id) }); return; }
    set({
      tabs: [...get().tabs, { kind: 'session', id, projectId, sessionId, title, mode: 'history' }],
      activeTabId: id,
      mruOrder: moveToFront(get().mruOrder, id),
    });
  },
```

`openNewSessionTab`:

```ts
  openNewSessionTab: (projectId) => {
    const sessionId = `new-${crypto.randomUUID()}`;
    const id = sessionTabId(sessionId);
    set({
      tabs: [...get().tabs, { kind: 'session', id, projectId, sessionId, title: 'New session', mode: 'terminal' }],
      activeTabId: id,
      mruOrder: moveToFront(get().mruOrder, id),
    });
  },
```

`openNewTerminalTab`:

```ts
  openNewTerminalTab: (projectId) => {
    const id = `terminal:${crypto.randomUUID()}`;
    set({
      tabs: [...get().tabs, { kind: 'terminal', id, projectId, title: 'Terminal' }],
      activeTabId: id,
      mruOrder: moveToFront(get().mruOrder, id),
    });
  },
```

`closeTab`:

```ts
  closeTab: (id) => {
    const tabs = get().tabs.filter(t => t.id !== id);
    const mruOrder = get().mruOrder.filter(x => x !== id);
    const activeTabId = get().activeTabId === id ? (tabs[tabs.length - 1]?.id ?? null) : get().activeTabId;
    set({ tabs, activeTabId, mruOrder });
  },
```

`setActive`:

```ts
  setActive: (id) => set({ activeTabId: id, mruOrder: moveToFront(get().mruOrder, id) }),
```

`upsertActionTab`:

```ts
  upsertActionTab: (tab) => {
    const existing = get().tabs.find(t => t.id === tab.id);
    const mruOrder = moveToFront(get().mruOrder, tab.id);
    if (existing) {
      set({ tabs: get().tabs.map(t => t.id === tab.id ? tab : t), activeTabId: tab.id, mruOrder });
    } else {
      set({ tabs: [...get().tabs, tab], activeTabId: tab.id, mruOrder });
    }
  },
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -- src/store/tabsSlice.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 6: Commit**

```bash
git add src/store/tabsSlice.ts src/store/tabsSlice.test.ts
git commit -m "feat(tabs): track most-recently-used tab order"
```

---

## Task 3: `TabSwitcher` overlay component

**Files:**
- Create: `src/components/center/TabSwitcher.tsx`
- Modify: `src/components/layout/AppShell.tsx`

The component renders nothing until opened. It registers `keydown`/`keyup` on
`document` in the **capture** phase (per CLAUDE.md, this is required so the
handler wins over xterm's textarea) plus a `window` `blur` to cancel. Latest
open/snapshot/index are mirrored into refs so the once-registered listener reads
current values without re-subscribing.

Interaction (matches the spec):
- `Ctrl+Tab` (not open, >1 tab) → snapshot MRU-ordered tabs, select index 1, open.
- `Ctrl+Tab` while open → advance (`Shift` → backward). `ArrowDown`/`ArrowUp` too.
- hover row → move selection; mousedown row → `setActive` + close.
- `Escape` → cancel. Release `Control` → `setActive(selected)` + close.

- [ ] **Step 1: Create the component**

Create `src/components/center/TabSwitcher.tsx`:

```tsx
import { useEffect, useRef, useState } from 'react';
import { useStore } from '../../store';
import { useShallow } from 'zustand/react/shallow';
import { groupTabsByProject, getGroupColor } from '../../lib/tabGrouping';
import { orderTabsByMru, wrapIndex } from '../../lib/tabSwitcher';
import type { Tab } from '../../store/tabsSlice';

function SwitcherIcon({ tab }: { tab: Tab }) {
  if (tab.kind === 'session') return <>{tab.mode === 'terminal' ? '›' : '◇'}</>;
  if (tab.kind === 'terminal') return <>$</>;
  return <>▶</>;
}

export function TabSwitcher() {
  const projects = useStore(useShallow(s => s.projects));
  const [open, setOpen] = useState(false);
  const [snapshot, setSnapshot] = useState<Tab[]>([]);
  const [index, setIndex] = useState(0);

  const openRef = useRef(open);
  const snapRef = useRef(snapshot);
  const idxRef = useRef(index);
  useEffect(() => { openRef.current = open; }, [open]);
  useEffect(() => { snapRef.current = snapshot; }, [snapshot]);
  useEffect(() => { idxRef.current = index; }, [index]);

  const commit = (id: string) => {
    useStore.getState().setActive(id);
    setOpen(false);
  };

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === 'Tab') {
        if (!openRef.current) {
          const state = useStore.getState();
          if (state.tabs.length <= 1) return;
          e.preventDefault();
          e.stopPropagation();
          const ordered = orderTabsByMru(state.tabs, state.mruOrder);
          setSnapshot(ordered);
          setIndex(wrapIndex(e.shiftKey ? -1 : 1, ordered.length));
          setOpen(true);
        } else {
          e.preventDefault();
          e.stopPropagation();
          setIndex(wrapIndex(idxRef.current + (e.shiftKey ? -1 : 1), snapRef.current.length));
        }
        return;
      }
      if (!openRef.current) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        e.stopPropagation();
        setIndex(wrapIndex(idxRef.current + 1, snapRef.current.length));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        setIndex(wrapIndex(idxRef.current - 1, snapRef.current.length));
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Control' && openRef.current) {
        e.preventDefault();
        e.stopPropagation();
        const sel = snapRef.current[idxRef.current];
        if (sel) commit(sel.id);
        else setOpen(false);
      }
    };
    const onBlur = () => { if (openRef.current) setOpen(false); };
    document.addEventListener('keydown', onKeyDown, { capture: true });
    document.addEventListener('keyup', onKeyUp, { capture: true });
    window.addEventListener('blur', onBlur);
    return () => {
      document.removeEventListener('keydown', onKeyDown, { capture: true });
      document.removeEventListener('keyup', onKeyUp, { capture: true });
      window.removeEventListener('blur', onBlur);
    };
  }, []);

  if (!open) return null;

  const groups = groupTabsByProject(snapshot, projects);
  const selectedId = snapshot[index]?.id;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onMouseDown={() => setOpen(false)}
    >
      <div
        className="min-w-[320px] max-w-[480px] max-h-[70vh] overflow-y-auto rounded-md border border-border bg-bg-elev shadow-xl py-2"
        onMouseDown={e => e.stopPropagation()}
      >
        <div className="px-3 pb-1 text-[10px] uppercase tracking-wide text-muted">Przełącz zakładkę</div>
        {groups.map((group, gi) => (
          <div key={group.projectId} className="py-1">
            <div className="px-3 py-0.5 text-[10px] font-semibold" style={{ color: getGroupColor(gi) }}>
              {group.name}
            </div>
            {group.tabs.map(t => {
              const i = snapshot.findIndex(s => s.id === t.id);
              const selected = t.id === selectedId;
              return (
                <div
                  key={t.id}
                  onMouseEnter={() => setIndex(i)}
                  onMouseDown={e => { e.stopPropagation(); commit(t.id); }}
                  className={`flex items-center px-3 py-1 text-[12px] cursor-pointer select-none ${selected ? 'text-fg' : 'text-muted'}`}
                  style={selected ? { backgroundColor: `${getGroupColor(gi)}33` } : undefined}
                >
                  <span className="mr-2 text-muted"><SwitcherIcon tab={t} /></span>
                  <span className="truncate">{t.title}</span>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Mount it in `AppShell`**

In `src/components/layout/AppShell.tsx`, add the import after the `TitleBar` import (line 5):

```tsx
import { TitleBar } from './TitleBar';
import { TabSwitcher } from '../center/TabSwitcher';
```

Render it inside the root element, just before the closing `</div>` of the
outer container (after the `<div className="flex flex-1 min-h-0">…</div>` block,
around line 147):

```tsx
      <div className="flex flex-1 min-h-0">
        {/* ...existing columns... */}
      </div>
      <TabSwitcher />
    </div>
  );
}
```

- [ ] **Step 3: Type-check**

Run: `npm run lint`
Expected: zero errors.

- [ ] **Step 4: Manual smoke test**

Run: `npm run tauri dev`
- Open 3+ tabs across 2 projects.
- Hold Ctrl, tap Tab → overlay appears, highlight on the previous tab; release Ctrl → switches to it.
- Hold Ctrl, tap Tab repeatedly → highlight cycles in MRU order (may jump between project sections); Shift+Tab reverses.
- While holding Ctrl: hover a row → highlight follows; click a row → switches immediately.
- Press Esc while open → closes without switching.
- With a terminal focused, confirm Ctrl+Tab still opens the overlay (xterm does not swallow it).
- With only 1 tab open, Ctrl+Tab does nothing.

- [ ] **Step 5: Commit**

```bash
git add src/components/center/TabSwitcher.tsx src/components/layout/AppShell.tsx
git commit -m "feat(tabs): add Ctrl+Tab visual tab switcher overlay"
```

---

## Task 4: Discoverability in Settings

**Files:**
- Modify: `src/lib/shortcuts.ts`

Add the switcher to `FIXED_SHORTCUTS` (non-rebindable list shown in Settings) and
teach `formatBinding` a literal `ctrl` token so it renders as `Ctrl` (or `⌃` on
macOS) rather than mapping to `⌘`.

- [ ] **Step 1: Add the `ctrl` token to `formatBinding`**

In `src/lib/shortcuts.ts`, inside `formatBinding`'s `.map`, add the `ctrl` case
above the `mod` case:

```ts
    .map(p => {
      if (p === 'ctrl') return IS_MAC ? '⌃' : 'Ctrl';
      if (p === 'mod') return IS_MAC ? '⌘' : 'Ctrl';
      if (p === 'shift') return IS_MAC ? '⇧' : 'Shift';
      if (p === 'alt') return IS_MAC ? '⌥' : 'Alt';
      if (p === '1…9') return '1–9';
      return p.toUpperCase();
    })
```

- [ ] **Step 2: Add the FIXED_SHORTCUTS entry**

Replace the `FIXED_SHORTCUTS` array:

```ts
export const FIXED_SHORTCUTS = [
  { label: 'Akcja 1–9', description: 'Uruchamia akcję o podanym numerze', binding: 'mod+1…9' },
  { label: 'Przełącz zakładki', description: 'Cyklicznie po ostatnio używanych (Shift = wstecz)', binding: 'ctrl+tab' },
];
```

- [ ] **Step 3: Type-check**

Run: `npm run lint`
Expected: zero errors.

- [ ] **Step 4: Verify rendering**

Run: `npm run tauri dev`, open Settings → Skróty. Confirm a "Przełącz zakładki"
row shows `Ctrl+TAB` (non-macOS) / `⌃TAB` (macOS).

- [ ] **Step 5: Commit**

```bash
git add src/lib/shortcuts.ts
git commit -m "feat(tabs): list Ctrl+Tab switcher in settings shortcuts"
```

---

## Task 5: Full verification

**Files:** none (verification only).

- [ ] **Step 1: Run the full frontend test suite**

Run: `npm test`
Expected: all tests pass, including the new `tabSwitcher` and `tabsSlice` suites.

- [ ] **Step 2: Type-check the whole project**

Run: `npm run lint`
Expected: zero errors.

- [ ] **Step 3: Final manual pass**

Run: `npm run tauri dev`. Re-verify the Task 3 Step 4 checklist end to end, plus:
restart the app (so persisted session tabs reload with an empty `mruOrder`), then
Ctrl+Tab — the overlay should fall back to tab order and still switch correctly.
