# Project Launcher (Ctrl+Shift+N) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `Ctrl+Shift+N` quick launcher overlay — a focused search box over a project list where `Enter` starts a new session and `Ctrl+Enter` opens a terminal in the highlighted project.

**Architecture:** A new pure module `src/lib/projectLauncher.ts` holds the filtering + selection math (`filterProjects`, `clampIndex`). A new rebindable shortcut `openProjectLauncher` joins the `SHORTCUTS` registry. A new overlay component `src/components/center/ProjectLauncher.tsx` (mounted once in `AppShell`, next to `TabSwitcher`) owns the open/query/index state, reads sorted projects from the store, and reuses the existing `openNewSessionTab` / `openNewTerminalTab` store actions. No store or Rust changes.

**Tech Stack:** React 19, Zustand 5 (`useShallow`), TypeScript, Tailwind 4, Vitest + jsdom + @testing-library/react.

## Global Constraints

- Identifiers in English only; user-facing UI text in Polish.
- No comments unless the WHY is non-obvious; existing code rarely has comments — match that.
- Commits: Conventional Commits 1.0.0, scope `desktop` (`feat(desktop): …`). No co-author trailer.
- Global document listeners that may conflict with xterm register on `document` in `useEffect` with `{ capture: true }`, then `preventDefault()` + `stopPropagation()`.
- All commands run from `DesktopApp/`. `npm run lint` (= `tsc -b --noEmit`) must report zero errors. Tests run with `npx vitest run <file>` or `npm test`.
- The launcher's `open` / `query` / `index` are ephemeral local component state — never persisted.

---

### Task 1: Pure filtering + selection module

**Files:**
- Create: `DesktopApp/src/lib/projectLauncher.ts`
- Test: `DesktopApp/src/lib/projectLauncher.test.ts`

**Interfaces:**
- Consumes: `Project` from `../types`.
- Produces:
  - `filterProjects(projects: Project[], query: string): Project[]` — blank/whitespace query returns the input array unchanged (sidebar order preserved); otherwise keeps projects whose lowercased `name` or `path` contains the lowercased, trimmed query, in input order.
  - `clampIndex(index: number, length: number): number` — clamps to `[0, length-1]`; returns `0` for an empty list.

- [ ] **Step 1: Write the failing test**

Create `DesktopApp/src/lib/projectLauncher.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import type { Project } from '../types';
import { filterProjects, clampIndex } from './projectLauncher';

const mk = (id: number, name: string, path: string): Project => ({
  id, name, path, claudeDir: '', color: null, sortOrder: id, createdAt: 0,
});

const projects = [
  mk(1, 'AbeonCode', '/home/me/abeon/code'),
  mk(2, 'Mobile', '/home/me/abeon/mobile'),
  mk(3, 'Docs', '/var/www/docs-site'),
];

describe('filterProjects', () => {
  it('returns all projects in input order for a blank query', () => {
    expect(filterProjects(projects, '')).toEqual(projects);
    expect(filterProjects(projects, '   ')).toEqual(projects);
  });

  it('matches by name, case-insensitively', () => {
    expect(filterProjects(projects, 'mob').map(p => p.id)).toEqual([2]);
    expect(filterProjects(projects, 'ABEONCODE').map(p => p.id)).toEqual([1]);
  });

  it('matches by path', () => {
    expect(filterProjects(projects, '/var/www').map(p => p.id)).toEqual([3]);
    expect(filterProjects(projects, 'abeon').map(p => p.id)).toEqual([1, 2]);
  });

  it('returns an empty array when nothing matches', () => {
    expect(filterProjects(projects, 'zzz')).toEqual([]);
  });

  it('preserves input order among matches', () => {
    expect(filterProjects(projects, 'o').map(p => p.id)).toEqual([1, 2, 3]);
  });
});

describe('clampIndex', () => {
  it('clamps to the lower bound', () => {
    expect(clampIndex(-1, 3)).toBe(0);
  });

  it('clamps to the upper bound', () => {
    expect(clampIndex(5, 3)).toBe(2);
  });

  it('returns 0 for an empty list', () => {
    expect(clampIndex(0, 0)).toBe(0);
    expect(clampIndex(2, 0)).toBe(0);
  });

  it('passes through an in-range index', () => {
    expect(clampIndex(1, 3)).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd DesktopApp && npx vitest run src/lib/projectLauncher.test.ts`
