# Tab Grouping by Project — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Group tabs by project with collapsible headers, colored bottom borders, and horizontal scroll overflow.

**Architecture:** Pure derived state — grouping computed via `useMemo` in `TabBar.tsx`, collapse state in local `useState<Set<number>>`. No store changes. Scroll overflow uses `ResizeObserver` + arrow buttons. Color palette is a constant array indexed by group position.

**Tech Stack:** React 19, Zustand (read-only), Tailwind 4, Vitest + @testing-library/react

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src/lib/tabGrouping.ts` | Create | Grouping logic (`groupTabsByProject`), color palette (`GROUP_COLORS`), color getter (`getGroupColor`) |
| `src/lib/tabGrouping.test.ts` | Create | Unit tests for grouping logic and color assignment |
| `src/components/center/TabBar.tsx` | Modify | Render groups, collapse toggle, scroll overflow, arrow buttons |

Rationale for extracting `tabGrouping.ts`: the grouping function and color palette are pure logic with no React dependency — extracting them makes them independently testable without mocking the store or rendering components. `TabBar.tsx` stays focused on rendering.

---

### Task 1: Grouping Logic + Color Palette

**Files:**
- Create: `src/lib/tabGrouping.ts`
- Create: `src/lib/tabGrouping.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/tabGrouping.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { groupTabsByProject, getGroupColor, GROUP_COLORS } from './tabGrouping';
import type { Tab } from '../store/tabsSlice';

const tab = (id: string, projectId: number, kind: Tab['kind'] = 'session'): Tab => {
  if (kind === 'session') return { kind: 'session', id, projectId, sessionId: id, title: id, mode: 'history' };
  if (kind === 'terminal') return { kind: 'terminal', id, projectId, title: id };
  return { kind: 'action', id, projectId, actionId: 1, title: id, status: 'running' };
};

const projects = [
  { id: 1, name: 'Alpha', path: '/a', claudeDir: '', color: null, sortOrder: 0, createdAt: 0 },
  { id: 2, name: 'Beta', path: '/b', claudeDir: '', color: null, sortOrder: 1, createdAt: 0 },
];

