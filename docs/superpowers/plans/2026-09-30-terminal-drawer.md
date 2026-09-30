# Session Terminal Drawer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Opening a terminal from a session slides out a bottom drawer inside that session's pane; the drawer can be split Ghostty-style and any split can be detached into a regular terminal tab without restarting the shell.

**Architecture:** Drawer terminals are extra absolutely positioned layers in the single layer container of `PaneLayout`, rendered in the same keyed array as tab layers and sorted by id, so detaching only changes a layer's rectangle (no remount, the PTY and scrollback survive). Drawer state lives in a new `terminalDrawersSlice` that reuses `PaneNode` from `lib/paneTree.ts` for splits; `tabs[]` and `reconcilePanes` stay unaware of drawers until a terminal is detached. Geometry is expressed as linear `pct% + px` values in a pure module.

**Tech Stack:** React 19, Zustand 5, TypeScript, Tailwind 4, xterm.js 6, Vitest + jsdom + Testing Library. Frontend only — no Rust changes.

**Spec:** `docs/superpowers/specs/2026-09-30-terminal-drawer-design.md`

## Global Constraints

- All commands run from `DesktopApp/` (`npx vitest run <file>`, `npm test`, `npm run lint`).
- Identifiers in English only; user-facing UI text in Polish.
- No new code comments (the user's global rule). Keep existing comments you move as they are.
- Commits: Conventional Commits with scope `desktop` (e.g. `feat(desktop): …`). No `Co-Authored-By` trailer, no `Claude-Session` line.
- Never call `term.dispose()` in `TerminalView`.
- Content layers must never change DOM parent and must keep their relative order — they are rendered from one array, keyed by tab/terminal id, sorted by id.
- Zustand selectors that build new arrays/objects must use `useShallow`.
- Drawer size range 0.2–0.8, default 0.35; header 28 px; min session and drawer body height 120 px; min drawer split 160 × 60 px.
- Shortcuts: `mod+t` toggles the drawer in a session; `mod+shift+o` split right; `mod+shift+e` split down; `mod+alt+arrows` (fixed) move focus between splits; `mod+w` closes the focused drawer terminal when the drawer holds the keyboard.
- Baseline before starting: 84 test files / 697 tests passing, `npm run lint` clean.

## Review Focus

- A pane too short for both minimum heights (e.g. 250 px of content after a vertical pane split) — dragging the divider must keep the size inside 0.2–0.8 and never produce `NaN` or an inverted range (Task 1 test `falls back to the global range…`).
- A drawer terminal whose shell exits while its "Zamknąć terminal?" dialog is open — the dialog must vanish and a later confirm must not close some other terminal (Task 2 test `clears a close prompt whose terminal is gone`).
- `mod+shift+o` / `mod+shift+e` / `mod+alt+arrows` pressed while the keyboard is in the Claude session (drawer open but unfocused) — the keystroke must reach Claude untouched (Task 8 test `lets split shortcuts through…`).
- The last drawer shell exits (`exit`, Ctrl+D) while it held the keyboard — the keyboard must go back to the session terminal, not into the void (Task 6 test `hands the keyboard back to the session…`).
- Closing a session in history mode whose drawer is hidden — the user may have forgotten the shells, so closing must ask and say how many terminals die (Task 9 test `asks before closing a history session…`).

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `src/lib/drawerGeometry.ts` | create | `Len` arithmetic, CSS formatting, drawer rectangles, divider clamping, directional neighbour lookup |
| `src/lib/paneLayers.ts` | create | Pure function turning tabs + panes + drawers into the sorted layer list and the visible drawers |
| `src/store/terminalDrawersSlice.ts` | create | Drawer state and every drawer action; selectors for drawer terminals |
| `src/components/center/TerminalDrawerChrome.tsx` | create | Drawer header, session/drawer divider, in-drawer resizers, focus ring, close-confirm dialog |
| `src/components/center/useTerminalDrawerShortcuts.ts` | create | Split and focus-navigation shortcuts while the drawer holds the keyboard |
| `src/lib/paneTree.ts` | modify | Export `replaceSplitSizes` (moved from `panesSlice`) |
| `src/store/panesSlice.ts` | modify | Use `replaceSplitSizes` |
| `src/store/settingsSlice.ts` | modify | Persisted `terminalDrawerSize` |
| `src/store/index.ts` | modify | Compose slice, persist size, prune orphaned drawers |
| `src/components/terminal/TerminalView.tsx` | modify | `takeFocus` and `onExit` props |
| `src/components/center/TabContent.tsx` | modify | Pass `takeFocus` / `onExit` to `TerminalView` |
| `src/components/center/PaneResizers.tsx` | modify | Generic `SplitResizers` + thin `PaneResizers` |
| `src/components/center/PaneLayout.tsx` | modify | Render layers from `computePaneLayers`, drawer chrome, shortcuts hook |
| `src/components/shared/Icon.tsx` | modify | `splitRow`, `splitCol`, `toTab` icons |
| `src/lib/shortcuts.ts` | modify | New shortcut ids, drawer focus bindings, `arrows` badge |
| `src/components/layout/AppShell.tsx`, `center/TabBar.tsx`, `center/StackedTabBar.tsx`, `right/ProjectToolbar.tsx`, `history/HistoryHeader.tsx`, `sidebar/ProjectItem.tsx`, `center/ProjectLauncher.tsx` | modify | Route through `openTerminal` |
| `src/components/center/useTabBarActions.tsx` | modify | `mod+w` routing, close message, session/group detach with drawers |
| `src/lib/tabProcess.ts` | modify | Drawer-aware `isTabLiveProcess`, `closeConfirmMessage` |
| `src/components/layout/DetachedShell.tsx`, `layout/TitleBar.tsx` | modify | Drawer-aware close guard, live-shell count |
| `DesktopApp/CLAUDE.md` | modify | Document the drawer |

---

### Task 1: Drawer geometry

**Files:**
- Create: `src/lib/drawerGeometry.ts`
- Test: `src/lib/drawerGeometry.test.ts`

**Interfaces:**
- Consumes: `computePaneRects`, `PaneRect` from `src/lib/paneGeometry.ts`; `PaneNode` from `src/lib/paneTree.ts`.
- Produces:
  - constants `DRAWER_HEADER_HEIGHT = 28`, `DRAWER_DEFAULT_SIZE = 0.35`, `DRAWER_MIN_SIZE = 0.2`, `DRAWER_MAX_SIZE = 0.8`, `DRAWER_MIN_SESSION_HEIGHT = 120`, `DRAWER_MIN_BODY_HEIGHT = 120`, `DRAWER_MIN_SPLIT_WIDTH = 160`, `DRAWER_MIN_SPLIT_HEIGHT = 60`
  - `type Len = { pct: number; px: number }`, `type LenRect = { left: Len; top: Len; width: Len; height: Len }`, `type Direction = 'left' | 'right' | 'up' | 'down'`
  - `len(pct: number, px?: number): Len`, `addLen(a: Len, b: Len): Len`, `scaleLen(a: Len, k: number): Len`, `resolveLen(a: Len, totalPx: number): number`, `cssLen(a: Len): string`
  - `lenRectStyle(r: LenRect): { left: string; top: string; width: string; height: string }`
  - `paneContentRect(pane: PaneRect, barHeight: number): LenRect`
  - `withinRect(frame: LenRect, r: PaneRect): LenRect`
  - `type DrawerLayoutRects = { content: LenRect; session: LenRect; header: LenRect; body: LenRect; terminals: Map<string, LenRect> }`
  - `computeDrawerLayout(pane: PaneRect, barHeight: number, size: number, layout: PaneNode): DrawerLayoutRects`
  - `clampDrawerSize(next: number, contentPx: number): number`
  - `neighborInDirection(layout: PaneNode, fromId: string, dir: Direction): string | null`

- [ ] **Step 1: Write the failing test**

Create `src/lib/drawerGeometry.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  DRAWER_DEFAULT_SIZE,
  DRAWER_HEADER_HEIGHT,
  DRAWER_MAX_SIZE,
  DRAWER_MIN_SIZE,
  addLen,
  clampDrawerSize,
  computeDrawerLayout,
  cssLen,
  len,
  lenRectStyle,
  neighborInDirection,
  paneContentRect,
  resolveLen,
  scaleLen,
} from './drawerGeometry';
import { createLeaf, type PaneNode } from './paneTree';

const FULL = { left: 0, top: 0, width: 100, height: 100 };
const single = createLeaf('a', ['a'], 'a');
const row: PaneNode = {
  kind: 'split', id: 'r', dir: 'row', sizes: [0.5, 0.5],
  children: [createLeaf('a', ['a'], 'a'), createLeaf('b', ['b'], 'b')],
};
const mixed: PaneNode = {
  kind: 'split', id: 'r', dir: 'row', sizes: [0.5, 0.5],
  children: [
    createLeaf('a', ['a'], 'a'),
    {
      kind: 'split', id: 'c', dir: 'col', sizes: [0.5, 0.5],
      children: [createLeaf('b', ['b'], 'b'), createLeaf('c', ['c'], 'c')],
    },
  ],
};

describe('Len arithmetic', () => {
  it('formats percent-only, positive and negative pixel offsets', () => {
    expect(cssLen(len(50))).toBe('50%');
    expect(cssLen(len(0, 32))).toBe('calc(0% + 32px)');
    expect(cssLen(len(100, -32))).toBe('calc(100% - 32px)');
  });

  it('rounds float noise away', () => {
    expect(cssLen(len(100 / 3))).toBe('33.3333%');
    expect(cssLen(scaleLen(len(100, -32), 0.65))).toBe('calc(65% - 20.8px)');
  });

  it('adds, scales and resolves against a pixel size', () => {
    const v = addLen(len(50, 10), scaleLen(len(20, -4), 0.5));
    expect(v.pct).toBeCloseTo(60);
    expect(v.px).toBeCloseTo(8);
    expect(resolveLen(v, 1000)).toBeCloseTo(608);
  });
});

describe('computeDrawerLayout', () => {
  it('keeps the plain content rect format of a pane without a drawer', () => {
    const c = paneContentRect(FULL, 32);
    expect(lenRectStyle(c)).toEqual({
      left: '0%', top: 'calc(0% + 32px)', width: '100%', height: 'calc(100% - 32px)',
    });
  });

  it('splits the content into session, header and body', () => {
    const r = computeDrawerLayout(FULL, 32, 0.35, single);
    expect(cssLen(r.session.height)).toBe('calc(65% - 20.8px)');
    expect(cssLen(r.header.top)).toBe('calc(65% + 11.2px)');
    expect(cssLen(r.header.height)).toBe(`calc(0% + ${DRAWER_HEADER_HEIGHT}px)`);
    expect(cssLen(r.body.top)).toBe('calc(65% + 39.2px)');
    expect(cssLen(r.body.height)).toBe('calc(35% - 39.2px)');
    expect(lenRectStyle(r.terminals.get('a')!)).toEqual(lenRectStyle(r.body));
    expect(lenRectStyle(r.content)).toEqual(lenRectStyle(paneContentRect(FULL, 32)));
  });

  it('lays terminals out inside the body of an offset pane', () => {
    const r = computeDrawerLayout({ left: 50, top: 0, width: 50, height: 100 }, 32, 0.5, row);
    expect(cssLen(r.header.left)).toBe('50%');
    expect(cssLen(r.header.width)).toBe('50%');
    expect(cssLen(r.terminals.get('b')!.left)).toBe('75%');
    expect(cssLen(r.terminals.get('b')!.width)).toBe('25%');
  });

  it('stacks a column split vertically inside the body', () => {
    const r = computeDrawerLayout(FULL, 32, 0.5, mixed);
    expect(cssLen(r.terminals.get('c')!.top)).toBe('calc(75% + 22px)');
    expect(cssLen(r.terminals.get('c')!.height)).toBe('calc(25% - 22px)');
  });
});

describe('clampDrawerSize', () => {
  it('keeps the size inside the global range', () => {
    expect(clampDrawerSize(0.95, 1000)).toBe(DRAWER_MAX_SIZE);
    expect(clampDrawerSize(0.05, 1000)).toBe(DRAWER_MIN_SIZE);
  });

  it('protects the minimum session and drawer heights', () => {
    expect(clampDrawerSize(0.1, 500)).toBeCloseTo((120 + 28) / 500);
    expect(clampDrawerSize(0.79, 500)).toBeCloseTo(1 - 120 / 500);
  });

  it('falls back to the global range when a pane is too short for both minimums', () => {
    expect(clampDrawerSize(0.5, 200)).toBe(0.5);
    expect(clampDrawerSize(0.9, 200)).toBe(DRAWER_MAX_SIZE);
    expect(clampDrawerSize(0.5, 0)).toBe(0.5);
    expect(clampDrawerSize(Number.NaN, 500)).toBe(DRAWER_DEFAULT_SIZE);
  });
});

describe('neighborInDirection', () => {
  it('finds the adjacent split in every direction', () => {
    expect(neighborInDirection(mixed, 'a', 'right')).toBe('b');
    expect(neighborInDirection(mixed, 'b', 'left')).toBe('a');
    expect(neighborInDirection(mixed, 'c', 'left')).toBe('a');
    expect(neighborInDirection(mixed, 'b', 'down')).toBe('c');
    expect(neighborInDirection(mixed, 'c', 'up')).toBe('b');
  });

  it('returns null at the edges and for unknown ids', () => {
    expect(neighborInDirection(mixed, 'a', 'left')).toBeNull();
    expect(neighborInDirection(mixed, 'a', 'up')).toBeNull();
    expect(neighborInDirection(mixed, 'x', 'left')).toBeNull();
    expect(neighborInDirection(single, 'a', 'right')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/drawerGeometry.test.ts`
Expected: FAIL — `Failed to resolve import "./drawerGeometry"`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/drawerGeometry.ts`:

```ts
import { computePaneRects, type PaneRect } from './paneGeometry';
import type { PaneNode } from './paneTree';

export const DRAWER_HEADER_HEIGHT = 28;
export const DRAWER_DEFAULT_SIZE = 0.35;
export const DRAWER_MIN_SIZE = 0.2;
export const DRAWER_MAX_SIZE = 0.8;
export const DRAWER_MIN_SESSION_HEIGHT = 120;
export const DRAWER_MIN_BODY_HEIGHT = 120;
export const DRAWER_MIN_SPLIT_WIDTH = 160;
export const DRAWER_MIN_SPLIT_HEIGHT = 60;

export type Len = { pct: number; px: number };
export type LenRect = { left: Len; top: Len; width: Len; height: Len };
export type Direction = 'left' | 'right' | 'up' | 'down';

export const len = (pct: number, px = 0): Len => ({ pct, px });
export const addLen = (a: Len, b: Len): Len => ({ pct: a.pct + b.pct, px: a.px + b.px });
export const scaleLen = (a: Len, k: number): Len => ({ pct: a.pct * k, px: a.px * k });
export const resolveLen = (a: Len, totalPx: number): number => (a.pct / 100) * totalPx + a.px;

const round = (v: number) => Number(v.toFixed(4)) + 0;

export function cssLen(a: Len): string {
  const pct = round(a.pct);
  const px = round(a.px);
  if (px === 0) return `${pct}%`;
  return px > 0 ? `calc(${pct}% + ${px}px)` : `calc(${pct}% - ${-px}px)`;
}

export function lenRectStyle(r: LenRect) {
  return { left: cssLen(r.left), top: cssLen(r.top), width: cssLen(r.width), height: cssLen(r.height) };
}

export function paneContentRect(pane: PaneRect, barHeight: number): LenRect {
  return {
    left: len(pane.left),
    top: len(pane.top, barHeight),
    width: len(pane.width),
    height: len(pane.height, -barHeight),
  };
}

export function withinRect(frame: LenRect, r: PaneRect): LenRect {
  return {
    left: addLen(frame.left, scaleLen(frame.width, r.left / 100)),
    top: addLen(frame.top, scaleLen(frame.height, r.top / 100)),
    width: scaleLen(frame.width, r.width / 100),
    height: scaleLen(frame.height, r.height / 100),
  };
}

export type DrawerLayoutRects = {
  content: LenRect;
  session: LenRect;
  header: LenRect;
  body: LenRect;
  terminals: Map<string, LenRect>;
};

export function computeDrawerLayout(pane: PaneRect, barHeight: number, size: number, layout: PaneNode): DrawerLayoutRects {
  const content = paneContentRect(pane, barHeight);
  const sessionHeight = scaleLen(content.height, 1 - size);
  const drawerTop = addLen(content.top, sessionHeight);
  const header: LenRect = {
    left: content.left,
    top: drawerTop,
    width: content.width,
    height: len(0, DRAWER_HEADER_HEIGHT),
  };
  const body: LenRect = {
    left: content.left,
    top: addLen(drawerTop, len(0, DRAWER_HEADER_HEIGHT)),
    width: content.width,
    height: addLen(scaleLen(content.height, size), len(0, -DRAWER_HEADER_HEIGHT)),
  };
  const terminals = new Map<string, LenRect>();
  for (const [id, rect] of computePaneRects(layout)) terminals.set(id, withinRect(body, rect));
  return { content, session: { ...content, height: sessionHeight }, header, body, terminals };
}

export function clampDrawerSize(next: number, contentPx: number): number {
  if (!Number.isFinite(next)) return DRAWER_DEFAULT_SIZE;
  const globalClamp = Math.min(DRAWER_MAX_SIZE, Math.max(DRAWER_MIN_SIZE, next));
  if (!(contentPx > 0)) return globalClamp;
  const min = Math.max(DRAWER_MIN_SIZE, (DRAWER_MIN_BODY_HEIGHT + DRAWER_HEADER_HEIGHT) / contentPx);
  const max = Math.min(DRAWER_MAX_SIZE, 1 - DRAWER_MIN_SESSION_HEIGHT / contentPx);
  if (min > max) return globalClamp;
  return Math.min(max, Math.max(min, next));
}

const EDGE_EPSILON = 1e-6;

export function neighborInDirection(layout: PaneNode, fromId: string, dir: Direction): string | null {
  const rects = computePaneRects(layout);
  const from = rects.get(fromId);
  if (!from) return null;
  const horizontal = dir === 'left' || dir === 'right';
  let best: { id: string; overlap: number } | null = null;
  for (const [id, r] of rects) {
    if (id === fromId) continue;
    const gap =
      dir === 'left' ? from.left - (r.left + r.width)
      : dir === 'right' ? r.left - (from.left + from.width)
      : dir === 'up' ? from.top - (r.top + r.height)
      : r.top - (from.top + from.height);
    if (Math.abs(gap) > EDGE_EPSILON) continue;
    const overlap = horizontal
      ? Math.min(from.top + from.height, r.top + r.height) - Math.max(from.top, r.top)
      : Math.min(from.left + from.width, r.left + r.width) - Math.max(from.left, r.left);
    if (overlap <= EDGE_EPSILON) continue;
    if (!best || overlap > best.overlap) best = { id, overlap };
  }
  return best?.id ?? null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/drawerGeometry.test.ts`
Expected: PASS (all tests). If a `cssLen` string differs only by float noise (e.g. `11.200000000000001`), the `round` helper is missing from that path — fix the implementation, not the test.

- [ ] **Step 5: Commit**

```bash
git add src/lib/drawerGeometry.ts src/lib/drawerGeometry.test.ts
git commit -m "feat(desktop): add terminal drawer geometry helpers"
```

---

### Task 2: Terminal drawers slice (core) and persisted drawer size

**Files:**
- Create: `src/store/terminalDrawersSlice.ts`
- Modify: `src/lib/paneTree.ts` (add `replaceSplitSizes`), `src/store/panesSlice.ts:28-33,68-70`, `src/store/settingsSlice.ts`, `src/store/index.ts`
- Test: `src/store/terminalDrawersSlice.test.ts`

**Interfaces:**
- Consumes: Task 1 `neighborInDirection`, `Direction`, `DRAWER_DEFAULT_SIZE`, `DRAWER_MIN_SIZE`, `DRAWER_MAX_SIZE`; `paneTree` (`collapseEmpty`, `createLeaf`, `insertBeside`, `leaves`, `removeTabFromLeaves`).
- Produces:
  - `replaceSplitSizes(node: PaneNode, splitId: string, sizes: number[]): PaneNode` exported from `src/lib/paneTree.ts`
  - `SettingsSlice.terminalDrawerSize: number`, `SettingsSlice.setTerminalDrawerSize(size: number): void` (persisted key `terminalDrawerSize`)
  - `type DrawerTerminal = { id: string; ownerTabId: string; projectId: number; title: string }`
  - `type TerminalDrawer = { open: boolean; hasFocus: boolean; layout: PaneNode; focusedTerminalId: string }` — invariant: every leaf id equals the terminal id it holds; a drawer exists only while it has ≥1 terminal
  - `toTerminalTab(t: DrawerTerminal): Extract<Tab, { kind: 'terminal' }>`
  - `countDrawerTerminals(state: Pick<TerminalDrawersSlice, 'drawerTerminals'>, ownerTabId: string): number`
  - slice state `drawers: Record<string, TerminalDrawer>` (key = session tab id), `drawerTerminals: Record<string, DrawerTerminal>`, `drawerDragSize: number | null`, `drawerClosePrompt: string | null`
  - actions `toggleTerminalDrawer(tabId)`, `showTerminalDrawer(tabId)`, `hideTerminalDrawer(tabId)`, `splitDrawerTerminal(tabId, dir: 'row' | 'col')`, `focusDrawerTerminal(tabId, terminalId)`, `focusDrawerSession(tabId)`, `moveDrawerFocus(tabId, dir: Direction)`, `closeDrawerTerminal(terminalId)`, `requestCloseDrawerTerminal(terminalId)`, `cancelCloseDrawerTerminal()`, `resizeDrawerSplit(tabId, splitId, sizes)`, `setDrawerDragSize(size | null)`

- [ ] **Step 1: Write the failing test**

Create `src/store/terminalDrawersSlice.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from './index';
import { ROOT_PANE_ID } from './panesSlice';
import { createLeaf, leaves, type PaneSplit } from '../lib/paneTree';
import type { Tab } from './tabsSlice';

const session = (id: string, projectId = 1, extra: Partial<Extract<Tab, { kind: 'session' }>> = {}): Tab => ({
  kind: 'session', id, projectId, sessionId: id, title: id, mode: 'terminal', ...extra,
});

const drawer = () => useStore.getState().drawers.s1;
const terminalIds = () => leaves(drawer().layout).map(l => l.id);

beforeEach(() => {
  useStore.setState({
    tabs: [session('s1')],
    activeTabId: 's1',
    mruOrder: [],
    navHistory: [],
    navIndex: 0,
    layout: createLeaf(ROOT_PANE_ID, ['s1'], 's1'),
    focusedPaneId: ROOT_PANE_ID,
    drawers: {},
    drawerTerminals: {},
    drawerDragSize: null,
    drawerClosePrompt: null,
  });
});

describe('terminal drawer toggle', () => {
  it('creates a focused drawer with one shell on first toggle', () => {
    useStore.getState().toggleTerminalDrawer('s1');
    expect(drawer()).toMatchObject({ open: true, hasFocus: true });
    const [id] = terminalIds();
    expect(id.startsWith('terminal:')).toBe(true);
    expect(drawer().focusedTerminalId).toBe(id);
    expect(useStore.getState().drawerTerminals[id]).toEqual({ id, ownerTabId: 's1', projectId: 1, title: 'Terminal' });
  });

  it('moves the keyboard into a visible drawer before hiding it', () => {
    useStore.getState().toggleTerminalDrawer('s1');
    useStore.getState().focusDrawerSession('s1');
    expect(drawer().hasFocus).toBe(false);

    useStore.getState().toggleTerminalDrawer('s1');
    expect(drawer()).toMatchObject({ open: true, hasFocus: true });

    useStore.getState().toggleTerminalDrawer('s1');
    expect(drawer()).toMatchObject({ open: false, hasFocus: false });
    expect(terminalIds()).toHaveLength(1);
  });

  it('reopens a hidden drawer with its terminals intact', () => {
    useStore.getState().toggleTerminalDrawer('s1');
    const [id] = terminalIds();
    useStore.getState().hideTerminalDrawer('s1');
    useStore.getState().toggleTerminalDrawer('s1');
    expect(drawer()).toMatchObject({ open: true, hasFocus: true, focusedTerminalId: id });
  });

  it('never hides the drawer through show', () => {
    useStore.getState().showTerminalDrawer('s1');
    useStore.getState().showTerminalDrawer('s1');
    expect(drawer()).toMatchObject({ open: true, hasFocus: true });
  });

  it('ignores tabs that are not sessions', () => {
    useStore.setState({ tabs: [{ kind: 'terminal', id: 't1', projectId: 1, title: 'T' }] });
    useStore.getState().toggleTerminalDrawer('t1');
    expect(useStore.getState().drawers).toEqual({});
  });

  it('pins a preview tab when it gets a drawer', () => {
    useStore.setState({ tabs: [session('s1', 1, { mode: 'history', preview: true })] });
    useStore.getState().toggleTerminalDrawer('s1');
    const tab = useStore.getState().tabs[0];
    expect(tab.kind === 'session' && tab.preview).toBe(false);
  });
});

describe('terminal drawer splits', () => {
  it('splits beside the focused terminal and focuses the new one', () => {
    useStore.getState().toggleTerminalDrawer('s1');
    const [first] = terminalIds();
    useStore.getState().splitDrawerTerminal('s1', 'row');
    const root = drawer().layout as PaneSplit;
    expect(root.kind).toBe('split');
    expect(root.dir).toBe('row');
    const [, second] = terminalIds();
    expect(terminalIds()).toEqual([first, second]);
    expect(drawer().focusedTerminalId).toBe(second);
    expect(useStore.getState().drawerTerminals[second].ownerTabId).toBe('s1');
  });

  it('nests a split of the other direction', () => {
    useStore.getState().toggleTerminalDrawer('s1');
    useStore.getState().splitDrawerTerminal('s1', 'row');
    useStore.getState().splitDrawerTerminal('s1', 'col');
    const root = drawer().layout as PaneSplit;
    expect(root.children[1].kind).toBe('split');
    expect(terminalIds()).toHaveLength(3);
  });

  it('moves focus to the neighbour in a direction', () => {
    useStore.getState().toggleTerminalDrawer('s1');
    useStore.getState().splitDrawerTerminal('s1', 'row');
    const [first, second] = terminalIds();
    useStore.getState().moveDrawerFocus('s1', 'left');
    expect(drawer().focusedTerminalId).toBe(first);
    useStore.getState().moveDrawerFocus('s1', 'left');
    expect(drawer().focusedTerminalId).toBe(first);
    useStore.getState().moveDrawerFocus('s1', 'right');
    expect(drawer().focusedTerminalId).toBe(second);
  });

  it('focuses a clicked terminal only when it belongs to the drawer', () => {
    useStore.getState().toggleTerminalDrawer('s1');
    useStore.getState().splitDrawerTerminal('s1', 'row');
    const [first] = terminalIds();
    useStore.getState().focusDrawerSession('s1');
    useStore.getState().focusDrawerTerminal('s1', first);
    expect(drawer()).toMatchObject({ hasFocus: true, focusedTerminalId: first });
    useStore.getState().focusDrawerTerminal('s1', 'terminal:foreign');
    expect(drawer().focusedTerminalId).toBe(first);
  });

  it('resizes a split inside the drawer', () => {
    useStore.getState().toggleTerminalDrawer('s1');
    useStore.getState().splitDrawerTerminal('s1', 'row');
    const splitId = (drawer().layout as PaneSplit).id;
    useStore.getState().resizeDrawerSplit('s1', splitId, [0.7, 0.3]);
    expect((drawer().layout as PaneSplit).sizes).toEqual([0.7, 0.3]);
  });
});

describe('closing drawer terminals', () => {
  it('focuses the neighbour when the focused terminal closes', () => {
    useStore.getState().toggleTerminalDrawer('s1');
    useStore.getState().splitDrawerTerminal('s1', 'row');
    const [first, second] = terminalIds();
    useStore.getState().closeDrawerTerminal(second);
    expect(terminalIds()).toEqual([first]);
    expect(drawer().layout.kind).toBe('leaf');
    expect(drawer().focusedTerminalId).toBe(first);
    expect(useStore.getState().drawerTerminals[second]).toBeUndefined();
  });

  it('removes the drawer with its last terminal', () => {
    useStore.getState().toggleTerminalDrawer('s1');
    const [id] = terminalIds();
    useStore.getState().closeDrawerTerminal(id);
    expect(useStore.getState().drawers).toEqual({});
    expect(useStore.getState().drawerTerminals).toEqual({});
  });

  it('clears a close prompt whose terminal is gone', () => {
    useStore.getState().toggleTerminalDrawer('s1');
    useStore.getState().splitDrawerTerminal('s1', 'row');
    const [first, second] = terminalIds();
    useStore.getState().requestCloseDrawerTerminal(second);
    useStore.getState().closeDrawerTerminal(first);
    expect(useStore.getState().drawerClosePrompt).toBe(second);
    useStore.getState().closeDrawerTerminal(second);
    expect(useStore.getState().drawerClosePrompt).toBeNull();
  });

  it('refuses a close prompt for an unknown terminal', () => {
    useStore.getState().requestCloseDrawerTerminal('terminal:none');
    expect(useStore.getState().drawerClosePrompt).toBeNull();
  });
});

describe('drawer size setting', () => {
  it('persists the drawer size with the other settings', () => {
    useStore.getState().setTerminalDrawerSize(0.5);
    const persisted = JSON.parse(localStorage.getItem('abeoncode.settings') ?? '{}');
    expect(persisted.terminalDrawerSize).toBe(0.5);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/store/terminalDrawersSlice.test.ts`
Expected: FAIL — `toggleTerminalDrawer is not a function` (or TS/import error).

- [ ] **Step 3: Move `replaceSizes` into `paneTree` as `replaceSplitSizes`**

In `src/lib/paneTree.ts`, append after `mapLeaves`:

```ts
export function replaceSplitSizes(node: PaneNode, splitId: string, sizes: number[]): PaneNode {
  if (node.kind === 'leaf') return node;
  if (node.id === splitId) return { ...node, sizes };
  const children = node.children.map(c => replaceSplitSizes(c, splitId, sizes));
  return children.every((c, i) => c === node.children[i]) ? node : { ...node, children };
}
```

In `src/store/panesSlice.ts`: delete the local `function replaceSizes(...) { … }`, add `replaceSplitSizes` to the `../lib/paneTree` import list, and change `resizeSplit` to:

```ts
  resizeSplit: (splitId, sizes) => {
    set({ layout: replaceSplitSizes(get().layout, splitId, sizes) });
  },
```

- [ ] **Step 4: Add the persisted size to `settingsSlice`**

In `src/store/settingsSlice.ts`:
- add `import { DRAWER_DEFAULT_SIZE } from '../lib/drawerGeometry';`
- in `export type SettingsSlice = {` add `terminalDrawerSize: number;` next to `tabLayoutMode: TabLayoutMode;` and `setTerminalDrawerSize: (size: number) => void;` next to `setTabLayoutMode`.
- in `createSettingsSlice` add `terminalDrawerSize: DRAWER_DEFAULT_SIZE,` next to `tabLayoutMode: 'classic',` and `setTerminalDrawerSize: (terminalDrawerSize) => set({ terminalDrawerSize }),` next to `setTabLayoutMode`.

- [ ] **Step 5: Write the slice**

Create `src/store/terminalDrawersSlice.ts`:

```ts
import type { StateCreator } from 'zustand';
import {
  collapseEmpty,
  createLeaf,
  insertBeside,
  leaves,
  removeTabFromLeaves,
  replaceSplitSizes,
  type PaneNode,
} from '../lib/paneTree';
import { neighborInDirection, type Direction } from '../lib/drawerGeometry';
import type { Tab } from './tabsSlice';
import type { AppState } from './index';

export type DrawerTerminal = { id: string; ownerTabId: string; projectId: number; title: string };

export type TerminalDrawer = {
  open: boolean;
  hasFocus: boolean;
  layout: PaneNode;
  focusedTerminalId: string;
};

export type TerminalDrawersSlice = {
  drawers: Record<string, TerminalDrawer>;
  drawerTerminals: Record<string, DrawerTerminal>;
  drawerDragSize: number | null;
  drawerClosePrompt: string | null;
  toggleTerminalDrawer: (tabId: string) => void;
  showTerminalDrawer: (tabId: string) => void;
  hideTerminalDrawer: (tabId: string) => void;
  splitDrawerTerminal: (tabId: string, dir: 'row' | 'col') => void;
  focusDrawerTerminal: (tabId: string, terminalId: string) => void;
  focusDrawerSession: (tabId: string) => void;
  moveDrawerFocus: (tabId: string, dir: Direction) => void;
  closeDrawerTerminal: (terminalId: string) => void;
  requestCloseDrawerTerminal: (terminalId: string) => void;
  cancelCloseDrawerTerminal: () => void;
  resizeDrawerSplit: (tabId: string, splitId: string, sizes: number[]) => void;
  setDrawerDragSize: (size: number | null) => void;
};

const DRAWER_TERMINAL_TITLE = 'Terminal';

const newTerminalId = () => `terminal:${crypto.randomUUID()}`;
const terminalLeaf = (id: string) => createLeaf(id, [id], id);

export const toTerminalTab = (terminal: DrawerTerminal): Extract<Tab, { kind: 'terminal' }> => ({
  kind: 'terminal',
  id: terminal.id,
  projectId: terminal.projectId,
  title: terminal.title,
});

export function countDrawerTerminals(state: Pick<TerminalDrawersSlice, 'drawerTerminals'>, ownerTabId: string): number {
  return Object.values(state.drawerTerminals).filter(t => t.ownerTabId === ownerTabId).length;
}

type DrawerMaps = Pick<TerminalDrawersSlice, 'drawers' | 'drawerTerminals'>;

export function withoutDrawerTerminal(maps: DrawerMaps, terminalId: string): DrawerMaps | null {
  const terminal = maps.drawerTerminals[terminalId];
  if (!terminal) return null;
  const { [terminalId]: _removed, ...drawerTerminals } = maps.drawerTerminals;
  const drawer = maps.drawers[terminal.ownerTabId];
  if (!drawer) return { drawers: maps.drawers, drawerTerminals };
  const stripped = removeTabFromLeaves(drawer.layout, terminalId);
  if (leaves(stripped).every(leaf => leaf.tabIds.length === 0)) {
    const { [terminal.ownerTabId]: _closed, ...drawers } = maps.drawers;
    return { drawers, drawerTerminals };
  }
  const collapsed = collapseEmpty(stripped, drawer.focusedTerminalId);
  return {
    drawers: {
      ...maps.drawers,
      [terminal.ownerTabId]: { ...drawer, layout: collapsed.root, focusedTerminalId: collapsed.focusedPaneId },
    },
    drawerTerminals,
  };
}

export const createTerminalDrawersSlice: StateCreator<AppState, [], [], TerminalDrawersSlice> = (set, get) => {
  const patchDrawer = (tabId: string, patch: Partial<TerminalDrawer>) => {
    const drawer = get().drawers[tabId];
    if (!drawer) return;
    set({ drawers: { ...get().drawers, [tabId]: { ...drawer, ...patch } } });
  };

  const reveal = (tabId: string, hideWhenFocused: boolean) => {
    const drawer = get().drawers[tabId];
    if (drawer) {
      if (!drawer.open || !drawer.hasFocus) patchDrawer(tabId, { open: true, hasFocus: true });
      else if (hideWhenFocused) patchDrawer(tabId, { open: false, hasFocus: false });
      return;
    }
    const owner = get().tabs.find(t => t.id === tabId);
    if (!owner || owner.kind !== 'session') return;
    const id = newTerminalId();
    set({
      drawers: {
        ...get().drawers,
        [tabId]: { open: true, hasFocus: true, layout: terminalLeaf(id), focusedTerminalId: id },
      },
      drawerTerminals: {
        ...get().drawerTerminals,
        [id]: { id, ownerTabId: tabId, projectId: owner.projectId, title: DRAWER_TERMINAL_TITLE },
      },
      tabs: owner.preview ? get().tabs.map(t => (t.id === tabId ? { ...owner, preview: false } : t)) : get().tabs,
    });
  };

  return {
    drawers: {},
    drawerTerminals: {},
    drawerDragSize: null,
    drawerClosePrompt: null,
    toggleTerminalDrawer: (tabId) => reveal(tabId, true),
    showTerminalDrawer: (tabId) => reveal(tabId, false),
    hideTerminalDrawer: (tabId) => patchDrawer(tabId, { open: false, hasFocus: false }),
    splitDrawerTerminal: (tabId, dir) => {
      const drawer = get().drawers[tabId];
      const owner = get().tabs.find(t => t.id === tabId);
      if (!drawer || !owner) return;
      const id = newTerminalId();
      set({
        drawers: {
          ...get().drawers,
          [tabId]: {
            open: true,
            hasFocus: true,
            focusedTerminalId: id,
            layout: insertBeside(drawer.layout, drawer.focusedTerminalId, dir, false, terminalLeaf(id), crypto.randomUUID()),
          },
        },
        drawerTerminals: {
          ...get().drawerTerminals,
          [id]: { id, ownerTabId: tabId, projectId: owner.projectId, title: DRAWER_TERMINAL_TITLE },
        },
      });
    },
    focusDrawerTerminal: (tabId, terminalId) => {
      const drawer = get().drawers[tabId];
      if (!drawer || get().drawerTerminals[terminalId]?.ownerTabId !== tabId) return;
      if (drawer.hasFocus && drawer.focusedTerminalId === terminalId) return;
      patchDrawer(tabId, { hasFocus: true, focusedTerminalId: terminalId });
    },
    focusDrawerSession: (tabId) => {
      if (get().drawers[tabId]?.hasFocus) patchDrawer(tabId, { hasFocus: false });
    },
    moveDrawerFocus: (tabId, dir) => {
      const drawer = get().drawers[tabId];
      if (!drawer) return;
      const next = neighborInDirection(drawer.layout, drawer.focusedTerminalId, dir);
      if (next) patchDrawer(tabId, { hasFocus: true, focusedTerminalId: next });
    },
    closeDrawerTerminal: (terminalId) => {
      const next = withoutDrawerTerminal(get(), terminalId);
      if (!next) return;
      const prompt = get().drawerClosePrompt;
      set({ ...next, drawerClosePrompt: prompt === terminalId ? null : prompt });
    },
    requestCloseDrawerTerminal: (terminalId) => {
      if (get().drawerTerminals[terminalId]) set({ drawerClosePrompt: terminalId });
    },
    cancelCloseDrawerTerminal: () => set({ drawerClosePrompt: null }),
    resizeDrawerSplit: (tabId, splitId, sizes) => {
      const drawer = get().drawers[tabId];
      if (drawer) patchDrawer(tabId, { layout: replaceSplitSizes(drawer.layout, splitId, sizes) });
    },
    setDrawerDragSize: (drawerDragSize) => set({ drawerDragSize }),
  };
};
```

- [ ] **Step 6: Compose the slice and persist the size in `store/index.ts`**

In `src/store/index.ts`:
- import: `import { createTerminalDrawersSlice, type TerminalDrawersSlice } from './terminalDrawersSlice';` and `import { DRAWER_MAX_SIZE, DRAWER_MIN_SIZE } from '../lib/drawerGeometry';`
- `export type AppState = … & PanesSlice & TerminalDrawersSlice;`
- inside `create<AppState>()`: add `...createTerminalDrawersSlice(...a),` after `...createPanesSlice(...a),`
- `type Persisted`: add `terminalDrawerSize?: number;`
- `PERSISTED_KEYS`: add `'terminalDrawerSize',` after `'tabLayoutMode',`
- `pickPersistedFields`: add `terminalDrawerSize: state.terminalDrawerSize,` after `tabLayoutMode: state.tabLayoutMode,`
- `serializeValue`: add `case 'terminalDrawerSize':` right under `case 'rightWidth':` (same `String(value as number)` branch)
- `deserializeValue`: add before `case 'skipPermissions':` group:

```ts
    case 'terminalDrawerSize':
      return clamp(Number(raw), DRAWER_MIN_SIZE, DRAWER_MAX_SIZE);
```

- `applyPersistedToState`: add after the `tabLayoutMode` block:

```ts
  if (typeof p.terminalDrawerSize === 'number' && Number.isFinite(p.terminalDrawerSize)) {
    patch.terminalDrawerSize = clamp(p.terminalDrawerSize, DRAWER_MIN_SIZE, DRAWER_MAX_SIZE);
  }
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx vitest run src/store/terminalDrawersSlice.test.ts src/store/panesSlice.test.ts src/store/settingsSlice.test.ts`
Expected: PASS.

Run: `npm run lint`
Expected: zero errors.

- [ ] **Step 8: Commit**

```bash
git add src/lib/paneTree.ts src/store/panesSlice.ts src/store/settingsSlice.ts src/store/index.ts src/store/terminalDrawersSlice.ts src/store/terminalDrawersSlice.test.ts
git commit -m "feat(desktop): add terminal drawer state with splits and persisted size"
```

---

### Task 3: Drawer routing, detaching and cleanup

**Files:**
- Modify: `src/store/terminalDrawersSlice.ts`, `src/store/index.ts`
- Test: `src/store/terminalDrawersSlice.test.ts`

**Interfaces:**
- Consumes: Task 2 slice internals (`reveal`, `withoutDrawerTerminal`, `toTerminalTab`); `findLeafOfTab`, `mapLeaves`, `leaves` from `paneTree`; `pushNav` from `src/lib/navHistory.ts`; `TabsSlice.openNewTerminalTab`, `TabsSlice.closeTab`.
- Produces:
  - `openTerminal(projectId: number, opts: { toggle: boolean }): void`
  - `detachDrawerTerminal(terminalId: string): void`
  - `detachAllDrawerTerminals(tabId: string): void`
  - `pruneDrawers(liveTabIds: ReadonlySet<string>): void`
  - `selectDrawerTerminalTabs(state: Pick<TerminalDrawersSlice, 'drawerTerminals'>, projectId: number): Extract<Tab, { kind: 'terminal' }>[]`
  - store subscriber that removes drawers of vanished session tabs

- [ ] **Step 1: Write the failing test**

Append to `src/store/terminalDrawersSlice.test.ts` (add `findLeaf` and `selectDrawerTerminalTabs` imports: `import { createLeaf, findLeaf, leaves, type PaneSplit } from '../lib/paneTree';` and `import { selectDrawerTerminalTabs } from './terminalDrawersSlice';`):

```ts
describe('openTerminal routing', () => {
  it('opens the drawer of the active session of the same project', () => {
    useStore.getState().openTerminal(1, { toggle: true });
    expect(drawer()?.open).toBe(true);
    expect(useStore.getState().tabs).toHaveLength(1);
  });

  it('opens a terminal tab when the active tab belongs to another project', () => {
    useStore.getState().openTerminal(2, { toggle: true });
    expect(useStore.getState().drawers).toEqual({});
    expect(useStore.getState().tabs.some(t => t.kind === 'terminal' && t.projectId === 2)).toBe(true);
  });

  it('opens a terminal tab when no tab is active', () => {
    useStore.setState({ tabs: [], activeTabId: null, layout: createLeaf(ROOT_PANE_ID) });
    useStore.getState().openTerminal(1, { toggle: false });
    expect(useStore.getState().tabs.map(t => t.kind)).toEqual(['terminal']);
  });

  it('keeps a focused drawer open when not toggling', () => {
    useStore.getState().openTerminal(1, { toggle: false });
    useStore.getState().openTerminal(1, { toggle: false });
    expect(drawer()).toMatchObject({ open: true, hasFocus: true });
  });

  it('only touches the drawer of the focused pane session', () => {
    useStore.setState({
      tabs: [session('s1'), session('s2')],
      activeTabId: 's2',
      layout: {
        kind: 'split', id: 'outer', dir: 'row', sizes: [0.5, 0.5],
        children: [createLeaf('left', ['s1'], 's1'), createLeaf('right', ['s2'], 's2')],
      },
      focusedPaneId: 'right',
    });
    useStore.getState().openTerminal(1, { toggle: true });
    expect(useStore.getState().drawers.s2?.open).toBe(true);
    expect(useStore.getState().drawers.s1).toBeUndefined();
  });
});

describe('detaching drawer terminals', () => {
  it('turns the terminal into a tab right after its session, keeping the id', () => {
    useStore.setState({
      tabs: [session('s1'), { kind: 'terminal', id: 'x', projectId: 1, title: 'X' }],
      layout: createLeaf(ROOT_PANE_ID, ['s1', 'x'], 's1'),
    });
    useStore.getState().toggleTerminalDrawer('s1');
    const [id] = terminalIds();

    useStore.getState().detachDrawerTerminal(id);

    const state = useStore.getState();
    expect(state.drawers).toEqual({});
    expect(state.drawerTerminals).toEqual({});
    expect(state.tabs.find(t => t.id === id)).toEqual({ kind: 'terminal', id, projectId: 1, title: 'Terminal' });
    expect(findLeaf(state.layout, ROOT_PANE_ID)?.tabIds).toEqual(['s1', id, 'x']);
    expect(state.activeTabId).toBe(id);
    expect(state.focusedPaneId).toBe(ROOT_PANE_ID);
    expect(state.mruOrder[0]).toBe(id);
  });

  it('keeps the other terminals in the drawer', () => {
    useStore.getState().toggleTerminalDrawer('s1');
    useStore.getState().splitDrawerTerminal('s1', 'row');
    const [first, second] = terminalIds();
    useStore.getState().detachDrawerTerminal(second);
    expect(terminalIds()).toEqual([first]);
    expect(drawer().focusedTerminalId).toBe(first);
  });

  it('detaches every drawer terminal of a session', () => {
    useStore.getState().toggleTerminalDrawer('s1');
    useStore.getState().splitDrawerTerminal('s1', 'col');
    const ids = terminalIds();
    useStore.getState().detachAllDrawerTerminals('s1');
    expect(useStore.getState().drawers).toEqual({});
    expect(ids.every(id => useStore.getState().tabs.some(t => t.id === id))).toBe(true);
  });
});

describe('drawer cleanup', () => {
  it('drops a drawer when its session tab closes', () => {
    useStore.getState().toggleTerminalDrawer('s1');
    useStore.getState().requestCloseDrawerTerminal(drawer().focusedTerminalId);
    useStore.getState().closeTab('s1');
    expect(useStore.getState().drawers).toEqual({});
    expect(useStore.getState().drawerTerminals).toEqual({});
    expect(useStore.getState().drawerClosePrompt).toBeNull();
  });

  it('lists drawer terminals of a project as terminal tabs', () => {
    useStore.setState({ tabs: [session('s1'), session('s2', 2)] });
    useStore.getState().toggleTerminalDrawer('s1');
    useStore.getState().toggleTerminalDrawer('s2');
    const own = selectDrawerTerminalTabs(useStore.getState(), 1);
    expect(own).toHaveLength(1);
    expect(own[0]).toMatchObject({ kind: 'terminal', projectId: 1 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/store/terminalDrawersSlice.test.ts`
Expected: FAIL — `openTerminal is not a function` and the cleanup test finds the drawer still present.

- [ ] **Step 3: Implement the actions**

In `src/store/terminalDrawersSlice.ts`:

Extend the `../lib/paneTree` import with `findLeafOfTab` and `mapLeaves`, and add `import { pushNav } from '../lib/navHistory';`.

Add to `TerminalDrawersSlice`:

```ts
  openTerminal: (projectId: number, opts: { toggle: boolean }) => void;
  detachDrawerTerminal: (terminalId: string) => void;
  detachAllDrawerTerminals: (tabId: string) => void;
  pruneDrawers: (liveTabIds: ReadonlySet<string>) => void;
```

Add the selector next to `countDrawerTerminals`:

```ts
export function selectDrawerTerminalTabs(
  state: Pick<TerminalDrawersSlice, 'drawerTerminals'>,
  projectId: number,
): Extract<Tab, { kind: 'terminal' }>[] {
  return Object.values(state.drawerTerminals).filter(t => t.projectId === projectId).map(toTerminalTab);
}
```

Add inside the returned object of `createTerminalDrawersSlice`:

```ts
    openTerminal: (projectId, { toggle }) => {
      const active = get().tabs.find(t => t.id === get().activeTabId);
      if (active?.kind === 'session' && active.projectId === projectId) {
        reveal(active.id, toggle);
        return;
      }
      get().openNewTerminalTab(projectId);
    },
    detachDrawerTerminal: (terminalId) => {
      const terminal = get().drawerTerminals[terminalId];
      if (!terminal) return;
      const pane = findLeafOfTab(get().layout, terminal.ownerTabId);
      const remaining = withoutDrawerTerminal(get(), terminalId);
      if (!pane || !remaining) return;
      const at = pane.tabIds.indexOf(terminal.ownerTabId) + 1;
      const tabIds = [...pane.tabIds.slice(0, at), terminalId, ...pane.tabIds.slice(at)];
      const nav = pushNav({ history: get().navHistory, index: get().navIndex }, terminalId);
      const prompt = get().drawerClosePrompt;
      set({
        ...remaining,
        drawerClosePrompt: prompt === terminalId ? null : prompt,
        tabs: [...get().tabs, toTerminalTab(terminal)],
        layout: mapLeaves(get().layout, leaf => (leaf.id === pane.id ? { ...leaf, tabIds, activeTabId: terminalId } : leaf)),
        focusedPaneId: pane.id,
        activeTabId: terminalId,
        mruOrder: [terminalId, ...get().mruOrder.filter(x => x !== terminalId)],
        navHistory: nav.history,
        navIndex: nav.index,
      });
    },
    detachAllDrawerTerminals: (tabId) => {
      const drawer = get().drawers[tabId];
      if (!drawer) return;
      for (const leaf of leaves(drawer.layout)) get().detachDrawerTerminal(leaf.id);
    },
    pruneDrawers: (liveTabIds) => {
      const drawers = Object.fromEntries(
        Object.entries(get().drawers).filter(([tabId]) => liveTabIds.has(tabId)),
      );
      const drawerTerminals = Object.fromEntries(
        Object.entries(get().drawerTerminals).filter(([, t]) => liveTabIds.has(t.ownerTabId)),
      );
      const prompt = get().drawerClosePrompt;
      set({ drawers, drawerTerminals, drawerClosePrompt: prompt && drawerTerminals[prompt] ? prompt : null });
    },
```

- [ ] **Step 4: Register the cleanup subscriber**

In `src/store/index.ts`, directly after `reconcileLayout(useStore.getState());` add:

```ts
function pruneOrphanDrawers(state: AppState) {
  const terminals = Object.values(state.drawerTerminals);
  const owners = Object.keys(state.drawers);
  if (owners.length === 0 && terminals.length === 0) return;
  const live = new Set(state.tabs.map(t => t.id));
  if (owners.every(id => live.has(id)) && terminals.every(t => live.has(t.ownerTabId))) return;
  state.pruneDrawers(live);
}

useStore.subscribe(pruneOrphanDrawers);
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/store/`
Expected: PASS (whole store folder — `reconcileLayout` runs on the new tab and must keep the placement from `detachDrawerTerminal`).

Run: `npm run lint`
Expected: zero errors.

- [ ] **Step 6: Commit**

```bash
git add src/store/terminalDrawersSlice.ts src/store/terminalDrawersSlice.test.ts src/store/index.ts
git commit -m "feat(desktop): route terminals to session drawers and detach them into tabs"
```

---

### Task 4: `TerminalView` keyboard claim and exit callback

**Files:**
- Modify: `src/components/terminal/TerminalView.tsx`, `src/components/center/TabContent.tsx`
- Test: `src/components/terminal/TerminalView.test.tsx`, `src/components/center/TabContent.test.tsx`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `TerminalView` props `takeFocus?: boolean` (defaults to `focused`; only controls `term.focus()`) and `onExit?: (code: number) => void` (read through a ref; never restarts the PTY)
  - `TabPanel({ tab, visible, focused = true, takeFocus, onExit })` passing both through (session → every `TerminalView` in `SessionBody` gets `takeFocus`; terminal → `takeFocus` + `onExit`)

- [ ] **Step 1: Write the failing tests**

In `src/components/terminal/TerminalView.test.tsx`:
- add `exits: [] as Array<(code: number) => void>,` to the `probe` object in `vi.hoisted`;
- replace the `onPtyExit` mock with:

```ts
    onPtyExit: vi.fn(async (_id: string, cb: (code: number) => void) => {
      probe.exits.push(cb);
      return () => {};
    }),
```

- add `probe.exits = [];` to the `beforeEach` of `describe('TerminalView focus'`;
- append inside `describe('TerminalView focus', …)`:

```ts
  it('keeps the active agent PTY while another element holds the keyboard', async () => {
    await act(async () => {
      render(<TerminalView projectId={1} kind="agent" sessionId="s1" visible focused takeFocus={false} />);
    });
    expect(useStore.getState().activeAgentPtyId).toBe('pty-1');
    expect(probe.focusCalls).toBe(0);
  });

  it('takes the keyboard back when takeFocus turns on', async () => {
    let view!: ReturnType<typeof render>;
    await act(async () => {
      view = render(<TerminalView projectId={1} kind="agent" sessionId="s1" visible focused takeFocus={false} />);
    });
    await act(async () => {
      view.rerender(<TerminalView projectId={1} kind="agent" sessionId="s1" visible focused takeFocus />);
    });
    expect(probe.focusCalls).toBeGreaterThan(0);
  });

  it('reports the PTY exit to the latest onExit without respawning', async () => {
    const first = vi.fn();
    const second = vi.fn();
    let view!: ReturnType<typeof render>;
    await act(async () => { view = render(<TerminalView projectId={1} kind="shell" visible onExit={first} />); });
    await act(async () => { view.rerender(<TerminalView projectId={1} kind="shell" visible onExit={second} />); });
    act(() => { probe.exits[0](0); });
    expect(probe.spawned).toBe(1);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith(0);
  });
```

In `src/components/center/TabContent.test.tsx`, add a props probe. Change the hoisted counters to `const counters = vi.hoisted(() => ({ terminalMounts: 0, lastProps: null as Record<string, unknown> | null }));` and the mock to:

```tsx
vi.mock('../terminal/TerminalView', () => ({
  TerminalView: (props: { visible?: boolean }) => {
    counters.lastProps = props;
    useEffect(() => { counters.terminalMounts += 1; }, []);
    return <div data-testid="terminal" data-visible={String(props.visible)} />;
  },
}));
```

Append a new `describe` at the end of the file:

```tsx
describe('TabPanel keyboard and exit wiring', () => {
  it('passes takeFocus and onExit to a terminal tab', () => {
    const onExit = vi.fn();
    render(<TabPanel tab={{ kind: 'terminal', id: 't1', projectId: 1, title: 'T' }} visible focused takeFocus={false} onExit={onExit} />);
    expect(counters.lastProps).toMatchObject({ kind: 'shell', focused: true, takeFocus: false, onExit });
  });

  it('passes takeFocus to a live session', () => {
    render(<TabPanel tab={{ kind: 'session', id: 's', projectId: 1, sessionId: 's', title: 'S', mode: 'terminal' }} visible focused takeFocus={false} />);
    expect(counters.lastProps).toMatchObject({ kind: 'agent', focused: true, takeFocus: false });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/components/terminal/TerminalView.test.tsx src/components/center/TabContent.test.tsx`
Expected: FAIL — focus is taken despite `takeFocus={false}`, `onExit` never called, props missing.

- [ ] **Step 3: Implement in `TerminalView`**

In `src/components/terminal/TerminalView.tsx`:
1. Add to `type Props`:

```ts
  takeFocus?: boolean;
  onExit?: (code: number) => void;
```

2. Change the signature to `export function TerminalView({ projectId, kind, provider, sessionId, fresh, actionId, tabId, visible = true, focused = true, takeFocus, onExit }: Props) {`
3. Replace

```ts
  const focusedRef = useRef(focused);
  focusedRef.current = focused;
```

with

```ts
  const claimsKeyboard = takeFocus ?? focused;
  const claimsKeyboardRef = useRef(claimsKeyboard);
  claimsKeyboardRef.current = claimsKeyboard;
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;
```

4. Replace `if (visibleRef.current && focusedRef.current) term.focus();` with `if (visibleRef.current && claimsKeyboardRef.current) term.focus();` (run `grep -n focusedRef src/components/terminal/TerminalView.tsx` afterwards — it must return nothing).
5. In the `tauri.onPtyExit(id, (code) => { … })` callback, after the `term.write(...)` line add `onExitRef.current?.(code);`
6. In the visibility effect replace `if (focused) term.focus();` with `if (claimsKeyboard) term.focus();` and its dependency list `[visible, focused]` with `[visible, claimsKeyboard]`.

- [ ] **Step 4: Pass the props through `TabPanel`**

In `src/components/center/TabContent.tsx`:
- `SessionBody` signature: `function SessionBody({ tab, visible, focused = true, takeFocus }: { tab: SessionTab; visible: boolean; focused?: boolean; takeFocus?: boolean })`, and add `takeFocus={takeFocus}` to **both** `TerminalView` elements in it.
- `TabPanel` signature:

```tsx
export function TabPanel({ tab, visible, focused = true, takeFocus, onExit }: {
  tab: Tab;
  visible: boolean;
  focused?: boolean;
  takeFocus?: boolean;
  onExit?: (code: number) => void;
}) {
```

- session branch: `<SessionBody tab={tab} visible={visible && !agentId} focused={focused} takeFocus={takeFocus} />`
- terminal branch: `<TerminalView projectId={tab.projectId} kind="shell" visible={visible} focused={focused} takeFocus={takeFocus} onExit={onExit} />`

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/components/terminal/TerminalView.test.tsx src/components/center/TabContent.test.tsx src/components/center/PaneLayout.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/components/terminal/TerminalView.tsx src/components/terminal/TerminalView.test.tsx src/components/center/TabContent.tsx src/components/center/TabContent.test.tsx
git commit -m "feat(desktop): let terminals yield the keyboard and report shell exit"
```

---

### Task 5: Generic split resizers

**Files:**
- Modify: `src/components/center/PaneResizers.tsx`
- Test: `src/components/center/PaneResizers.test.tsx` (create)

**Interfaces:**
- Consumes: Task 1 `LenRect`, `len`, `cssLen`, `resolveLen`, `withinRect`; `computeSplitBoundaries`, `clampSizes`, `SplitBoundary` from `paneGeometry`.
- Produces:
  - `SplitResizers({ layout, containerRef, frame, minPx, onResize }: { layout: PaneNode; containerRef: RefObject<HTMLDivElement | null>; frame: LenRect; minPx: (dir: 'row' | 'col') => number; onResize: (splitId: string, sizes: number[]) => void })` — renders one `role="separator"` per boundary positioned inside `frame`
  - `PaneResizers({ layout, containerRef })` unchanged API

- [ ] **Step 1: Write the failing test**

Create `src/components/center/PaneResizers.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { createRef } from 'react';
import { fireEvent, render } from '@testing-library/react';
import { SplitResizers } from './PaneResizers';
import { len, type LenRect } from '../../lib/drawerGeometry';
import { createLeaf, type PaneNode } from '../../lib/paneTree';

const frame: LenRect = { left: len(0), top: len(50, 28), width: len(100), height: len(50, -28) };

function renderInBox(layout: PaneNode, onResize: (splitId: string, sizes: number[]) => void) {
  const containerRef = createRef<HTMLDivElement>();
  const view = render(
    <div ref={containerRef}>
      <SplitResizers layout={layout} containerRef={containerRef} frame={frame} minPx={() => 10} onResize={onResize} />
    </div>,
  );
  containerRef.current!.getBoundingClientRect = () => ({
    x: 0, y: 0, left: 0, top: 0, right: 1000, bottom: 800, width: 1000, height: 800, toJSON: () => ({}),
  });
  return view;
}

describe('SplitResizers', () => {
  it('positions a vertical separator inside the frame', () => {
    const layout: PaneNode = { kind: 'split', id: 's', dir: 'row', sizes: [0.5, 0.5], children: [createLeaf('a', ['a'], 'a'), createLeaf('b', ['b'], 'b')] };
    const { container } = renderInBox(layout, vi.fn());
    const handle = container.querySelector('[role="separator"]') as HTMLElement;
    expect(handle.style.left).toBe('50%');
    expect(handle.style.top).toBe('calc(50% + 28px)');
    expect(handle.style.height).toBe('calc(50% - 28px)');
  });

  it('measures a horizontal drag against the frame width', () => {
    const onResize = vi.fn();
    const layout: PaneNode = { kind: 'split', id: 's', dir: 'row', sizes: [0.5, 0.5], children: [createLeaf('a', ['a'], 'a'), createLeaf('b', ['b'], 'b')] };
    const { container } = renderInBox(layout, onResize);
    fireEvent.mouseDown(container.querySelector('[role="separator"]')!, { clientX: 500, clientY: 600 });
    fireEvent.mouseMove(window, { clientX: 600, clientY: 600 });
    const [splitId, sizes] = onResize.mock.calls.at(-1)!;
    expect(splitId).toBe('s');
    expect(sizes[0]).toBeCloseTo(0.6);
  });

  it('measures a vertical drag against the frame height in pixels', () => {
    const onResize = vi.fn();
    const layout: PaneNode = { kind: 'split', id: 's', dir: 'col', sizes: [0.5, 0.5], children: [createLeaf('a', ['a'], 'a'), createLeaf('b', ['b'], 'b')] };
    const { container } = renderInBox(layout, onResize);
    fireEvent.mouseDown(container.querySelector('[role="separator"]')!, { clientX: 500, clientY: 600 });
    fireEvent.mouseMove(window, { clientX: 500, clientY: 637.2 });
    expect(onResize.mock.calls.at(-1)![1][0]).toBeCloseTo(0.6);
  });
});
```

(Frame height is `0.5 × 800 − 28 = 372 px`, so 37.2 px is a tenth.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/center/PaneResizers.test.tsx`
Expected: FAIL — `SplitResizers` is not exported.

- [ ] **Step 3: Rewrite `PaneResizers.tsx`**

Replace the whole file `src/components/center/PaneResizers.tsx` with:

```tsx
import { useCallback, useEffect, useRef, type RefObject } from 'react';
import { useStore } from '../../store';
import {
  clampSizes,
  computeSplitBoundaries,
  MIN_PANE_HEIGHT,
  MIN_PANE_WIDTH,
  tabBarHeight,
  type SplitBoundary,
} from '../../lib/paneGeometry';
import { cssLen, len, resolveLen, withinRect, type LenRect } from '../../lib/drawerGeometry';
import type { PaneNode } from '../../lib/paneTree';

const FULL_FRAME: LenRect = { left: len(0), top: len(0), width: len(100), height: len(100) };

type SplitResizersProps = {
  layout: PaneNode;
  containerRef: RefObject<HTMLDivElement | null>;
  frame: LenRect;
  minPx: (dir: 'row' | 'col') => number;
  onResize: (splitId: string, sizes: number[]) => void;
};

export function SplitResizers({ layout, containerRef, frame, minPx, onResize }: SplitResizersProps) {
  const boundaries = computeSplitBoundaries(layout);
  const handlersRef = useRef<{ move: (e: MouseEvent) => void; up: () => void } | null>(null);

  const detach = useCallback(() => {
    if (!handlersRef.current) return;
    window.removeEventListener('mousemove', handlersRef.current.move);
    window.removeEventListener('mouseup', handlersRef.current.up);
    handlersRef.current = null;
  }, []);

  useEffect(() => detach, [detach]);

  const startDrag = useCallback((e: React.MouseEvent, boundary: SplitBoundary) => {
    detach();
    e.preventDefault();
    const container = containerRef.current;
    if (!container) return;
    const box = container.getBoundingClientRect();
    const horizontal = boundary.dir === 'row';
    const framePx = horizontal ? resolveLen(frame.width, box.width) : resolveLen(frame.height, box.height);
    const totalPx = (framePx * boundary.extent) / 100;
    if (totalPx <= 0) return;
    const startPx = horizontal ? e.clientX : e.clientY;
    const startFraction = boundary.sizes[boundary.index];
    const min = minPx(boundary.dir);

    const move = (ev: MouseEvent) => {
      const delta = (horizontal ? ev.clientX : ev.clientY) - startPx;
      onResize(boundary.splitId, clampSizes(boundary.sizes, boundary.index, startFraction + delta / totalPx, totalPx, min));
    };
    const up = () => detach();
    handlersRef.current = { move, up };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }, [containerRef, detach, frame, minPx, onResize]);

  return (
    <>
      {boundaries.map(b => {
        const r = withinRect(frame, b.dir === 'row'
          ? { left: b.left, top: b.top, width: 0, height: b.length }
          : { left: b.left, top: b.top, width: b.length, height: 0 });
        return (
          <div
            key={`${b.splitId}:${b.index}`}
            role="separator"
            aria-orientation={b.dir === 'row' ? 'vertical' : 'horizontal'}
            onMouseDown={e => startDrag(e, b)}
            className={`absolute z-30 bg-border hover:bg-accent transition-colors ${
              b.dir === 'row' ? 'cursor-col-resize -translate-x-1/2' : 'cursor-row-resize -translate-y-1/2'
            }`}
            style={
              b.dir === 'row'
                ? { left: cssLen(r.left), top: cssLen(r.top), width: 5, height: cssLen(r.height) }
                : { left: cssLen(r.left), top: cssLen(r.top), width: cssLen(r.width), height: 5 }
            }
          />
        );
      })}
    </>
  );
}

export function PaneResizers({ layout, containerRef }: { layout: PaneNode; containerRef: RefObject<HTMLDivElement | null> }) {
  const resizeSplit = useStore(s => s.resizeSplit);
  const tabLayoutMode = useStore(s => s.tabLayoutMode);
  const minPx = useCallback(
    (dir: 'row' | 'col') => (dir === 'row' ? MIN_PANE_WIDTH : MIN_PANE_HEIGHT + tabBarHeight(tabLayoutMode)),
    [tabLayoutMode],
  );
  return <SplitResizers layout={layout} containerRef={containerRef} frame={FULL_FRAME} minPx={minPx} onResize={resizeSplit} />;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/components/center/PaneResizers.test.tsx src/components/center/PaneLayout.test.tsx`
Expected: PASS (PaneLayout's existing resizer tests are the regression guard).

- [ ] **Step 5: Commit**

```bash
git add src/components/center/PaneResizers.tsx src/components/center/PaneResizers.test.tsx
git commit -m "refactor(desktop): generalize split resizers to any frame"
```

---

### Task 6: Render drawer terminals as pane layers

**Files:**
- Create: `src/lib/paneLayers.ts`, `src/lib/paneLayers.test.ts`
- Modify: `src/components/center/PaneLayout.tsx`
- Test: `src/components/center/PaneLayout.test.tsx`

**Interfaces:**
- Consumes: Task 1 `computeDrawerLayout`, `paneContentRect`, `lenRectStyle`, `LenRect`, `DrawerLayoutRects`; Task 2 `TerminalDrawer`, `DrawerTerminal`, `toTerminalTab`, `focusDrawerTerminal`, `focusDrawerSession`, `closeDrawerTerminal`, `terminalDrawerSize`, `drawerDragSize`; Task 4 `TabPanel` props.
- Produces:
  - `type PaneLayer = { tab: Tab; paneId: string; rect: LenRect; visible: boolean; focused: boolean; takeFocus: boolean; drawerOwnerId: string | null }`
  - `type VisibleDrawer = { ownerTabId: string; paneId: string; rects: DrawerLayoutRects; drawer: TerminalDrawer }`
  - `computePaneLayers(input: { tabs: Tab[]; layout: PaneNode; focusedPaneId: string; barHeight: number; drawers: Record<string, TerminalDrawer>; drawerTerminals: Record<string, DrawerTerminal>; drawerSize: number }): { layers: PaneLayer[]; visibleDrawers: VisibleDrawer[] }` — layers sorted by `tab.id`
  - Layer DOM: every layer `div` has `data-tab-layer={id}` and `data-pane-content={paneId}`; drawer layers additionally `data-drawer-owner={sessionTabId}`

- [ ] **Step 1: Write the failing pure test**

Create `src/lib/paneLayers.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { computePaneLayers } from './paneLayers';
import { lenRectStyle, paneContentRect } from './drawerGeometry';
import { createLeaf, type PaneNode } from './paneTree';
import type { Tab } from '../store/tabsSlice';
import type { DrawerTerminal, TerminalDrawer } from '../store/terminalDrawersSlice';

const s1: Tab = { kind: 'session', id: 'session:s1', projectId: 1, sessionId: 's1', title: 'S1', mode: 'terminal' };
const t0: Tab = { kind: 'terminal', id: 'terminal:0', projectId: 1, title: 'T0' };
const FULL = { left: 0, top: 0, width: 100, height: 100 };
const drawerTerminal = (id: string): DrawerTerminal => ({ id, ownerTabId: 'session:s1', projectId: 1, title: 'Terminal' });

function run(opts: { drawer?: Partial<TerminalDrawer>; layout?: PaneNode; focusedPaneId?: string; tabs?: Tab[] } = {}) {
  const drawer: TerminalDrawer | undefined = opts.drawer
    ? { open: true, hasFocus: true, layout: createLeaf('terminal:d1', ['terminal:d1'], 'terminal:d1'), focusedTerminalId: 'terminal:d1', ...opts.drawer }
    : undefined;
  return computePaneLayers({
    tabs: opts.tabs ?? [s1],
    layout: opts.layout ?? createLeaf('root', (opts.tabs ?? [s1]).map(t => t.id), 'session:s1'),
    focusedPaneId: opts.focusedPaneId ?? 'root',
    barHeight: 32,
    drawers: drawer ? { 'session:s1': drawer } : {},
    drawerTerminals: drawer ? { 'terminal:d1': drawerTerminal('terminal:d1') } : {},
    drawerSize: 0.35,
  });
}

describe('computePaneLayers', () => {
  it('gives a tab without a drawer the whole pane content', () => {
    const { layers, visibleDrawers } = run();
    expect(layers).toHaveLength(1);
    expect(lenRectStyle(layers[0].rect)).toEqual(lenRectStyle(paneContentRect(FULL, 32)));
    expect(layers[0]).toMatchObject({ visible: true, focused: true, takeFocus: true, drawerOwnerId: null });
    expect(visibleDrawers).toEqual([]);
  });

  it('lets a focused drawer take the keyboard from its session', () => {
    const { layers, visibleDrawers } = run({ drawer: {} });
    const session = layers.find(l => l.tab.id === 'session:s1')!;
    const terminal = layers.find(l => l.tab.id === 'terminal:d1')!;
    expect(session).toMatchObject({ visible: true, focused: true, takeFocus: false });
    expect(terminal).toMatchObject({ visible: true, focused: true, takeFocus: true, drawerOwnerId: 'session:s1' });
    expect(terminal.tab).toEqual({ kind: 'terminal', id: 'terminal:d1', projectId: 1, title: 'Terminal' });
    expect(lenRectStyle(session.rect).height).toBe('calc(65% - 20.8px)');
    expect(visibleDrawers).toHaveLength(1);
  });

  it('keeps the session keyboard while the drawer is open but unfocused', () => {
    const { layers } = run({ drawer: { hasFocus: false } });
    expect(layers.find(l => l.tab.id === 'session:s1')!.takeFocus).toBe(true);
    expect(layers.find(l => l.tab.id === 'terminal:d1')!).toMatchObject({ visible: true, focused: false });
  });

  it('hides the terminals of a hidden drawer and restores the full session', () => {
    const { layers, visibleDrawers } = run({ drawer: { open: false, hasFocus: false } });
    const session = layers.find(l => l.tab.id === 'session:s1')!;
    expect(lenRectStyle(session.rect)).toEqual(lenRectStyle(paneContentRect(FULL, 32)));
    expect(layers.find(l => l.tab.id === 'terminal:d1')!.visible).toBe(false);
    expect(visibleDrawers).toEqual([]);
  });

  it('hides the drawer of a session that is not the active tab of its pane', () => {
    const { layers, visibleDrawers } = run({
      drawer: {},
      tabs: [s1, t0],
      layout: createLeaf('root', ['session:s1', 'terminal:0'], 'terminal:0'),
    });
    expect(layers.find(l => l.tab.id === 'terminal:d1')!.visible).toBe(false);
    expect(visibleDrawers).toEqual([]);
  });

  it('never focuses a drawer terminal in an unfocused pane', () => {
    const { layers } = run({ drawer: {}, focusedPaneId: 'elsewhere' });
    expect(layers.find(l => l.tab.id === 'terminal:d1')!).toMatchObject({ visible: true, focused: false, takeFocus: false });
  });

  it('sorts layers by id', () => {
    const { layers } = run({ drawer: {}, tabs: [t0, s1], layout: createLeaf('root', ['terminal:0', 'session:s1'], 'session:s1') });
    expect(layers.map(l => l.tab.id)).toEqual(['session:s1', 'terminal:0', 'terminal:d1']);
  });

  it('skips tabs that are not placed in any pane', () => {
    const { layers } = run({ drawer: {}, layout: createLeaf('root') });
    expect(layers).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/paneLayers.test.ts`
Expected: FAIL — cannot resolve `./paneLayers`.

- [ ] **Step 3: Implement `computePaneLayers`**

Create `src/lib/paneLayers.ts`:

```ts
import { computePaneRects } from './paneGeometry';
import { computeDrawerLayout, paneContentRect, type DrawerLayoutRects, type LenRect } from './drawerGeometry';
import { leaves, type PaneNode } from './paneTree';
import type { Tab } from '../store/tabsSlice';
import { toTerminalTab, type DrawerTerminal, type TerminalDrawer } from '../store/terminalDrawersSlice';

export type PaneLayer = {
  tab: Tab;
  paneId: string;
  rect: LenRect;
  visible: boolean;
  focused: boolean;
  takeFocus: boolean;
  drawerOwnerId: string | null;
};

export type VisibleDrawer = {
  ownerTabId: string;
  paneId: string;
  rects: DrawerLayoutRects;
  drawer: TerminalDrawer;
};

export function computePaneLayers(input: {
  tabs: Tab[];
  layout: PaneNode;
  focusedPaneId: string;
  barHeight: number;
  drawers: Record<string, TerminalDrawer>;
  drawerTerminals: Record<string, DrawerTerminal>;
  drawerSize: number;
}): { layers: PaneLayer[]; visibleDrawers: VisibleDrawer[] } {
  const rects = computePaneRects(input.layout);
  const owners = new Map<string, { paneId: string; active: boolean }>();
  for (const pane of leaves(input.layout)) {
    for (const tabId of pane.tabIds) owners.set(tabId, { paneId: pane.id, active: pane.activeTabId === tabId });
  }

  const layers: PaneLayer[] = [];
  const visibleDrawers: VisibleDrawer[] = [];
  for (const tab of input.tabs) {
    const owner = owners.get(tab.id);
    const paneRect = owner ? rects.get(owner.paneId) : undefined;
    if (!owner || !paneRect) continue;
    const paneFocused = owner.paneId === input.focusedPaneId;
    const content = paneContentRect(paneRect, input.barHeight);
    const drawer = tab.kind === 'session' ? input.drawers[tab.id] : undefined;
    if (!drawer) {
      layers.push({ tab, paneId: owner.paneId, rect: content, visible: owner.active, focused: paneFocused, takeFocus: paneFocused, drawerOwnerId: null });
      continue;
    }
    const drawerRects = computeDrawerLayout(paneRect, input.barHeight, input.drawerSize, drawer.layout);
    const drawerShown = owner.active && drawer.open;
    layers.push({
      tab,
      paneId: owner.paneId,
      rect: drawer.open ? drawerRects.session : content,
      visible: owner.active,
      focused: paneFocused,
      takeFocus: paneFocused && !(drawer.open && drawer.hasFocus),
      drawerOwnerId: null,
    });
    for (const [terminalId, rect] of drawerRects.terminals) {
      const terminal = input.drawerTerminals[terminalId];
      if (!terminal) continue;
      const focused = drawerShown && paneFocused && drawer.hasFocus && drawer.focusedTerminalId === terminalId;
      layers.push({ tab: toTerminalTab(terminal), paneId: owner.paneId, rect, visible: drawerShown, focused, takeFocus: focused, drawerOwnerId: tab.id });
    }
    if (drawerShown) visibleDrawers.push({ ownerTabId: tab.id, paneId: owner.paneId, rects: drawerRects, drawer });
  }
  layers.sort((a, b) => (a.tab.id < b.tab.id ? -1 : a.tab.id > b.tab.id ? 1 : 0));
  return { layers, visibleDrawers };
}
```

- [ ] **Step 4: Run the pure test**

Run: `npx vitest run src/lib/paneLayers.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing component tests**

In `src/components/center/PaneLayout.test.tsx` replace the `TerminalView` mock with:

```tsx
vi.mock('../terminal/TerminalView', () => ({
  TerminalView: ({ visible, focused, takeFocus, onExit }: { visible?: boolean; focused?: boolean; takeFocus?: boolean; onExit?: (code: number) => void }) => {
    useEffect(() => { counters.terminalMounts += 1; }, []);
    return (
      <div
        data-testid="terminal"
        data-visible={String(visible)}
        data-focused={String(!!focused)}
        data-take-focus={String(takeFocus ?? !!focused)}
        onMouseDown={e => e.stopPropagation()}
      >
        {onExit ? <button data-testid="exit" onClick={() => onExit(0)} /> : null}
      </div>
    );
  },
}));
```

Append at the end of the file:

```tsx
const liveSession = (id: string): Tab => ({ kind: 'session', id, projectId: 1, sessionId: id, title: id, mode: 'terminal' });

describe('PaneLayout terminal drawer', () => {
  beforeEach(() => {
    counters.terminalMounts = 0;
    useStore.setState({
      tabs: [liveSession('s1')],
      activeTabId: 's1',
      mruOrder: [],
      navHistory: [],
      navIndex: 0,
      projects: [{ id: 1, name: 'P', path: '/p' }] as never,
      layout: createLeaf(ROOT_PANE_ID, ['s1'], 's1'),
      focusedPaneId: ROOT_PANE_ID,
      tabLayoutMode: 'classic',
      drawers: {},
      drawerTerminals: {},
      drawerDragSize: null,
      drawerClosePrompt: null,
      terminalDrawerSize: 0.35,
    });
  });

  const drawerIds = () => leaves(useStore.getState().drawers.s1.layout).map(l => l.id);

  it('shrinks the session layer and places the drawer terminal below it', () => {
    const { container } = render(<PaneLayout />);
    act(() => { useStore.getState().toggleTerminalDrawer('s1'); });
    const [id] = drawerIds();
    const session = container.querySelector('[data-tab-layer="s1"]') as HTMLElement;
    const terminal = container.querySelector(`[data-tab-layer="${id}"]`) as HTMLElement;
    expect(session.style.height).toBe('calc(65% - 20.8px)');
    expect(terminal.style.top).toBe('calc(65% + 39.2px)');
    expect(terminal.dataset.drawerOwner).toBe('s1');
  });

  it('never remounts a drawer terminal when it is detached to a tab', () => {
    const { container } = render(<PaneLayout />);
    act(() => { useStore.getState().toggleTerminalDrawer('s1'); });
    expect(counters.terminalMounts).toBe(2);
    const [id] = drawerIds();
    const node = container.querySelector(`[data-tab-layer="${id}"]`) as HTMLElement;
    const observer = new MutationObserver(() => {});
    observer.observe(node.parentElement!, { childList: true });

    act(() => { useStore.getState().detachDrawerTerminal(id); });

    const removed = observer.takeRecords().flatMap(r => Array.from(r.removedNodes));
    observer.disconnect();
    expect(counters.terminalMounts).toBe(2);
    expect(container.querySelector(`[data-tab-layer="${id}"]`)).toBe(node);
    expect(removed).not.toContain(node);
    expect(node.dataset.drawerOwner).toBeUndefined();
  });

  it('never remounts drawer terminals when their session moves to another pane', () => {
    useStore.setState({ tabs: [liveSession('s1'), terminalTab('t2', 'Inny')], layout: createLeaf(ROOT_PANE_ID, ['s1', 't2'], 's1') });
    render(<PaneLayout />);
    act(() => { useStore.getState().toggleTerminalDrawer('s1'); });
    const mounts = counters.terminalMounts;
    act(() => { useStore.getState().splitPaneWithTab(ROOT_PANE_ID, 'row', false, 's1'); });
    expect(counters.terminalMounts).toBe(mounts);
  });

  it('keeps the terminals of a hidden drawer mounted but invisible', () => {
    const { container } = render(<PaneLayout />);
    act(() => { useStore.getState().toggleTerminalDrawer('s1'); });
    const [id] = drawerIds();
    act(() => { useStore.getState().hideTerminalDrawer('s1'); });
    const layer = container.querySelector(`[data-tab-layer="${id}"]`) as HTMLElement;
    expect(layer.className).toContain('invisible');
    expect(counters.terminalMounts).toBe(2);
    expect((container.querySelector('[data-tab-layer="s1"]') as HTMLElement).style.height).toBe('calc(100% - 32px)');
  });

  it('hands the keyboard back to the session when the last drawer shell exits', () => {
    const { container } = render(<PaneLayout />);
    act(() => { useStore.getState().toggleTerminalDrawer('s1'); });
    const session = () => container.querySelector('[data-tab-layer="s1"] [data-testid="terminal"]') as HTMLElement;
    expect(session().dataset.takeFocus).toBe('false');

    fireEvent.click(container.querySelector('[data-testid="exit"]')!);

    expect(useStore.getState().drawers.s1).toBeUndefined();
    expect(session().dataset.takeFocus).toBe('true');
  });

  it('moves the keyboard between the session and a clicked drawer terminal', () => {
    const { container } = render(<PaneLayout />);
    act(() => {
      useStore.getState().toggleTerminalDrawer('s1');
      useStore.getState().splitDrawerTerminal('s1', 'row');
    });
    const [first] = drawerIds();
    fireEvent.mouseDown(container.querySelector(`[data-tab-layer="${first}"] [data-testid="terminal"]`)!);
    expect(useStore.getState().drawers.s1).toMatchObject({ hasFocus: true, focusedTerminalId: first });
    fireEvent.mouseDown(container.querySelector('[data-tab-layer="s1"] [data-testid="terminal"]')!);
    expect(useStore.getState().drawers.s1.hasFocus).toBe(false);
  });
});
```

- [ ] **Step 6: Run to verify the component tests fail**

Run: `npx vitest run src/components/center/PaneLayout.test.tsx`
Expected: FAIL — drawer layers are not rendered (`querySelector` returns null).

- [ ] **Step 7: Render layers from `computePaneLayers` in `PaneLayout`**

In `src/components/center/PaneLayout.tsx`:
- add imports `import { lenRectStyle } from '../../lib/drawerGeometry';` and `import { computePaneLayers } from '../../lib/paneLayers';`
- add selectors after `const tabLayoutMode = …`:

```tsx
  const drawers = useStore(s => s.drawers);
  const drawerTerminals = useStore(s => s.drawerTerminals);
  const drawerSize = useStore(s => s.drawerDragSize ?? s.terminalDrawerSize);
  const focusDrawerTerminal = useStore(s => s.focusDrawerTerminal);
  const focusDrawerSession = useStore(s => s.focusDrawerSession);
  const closeDrawerTerminal = useStore(s => s.closeDrawerTerminal);
```

- replace the `ownerOf` `useMemo` with:

```tsx
  const { layers } = useMemo(
    () => computePaneLayers({ tabs, layout, focusedPaneId, barHeight, drawers, drawerTerminals, drawerSize }),
    [tabs, layout, focusedPaneId, barHeight, drawers, drawerTerminals, drawerSize],
  );
```

- replace the whole `{tabs.map(tab => { … })}` block (keep the `{/* Layers stay siblings … */}` comment above it) with:

```tsx
      {layers.map(layer => (
        <div
          key={layer.tab.id}
          data-tab-layer={layer.tab.id}
          data-pane-content={layer.paneId}
          data-drawer-owner={layer.drawerOwnerId ?? undefined}
          // Capture phase: xterm's textarea swallows mousedown before it bubbles out.
          onMouseDownCapture={() => {
            focusPane(layer.paneId);
            if (layer.drawerOwnerId) focusDrawerTerminal(layer.drawerOwnerId, layer.tab.id);
            else focusDrawerSession(layer.tab.id);
          }}
          className={`absolute ${layer.visible ? '' : 'invisible pointer-events-none'}`}
          style={lenRectStyle(layer.rect)}
        >
          <TabPanel
            tab={layer.tab}
            visible={layer.visible}
            focused={layer.focused}
            takeFocus={layer.takeFocus}
            onExit={layer.drawerOwnerId ? () => closeDrawerTerminal(layer.tab.id) : undefined}
          />
        </div>
      ))}
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `npx vitest run src/components/center/ src/components/layout/`
Expected: PASS. If an existing test indexes `querySelectorAll('[data-testid="terminal"]')` by position and now fails only because layers are sorted by id, change that assertion to select by `[data-tab-layer="<id>"]` — do not remove the sort.

Run: `npm run lint`
Expected: zero errors.

- [ ] **Step 9: Commit**

```bash
git add src/lib/paneLayers.ts src/lib/paneLayers.test.ts src/components/center/PaneLayout.tsx src/components/center/PaneLayout.test.tsx
git commit -m "feat(desktop): render session drawer terminals as pane layers"
```

---

### Task 7: Drawer chrome — header, divider, resizers, focus ring, close dialog

**Files:**
- Create: `src/components/center/TerminalDrawerChrome.tsx`
- Modify: `src/components/center/PaneLayout.tsx`, `src/components/shared/Icon.tsx`
- Test: `src/components/center/PaneLayout.test.tsx`

**Interfaces:**
- Consumes: Task 1 `clampDrawerSize`, `cssLen`, `lenRectStyle`, `resolveLen`, `DRAWER_MIN_SPLIT_WIDTH`, `DRAWER_MIN_SPLIT_HEIGHT`, `LenRect`; Task 2/3 slice actions; Task 5 `SplitResizers`; Task 6 `VisibleDrawer`; `formatBinding`, `getBinding`, `ShortcutId` from `lib/shortcuts` (the ids `splitTerminalRight`/`splitTerminalDown` are added in Task 8 — until then `hint` receives them typed as `ShortcutId`, so **add the two ids to the `ShortcutId` union and `SHORTCUTS` array in this task** exactly as shown in Task 8 Step 3, first bullet).
- Produces:
  - `TerminalDrawerChrome({ entry, containerRef }: { entry: VisibleDrawer; containerRef: RefObject<HTMLDivElement | null> })`
  - `DrawerCloseDialog()`
  - DOM hooks: `[data-drawer-divider]` (role separator), `[data-drawer-header="<sessionTabId>"]`, `[data-drawer-focus-ring]`; buttons with accessible names `Podziel w prawo (…)`, `Podziel w dół (…)`, `Wydziel do zakładki`, `Zamknij terminal`, `Schowaj panel`
  - icons `splitRow`, `splitCol`, `toTab`

- [ ] **Step 1: Write the failing tests**

Add `screen` to the Testing Library import at the top of `src/components/center/PaneLayout.test.tsx` (`import { act, fireEvent, render, screen } from '@testing-library/react';`) and append inside `describe('PaneLayout terminal drawer', …)`:

```tsx
  it('splits from the header and outlines the focused terminal', () => {
    const { container } = render(<PaneLayout />);
    act(() => { useStore.getState().toggleTerminalDrawer('s1'); });
    expect(container.querySelector('[data-drawer-focus-ring]')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Podziel w prawo/ }));
    expect(container.querySelectorAll('[data-drawer-owner="s1"]')).toHaveLength(2);
    expect(container.querySelector('[data-drawer-focus-ring]')).not.toBeNull();
  });

  it('detaches the focused terminal from the header', () => {
    render(<PaneLayout />);
    act(() => { useStore.getState().toggleTerminalDrawer('s1'); });
    const [id] = drawerIds();
    fireEvent.click(screen.getByRole('button', { name: 'Wydziel do zakładki' }));
    expect(useStore.getState().tabs.some(t => t.id === id && t.kind === 'terminal')).toBe(true);
    expect(useStore.getState().drawers).toEqual({});
  });

  it('hides the drawer from the header', () => {
    const { container } = render(<PaneLayout />);
    act(() => { useStore.getState().toggleTerminalDrawer('s1'); });
    fireEvent.click(screen.getByRole('button', { name: 'Schowaj panel' }));
    expect(useStore.getState().drawers.s1.open).toBe(false);
    expect(container.querySelector('[data-drawer-header]')).toBeNull();
  });

  it('asks before closing a terminal from the header', () => {
    render(<PaneLayout />);
    act(() => { useStore.getState().toggleTerminalDrawer('s1'); });
    fireEvent.click(screen.getByRole('button', { name: 'Zamknij terminal' }));
    expect(screen.getByText('Zamknąć terminal?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Zamknij' }));
    expect(useStore.getState().drawers).toEqual({});
    expect(screen.queryByText('Zamknąć terminal?')).toBeNull();
  });

  it('resizes the drawer from the divider and persists only on release', () => {
    const { container } = render(<PaneLayout />);
    act(() => { useStore.getState().toggleTerminalDrawer('s1'); });
    stubBox(container.firstElementChild as HTMLElement, 1000, 800);
    const divider = container.querySelector('[data-drawer-divider]') as HTMLElement;

    fireEvent.mouseDown(divider, { clientX: 500, clientY: 500 });
    fireEvent.mouseMove(window, { clientX: 500, clientY: 400 });
    expect(useStore.getState().drawerDragSize).toBeCloseTo(0.35 + 100 / 768);
    expect(useStore.getState().terminalDrawerSize).toBe(0.35);

    fireEvent.mouseUp(window);
    expect(useStore.getState().terminalDrawerSize).toBeCloseTo(0.35 + 100 / 768);
    expect(useStore.getState().drawerDragSize).toBeNull();
  });

  it('resizes a split inside the drawer', () => {
    const { container } = render(<PaneLayout />);
    act(() => {
      useStore.getState().toggleTerminalDrawer('s1');
      useStore.getState().splitDrawerTerminal('s1', 'row');
    });
    stubBox(container.firstElementChild as HTMLElement, 1000, 800);
    const handle = container.querySelector('[role="separator"]:not([data-drawer-divider])') as HTMLElement;
    fireEvent.mouseDown(handle, { clientX: 500, clientY: 700 });
    fireEvent.mouseMove(window, { clientX: 600, clientY: 700 });
    const split = useStore.getState().drawers.s1.layout as PaneSplit;
    expect(split.sizes[0]).toBeCloseTo(0.6);
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/components/center/PaneLayout.test.tsx`
Expected: FAIL — no header buttons, no divider.

- [ ] **Step 3: Add the icons**

In `src/components/shared/Icon.tsx`, inside `paths`, after the `terminal:` entry add:

```tsx
  splitRow: <g><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v16"/></g>,
  splitCol: <g><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 12h18"/></g>,
  toTab:    <g><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 15l6-6"/><path d="M10 9h5v5"/></g>,
```

- [ ] **Step 4: Add the two shortcut ids now**

Apply Task 8 Step 3's first bullet (the `ShortcutId` union and the two `SHORTCUTS` rows) in `src/lib/shortcuts.ts` so the header can show their bindings.

- [ ] **Step 5: Write the chrome component**

Create `src/components/center/TerminalDrawerChrome.tsx`:

```tsx
import { useCallback, useEffect, useRef, type RefObject } from 'react';
import { useStore } from '../../store';
import {
  clampDrawerSize,
  cssLen,
  DRAWER_MIN_SPLIT_HEIGHT,
  DRAWER_MIN_SPLIT_WIDTH,
  lenRectStyle,
  resolveLen,
  type LenRect,
} from '../../lib/drawerGeometry';
import type { VisibleDrawer } from '../../lib/paneLayers';
import { formatBinding, getBinding, type ShortcutId } from '../../lib/shortcuts';
import { IconBtn } from '../shared/IconBtn';
import { ConfirmDialog } from '../dialogs/ConfirmDialog';
import { SplitResizers } from './PaneResizers';

const drawerMinPx = (dir: 'row' | 'col') => (dir === 'row' ? DRAWER_MIN_SPLIT_WIDTH : DRAWER_MIN_SPLIT_HEIGHT);

function DrawerDivider({ content, header, containerRef }: {
  content: LenRect;
  header: LenRect;
  containerRef: RefObject<HTMLDivElement | null>;
}) {
  const setDrawerDragSize = useStore(s => s.setDrawerDragSize);
  const setTerminalDrawerSize = useStore(s => s.setTerminalDrawerSize);
  const handlersRef = useRef<{ move: (e: MouseEvent) => void; up: () => void } | null>(null);

  const finish = useCallback(() => {
    if (!handlersRef.current) return;
    window.removeEventListener('mousemove', handlersRef.current.move);
    window.removeEventListener('mouseup', handlersRef.current.up);
    handlersRef.current = null;
    const size = useStore.getState().drawerDragSize;
    if (size !== null) setTerminalDrawerSize(size);
    setDrawerDragSize(null);
  }, [setDrawerDragSize, setTerminalDrawerSize]);

  useEffect(() => finish, [finish]);

  const onMouseDown = (e: React.MouseEvent) => {
    finish();
    e.preventDefault();
    const box = containerRef.current?.getBoundingClientRect();
    if (!box) return;
    const contentPx = resolveLen(content.height, box.height);
    if (contentPx <= 0) return;
    const startY = e.clientY;
    const startSize = useStore.getState().terminalDrawerSize;
    const move = (ev: MouseEvent) =>
      setDrawerDragSize(clampDrawerSize(startSize - (ev.clientY - startY) / contentPx, contentPx));
    handlersRef.current = { move, up: finish };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', finish);
  };

  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      data-drawer-divider
      onMouseDown={onMouseDown}
      className="absolute z-30 h-[5px] -translate-y-1/2 cursor-row-resize bg-border hover:bg-accent transition-colors"
      style={{ left: cssLen(header.left), top: cssLen(header.top), width: cssLen(header.width) }}
    />
  );
}

export function TerminalDrawerChrome({ entry, containerRef }: {
  entry: VisibleDrawer;
  containerRef: RefObject<HTMLDivElement | null>;
}) {
  const { ownerTabId, paneId, rects, drawer } = entry;
  const overrides = useStore(s => s.shortcutOverrides);
  const focusPane = useStore(s => s.focusPane);
  const focusDrawerTerminal = useStore(s => s.focusDrawerTerminal);
  const splitDrawerTerminal = useStore(s => s.splitDrawerTerminal);
  const detachDrawerTerminal = useStore(s => s.detachDrawerTerminal);
  const requestCloseDrawerTerminal = useStore(s => s.requestCloseDrawerTerminal);
  const hideTerminalDrawer = useStore(s => s.hideTerminalDrawer);
  const resizeDrawerSplit = useStore(s => s.resizeDrawerSplit);
  const onResize = useCallback(
    (splitId: string, sizes: number[]) => resizeDrawerSplit(ownerTabId, splitId, sizes),
    [ownerTabId, resizeDrawerSplit],
  );
  const hint = (id: ShortcutId) => formatBinding(getBinding(id, overrides));
  const focusedRect = rects.terminals.get(drawer.focusedTerminalId);

  return (
    <>
      <DrawerDivider content={rects.content} header={rects.header} containerRef={containerRef} />
      <div
        data-drawer-header={ownerTabId}
        onMouseDownCapture={() => {
          focusPane(paneId);
          focusDrawerTerminal(ownerTabId, drawer.focusedTerminalId);
        }}
        className="absolute z-20 flex items-center justify-between gap-2 border-t border-border bg-bg px-2"
        style={lenRectStyle(rects.header)}
      >
        <span className="text-[11px] text-muted select-none">Terminal</span>
        <div className="flex items-center gap-0.5">
          <IconBtn tone="ghost" size="sm" icon="splitRow" label={`Podziel w prawo (${hint('splitTerminalRight')})`} onClick={() => splitDrawerTerminal(ownerTabId, 'row')} />
          <IconBtn tone="ghost" size="sm" icon="splitCol" label={`Podziel w dół (${hint('splitTerminalDown')})`} onClick={() => splitDrawerTerminal(ownerTabId, 'col')} />
          <IconBtn tone="ghost" size="sm" icon="toTab" label="Wydziel do zakładki" onClick={() => detachDrawerTerminal(drawer.focusedTerminalId)} />
          <IconBtn tone="ghost" size="sm" icon="close" label="Zamknij terminal" onClick={() => requestCloseDrawerTerminal(drawer.focusedTerminalId)} />
          <IconBtn tone="ghost" size="sm" icon="chevron" label="Schowaj panel" onClick={() => hideTerminalDrawer(ownerTabId)} />
        </div>
      </div>
      <SplitResizers layout={drawer.layout} containerRef={containerRef} frame={rects.body} minPx={drawerMinPx} onResize={onResize} />
      {rects.terminals.size > 1 && drawer.hasFocus && focusedRect && (
        <div
          data-drawer-focus-ring
          className="absolute z-20 pointer-events-none border border-accent"
          style={lenRectStyle(focusedRect)}
        />
      )}
    </>
  );
}

export function DrawerCloseDialog() {
  const prompt = useStore(s => s.drawerClosePrompt);
  const cancel = useStore(s => s.cancelCloseDrawerTerminal);
  const close = useStore(s => s.closeDrawerTerminal);
  if (!prompt) return null;
  return (
    <ConfirmDialog
      title="Zamknąć terminal?"
      message="W tym terminalu działa powłoka. Zamknięcie zakończy ją."
      onCancel={cancel}
      onConfirm={() => close(prompt)}
    />
  );
}
```

- [ ] **Step 6: Mount the chrome in `PaneLayout`**

In `src/components/center/PaneLayout.tsx`:
- import `import { DrawerCloseDialog, TerminalDrawerChrome } from './TerminalDrawerChrome';`
- destructure `visibleDrawers` too: `const { layers, visibleDrawers } = useMemo(…)`
- directly after `<PaneResizers layout={layout} containerRef={containerRef} />` add:

```tsx
      {visibleDrawers.map(entry => (
        <TerminalDrawerChrome key={entry.ownerTabId} entry={entry} containerRef={containerRef} />
      ))}
      <DrawerCloseDialog />
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx vitest run src/components/center/`
Expected: PASS.

Run: `npm run lint`
Expected: zero errors.

- [ ] **Step 8: Commit**

```bash
git add src/components/center/TerminalDrawerChrome.tsx src/components/center/PaneLayout.tsx src/components/center/PaneLayout.test.tsx src/components/shared/Icon.tsx src/lib/shortcuts.ts
git commit -m "feat(desktop): add terminal drawer header, divider and split resizers"
```

---

### Task 8: Entry points and keyboard shortcuts

**Files:**
- Create: `src/components/center/useTerminalDrawerShortcuts.ts`
- Modify: `src/lib/shortcuts.ts`, `src/components/center/PaneLayout.tsx`, `src/components/layout/AppShell.tsx`, `src/components/center/TabBar.tsx`, `src/components/center/StackedTabBar.tsx`, `src/components/right/ProjectToolbar.tsx`, `src/components/history/HistoryHeader.tsx`, `src/components/sidebar/ProjectItem.tsx`, `src/components/center/ProjectLauncher.tsx`, `src/components/center/useTabBarActions.tsx`
- Test: `src/lib/shortcuts.test.ts`, `src/components/center/PaneLayout.test.tsx`, `src/components/center/StackedTabBar.test.tsx`, `src/components/right/ProjectToolbar.test.tsx`, `src/components/layout/AppShell.test.tsx`

**Interfaces:**
- Consumes: Task 1 `Direction`; Task 2/3 `openTerminal`, `splitDrawerTerminal`, `moveDrawerFocus`, `requestCloseDrawerTerminal`, `drawers`.
- Produces:
  - `ShortcutId` gains `'splitTerminalRight' | 'splitTerminalDown'`
  - `DRAWER_FOCUS_BINDINGS: ReadonlyArray<readonly [Direction, string]>`, `drawerFocusDirection(e: KeyboardEvent): Direction | null`
  - `formatBinding('mod+alt+arrows')` renders the `arrows` token as `←↑→↓`
  - `useTerminalDrawerShortcuts(): void`

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/shortcuts.test.ts` (extend its import to `import { DRAWER_FOCUS_BINDINGS, FIXED_SHORTCUTS, SHORTCUTS, drawerFocusDirection, formatBinding } from './shortcuts';`):

```ts
describe('terminal drawer shortcuts', () => {
  it('registers configurable split shortcuts', () => {
    expect(SHORTCUTS.find(s => s.id === 'splitTerminalRight')?.defaultBinding).toBe('mod+shift+o');
    expect(SHORTCUTS.find(s => s.id === 'splitTerminalDown')?.defaultBinding).toBe('mod+shift+e');
  });

  it('lists split navigation as a fixed shortcut with an arrows badge', () => {
    const row = FIXED_SHORTCUTS.find(s => s.binding === 'mod+alt+arrows');
    expect(row).toBeDefined();
    expect(formatBinding('mod+alt+arrows')).toContain('←↑→↓');
  });

  it('maps mod+alt+arrow keys to directions', () => {
    const ev = (key: string) => new KeyboardEvent('keydown', { key, ctrlKey: true, altKey: true });
    expect(drawerFocusDirection(ev('ArrowLeft'))).toBe('left');
    expect(drawerFocusDirection(ev('ArrowDown'))).toBe('down');
    expect(drawerFocusDirection(new KeyboardEvent('keydown', { key: 'ArrowLeft', ctrlKey: true }))).toBeNull();
    expect(DRAWER_FOCUS_BINDINGS).toHaveLength(4);
  });
});
```

Append inside `describe('PaneLayout terminal drawer', …)` in `src/components/center/PaneLayout.test.tsx` (add `createEvent` to the Testing Library import):

```tsx
  it('splits the focused drawer terminal with the shortcut', () => {
    render(<PaneLayout />);
    act(() => { useStore.getState().toggleTerminalDrawer('s1'); });
    fireEvent.keyDown(document, { key: 'O', ctrlKey: true, shiftKey: true });
    expect(drawerIds()).toHaveLength(2);
  });

  it('lets split shortcuts through to the session while it holds the keyboard', () => {
    render(<PaneLayout />);
    act(() => {
      useStore.getState().toggleTerminalDrawer('s1');
      useStore.getState().focusDrawerSession('s1');
    });
    const ev = createEvent.keyDown(document, { key: 'O', ctrlKey: true, shiftKey: true });
    fireEvent(document, ev);
    expect(ev.defaultPrevented).toBe(false);
    expect(drawerIds()).toHaveLength(1);
  });

  it('moves between drawer splits with mod+alt+arrows', () => {
    render(<PaneLayout />);
    act(() => {
      useStore.getState().toggleTerminalDrawer('s1');
      useStore.getState().splitDrawerTerminal('s1', 'row');
    });
    const [first] = drawerIds();
    fireEvent.keyDown(document, { key: 'ArrowLeft', ctrlKey: true, altKey: true });
    expect(useStore.getState().drawers.s1.focusedTerminalId).toBe(first);
  });

  it('closes the focused drawer terminal on mod+w instead of the session', () => {
    render(<PaneLayout />);
    act(() => { useStore.getState().toggleTerminalDrawer('s1'); });
    const [id] = drawerIds();
    fireEvent.keyDown(document, { key: 'w', ctrlKey: true });
    expect(useStore.getState().drawerClosePrompt).toBe(id);
    expect(screen.getByText('Zamknąć terminal?')).toBeInTheDocument();
    expect(useStore.getState().tabs.some(t => t.id === 's1')).toBe(true);
  });

  it('closes the session on mod+w while the session holds the keyboard', () => {
    render(<PaneLayout />);
    act(() => {
      useStore.getState().toggleTerminalDrawer('s1');
      useStore.getState().focusDrawerSession('s1');
    });
    fireEvent.keyDown(document, { key: 'w', ctrlKey: true });
    expect(useStore.getState().drawerClosePrompt).toBeNull();
    expect(screen.getByText('Zamknąć aktywny tab?')).toBeInTheDocument();
  });
```

In `src/components/center/StackedTabBar.test.tsx` replace the test `opens a new terminal for the project of the active tab` with:

```tsx
  it('toggles the terminal drawer of the active session', () => {
    seed('session:a1', ['session:a1']);
    useStore.setState({ drawers: {}, drawerTerminals: {} });
    render(<StackedTabBar />);
    fireEvent.click(screen.getByTitle('Nowy terminal'));
    expect(useStore.getState().drawers['session:a1']?.open).toBe(true);
  });

  it('opens a terminal tab when the active tab is not a session', () => {
    seed('session:a1', ['session:a1']);
    const openNewTerminalTab = vi.fn();
    useStore.setState({
      tabs: [...useStore.getState().tabs, { kind: 'terminal', id: 'terminal:x', projectId: 1, title: 'T' }],
      activeTabId: 'terminal:x',
      openNewTerminalTab,
    });
    render(<StackedTabBar />);
    fireEvent.click(screen.getByTitle('Nowy terminal'));
    expect(openNewTerminalTab).toHaveBeenCalledWith(1);
  });
```

(If `seed` also sets `layout`, the reconciler places `terminal:x` automatically; if the second test's `$` button is not rendered because the stacked bar's selected project differs, set `layout` to a leaf containing all four tab ids with `terminal:x` active.)

In `src/components/right/ProjectToolbar.test.tsx`:
- rename the hoisted mock `openNewTerminalTab` to `openTerminal` (both in `vi.hoisted` and in `baseState`, where the key becomes `openTerminal`);
- change the assertion to `expect(openTerminal).toHaveBeenCalledWith(4, { toggle: false });`

In `src/components/layout/AppShell.test.tsx` add `fireEvent` to its Testing Library import and append this test **inside** the existing `describe('AppShell attention across panes', …)` — its `beforeEach` mocks the Tauri APIs and already renders `AppShell` with `session:s1` (project 1) active in the focused pane:

```tsx
  it('toggles the drawer of the active session on mod+t', () => {
    act(() => { useStore.setState({ drawers: {}, drawerTerminals: {}, shortcutOverrides: {} }); });
    fireEvent.keyDown(document, { key: 't', ctrlKey: true });
    expect(useStore.getState().drawers['session:s1']?.open).toBe(true);
    expect(useStore.getState().tabs.some(t => t.kind === 'terminal')).toBe(false);
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/lib/shortcuts.test.ts src/components/center/PaneLayout.test.tsx src/components/center/StackedTabBar.test.tsx src/components/right/ProjectToolbar.test.tsx src/components/layout/AppShell.test.tsx`
Expected: FAIL on every new/changed test.

- [ ] **Step 3: Extend `lib/shortcuts.ts`**

- Change the id union and add the rows (the first two edits may already exist from Task 7 Step 4):

```ts
export type ShortcutId = 'newSession' | 'newTerminal' | 'closeTab' | 'focusSearch' | 'openProjectLauncher' | 'splitTerminalRight' | 'splitTerminalDown';
```

In `SHORTCUTS` replace the `newTerminal` row and append two rows:

```ts
  { id: 'newTerminal', label: 'Terminal', description: 'W sesji wysuwa lub chowa panel terminala, poza sesją otwiera nową zakładkę terminala', defaultBinding: 'mod+t' },
```

```ts
  { id: 'splitTerminalRight', label: 'Podziel terminal w prawo', description: 'Dzieli terminal z fokusem w panelu terminala sesji', defaultBinding: 'mod+shift+o' },
  { id: 'splitTerminalDown', label: 'Podziel terminal w dół', description: 'Dzieli terminal z fokusem w panelu terminala sesji', defaultBinding: 'mod+shift+e' },
```

- Append to `FIXED_SHORTCUTS`:

```ts
  { label: 'Podziały terminala', description: 'Przenosi fokus na sąsiedni podział w panelu terminala', binding: 'mod+alt+arrows' },
```

- Add `import type { Direction } from './drawerGeometry';` at the top and, after `matchesBinding`:

```ts
export const DRAWER_FOCUS_BINDINGS: ReadonlyArray<readonly [Direction, string]> = [
  ['left', 'mod+alt+arrowleft'],
  ['right', 'mod+alt+arrowright'],
  ['up', 'mod+alt+arrowup'],
  ['down', 'mod+alt+arrowdown'],
];

export function drawerFocusDirection(e: KeyboardEvent): Direction | null {
  return DRAWER_FOCUS_BINDINGS.find(([, binding]) => matchesBinding(e, binding))?.[0] ?? null;
}
```

- In `formatBinding`'s `map`, add before the final `return p.toUpperCase();`: `if (p === 'arrows') return '←↑→↓';`

- [ ] **Step 4: Add the shortcuts hook and mount it**

Create `src/components/center/useTerminalDrawerShortcuts.ts`:

```ts
import { useEffect } from 'react';
import { useStore } from '../../store';
import { drawerFocusDirection, matchesShortcut } from '../../lib/shortcuts';

export function useTerminalDrawerShortcuts() {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const state = useStore.getState();
      const tabId = state.activeTabId;
      const drawer = tabId ? state.drawers[tabId] : undefined;
      if (!tabId || !drawer?.open || !drawer.hasFocus) return;
      const overrides = state.shortcutOverrides;
      const direction = drawerFocusDirection(e);
      if (matchesShortcut(e, 'splitTerminalRight', overrides)) state.splitDrawerTerminal(tabId, 'row');
      else if (matchesShortcut(e, 'splitTerminalDown', overrides)) state.splitDrawerTerminal(tabId, 'col');
      else if (direction) state.moveDrawerFocus(tabId, direction);
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    document.addEventListener('keydown', onKeyDown, { capture: true });
    return () => document.removeEventListener('keydown', onKeyDown, { capture: true });
  }, []);
}
```

In `src/components/center/PaneLayout.tsx` import it and call `useTerminalDrawerShortcuts();` right after `const { drag, beginDrag } = usePaneDrag(containerRef);`.

- [ ] **Step 5: Route `mod+w` through the drawer**

In `src/components/center/useTabBarActions.tsx`, in the `closeTab` keydown effect, replace

```ts
      e.preventDefault();
      e.stopPropagation();
      closeWithGuard(active);
```

with

```ts
      e.preventDefault();
      e.stopPropagation();
      const drawer = useStore.getState().drawers[active];
      if (drawer?.open && drawer.hasFocus) {
        useStore.getState().requestCloseDrawerTerminal(drawer.focusedTerminalId);
        return;
      }
      closeWithGuard(active);
```

- [ ] **Step 6: Switch every entry point to `openTerminal`**

- `src/components/layout/AppShell.tsx`: in the `newTerminal` branch replace `state.openNewTerminalTab(projectId);` with `state.openTerminal(projectId, { toggle: true });`
- `src/components/center/TabBar.tsx`: replace `const openNewTerminalTab = useStore(s => s.openNewTerminalTab);` with `const openTerminal = useStore(s => s.openTerminal);` and the `$` button's `onClick` with `() => openTerminal(detachedProjectId, { toggle: true })`
- `src/components/center/StackedTabBar.tsx`: same selector swap; `$` `onClick` → `() => openTerminal(selectedProjectId, { toggle: true })`
- `src/components/right/ProjectToolbar.tsx`: `const openTerminal = useStore(state => state.openTerminal);` and `onClick={() => openTerminal(project.id, { toggle: false })}`
- `src/components/history/HistoryHeader.tsx`: `const openTerminal = useStore(s => s.openTerminal);` and `onClick={() => openTerminal(meta.projectId, { toggle: false })}`
- `src/components/sidebar/ProjectItem.tsx`: `const openTerminal = useStore(s => s.openTerminal);` and `openTerminal(project.id, { toggle: false });`
- `src/components/center/ProjectLauncher.tsx`: `const openTerminal = useStore(s => s.openTerminal);` and `if (terminal) openTerminal(projectId, { toggle: false });`

Verify: `grep -rn "openNewTerminalTab" src --include='*.tsx' | grep -v '\.test\.'` — expected: no output (only the store files `tabsSlice.ts` and `terminalDrawersSlice.ts` may still reference it).

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx vitest run src/lib/shortcuts.test.ts src/components/`
Expected: PASS.

Run: `npm run lint`
Expected: zero errors.

- [ ] **Step 8: Commit**

```bash
git add src/lib/shortcuts.ts src/lib/shortcuts.test.ts src/components/center/useTerminalDrawerShortcuts.ts src/components/center/PaneLayout.tsx src/components/center/PaneLayout.test.tsx src/components/center/useTabBarActions.tsx src/components/layout/AppShell.tsx src/components/layout/AppShell.test.tsx src/components/center/TabBar.tsx src/components/center/StackedTabBar.tsx src/components/center/StackedTabBar.test.tsx src/components/right/ProjectToolbar.tsx src/components/right/ProjectToolbar.test.tsx src/components/history/HistoryHeader.tsx src/components/sidebar/ProjectItem.tsx src/components/center/ProjectLauncher.tsx
git commit -m "feat(desktop): open terminals in the session drawer with split shortcuts"
```

---

### Task 9: Lifecycle — close guards, window detach, live-shell count

**Files:**
- Modify: `src/lib/tabProcess.ts`, `src/components/center/useTabBarActions.tsx`, `src/components/layout/DetachedShell.tsx`, `src/components/layout/TitleBar.tsx`, `src/store/terminalDrawersSlice.ts`
- Test: `src/lib/tabProcess.test.ts`, `src/components/center/PaneLayout.test.tsx`, `src/store/terminalDrawersSlice.test.ts`

**Interfaces:**
- Consumes: Task 2/3 `drawers`, `countDrawerTerminals`, `selectDrawerTerminalTabs`, `detachAllDrawerTerminals`.
- Produces:
  - `isTabLiveProcess(tab: Tab, runningActions: Record<number, RunningAction | undefined>, drawers?: Readonly<Record<string, unknown>>): boolean` — a session with a drawer counts as live
  - `closeConfirmMessage(drawerTerminalCount: number): string`
  - `selectProjectTabsWithDrawers(state: Pick<AppState, 'tabs' | 'drawerTerminals'>, projectId: number): Tab[]`

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/tabProcess.test.ts` (extend the import to `import { closeConfirmMessage, isTabLiveProcess } from './tabProcess';`; `sessionHistory` already exists in the file — reuse it):

```ts
describe('drawer-aware close guard', () => {
  it('treats a history session with a drawer as live', () => {
    expect(isTabLiveProcess(sessionHistory, {}, { [sessionHistory.id]: {} })).toBe(true);
    expect(isTabLiveProcess(sessionHistory, {}, {})).toBe(false);
  });

  it('mentions how many drawer terminals will close', () => {
    expect(closeConfirmMessage(0)).toBe('W tym tabie działa aktywny proces. Zamknięcie zakończy go.');
    expect(closeConfirmMessage(2)).toBe('W tym tabie działa aktywny proces. Zamknięcie zakończy go. Zamknięte zostaną też terminale z panelu (2).');
  });
});
```

Append to `src/store/terminalDrawersSlice.test.ts` (import `selectProjectTabsWithDrawers`):

```ts
describe('group detach payload', () => {
  it('adds drawer terminals of the project to its tabs', () => {
    useStore.setState({ tabs: [session('s1'), session('s2', 2)] });
    useStore.getState().toggleTerminalDrawer('s1');
    const tabs = selectProjectTabsWithDrawers(useStore.getState(), 1);
    expect(tabs.map(t => t.kind)).toEqual(['session', 'terminal']);
  });
});
```

Append inside `describe('PaneLayout terminal drawer', …)` in `src/components/center/PaneLayout.test.tsx`:

```tsx
  it('asks before closing a history session with a hidden drawer', () => {
    useStore.setState({ tabs: [{ kind: 'session', id: 's1', projectId: 1, sessionId: 's1', title: 's1', mode: 'history' }] });
    render(<PaneLayout />);
    act(() => {
      useStore.getState().toggleTerminalDrawer('s1');
      useStore.getState().hideTerminalDrawer('s1');
    });
    fireEvent.click(screen.getByText('×'));
    expect(screen.getByText('Zamknąć aktywny tab?')).toBeInTheDocument();
    expect(screen.getByText(/terminale z panelu \(1\)/)).toBeInTheDocument();
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/lib/tabProcess.test.ts src/store/terminalDrawersSlice.test.ts src/components/center/PaneLayout.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement the guards**

Replace `src/lib/tabProcess.ts` with:

```ts
import type { Tab } from '../store/tabsSlice';
import type { RunningAction } from '../store/actionsSlice';

export function isTabLiveProcess(
  tab: Tab,
  runningActions: Record<number, RunningAction | undefined>,
  drawers: Readonly<Record<string, unknown>> = {},
): boolean {
  if (tab.kind === 'action') return runningActions[tab.actionId]?.status === 'running';
  if (tab.kind === 'session') return tab.mode === 'terminal' || drawers[tab.id] !== undefined;
  return tab.kind === 'terminal';
}

const CLOSE_MESSAGE = 'W tym tabie działa aktywny proces. Zamknięcie zakończy go.';

export function closeConfirmMessage(drawerTerminalCount: number): string {
  if (drawerTerminalCount === 0) return CLOSE_MESSAGE;
  return `${CLOSE_MESSAGE} Zamknięte zostaną też terminale z panelu (${drawerTerminalCount}).`;
}
```

Add to `src/store/terminalDrawersSlice.ts`:

```ts
export function selectProjectTabsWithDrawers(
  state: Pick<AppState, 'tabs' | 'drawerTerminals'>,
  projectId: number,
): Tab[] {
  return [...state.tabs.filter(t => t.projectId === projectId), ...selectDrawerTerminalTabs(state, projectId)];
}
```

- [ ] **Step 4: Wire the guards and detach paths in `useTabBarActions`**

In `src/components/center/useTabBarActions.tsx`:
- extend imports: `import { closeConfirmMessage, isTabLiveProcess } from '../../lib/tabProcess';` and `import { countDrawerTerminals, selectProjectTabsWithDrawers } from '../../store/terminalDrawersSlice';`
- `isActiveProcess`: `return t ? isTabLiveProcess(t, runningActions, useStore.getState().drawers) : false;`
- `runDetach`: replace `tabs: state.tabs.filter(t => t.projectId === projectId),` with `tabs: selectProjectTabsWithDrawers(state, projectId),`
- `detachWithGuard`: replace `const groupTabs = state.tabs.filter(t => t.projectId === projectId);` with `const groupTabs = selectProjectTabsWithDrawers(state, projectId);`
- context menu `onDetach`: the existing prop is

```tsx
              onDetach={() => {
                if (ctxMenu.tab.kind === 'session') void detachSessionTab(ctxMenu.tab, closeTab);
              }}
```

  replace it with

```tsx
              onDetach={() => {
                if (ctxMenu.tab.kind !== 'session') return;
                void detachSessionTab(ctxMenu.tab, id => {
                  useStore.getState().detachAllDrawerTerminals(id);
                  closeTab(id);
                });
              }}
```
- `pendingClose` dialog: `message={closeConfirmMessage(countDrawerTerminals(useStore.getState(), pendingClose))}`

- [ ] **Step 5: Detached window guard and title bar count**

- `src/components/layout/DetachedShell.tsx`: `if (state.tabs.some(t => isTabLiveProcess(t, state.runningActions, state.drawers))) {`
- `src/components/layout/TitleBar.tsx`: add `const drawerShells = useStore(s => Object.keys(s.drawerTerminals).length);` next to the `tabs` selector and change the count to

```ts
  const activeSessions = tabs.filter(t => (t.kind === 'session' && t.mode === 'terminal') || t.kind === 'terminal').length + drawerShells;
```

- [ ] **Step 6: Run the full suite and lint**

Run: `npm test`
Expected: PASS — all files (baseline 84 files / 697 tests plus the new ones).

Run: `npm run lint`
Expected: zero errors.

- [ ] **Step 7: Commit**

```bash
git add src/lib/tabProcess.ts src/lib/tabProcess.test.ts src/store/terminalDrawersSlice.ts src/store/terminalDrawersSlice.test.ts src/components/center/useTabBarActions.tsx src/components/center/PaneLayout.test.tsx src/components/layout/DetachedShell.tsx src/components/layout/TitleBar.tsx
git commit -m "feat(desktop): guard and hand over session drawer shells on close and detach"
```

---

### Task 10: Document the drawer in `DesktopApp/CLAUDE.md`

**Files:**
- Modify: `DesktopApp/CLAUDE.md`

**Interfaces:** none (documentation).

- [ ] **Step 1: Update the folder map**

In the `store/` bullet of "Folder map", add `terminalDrawersSlice` to the slice list, and in the `center/` bullet append: `TerminalDrawerChrome` + `useTerminalDrawerShortcuts` render the per-session terminal drawer (layers computed by `lib/paneLayers.ts`, geometry in `lib/drawerGeometry.ts`).

- [ ] **Step 2: Add a "Terminal drawer" subsection at the end of "Tabs system"**

```markdown
### Terminal drawer

A session tab can own a bottom drawer of shells (`store/terminalDrawersSlice.ts`, keyed by the
session tab id). Drawer terminals are **not** tabs: `tabs[]`, `reconcilePanes`, MRU and nav history
never see them. Splits reuse `PaneNode`, with every leaf id equal to the terminal id it holds.

- Entry point is `openTerminal(projectId, { toggle })`: the active session of the same project gets
  its drawer (`mod+t` / `$` toggle; toolbar, history header, sidebar and launcher only show), any
  other case opens a terminal tab.
- `PaneLayout` renders tab layers and drawer layers from one array (`computePaneLayers`) sorted by
  id. Detaching (`detachDrawerTerminal`) turns the terminal into a `terminal` tab with the **same id**
  in one `set()`, so React keeps the node and the PTY survives with its scrollback.
- `TerminalView.takeFocus` decides who gets the keyboard; `focused` still drives
  `activeAgentPtyId`, so "insert into active session" keeps targeting Claude while the drawer types.
- A store subscriber prunes drawers whose session tab vanished; that is the only cleanup path.
- Detaching a session to a window first turns its drawer terminals into tabs of the source window;
  detaching a project group hands them over as fresh terminal tabs.
```

- [ ] **Step 3: Add a gotcha**

Under "Gotchas", after the "Content layers must never change DOM parent" bullet add:

```markdown
- **Content layers must also keep their relative order** — `computePaneLayers` sorts them by id.
  React moves reordered keyed siblings with `insertBefore`, which detaches the node for a moment and
  resets xterm's scroll position and focus.
```

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(desktop): document the session terminal drawer"
```

---

### Task 11: Live QA in the real window (with the user)

**Files:** none unless a bug is found (then fix it TDD-style in the owning file and commit `fix(desktop): …`).

jsdom computes neither `calc()` nor `fit()`, so these checks can only happen in `npm run tauri dev` (run from `DesktopApp/`). Walk through them together with the user and record the outcome of each in the final report — do not mark this task done on your own.

- [ ] **Step 1:** Open a live Claude session, press `mod+t`: the drawer slides in, a shell starts in the project directory, Claude re-wraps to fewer rows and its prompt input stays fully visible.
- [ ] **Step 2:** Split right (`Ctrl+Shift+O`) and down (`Ctrl+Shift+E`), drag both the drawer divider and the split separators; in every split run `tput cols; tput lines` and compare with what is visible.
- [ ] **Step 3:** In a split run `htop` (or `seq 1 5000`), press "Wydziel do zakładki": the process keeps running in the new tab and the scrollback is intact.
- [ ] **Step 4:** Hide and show the drawer (`mod+t` twice with the drawer focused): processes survive, the drawer comes back at the same height; restart the app — the height is remembered.
- [ ] **Step 5:** `exit` in a split closes it; `exit` in the last one hides the drawer and typing goes straight to Claude.
- [ ] **Step 6:** `Ctrl+Alt+arrows` moves between splits; `Ctrl+W` with the drawer focused asks "Zamknąć terminal?", with the session focused asks about the tab.
- [ ] **Step 7:** Detach a session with a drawer to a window: its drawer shells stay in the main window as tabs. Detach a project group: the confirm lists the drawer terminals and they arrive as fresh terminal tabs.
- [ ] **Step 8:** Two panes side by side, each with a session and its own drawer: `mod+t` affects only the focused pane.