Expected: FAIL — `Failed to resolve import "./projectLauncher"`.

- [ ] **Step 3: Write minimal implementation**

Create `DesktopApp/src/lib/projectLauncher.ts`:

```ts
import type { Project } from '../types';

export function filterProjects(projects: Project[], query: string): Project[] {
  const q = query.trim().toLowerCase();
  if (!q) return projects;
  return projects.filter(
    p => p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q),
  );
}

export function clampIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  return Math.max(0, Math.min(index, length - 1));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd DesktopApp && npx vitest run src/lib/projectLauncher.test.ts`
Expected: PASS (all 9 cases green).

- [ ] **Step 5: Commit**

```bash
git add DesktopApp/src/lib/projectLauncher.ts DesktopApp/src/lib/projectLauncher.test.ts
git commit -m "feat(desktop): add project launcher filtering helpers"
```

---

### Task 2: Register the rebindable shortcut

**Files:**
- Modify: `DesktopApp/src/lib/shortcuts.ts:3` (the `ShortcutId` union) and `DesktopApp/src/lib/shortcuts.ts:12-17` (the `SHORTCUTS` array)

**Interfaces:**
- Consumes: nothing new.
- Produces: a new `ShortcutId` member `'openProjectLauncher'` with default binding `mod+shift+n`, consumed by Task 3 via `matchesShortcut(e, 'openProjectLauncher', overrides)`.

**Why no unit test:** `shortcuts.ts` has no test file; this is a data-only addition. The deliverable is verified by `npm run lint` (TS exhaustiveness) and by the shortcut appearing in Settings → Skróty, which `ShortcutsTab` renders by mapping over `SHORTCUTS` (`SettingsDialog.tsx:1006`) — no UI wiring needed.

- [ ] **Step 1: Extend the `ShortcutId` union**

In `DesktopApp/src/lib/shortcuts.ts`, change line 3 from:

```ts
export type ShortcutId = 'newSession' | 'newTerminal' | 'closeTab' | 'focusSearch';
```

to:

```ts
export type ShortcutId = 'newSession' | 'newTerminal' | 'closeTab' | 'focusSearch' | 'openProjectLauncher';
```

- [ ] **Step 2: Append the shortcut definition**

In the `SHORTCUTS` array, add this entry as the last element (after the `focusSearch` entry, before the closing `]`):

```ts
  { id: 'openProjectLauncher', label: 'Szukaj projektu', description: 'Otwiera szybką wyszukiwarkę projektów (nowa sesja / terminal)', defaultBinding: 'mod+shift+n' },
```

- [ ] **Step 3: Verify lint passes**

Run: `cd DesktopApp && npm run lint`
Expected: zero errors (the new `ShortcutId` member is now covered everywhere `SHORTCUTS` is mapped).

- [ ] **Step 4: Verify the binding parses and is conflict-free**

Run: `cd DesktopApp && npx vitest run src/lib`
Expected: PASS. Manually confirm the default `mod+shift+n` differs from `mod+n` / `mod+t` / `mod+w` / `mod+k` (it does — Shift distinguishes it), so `ShortcutsTab` conflict detection will not flag it.

- [ ] **Step 5: Commit**

```bash
git add DesktopApp/src/lib/shortcuts.ts
git commit -m "feat(desktop): register Ctrl+Shift+N project launcher shortcut"
```

---

### Task 3: ProjectLauncher overlay component

**Files:**
- Create: `DesktopApp/src/components/center/ProjectLauncher.tsx`
- Test: `DesktopApp/src/components/center/ProjectLauncher.test.tsx`