describe('groupTabsByProject', () => {
  it('groups tabs by projectId preserving insertion order', () => {
    const tabs = [tab('a', 1), tab('b', 2), tab('c', 1)];
    const groups = groupTabsByProject(tabs, projects);
    expect(groups).toHaveLength(2);
    expect(groups[0].projectId).toBe(1);
    expect(groups[0].name).toBe('Alpha');
    expect(groups[0].tabs.map(t => t.id)).toEqual(['a', 'c']);
    expect(groups[1].projectId).toBe(2);
    expect(groups[1].tabs.map(t => t.id)).toEqual(['b']);
  });

  it('returns empty array for no tabs', () => {
    expect(groupTabsByProject([], projects)).toEqual([]);
  });

  it('falls back to "Unknown" for missing project', () => {
    const tabs = [tab('x', 999)];
    const groups = groupTabsByProject(tabs, projects);
    expect(groups[0].name).toBe('Unknown');
  });

  it('preserves tab order within a group', () => {
    const tabs = [tab('a', 1), tab('b', 1), tab('c', 1)];
    const groups = groupTabsByProject(tabs, projects);
    expect(groups[0].tabs.map(t => t.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('getGroupColor', () => {
  it('returns different colors for different indices', () => {
    expect(getGroupColor(0)).not.toBe(getGroupColor(1));
  });

  it('wraps around the palette', () => {
    expect(getGroupColor(0)).toBe(getGroupColor(GROUP_COLORS.length));
  });
});

describe('GROUP_COLORS', () => {
  it('has at least 6 colors', () => {
    expect(GROUP_COLORS.length).toBeGreaterThanOrEqual(6);
  });

  it('all entries are valid hex colors', () => {
    for (const c of GROUP_COLORS) {
      expect(c).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/tabGrouping.test.ts`
Expected: FAIL — module `./tabGrouping` not found.

- [ ] **Step 3: Implement the grouping module**

Create `src/lib/tabGrouping.ts`:

```ts
import type { Tab } from '../store/tabsSlice';
import type { Project } from '../types';

export type TabGroup = {
  projectId: number;
  name: string;
  tabs: Tab[];
};

export const GROUP_COLORS = [
  '#6a9fb5',
  '#b58a6a',
  '#8ab56a',
  '#b56a9f',
  '#6ab5a8',
  '#b5a86a',
  '#8a6ab5',
  '#b56a6a',
];

export function getGroupColor(index: number): string {
  return GROUP_COLORS[index % GROUP_COLORS.length];
}

export function groupTabsByProject(tabs: Tab[], projects: Project[]): TabGroup[] {
  const map = new Map<number, TabGroup>();
  for (const tab of tabs) {
    if (!map.has(tab.projectId)) {
      const proj = projects.find(p => p.id === tab.projectId);
      map.set(tab.projectId, { projectId: tab.projectId, name: proj?.name ?? 'Unknown', tabs: [] });
    }
    map.get(tab.projectId)!.tabs.push(tab);
  }
  return Array.from(map.values());
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/tabGrouping.test.ts`
Expected: all 7 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/tabGrouping.ts src/lib/tabGrouping.test.ts
git commit -m "feat(tabs): add tab grouping logic and color palette"
```

---

### Task 2: TabBar — Group Rendering with Collapsible Headers

**Files:**
- Modify: `src/components/center/TabBar.tsx`

This task replaces the flat `tabs.map()` with grouped rendering. The full updated `TabBar.tsx` is provided below. Changes from the original:

1. Import `groupTabsByProject`, `getGroupColor` from `../../lib/tabGrouping`
2. Import `useShallow` (needed for `projects` array selector — see CLAUDE.md gotcha)
3. Add `useMemo` for `groups` and `showGroups`
4. Add `useState<Set<number>>` for `collapsed`
5. Add `useEffect` to auto-expand collapsed group when active tab changes from outside
6. Replace the flat `tabs.map()` with grouped rendering: group wrapper div with `border-bottom`, group header with chevron + name + optional count badge, then tabs (hidden when collapsed)

- [ ] **Step 1: Replace TabBar with grouped rendering**

Replace the entire content of `src/components/center/TabBar.tsx` with:

```tsx
import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../../store';
import { useShallow } from 'zustand/react/shallow';
import { ACTIVITY_DOT, ACTIVITY_LABEL } from '../../lib/activity';
import { selectSessionActivity } from '../../store/sessionsSlice';
import { ConfirmDialog } from '../dialogs/ConfirmDialog';
import { matchesShortcut } from '../../lib/shortcuts';
import { groupTabsByProject, getGroupColor } from '../../lib/tabGrouping';

function TabActivityDot({ tabId, sessionId }: { tabId: string; sessionId: string }) {
  const activity = useStore(selectSessionActivity(tabId, sessionId));
  return (
    <span
      className={`mr-1.5 w-[5px] h-[5px] rounded-full ${ACTIVITY_DOT[activity]}`}
      title={ACTIVITY_LABEL[activity]}
    />
  );
}

function TabIcon({ tab }: { tab: import('../../store/tabsSlice').Tab }) {
  if (tab.kind === 'session') return <>{tab.mode === 'terminal' ? '›' : '◇'}</>;
  if (tab.kind === 'terminal') return <>$</>;
  return <>▶</>;
}

export function TabBar() {
  const tabs = useStore(s => s.tabs);
  const active = useStore(s => s.activeTabId);
  const setActive = useStore(s => s.setActive);
  const closeTab = useStore(s => s.closeTab);
  const renameTab = useStore(s => s.renameTab);
  const projects = useStore(useShallow(s => s.projects));
  const [pendingClose, setPendingClose] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const inputRef = useRef<HTMLInputElement | null>(null);

  const groups = useMemo(() => groupTabsByProject(tabs, projects), [tabs, projects]);
  const showGroups = groups.length > 1;

  const toggleCollapse = (projectId: number) =>
    setCollapsed(prev => {
      const next = new Set(prev);
      if (next.has(projectId)) next.delete(projectId); else next.add(projectId);
      return next;
    });

  useEffect(() => {
    if (!active) return;
    const tab = tabs.find(t => t.id === active);
    if (tab && collapsed.has(tab.projectId)) {
      setCollapsed(prev => {
        const next = new Set(prev);
        next.delete(tab.projectId);
        return next;
      });
    }
  }, [active]);

  const isActiveProcess = (id: string) => {
    const t = tabs.find(x => x.id === id);
    return !!t && ((t.kind === 'session' && t.mode === 'terminal') || t.kind === 'action' || t.kind === 'terminal');
  };

  const closeWithGuard = (id: string) => {
    if (isActiveProcess(id)) setPendingClose(id);
    else closeTab(id);
  };

  const requestClose = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    closeWithGuard(id);
  };

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const overrides = useStore.getState().shortcutOverrides;
      if (!matchesShortcut(e, 'closeTab', overrides)) return;
      if (!active) return;
      e.preventDefault();
      e.stopPropagation();
      closeWithGuard(active);
    };
    document.addEventListener('keydown', onKeyDown, { capture: true });
    return () => document.removeEventListener('keydown', onKeyDown, { capture: true });
  }, [active, tabs, closeTab]);

  const commitRename = (id: string) => {
    const value = inputRef.current?.value.trim();
    if (value) renameTab(id, value);
    setEditingId(null);
  };

  const renderTab = (t: import('../../store/tabsSlice').Tab) => (
    <div
      key={t.id}
      onClick={() => setActive(t.id)}
      onMouseDown={(e) => {
        if (e.button === 1) {
          e.preventDefault();
          e.stopPropagation();
          closeWithGuard(t.id);
        }
      }}
      className={`group relative flex items-center px-3 py-1 text-[11px] border-x border-t cursor-pointer shrink-0 ${
        t.id === active
          ? 'bg-bg-elev border-border text-fg'
          : 'bg-bg border-transparent text-muted hover:text-fg'
      }`}
    >
      {t.kind === 'session' && <TabActivityDot tabId={t.id} sessionId={t.sessionId} />}
      <span className="mr-1.5 text-muted">
        <TabIcon tab={t} />
      </span>
      {editingId === t.id ? (
        <input
          ref={inputRef}
          defaultValue={t.title}
          autoFocus
          onFocus={e => e.target.select()}
          onBlur={() => commitRename(t.id)}
          onKeyDown={e => {
            if (e.key === 'Enter') commitRename(t.id);
            if (e.key === 'Escape') setEditingId(null);
          }}
          onClick={e => e.stopPropagation()}
          className="bg-transparent border-b border-accent outline-none text-[11px] text-fg w-[120px]"
        />
      ) : (
        <span
          className="truncate max-w-[160px] inline-block align-middle"
          onDoubleClick={(e) => {
            e.stopPropagation();
            setEditingId(t.id);
          }}
        >
          {t.title}
        </span>
      )}
      <span
        onClick={(e) => requestClose(e, t.id)}
        className="ml-2 text-muted hover:text-danger opacity-0 group-hover:opacity-100"
      >×</span>
    </div>
  );

  if (tabs.length === 0) return null;

  return (
    <>
      <div className="flex h-8 border-b border-border bg-bg px-2 gap-0.5 items-end overflow-x-auto [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]">
        {showGroups ? (
          groups.map((group, gi) => (
            <div key={group.projectId} className="contents">
              {gi > 0 && <div className="w-2 shrink-0" />}
              <div className="flex items-end shrink-0" style={{ borderBottom: `2px solid ${getGroupColor(gi)}` }}>
                <div
                  onClick={() => toggleCollapse(group.projectId)}
                  className="flex items-center px-2 py-1 cursor-pointer text-[10px] shrink-0 select-none"
                >
                  <span className="mr-1 text-[8px]">{collapsed.has(group.projectId) ? '▶' : '▼'}</span>
                  <span className="font-semibold" style={{ color: getGroupColor(gi) }}>{group.name}</span>
                  {collapsed.has(group.projectId) && (
                    <span
                      className="ml-1 px-1.5 rounded-full text-[9px]"
                      style={{ backgroundColor: `${getGroupColor(gi)}33`, color: getGroupColor(gi) }}
                    >
                      {group.tabs.length}
                    </span>
                  )}
                </div>
                {!collapsed.has(group.projectId) && group.tabs.map(renderTab)}
              </div>
            </div>
          ))
        ) : (
          tabs.map(renderTab)
        )}
      </div>
      {pendingClose && (
        <ConfirmDialog
          title="Zamknąć aktywny tab?"
          message="W tym tabie działa aktywny proces. Zamknięcie zakończy go."
          onCancel={() => setPendingClose(null)}
          onConfirm={() => { closeTab(pendingClose); setPendingClose(null); }}
        />
      )}
    </>
  );
}
```

- [ ] **Step 2: Verify lint passes**

Run: `npm run lint`
Expected: only the 2 pre-existing baseline errors (vite.config.ts + tsconfig.json). No new errors.

- [ ] **Step 3: Smoke test visually**

Run: `npm run tauri dev`
Open two projects with tabs. Verify:
- Groups appear with colored headers and bottom borders
- Clicking `▼`/`▶` toggles group collapse
- Collapsed group shows name + count badge
- Single-project mode shows flat tabs (no headers)
- Activating a tab from sidebar auto-expands its group

- [ ] **Step 4: Commit**

```bash
git add src/components/center/TabBar.tsx
git commit -m "feat(tabs): render grouped tabs with collapsible project headers"
```

---

### Task 3: Scroll Overflow with Arrow Buttons

**Files:**
- Modify: `src/components/center/TabBar.tsx`

This task adds scroll overflow handling: a `scrollRef` on the inner container, `ResizeObserver` for overflow detection, left/right arrow buttons with gradient fade, `onWheel` horizontal translation, and `scrollIntoView` on active tab change.

- [ ] **Step 1: Add scroll state and overflow detection**

In `TabBar()`, add after the existing refs:

```tsx
const scrollRef = useRef<HTMLDivElement>(null);
const [canScrollLeft, setCanScrollLeft] = useState(false);
const [canScrollRight, setCanScrollRight] = useState(false);
```

Add this `useEffect` after the collapse auto-expand effect:

```tsx
useEffect(() => {
  const el = scrollRef.current;
  if (!el) return;
  const check = () => {
    setCanScrollLeft(el.scrollLeft > 0);
    setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
  };
  check();
  el.addEventListener('scroll', check);
  const ro = new ResizeObserver(check);
  ro.observe(el);
  return () => { el.removeEventListener('scroll', check); ro.disconnect(); };
}, [tabs, collapsed]);
```

- [ ] **Step 2: Add scroll-into-view for active tab**

Add this `useEffect` after the overflow detection one:

```tsx
useEffect(() => {
  if (!active || !scrollRef.current) return;
  const el = scrollRef.current.querySelector(`[data-tab-id="${active}"]`);
  if (el) el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}, [active]);
```

Also add `data-tab-id={t.id}` to the tab div in `renderTab`. Add it to the outermost `<div>` of the tab, right after `key={t.id}`:

Change:
```tsx
<div
  key={t.id}
  onClick={() => setActive(t.id)}
```

To:
```tsx
<div
  key={t.id}
  data-tab-id={t.id}
  onClick={() => setActive(t.id)}
```

- [ ] **Step 3: Replace the outer container with scroll structure**

Replace the outer `<div>` that wraps the tab content (the one with `className="flex h-8 border-b ..."`) with this structure:

```tsx
<div className="relative flex h-8 border-b border-border bg-bg items-end">
  <button
    onClick={() => scrollRef.current?.scrollBy({ left: -200, behavior: 'smooth' })}
    className={`absolute left-0 z-10 h-full px-1.5 text-sm bg-gradient-to-r from-bg from-60% to-transparent transition-opacity ${
      canScrollLeft ? 'opacity-100' : 'opacity-0 pointer-events-none'
    }`}
  >‹</button>
  <div
    ref={scrollRef}
    onWheel={(e) => {
      if (scrollRef.current && e.deltaY !== 0) {
        scrollRef.current.scrollLeft += e.deltaY;
        e.preventDefault();
      }
    }}
    className="flex items-end h-full px-2 gap-0.5 overflow-x-auto [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]"
  >
    {showGroups ? (
      groups.map((group, gi) => (
        <div key={group.projectId} className="contents">
          {gi > 0 && <div className="w-2 shrink-0" />}
          <div className="flex items-end shrink-0" style={{ borderBottom: `2px solid ${getGroupColor(gi)}` }}>
            <div
              onClick={() => toggleCollapse(group.projectId)}
              className="flex items-center px-2 py-1 cursor-pointer text-[10px] shrink-0 select-none"
            >
              <span className="mr-1 text-[8px]">{collapsed.has(group.projectId) ? '▶' : '▼'}</span>
              <span className="font-semibold" style={{ color: getGroupColor(gi) }}>{group.name}</span>
              {collapsed.has(group.projectId) && (
                <span
                  className="ml-1 px-1.5 rounded-full text-[9px]"
                  style={{ backgroundColor: `${getGroupColor(gi)}33`, color: getGroupColor(gi) }}
                >
                  {group.tabs.length}
                </span>
              )}
            </div>
            {!collapsed.has(group.projectId) && group.tabs.map(renderTab)}
          </div>
        </div>
      ))
    ) : (
      tabs.map(renderTab)
    )}
  </div>
  <button
    onClick={() => scrollRef.current?.scrollBy({ left: 200, behavior: 'smooth' })}
    className={`absolute right-0 z-10 h-full px-1.5 text-sm bg-gradient-to-l from-bg from-60% to-transparent transition-opacity ${
      canScrollRight ? 'opacity-100' : 'opacity-0 pointer-events-none'
    }`}
  >›</button>
</div>
```

- [ ] **Step 4: Verify lint passes**

Run: `npm run lint`
Expected: only baseline errors.

- [ ] **Step 5: Smoke test scroll behavior**

Run: `npm run tauri dev`
Test:
- Open many tabs until they overflow → arrow buttons appear with gradient fade
- Click arrows → smooth scroll left/right
- Mouse wheel over tab bar → horizontal scroll
- Click a tab that's scrolled out of view (e.g., via sidebar) → it scrolls into view
- Resize window smaller → right arrow appears; resize bigger → arrows disappear

- [ ] **Step 6: Commit**

```bash
git add src/components/center/TabBar.tsx
git commit -m "feat(tabs): add scroll overflow with arrow buttons"
```

---

### Task 4: Final Verification

- [ ] **Step 1: Run full test suite**

Run: `npm test`
Expected: all tests pass (including the new `tabGrouping.test.ts`).

- [ ] **Step 2: Run lint**

Run: `npm run lint`
Expected: only baseline errors.

- [ ] **Step 3: Full visual QA**

Run: `npm run tauri dev`

Checklist:
- [ ] Single project: flat tabs, no headers, no borders
- [ ] Two+ projects: grouped with headers and colored bottom borders
- [ ] Collapse/expand groups by clicking header
- [ ] Collapsed group shows `▶ Name (N)` with colored badge
- [ ] Active tab from sidebar auto-expands collapsed group
- [ ] Scroll arrows appear on overflow, hide when not needed
- [ ] Mouse wheel scrolls horizontally
- [ ] Arrow clicks scroll smoothly
- [ ] Active tab scrolls into view
- [ ] Ctrl/Cmd+W still closes active tab
- [ ] Middle-click on tab still works (close with guard)
- [ ] Double-click to rename still works
- [ ] Tab activity dots still display correctly
- [ ] Light theme: group colors readable on light background