**Interfaces:**
- Consumes: `filterProjects`, `clampIndex` (Task 1); `matchesShortcut` + `'openProjectLauncher'` (Task 2); `selectSortedProjects` from `../../store/projectsSlice`; `getProjectColor` from `../../lib/projectColors`; store actions `openNewSessionTab(projectId: number)` / `openNewTerminalTab(projectId: number)`; `Icon` from `../shared/Icon`.
- Produces: `export function ProjectLauncher(): JSX.Element | null`, mounted by Task 4.

**Notes for the implementer:**
- The component is mounted once and always present. Hooks (`useEffect`, `useLayoutEffect`) are declared **before** the `if (!open) return null` early return — never move them after it.
- The open shortcut listener lives on `document` in capture phase so it beats xterm's textarea (mandated pattern). Navigation/commit keys are handled on the search input's own `onKeyDown` (the input is focused while open), so no refs-vs-stale-closure gymnastics are needed.
- Opening resets `query`/`index` and focuses the input inside a `useLayoutEffect` keyed on `open` (runs before paint → no flash of a stale query and guarantees immediate focus).

- [ ] **Step 1: Write the failing test**

Create `DesktopApp/src/components/center/ProjectLauncher.test.tsx`:

```tsx
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { useStore } from '../../store';
import { ProjectLauncher } from './ProjectLauncher';

const openSession = vi.fn();
const openTerminal = vi.fn();

function open() {
  fireEvent.keyDown(document.body, { key: 'n', ctrlKey: true, shiftKey: true });
}

beforeEach(() => {
  vi.clearAllMocks();
  useStore.setState({
    projects: [
      { id: 1, name: 'alpha', path: '/p/alpha' },
      { id: 2, name: 'beta', path: '/p/beta' },
    ] as never,
    sortMode: 'alpha',
    shortcutOverrides: {},
    openNewSessionTab: openSession,
    openNewTerminalTab: openTerminal,
  });
});

describe('ProjectLauncher', () => {
  it('renders nothing until the shortcut is pressed', () => {
    render(<ProjectLauncher />);
    expect(screen.queryByPlaceholderText('Szukaj projektu…')).toBeNull();
  });

  it('opens with the search input focused and the first row selected', () => {
    render(<ProjectLauncher />);
    open();
    const input = screen.getByPlaceholderText('Szukaj projektu…');
    expect(input).toHaveFocus();
    expect(screen.getByText('alpha')).toBeInTheDocument();
  });

  it('Enter starts a new session in the highlighted project', () => {
    render(<ProjectLauncher />);
    open();
    fireEvent.keyDown(screen.getByPlaceholderText('Szukaj projektu…'), { key: 'Enter' });
    expect(openSession).toHaveBeenCalledWith(1);
    expect(openTerminal).not.toHaveBeenCalled();
  });

  it('ArrowDown then Enter targets the second project', () => {
    render(<ProjectLauncher />);
    open();
    const input = screen.getByPlaceholderText('Szukaj projektu…');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(openSession).toHaveBeenCalledWith(2);
  });

  it('Ctrl+Enter opens a terminal in the highlighted project', () => {
    render(<ProjectLauncher />);
    open();
    fireEvent.keyDown(screen.getByPlaceholderText('Szukaj projektu…'), { key: 'Enter', ctrlKey: true });
    expect(openTerminal).toHaveBeenCalledWith(1);
    expect(openSession).not.toHaveBeenCalled();
  });

  it('resets the selection to the first row when the query changes', () => {
    render(<ProjectLauncher />);
    open();
    const input = screen.getByPlaceholderText('Szukaj projektu…');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.change(input, { target: { value: 'a' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(openSession).toHaveBeenCalledWith(1);
  });

  it('filters by path', () => {
    render(<ProjectLauncher />);
    open();
    fireEvent.change(screen.getByPlaceholderText('Szukaj projektu…'), { target: { value: '/p/beta' } });
    expect(screen.queryByText('alpha')).toBeNull();
    expect(screen.getByText('beta')).toBeInTheDocument();
  });

  it('Escape closes the overlay', () => {
    render(<ProjectLauncher />);
    open();
    fireEvent.keyDown(screen.getByPlaceholderText('Szukaj projektu…'), { key: 'Escape' });
    expect(screen.queryByPlaceholderText('Szukaj projektu…')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd DesktopApp && npx vitest run src/components/center/ProjectLauncher.test.tsx`
Expected: FAIL — `Failed to resolve import "./ProjectLauncher"`.

- [ ] **Step 3: Write the component**

Create `DesktopApp/src/components/center/ProjectLauncher.tsx`:

```tsx
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../../store';
import { selectSortedProjects } from '../../store/projectsSlice';
import { filterProjects, clampIndex } from '../../lib/projectLauncher';
import { matchesShortcut } from '../../lib/shortcuts';
import { getProjectColor } from '../../lib/projectColors';
import { Icon } from '../shared/Icon';

export function ProjectLauncher() {
  const projects = useStore(useShallow(selectSortedProjects));
  const openNewSession = useStore(s => s.openNewSessionTab);
  const openNewTerminal = useStore(s => s.openNewTerminalTab);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!matchesShortcut(e, 'openProjectLauncher', useStore.getState().shortcutOverrides)) return;
      e.preventDefault();
      e.stopPropagation();
      setOpen(o => !o);
    };
    document.addEventListener('keydown', onKeyDown, { capture: true });
    return () => document.removeEventListener('keydown', onKeyDown, { capture: true });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    setQuery('');
    setIndex(0);
    inputRef.current?.focus();
  }, [open]);

  if (!open) return null;

  const list = filterProjects(projects, query);
  const selected = list[index];
  const close = () => setOpen(false);

  const launch = (projectId: number, terminal: boolean) => {
    if (terminal) openNewTerminal(projectId);
    else openNewSession(projectId);
    close();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-[15vh]"
      onMouseDown={close}
    >
      <div
        className="w-[460px] max-w-[90vw] max-h-[60vh] flex flex-col rounded-md border border-border bg-bg-elev shadow-xl overflow-hidden"
        onMouseDown={e => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-3 py-2.5 border-b border-border">
          <Icon name="search" className="w-[13px] h-[13px] text-muted" />
          <input
            ref={inputRef}
            value={query}
            onChange={e => { setQuery(e.target.value); setIndex(0); }}
            onKeyDown={e => {
              if (e.key === 'ArrowDown') {
                e.preventDefault(); e.stopPropagation();
                setIndex(i => clampIndex(i + 1, list.length));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault(); e.stopPropagation();
                setIndex(i => clampIndex(i - 1, list.length));
              } else if (e.key === 'Enter') {
                e.preventDefault(); e.stopPropagation();
                if (selected) launch(selected.id, e.ctrlKey || e.metaKey);
              } else if (e.key === 'Escape') {
                e.preventDefault(); e.stopPropagation();
                close();
              }
            }}
            placeholder="Szukaj projektu…"
            className="bg-transparent outline-none text-[13px] text-fg flex-1 placeholder:text-muted"
          />
        </div>
        <div className="overflow-y-auto scroll-thin py-1">
          {list.length === 0 && (
            <div className="px-3 py-2 text-[12px] text-muted">— brak —</div>
          )}
          {list.map((p, i) => {
            const color = getProjectColor(p);
            const isSelected = i === index;
            return (
              <div
                key={p.id}
                onMouseEnter={() => setIndex(i)}
                onMouseDown={e => { e.stopPropagation(); launch(p.id, false); }}
                className={`flex items-center gap-2 px-3 py-1.5 cursor-pointer select-none ${isSelected ? 'text-fg' : 'text-muted'}`}
                style={isSelected ? { backgroundColor: `${color}33` } : undefined}
              >
                <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: color }} />
                <span className="text-[12.5px] truncate">{p.name}</span>
                <span className="text-[11px] text-muted truncate ml-1">{p.path}</span>
              </div>
            );
          })}
        </div>
        <div className="px-3 py-1.5 border-t border-border text-[10px] text-muted">
          Enter — nowa sesja · Ctrl+Enter — terminal · Esc — zamknij
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd DesktopApp && npx vitest run src/components/center/ProjectLauncher.test.tsx`
Expected: PASS (all 8 cases green).

- [ ] **Step 5: Verify lint passes**

Run: `cd DesktopApp && npm run lint`
Expected: zero errors.

- [ ] **Step 6: Commit**

```bash
git add DesktopApp/src/components/center/ProjectLauncher.tsx DesktopApp/src/components/center/ProjectLauncher.test.tsx
git commit -m "feat(desktop): add ProjectLauncher overlay component"
```

---

### Task 4: Mount the launcher in AppShell

**Files:**
- Modify: `DesktopApp/src/components/layout/AppShell.tsx:9` (import) and `DesktopApp/src/components/layout/AppShell.tsx:227` (render, next to `<TabSwitcher />`)

**Interfaces:**
- Consumes: `ProjectLauncher` (Task 3).
- Produces: nothing — terminal wiring task.

- [ ] **Step 1: Add the import**

In `DesktopApp/src/components/layout/AppShell.tsx`, below the existing `TabSwitcher` import (line 9):

```tsx
import { TabSwitcher } from '../center/TabSwitcher';
import { ProjectLauncher } from '../center/ProjectLauncher';
```

- [ ] **Step 2: Render the overlay**

Find the `<TabSwitcher />` render (near line 227) and add `<ProjectLauncher />` right after it:

```tsx
      <TabSwitcher />
      <ProjectLauncher />
```

- [ ] **Step 3: Verify lint + full test suite pass**

Run: `cd DesktopApp && npm run lint && npm test`
Expected: lint zero errors; the full Vitest suite passes (including the two new files).

- [ ] **Step 4: Manual verification**

Run `cd DesktopApp && npm run tauri dev`, then verify:
- `Ctrl+Shift+N` opens the overlay **even while an xterm terminal is focused** (capture-phase listener wins).
- The search input is focused immediately; typing filters by name and by path; the first row is highlighted and re-highlights on every keystroke.
- `ArrowDown` / `ArrowUp` move the highlight (clamped — no wrap past the ends).
- `Enter` opens a new session in the highlighted project; with >1 provider enabled it opens the provider picker (reused `openNewSessionTab` behavior).
- `Ctrl+Enter` opens a terminal in the highlighted project.
- Clicking a row starts a new session; clicking the dimmed backdrop and `Escape` both close without launching.
- `Ctrl+Shift+N` while open toggles it closed.
- Settings → Skróty lists "Szukaj projektu", lets you rebind it, and flags a conflict if you try a binding already used by another shortcut.

- [ ] **Step 5: Commit**

```bash
git add DesktopApp/src/components/layout/AppShell.tsx
git commit -m "feat(desktop): mount ProjectLauncher in AppShell"
```

---

## Self-Review

**Spec coverage:**
- Shortcut `Ctrl+Shift+N` → Task 2 (registration) + Task 3 (listener). ✓
- Search box on top, focused immediately → Task 3 (`useLayoutEffect` focus + input at top). ✓
- First row always highlighted, resets on filter change → Task 3 (`index` reset in `onChange` + open effect). ✓
- `Enter` → new session; `Ctrl+Enter` → terminal → Task 3 (`launch`). ✓
- Arrow navigation, clamp, reset-to-first → Task 1 (`clampIndex`) + Task 3. ✓
- Ordering as sidebar → Task 3 (`selectSortedProjects`). ✓
- Search by name + path → Task 1 (`filterProjects`). ✓
- Rebindable + conflict detection + Settings entry → Task 2 (joins `SHORTCUTS`). ✓
- Reuse `openNewSessionTab` / provider-picker behavior → Task 3 (no special-casing). ✓
- Empty-state, backdrop/Escape close, mouse parity → Task 3. ✓

**Placeholder scan:** No TBD/TODO; every code and test step contains complete content. ✓

**Type consistency:** `filterProjects(projects, query)` and `clampIndex(index, length)` signatures are identical across Task 1, its tests, and Task 3's usage. Store actions referenced as `openNewSessionTab` / `openNewTerminalTab` match `tabsSlice`. `ShortcutId` member `'openProjectLauncher'` is defined in Task 2 and consumed in Task 3. ✓
