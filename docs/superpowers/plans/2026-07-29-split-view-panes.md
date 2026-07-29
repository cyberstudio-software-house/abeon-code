# Split view (panele robocze) — plan implementacji

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Podzielić centralny obszar `DesktopApp` na drzewo paneli, w którym każdy panel ma własny pasek zakładek i własną zakładkę aktywną, a przeciągnięcie zakładki na krawędź panelu tworzy nowy podział.

**Architecture:** Layout stoi nad płaską listą `Tab[]` jako drzewo `PaneNode` (liście trzymają identyfikatory zakładek). Prostokąty paneli liczy czysta funkcja z drzewa i wystawia jako procenty w stylach inline, dzięki czemu wszystkie warstwy treści leżą w jednym kontenerze `relative` i **nigdy nie zmieniają rodzica w DOM** — `TerminalView` się nie remountuje, PTY nie ginie. Layout uzgadnia się z `tabs[]` jedną czystą funkcją `reconcilePanes` wołaną z subskrypcji store'a, więc żadna akcja otwierająca zakładkę nie musi wiedzieć o panelach.

**Tech Stack:** React 19, Zustand 5, TypeScript, Tailwind 4, Vitest + jsdom + @testing-library/react. Bez nowych zależności.

**Spec:** `docs/superpowers/specs/2026-07-29-split-view-panes-design.md`

## Global Constraints

- Identyfikatory w kodzie wyłącznie po angielsku; teksty UI po polsku.
- Bez komentarzy w kodzie, chyba że wyjaśniają nieoczywiste „dlaczego" (repo prawie ich nie ma).
- Commity: Conventional Commits 1.0.0, scope `desktop`, opis po polsku, **bez** trailera co-author.
- `npm run lint` (= `tsc --noEmit`) musi kończyć się zerem błędów.
- Zero nowych zależności w `package.json`.
- Testy uruchamiane z katalogu `DesktopApp/`.
- Minimalny rozmiar panelu: `MIN_PANE_WIDTH = 240`, `MIN_PANE_HEIGHT = 120` (px). Wysokość paska zakładek: `TAB_BAR_HEIGHT = 32` (odpowiada `h-8` w `TabBar`).
- Wszystkie funkcje czyste operujące na drzewie **muszą zwracać tę samą referencję**, gdy nic się nie zmieniło — subskrypcja store'a polega na tym, żeby nie wpaść w pętlę.

---

### Task 1: Drzewo paneli — typy i przechodzenie

**Files:**
- Create: `DesktopApp/src/lib/paneTree.ts`
- Test: `DesktopApp/src/lib/paneTree.test.ts`

**Interfaces:**
- Consumes: nic.
- Produces: `PaneLeaf`, `PaneSplit`, `PaneNode`, `createLeaf(id, tabIds?, activeTabId?)`, `leaves(node): PaneLeaf[]`, `findLeaf(node, paneId): PaneLeaf | null`, `findLeafOfTab(node, tabId): PaneLeaf | null`, `mapLeaves(node, fn): PaneNode`.

- [ ] **Step 1: Write the failing test**

Utwórz `DesktopApp/src/lib/paneTree.test.ts`:

```ts
// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { createLeaf, findLeaf, findLeafOfTab, leaves, mapLeaves, type PaneNode } from './paneTree';

const tree: PaneNode = {
  kind: 'split',
  id: 's1',
  dir: 'row',
  sizes: [0.5, 0.5],
  children: [
    createLeaf('p1', ['a', 'b'], 'a'),
    { kind: 'split', id: 's2', dir: 'col', sizes: [0.5, 0.5], children: [createLeaf('p2', ['c'], 'c'), createLeaf('p3', [], null)] },
  ],
};

describe('paneTree traversal', () => {
  it('lists leaves depth-first, left to right', () => {
    expect(leaves(tree).map(l => l.id)).toEqual(['p1', 'p2', 'p3']);
  });

  it('finds a leaf by pane id and returns null for a split id', () => {
    expect(findLeaf(tree, 'p2')?.tabIds).toEqual(['c']);
    expect(findLeaf(tree, 's2')).toBeNull();
    expect(findLeaf(tree, 'nope')).toBeNull();
  });

  it('finds the leaf owning a tab', () => {
    expect(findLeafOfTab(tree, 'b')?.id).toBe('p1');
    expect(findLeafOfTab(tree, 'zzz')).toBeNull();
  });

  it('mapLeaves returns the identical reference when no leaf changed', () => {
    expect(mapLeaves(tree, l => l)).toBe(tree);
  });

  it('mapLeaves rebuilds only the branch that changed', () => {
    const next = mapLeaves(tree, l => (l.id === 'p2' ? { ...l, tabIds: ['c', 'd'] } : l));
    expect(next).not.toBe(tree);
    expect(findLeaf(next, 'p2')?.tabIds).toEqual(['c', 'd']);
    expect((next as Extract<PaneNode, { kind: 'split' }>).children[0]).toBe(
      (tree as Extract<PaneNode, { kind: 'split' }>).children[0],
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd DesktopApp && npm test -- src/lib/paneTree.test.ts`
Expected: FAIL — `Failed to resolve import "./paneTree"`.

- [ ] **Step 3: Write minimal implementation**

Utwórz `DesktopApp/src/lib/paneTree.ts`:

```ts
export type PaneLeaf = { kind: 'leaf'; id: string; tabIds: string[]; activeTabId: string | null };
export type PaneSplit = { kind: 'split'; id: string; dir: 'row' | 'col'; sizes: number[]; children: PaneNode[] };
export type PaneNode = PaneLeaf | PaneSplit;

export function createLeaf(id: string, tabIds: string[] = [], activeTabId: string | null = null): PaneLeaf {
  return { kind: 'leaf', id, tabIds, activeTabId };
}

export function leaves(node: PaneNode): PaneLeaf[] {
  if (node.kind === 'leaf') return [node];
  return node.children.flatMap(leaves);
}

export function findLeaf(node: PaneNode, paneId: string): PaneLeaf | null {
  return leaves(node).find(l => l.id === paneId) ?? null;
}

export function findLeafOfTab(node: PaneNode, tabId: string): PaneLeaf | null {
  return leaves(node).find(l => l.tabIds.includes(tabId)) ?? null;
}

export function mapLeaves(node: PaneNode, fn: (leaf: PaneLeaf) => PaneLeaf): PaneNode {
  if (node.kind === 'leaf') return fn(node);
  const children = node.children.map(child => mapLeaves(child, fn));
  return children.every((child, i) => child === node.children[i]) ? node : { ...node, children };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd DesktopApp && npm test -- src/lib/paneTree.test.ts && npm run lint`
Expected: PASS, lint bez błędów.

- [ ] **Step 5: Commit**

```bash
cd DesktopApp && git add src/lib/paneTree.ts src/lib/paneTree.test.ts
git commit -m "feat(desktop): typy i przechodzenie drzewa paneli"
```

---

### Task 2: Drzewo paneli — podział, przenoszenie, zwijanie

**Files:**
- Modify: `DesktopApp/src/lib/paneTree.ts`
- Test: `DesktopApp/src/lib/paneTree.test.ts`

**Interfaces:**
- Consumes: `PaneNode`, `PaneLeaf`, `createLeaf`, `leaves`, `findLeaf`, `findLeafOfTab`, `mapLeaves` (Task 1).
- Produces:
  - `removeTabFromLeaves(root: PaneNode, tabId: string): PaneNode`
  - `insertBeside(root: PaneNode, targetPaneId: string, dir: 'row' | 'col', before: boolean, newLeaf: PaneLeaf, splitId: string): PaneNode`
  - `moveTab(root: PaneNode, tabId: string, targetPaneId: string, index: number): PaneNode`
  - `collapseEmpty(root: PaneNode, focusedPaneId: string): { root: PaneNode; focusedPaneId: string }`

Zasada wyboru aktywnej zakładki w liściu po usunięciu: zostaje dotychczasowa, jeśli wciąż istnieje; inaczej ostatnia z listy; inaczej `null`.

`insertBeside` spłaszcza podziały: jeśli rodzic celu jest splitem o tym samym `dir`, nowy liść trafia jako kolejne dziecko tego rodzica (zabierając połowę rozmiaru celu), zamiast tworzyć zagnieżdżony split. Dzięki temu trzy kolejne podziały w prawo dają trzy kolumny, nie drabinkę.

- [ ] **Step 1: Write the failing test**

Dopisz do `DesktopApp/src/lib/paneTree.test.ts`:

```ts
import { collapseEmpty, insertBeside, moveTab, removeTabFromLeaves } from './paneTree';

const flat = (n: PaneNode): string =>
  n.kind === 'leaf' ? `${n.id}(${n.tabIds.join(',')})` : `${n.dir}[${n.children.map(flat).join(' ')}]`;

describe('paneTree mutations', () => {
  it('removes a tab and repoints the leaf active tab', () => {
    const root = createLeaf('p1', ['a', 'b'], 'b');
    const next = removeTabFromLeaves(root, 'b') as PaneLeaf;
    expect(next.tabIds).toEqual(['a']);
    expect(next.activeTabId).toBe('a');
  });

  it('returns the same reference when the tab is absent', () => {
    const root = createLeaf('p1', ['a'], 'a');
    expect(removeTabFromLeaves(root, 'zzz')).toBe(root);
  });

  it('wraps a lone leaf into a split when inserting beside it', () => {
    const root = createLeaf('p1', ['a'], 'a');
    const next = insertBeside(root, 'p1', 'row', false, createLeaf('p2', ['b'], 'b'), 's1');
    expect(flat(next)).toBe('row[p1(a) p2(b)]');
  });

  it('inserts before the target when before=true', () => {
    const root = createLeaf('p1', ['a'], 'a');
    const next = insertBeside(root, 'p1', 'col', true, createLeaf('p2', ['b'], 'b'), 's1');
    expect(flat(next)).toBe('col[p2(b) p1(a)]');
  });

  it('flattens into the parent split when directions match', () => {
    const root = insertBeside(createLeaf('p1', ['a'], 'a'), 'p1', 'row', false, createLeaf('p2', ['b'], 'b'), 's1');
    const next = insertBeside(root, 'p2', 'row', false, createLeaf('p3', ['c'], 'c'), 's2');
    expect(flat(next)).toBe('row[p1(a) p2(b) p3(c)]');
    expect((next as PaneSplit).sizes.map(s => Number(s.toFixed(2)))).toEqual([0.5, 0.25, 0.25]);
  });

  it('nests when the parent split runs the other way', () => {
    const root = insertBeside(createLeaf('p1', ['a'], 'a'), 'p1', 'row', false, createLeaf('p2', ['b'], 'b'), 's1');
    const next = insertBeside(root, 'p2', 'col', false, createLeaf('p3', ['c'], 'c'), 's2');
    expect(flat(next)).toBe('row[p1(a) col[p2(b) p3(c)]]');
  });

  it('moves a tab between panes at the given index', () => {
    const root = insertBeside(createLeaf('p1', ['a', 'b'], 'a'), 'p1', 'row', false, createLeaf('p2', ['c'], 'c'), 's1');
    const next = moveTab(root, 'b', 'p2', 0);
    expect(flat(next)).toBe('row[p1(a) p2(b,c)]');
    expect(findLeaf(next, 'p2')?.activeTabId).toBe('b');
  });

  it('reorders inside one pane', () => {
    const root = createLeaf('p1', ['a', 'b', 'c'], 'a');
    expect(flat(moveTab(root, 'c', 'p1', 0))).toBe('p1(c,a,b)');
  });

  it('collapses an emptied leaf and renormalizes sibling sizes', () => {
    const root = insertBeside(createLeaf('p1', ['a'], 'a'), 'p1', 'row', false, createLeaf('p2', ['b'], 'b'), 's1');
    const emptied = removeTabFromLeaves(root, 'b');
    const out = collapseEmpty(emptied, 'p2');
    expect(flat(out.root)).toBe('p1(a)');
    expect(out.focusedPaneId).toBe('p1');
  });

  it('keeps an empty root leaf', () => {
    const root = createLeaf('p1', [], null);
    const out = collapseEmpty(root, 'p1');
    expect(out.root).toBe(root);
    expect(out.focusedPaneId).toBe('p1');
  });

  it('moves focus to the next sibling when the first pane collapses', () => {
    let root: PaneNode = insertBeside(createLeaf('p1', ['a'], 'a'), 'p1', 'row', false, createLeaf('p2', ['b'], 'b'), 's1');
    root = insertBeside(root, 'p2', 'row', false, createLeaf('p3', ['c'], 'c'), 's2');
    const out = collapseEmpty(removeTabFromLeaves(root, 'a'), 'p1');
    expect(flat(out.root)).toBe('row[p2(b) p3(c)]');
    expect(out.focusedPaneId).toBe('p2');
  });
});
```

Dopisz też brakujący import typu na górze pliku testowego: `import type { PaneLeaf, PaneSplit } from './paneTree';`

- [ ] **Step 2: Run test to verify it fails**

Run: `cd DesktopApp && npm test -- src/lib/paneTree.test.ts`
Expected: FAIL — `removeTabFromLeaves is not a function` (i pozostałe brakujące eksporty).

- [ ] **Step 3: Write minimal implementation**

Dopisz do `DesktopApp/src/lib/paneTree.ts`:

```ts
function pickActive(tabIds: string[], current: string | null): string | null {
  if (current && tabIds.includes(current)) return current;
  return tabIds[tabIds.length - 1] ?? null;
}

export function removeTabFromLeaves(root: PaneNode, tabId: string): PaneNode {
  return mapLeaves(root, leaf => {
    if (!leaf.tabIds.includes(tabId)) return leaf;
    const tabIds = leaf.tabIds.filter(id => id !== tabId);
    return { ...leaf, tabIds, activeTabId: pickActive(tabIds, leaf.activeTabId) };
  });
}

export function insertBeside(
  root: PaneNode,
  targetPaneId: string,
  dir: 'row' | 'col',
  before: boolean,
  newLeaf: PaneLeaf,
  splitId: string,
): PaneNode {
  if (root.kind === 'split') {
    const idx = root.children.findIndex(c => c.kind === 'leaf' && c.id === targetPaneId);
    if (idx !== -1 && root.dir === dir) {
      const half = root.sizes[idx] / 2;
      const sizes = [...root.sizes];
      sizes[idx] = half;
      sizes.splice(before ? idx : idx + 1, 0, half);
      const children = [...root.children];
      children.splice(before ? idx : idx + 1, 0, newLeaf);
      return { ...root, sizes, children };
    }
    const children = root.children.map(c => insertBeside(c, targetPaneId, dir, before, newLeaf, splitId));
    return children.every((c, i) => c === root.children[i]) ? root : { ...root, children };
  }
  if (root.id !== targetPaneId) return root;
  return {
    kind: 'split',
    id: splitId,
    dir,
    sizes: [0.5, 0.5],
    children: before ? [newLeaf, root] : [root, newLeaf],
  };
}

export function moveTab(root: PaneNode, tabId: string, targetPaneId: string, index: number): PaneNode {
  const stripped = removeTabFromLeaves(root, tabId);
  return mapLeaves(stripped, leaf => {
    if (leaf.id !== targetPaneId) return leaf;
    const tabIds = [...leaf.tabIds];
    tabIds.splice(Math.max(0, Math.min(index, tabIds.length)), 0, tabId);
    return { ...leaf, tabIds, activeTabId: tabId };
  });
}

export function collapseEmpty(root: PaneNode, focusedPaneId: string): { root: PaneNode; focusedPaneId: string } {
  const removed: string[] = [];

  const walk = (node: PaneNode): PaneNode | null => {
    if (node.kind === 'leaf') {
      if (node.tabIds.length > 0) return node;
      removed.push(node.id);
      return null;
    }
    const kept: PaneNode[] = [];
    const sizes: number[] = [];
    node.children.forEach((child, i) => {
      const next = walk(child);
      if (next === null) return;
      kept.push(next);
      sizes.push(node.sizes[i]);
    });
    if (kept.length === 0) return null;
    if (kept.length === 1) return kept[0];
    const total = sizes.reduce((a, b) => a + b, 0);
    const normalized = sizes.map(s => s / total);
    const unchanged = kept.length === node.children.length && kept.every((c, i) => c === node.children[i]);
    return unchanged ? node : { ...node, children: kept, sizes: normalized };
  };

  const next = walk(root);
  if (next === null) {
    const empty = leaves(root)[0] ?? createLeaf(focusedPaneId);
    return { root: empty, focusedPaneId: empty.id };
  }
  if (!removed.includes(focusedPaneId)) return { root: next, focusedPaneId };

  const order = leaves(root).map(l => l.id);
  const survivors = new Set(leaves(next).map(l => l.id));
  const at = order.indexOf(focusedPaneId);
  for (let i = at - 1; i >= 0; i--) if (survivors.has(order[i])) return { root: next, focusedPaneId: order[i] };
  for (let i = at + 1; i < order.length; i++) if (survivors.has(order[i])) return { root: next, focusedPaneId: order[i] };
  return { root: next, focusedPaneId: leaves(next)[0].id };
}
```

Uwaga do `collapseEmpty`: gdy usunięte zostałyby wszystkie liście (zamknięto ostatnią zakładkę), zwracamy pierwszy liść oryginalnego drzewa — pusty korzeń musi przetrwać, bo to on renderuje komunikat „Wybierz sesję z lewej".

Reguła wyboru fokusu po zwinięciu: poprzednie rodzeństwo w kolejności obchodzenia drzewa, a gdy go nie ma — następne.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd DesktopApp && npm test -- src/lib/paneTree.test.ts && npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd DesktopApp && git add src/lib/paneTree.ts src/lib/paneTree.test.ts
git commit -m "feat(desktop): operacje podziału i zwijania drzewa paneli"
```

---

### Task 3: Uzgadnianie layoutu z listą zakładek

**Files:**
- Modify: `DesktopApp/src/lib/paneTree.ts`
- Test: `DesktopApp/src/lib/paneTree.test.ts`

**Interfaces:**
- Consumes: wszystko z Tasków 1-2.
- Produces:
  ```ts
  export type PanesSnapshot = { layout: PaneNode; activeTabId: string | null; focusedPaneId: string };
  export function reconcilePanes(input: PanesSnapshot & { tabIds: string[]; prevActiveTabId: string | null }): PanesSnapshot;
  ```

To jest jedyny punkt, w którym layout dowiaduje się o zmianach `tabs[]`. Kolejność reguł:

1. usuń z liści identyfikatory spoza `tabIds`,
2. dopnij brakujące identyfikatory (w kolejności z `tabIds`) na koniec panelu sfokusowanego,
3. zwiń puste liście i popraw `focusedPaneId`,
4. jeśli `activeTabId` zmieniło się od poprzedniego uzgodnienia i leży w innym liściu — przenieś tam fokus (klik w sidebarze, `TabSwitcher`),
5. ustaw aktywną zakładkę każdego liścia: globalne `activeTabId`, jeśli należy do liścia; inaczej dotychczasowa, jeśli przetrwała; inaczej ostatnia,
6. zsynchronizuj globalne `activeTabId` z aktywną zakładką panelu sfokusowanego.

- [ ] **Step 1: Write the failing test**

Dopisz do `DesktopApp/src/lib/paneTree.test.ts`:

```ts
import { reconcilePanes } from './paneTree';

describe('reconcilePanes', () => {
  const base = (layout: PaneNode, activeTabId: string | null, focusedPaneId: string) =>
    ({ layout, activeTabId, focusedPaneId });

  it('returns identical references when nothing changed', () => {
    const snap = base(createLeaf('p1', ['a'], 'a'), 'a', 'p1');
    const out = reconcilePanes({ ...snap, tabIds: ['a'], prevActiveTabId: 'a' });
    expect(out.layout).toBe(snap.layout);
    expect(out.activeTabId).toBe('a');
    expect(out.focusedPaneId).toBe('p1');
  });

  it('appends a new tab to the focused pane and makes it active there', () => {
    const root = insertBeside(createLeaf('p1', ['a'], 'a'), 'p1', 'row', false, createLeaf('p2', ['b'], 'b'), 's1');
    const out = reconcilePanes({ layout: root, activeTabId: 'c', focusedPaneId: 'p2', tabIds: ['a', 'b', 'c'], prevActiveTabId: 'b' });
    expect(findLeaf(out.layout, 'p2')?.tabIds).toEqual(['b', 'c']);
    expect(findLeaf(out.layout, 'p2')?.activeTabId).toBe('c');
    expect(findLeaf(out.layout, 'p1')?.tabIds).toEqual(['a']);
  });

  it('drops tabs that no longer exist and collapses the emptied pane', () => {
    const root = insertBeside(createLeaf('p1', ['a'], 'a'), 'p1', 'row', false, createLeaf('p2', ['b'], 'b'), 's1');
    const out = reconcilePanes({ layout: root, activeTabId: 'a', focusedPaneId: 'p2', tabIds: ['a'], prevActiveTabId: 'b' });
    expect(out.layout.kind).toBe('leaf');
    expect(out.focusedPaneId).toBe('p1');
    expect(out.activeTabId).toBe('a');
  });

  it('follows the active tab into another pane when it changed', () => {
    const root = insertBeside(createLeaf('p1', ['a'], 'a'), 'p1', 'row', false, createLeaf('p2', ['b'], 'b'), 's1');
    const out = reconcilePanes({ layout: root, activeTabId: 'a', focusedPaneId: 'p2', tabIds: ['a', 'b'], prevActiveTabId: 'b' });
    expect(out.focusedPaneId).toBe('p1');
    expect(out.activeTabId).toBe('a');
  });

  it('keeps the other pane active tab untouched', () => {
    const root = insertBeside(createLeaf('p1', ['a', 'x'], 'x'), 'p1', 'row', false, createLeaf('p2', ['b'], 'b'), 's1');
    const out = reconcilePanes({ layout: root, activeTabId: 'b', focusedPaneId: 'p2', tabIds: ['a', 'x', 'b'], prevActiveTabId: 'b' });
    expect(findLeaf(out.layout, 'p1')?.activeTabId).toBe('x');
  });

  it('pulls the global active tab back to the focused pane after a close', () => {
    const root = insertBeside(createLeaf('p1', ['a'], 'a'), 'p1', 'row', false, createLeaf('p2', ['b', 'c'], 'c'), 's1');
    const out = reconcilePanes({ layout: root, activeTabId: 'a', focusedPaneId: 'p2', tabIds: ['a', 'b', 'c'], prevActiveTabId: 'a' });
    expect(out.focusedPaneId).toBe('p2');
    expect(out.activeTabId).toBe('c');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd DesktopApp && npm test -- src/lib/paneTree.test.ts`
Expected: FAIL — `reconcilePanes is not a function`.

- [ ] **Step 3: Write minimal implementation**

Dopisz do `DesktopApp/src/lib/paneTree.ts`:

```ts
export type PanesSnapshot = { layout: PaneNode; activeTabId: string | null; focusedPaneId: string };

export function reconcilePanes(
  input: PanesSnapshot & { tabIds: string[]; prevActiveTabId: string | null },
): PanesSnapshot {
  const known = new Set(input.tabIds);
  let layout = mapLeaves(input.layout, leaf => {
    const tabIds = leaf.tabIds.filter(id => known.has(id));
    return tabIds.length === leaf.tabIds.length ? leaf : { ...leaf, tabIds };
  });

  const placed = new Set(leaves(layout).flatMap(l => l.tabIds));
  const missing = input.tabIds.filter(id => !placed.has(id));
  if (missing.length > 0) {
    const host = findLeaf(layout, input.focusedPaneId) ? input.focusedPaneId : leaves(layout)[0].id;
    layout = mapLeaves(layout, leaf =>
      leaf.id === host ? { ...leaf, tabIds: [...leaf.tabIds, ...missing] } : leaf,
    );
  }

  const collapsed = collapseEmpty(layout, input.focusedPaneId);
  layout = collapsed.root;
  let focusedPaneId = collapsed.focusedPaneId;

  let activeTabId = input.activeTabId;
  if (activeTabId !== input.prevActiveTabId) {
    const owner = activeTabId ? findLeafOfTab(layout, activeTabId) : null;
    if (owner) focusedPaneId = owner.id;
  }

  layout = mapLeaves(layout, leaf => {
    const next = activeTabId && leaf.tabIds.includes(activeTabId)
      ? activeTabId
      : pickActive(leaf.tabIds, leaf.activeTabId);
    return next === leaf.activeTabId ? leaf : { ...leaf, activeTabId: next };
  });

  const focused = findLeaf(layout, focusedPaneId);
  if (focused && focused.activeTabId !== activeTabId) activeTabId = focused.activeTabId;

  return { layout, activeTabId, focusedPaneId };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd DesktopApp && npm test -- src/lib/paneTree.test.ts && npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd DesktopApp && git add src/lib/paneTree.ts src/lib/paneTree.test.ts
git commit -m "feat(desktop): uzgadnianie drzewa paneli z listą zakładek"
```

---

### Task 4: Geometria paneli

**Files:**
- Create: `DesktopApp/src/lib/paneGeometry.ts`
- Test: `DesktopApp/src/lib/paneGeometry.test.ts`

**Interfaces:**
- Consumes: `PaneNode`, `leaves` (Task 1).
- Produces:
  ```ts
  export const TAB_BAR_HEIGHT = 32;
  export const MIN_PANE_WIDTH = 240;
  export const MIN_PANE_HEIGHT = 120;
  export type PaneRect = { left: number; top: number; width: number; height: number };  // procenty 0-100
  export type DropZone = 'left' | 'right' | 'top' | 'bottom' | 'center';
  export function computePaneRects(root: PaneNode): Map<string, PaneRect>;
  export function hitTestPane(rects: Map<string, PaneRect>, container: { width: number; height: number }, point: { x: number; y: number }): { paneId: string; local: { x: number; y: number; width: number; height: number } } | null;
  export function dropZone(local: { x: number; y: number; width: number; height: number }): DropZone;
  export function canSplit(zone: DropZone, size: { width: number; height: number }): boolean;
  export function insertionIndex(tabRects: Array<{ id: string; left: number; width: number }>, x: number): number;
  export function clampSizes(sizes: number[], index: number, next: number, totalPx: number, minPx: number): number[];
  ```

`point` i `container` są w pikselach względem lewego górnego rogu kontenera paneli.

- [ ] **Step 1: Write the failing test**

Utwórz `DesktopApp/src/lib/paneGeometry.test.ts`:

```ts
// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { createLeaf, type PaneNode } from './paneTree';
import {
  canSplit,
  clampSizes,
  computePaneRects,
  dropZone,
  hitTestPane,
  insertionIndex,
  MIN_PANE_WIDTH,
} from './paneGeometry';

const tree: PaneNode = {
  kind: 'split',
  id: 's1',
  dir: 'row',
  sizes: [0.5, 0.5],
  children: [
    createLeaf('p1', ['a'], 'a'),
    { kind: 'split', id: 's2', dir: 'col', sizes: [0.25, 0.75], children: [createLeaf('p2', ['b'], 'b'), createLeaf('p3', ['c'], 'c')] },
  ],
};

describe('computePaneRects', () => {
  it('gives a lone leaf the whole area', () => {
    const rects = computePaneRects(createLeaf('p1', ['a'], 'a'));
    expect(rects.get('p1')).toEqual({ left: 0, top: 0, width: 100, height: 100 });
  });

  it('splits a row horizontally and a nested column vertically', () => {
    const rects = computePaneRects(tree);
    expect(rects.get('p1')).toEqual({ left: 0, top: 0, width: 50, height: 100 });
    expect(rects.get('p2')).toEqual({ left: 50, top: 0, width: 50, height: 25 });
    expect(rects.get('p3')).toEqual({ left: 50, top: 25, width: 50, height: 75 });
  });
});

describe('hitTestPane and dropZone', () => {
  const rects = computePaneRects(tree);
  const container = { width: 1000, height: 800 };

  it('maps a point to the owning pane with local coordinates', () => {
    const hit = hitTestPane(rects, container, { x: 600, y: 100 });
    expect(hit?.paneId).toBe('p2');
    expect(hit?.local).toEqual({ x: 100, y: 100, width: 500, height: 200 });
  });

  it('returns null outside the container', () => {
    expect(hitTestPane(rects, container, { x: -5, y: 10 })).toBeNull();
  });

  it('classifies the four edge bands and the centre', () => {
    const size = { width: 400, height: 400 };
    expect(dropZone({ ...size, x: 20, y: 200 })).toBe('left');
    expect(dropZone({ ...size, x: 380, y: 200 })).toBe('right');
    expect(dropZone({ ...size, x: 200, y: 20 })).toBe('top');
    expect(dropZone({ ...size, x: 200, y: 380 })).toBe('bottom');
    expect(dropZone({ ...size, x: 200, y: 200 })).toBe('center');
  });

  it('prefers the nearer edge in a corner', () => {
    expect(dropZone({ width: 400, height: 800, x: 10, y: 20 })).toBe('top');
    expect(dropZone({ width: 800, height: 400, x: 20, y: 10 })).toBe('left');
  });

  it('refuses a split that would go below the minimum', () => {
    expect(canSplit('left', { width: MIN_PANE_WIDTH * 2 - 1, height: 600 })).toBe(false);
    expect(canSplit('left', { width: MIN_PANE_WIDTH * 2, height: 600 })).toBe(true);
    expect(canSplit('center', { width: 10, height: 10 })).toBe(true);
  });
});

describe('insertionIndex', () => {
  const tabs = [
    { id: 'a', left: 0, width: 100 },
    { id: 'b', left: 100, width: 100 },
    { id: 'c', left: 200, width: 100 },
  ];

  it('returns the slot before the tab whose midpoint the pointer has not passed', () => {
    expect(insertionIndex(tabs, 10)).toBe(0);
    expect(insertionIndex(tabs, 60)).toBe(1);
    expect(insertionIndex(tabs, 260)).toBe(3);
  });

  it('returns 0 for an empty bar', () => {
    expect(insertionIndex([], 42)).toBe(0);
  });
});

describe('clampSizes', () => {
  it('keeps both sides above the minimum', () => {
    const out = clampSizes([0.5, 0.5], 0, 0.01, 1000, 240);
    expect(out[0]).toBeCloseTo(0.24);
    expect(out[1]).toBeCloseTo(0.76);
  });

  it('only moves the boundary between the pair', () => {
    const out = clampSizes([0.4, 0.3, 0.3], 1, 0.5, 1000, 100);
    expect(out[0]).toBeCloseTo(0.4);
    expect(out[1]).toBeCloseTo(0.5);
    expect(out[2]).toBeCloseTo(0.1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd DesktopApp && npm test -- src/lib/paneGeometry.test.ts`
Expected: FAIL — `Failed to resolve import "./paneGeometry"`.

- [ ] **Step 3: Write minimal implementation**

Utwórz `DesktopApp/src/lib/paneGeometry.ts`:

```ts
import type { PaneNode } from './paneTree';

export const TAB_BAR_HEIGHT = 32;
export const MIN_PANE_WIDTH = 240;
export const MIN_PANE_HEIGHT = 120;
const EDGE_BAND = 0.25;

export type PaneRect = { left: number; top: number; width: number; height: number };
export type DropZone = 'left' | 'right' | 'top' | 'bottom' | 'center';

export function computePaneRects(root: PaneNode): Map<string, PaneRect> {
  const out = new Map<string, PaneRect>();
  const walk = (node: PaneNode, rect: PaneRect) => {
    if (node.kind === 'leaf') {
      out.set(node.id, rect);
      return;
    }
    let offset = 0;
    node.children.forEach((child, i) => {
      const share = node.sizes[i];
      const next: PaneRect = node.dir === 'row'
        ? { left: rect.left + rect.width * offset, top: rect.top, width: rect.width * share, height: rect.height }
        : { left: rect.left, top: rect.top + rect.height * offset, width: rect.width, height: rect.height * share };
      walk(child, next);
      offset += share;
    });
  };
  walk(root, { left: 0, top: 0, width: 100, height: 100 });
  return out;
}

export function hitTestPane(
  rects: Map<string, PaneRect>,
  container: { width: number; height: number },
  point: { x: number; y: number },
): { paneId: string; local: { x: number; y: number; width: number; height: number } } | null {
  if (point.x < 0 || point.y < 0 || point.x > container.width || point.y > container.height) return null;
  for (const [paneId, rect] of rects) {
    const left = (rect.left / 100) * container.width;
    const top = (rect.top / 100) * container.height;
    const width = (rect.width / 100) * container.width;
    const height = (rect.height / 100) * container.height;
    if (point.x >= left && point.x <= left + width && point.y >= top && point.y <= top + height) {
      return { paneId, local: { x: point.x - left, y: point.y - top, width, height } };
    }
  }
  return null;
}

export function dropZone(local: { x: number; y: number; width: number; height: number }): DropZone {
  const ratios: Array<[DropZone, number]> = [
    ['left', local.x / local.width],
    ['right', 1 - local.x / local.width],
    ['top', local.y / local.height],
    ['bottom', 1 - local.y / local.height],
  ];
  const nearest = ratios.reduce((best, cur) => (cur[1] < best[1] ? cur : best));
  return nearest[1] < EDGE_BAND ? nearest[0] : 'center';
}

export function canSplit(zone: DropZone, size: { width: number; height: number }): boolean {
  if (zone === 'center') return true;
  if (zone === 'left' || zone === 'right') return size.width >= MIN_PANE_WIDTH * 2;
  return size.height >= (MIN_PANE_HEIGHT + TAB_BAR_HEIGHT) * 2;
}

export function insertionIndex(tabRects: Array<{ id: string; left: number; width: number }>, x: number): number {
  const at = tabRects.findIndex(r => x < r.left + r.width / 2);
  return at === -1 ? tabRects.length : at;
}

export function clampSizes(sizes: number[], index: number, next: number, totalPx: number, minPx: number): number[] {
  const pair = sizes[index] + sizes[index + 1];
  const min = minPx / totalPx;
  const clamped = Math.max(min, Math.min(pair - min, next));
  const out = [...sizes];
  out[index] = clamped;
  out[index + 1] = pair - clamped;
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd DesktopApp && npm test -- src/lib/paneGeometry.test.ts && npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd DesktopApp && git add src/lib/paneGeometry.ts src/lib/paneGeometry.test.ts
git commit -m "feat(desktop): geometria paneli i strefy zrzutu"
```

---

### Task 5: Slice paneli i podpięcie do store'a

**Files:**
- Create: `DesktopApp/src/store/panesSlice.ts`
- Create: `DesktopApp/src/store/panesSlice.test.ts`
- Modify: `DesktopApp/src/store/index.ts` (kompozycja slice'a + subskrypcja uzgadniająca)
- Modify: `DesktopApp/src/store/tabsSlice.ts` (`openSessionTab` — slot podglądu w panelu sfokusowanym)

**Interfaces:**
- Consumes: `reconcilePanes`, `insertBeside`, `moveTab`, `collapseEmpty`, `createLeaf`, `findLeaf`, `findLeafOfTab`, `removeTabFromLeaves`, `PaneNode` (Tasks 1-3).
- Produces:
  ```ts
  export type PanesSlice = {
    layout: PaneNode;
    focusedPaneId: string;
    focusPane: (paneId: string) => void;
    setPaneActiveTab: (paneId: string, tabId: string) => void;
    splitPaneWithTab: (targetPaneId: string, dir: 'row' | 'col', before: boolean, tabId: string) => void;
    moveTabToPane: (tabId: string, targetPaneId: string, index: number) => void;
    resizeSplit: (splitId: string, sizes: number[]) => void;
  };
  export const ROOT_PANE_ID = 'root';
  export function selectPaneOfTab(state: { layout: PaneNode }, tabId: string): string | null;
  ```

- [ ] **Step 1: Write the failing test**

Utwórz `DesktopApp/src/store/panesSlice.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from './index';
import { ROOT_PANE_ID } from './panesSlice';
import { createLeaf, findLeaf, leaves } from '../lib/paneTree';
import type { Tab } from './tabsSlice';

const sessionTab = (id: string): Tab => ({
  kind: 'session', id, projectId: 1, sessionId: id, title: id, mode: 'history',
});

describe('panesSlice', () => {
  beforeEach(() => {
    useStore.setState({
      tabs: [], activeTabId: null, mruOrder: [], navHistory: [], navIndex: 0,
      layout: createLeaf(ROOT_PANE_ID), focusedPaneId: ROOT_PANE_ID,
    });
  });

  it('places a newly opened tab in the focused pane', () => {
    useStore.getState().openSessionTab(1, 's1', 'Sesja');
    expect(findLeaf(useStore.getState().layout, ROOT_PANE_ID)?.tabIds).toEqual(['session:s1']);
    expect(useStore.getState().activeTabId).toBe('session:s1');
  });

  it('splits a pane and moves the tab into the new one', () => {
    useStore.setState({ tabs: [sessionTab('t1'), sessionTab('t2')], activeTabId: 't1' });
    useStore.getState().splitPaneWithTab(ROOT_PANE_ID, 'row', false, 't2');
    const paneIds = leaves(useStore.getState().layout).map(l => l.id);
    expect(paneIds).toHaveLength(2);
    expect(findLeaf(useStore.getState().layout, paneIds[0])?.tabIds).toEqual(['t1']);
    expect(findLeaf(useStore.getState().layout, paneIds[1])?.tabIds).toEqual(['t2']);
    expect(useStore.getState().focusedPaneId).toBe(paneIds[1]);
    expect(useStore.getState().activeTabId).toBe('t2');
  });

  it('refuses to split a pane holding a single tab', () => {
    useStore.setState({ tabs: [sessionTab('t1')], activeTabId: 't1' });
    useStore.getState().splitPaneWithTab(ROOT_PANE_ID, 'row', false, 't1');
    expect(leaves(useStore.getState().layout)).toHaveLength(1);
  });

  it('collapses a pane when its last tab is closed', () => {
    useStore.setState({ tabs: [sessionTab('t1'), sessionTab('t2')], activeTabId: 't1' });
    useStore.getState().splitPaneWithTab(ROOT_PANE_ID, 'row', false, 't2');
    useStore.getState().closeTab('t2');
    expect(leaves(useStore.getState().layout)).toHaveLength(1);
    expect(useStore.getState().activeTabId).toBe('t1');
  });

  it('moves focus to the pane owning a tab activated from elsewhere', () => {
    useStore.setState({ tabs: [sessionTab('t1'), sessionTab('t2')], activeTabId: 't1' });
    useStore.getState().splitPaneWithTab(ROOT_PANE_ID, 'row', false, 't2');
    const [first] = leaves(useStore.getState().layout).map(l => l.id);
    useStore.getState().setActive('t1');
    expect(useStore.getState().focusedPaneId).toBe(first);
  });

  it('keeps one preview slot per pane', () => {
    useStore.getState().openSessionTab(1, 's1', 'Pierwsza');
    useStore.getState().openSessionTab(1, 's2', 'Druga');
    expect(useStore.getState().tabs.map(t => t.id)).toEqual(['session:s2']);

    useStore.setState({ tabs: [sessionTab('keep'), ...useStore.getState().tabs] });
    useStore.getState().splitPaneWithTab(useStore.getState().focusedPaneId, 'row', false, 'keep');
    useStore.getState().openSessionTab(1, 's3', 'Trzecia');
    expect(useStore.getState().tabs.map(t => t.id).sort()).toEqual(['keep', 'session:s2', 'session:s3'].sort());
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd DesktopApp && npm test -- src/store/panesSlice.test.ts`
Expected: FAIL — `Failed to resolve import "./panesSlice"`.

- [ ] **Step 3: Write minimal implementation**

Utwórz `DesktopApp/src/store/panesSlice.ts`:

```ts
import type { StateCreator } from 'zustand';
import {
  collapseEmpty,
  createLeaf,
  findLeaf,
  findLeafOfTab,
  insertBeside,
  moveTab,
  removeTabFromLeaves,
  type PaneNode,
} from '../lib/paneTree';
import type { TabsSlice } from './tabsSlice';

export const ROOT_PANE_ID = 'root';

export type PanesSlice = {
  layout: PaneNode;
  focusedPaneId: string;
  focusPane: (paneId: string) => void;
  setPaneActiveTab: (paneId: string, tabId: string) => void;
  splitPaneWithTab: (targetPaneId: string, dir: 'row' | 'col', before: boolean, tabId: string) => void;
  moveTabToPane: (tabId: string, targetPaneId: string, index: number) => void;
  resizeSplit: (splitId: string, sizes: number[]) => void;
};

export function selectPaneOfTab(state: { layout: PaneNode }, tabId: string): string | null {
  return findLeafOfTab(state.layout, tabId)?.id ?? null;
}

function replaceSizes(node: PaneNode, splitId: string, sizes: number[]): PaneNode {
  if (node.kind === 'leaf') return node;
  if (node.id === splitId) return { ...node, sizes };
  const children = node.children.map(c => replaceSizes(c, splitId, sizes));
  return children.every((c, i) => c === node.children[i]) ? node : { ...node, children };
}

export const createPanesSlice: StateCreator<PanesSlice & TabsSlice, [], [], PanesSlice> = (set, get) => ({
  layout: createLeaf(ROOT_PANE_ID),
  focusedPaneId: ROOT_PANE_ID,
  focusPane: (paneId) => {
    const leaf = findLeaf(get().layout, paneId);
    if (!leaf) return;
    set({ focusedPaneId: paneId, ...(leaf.activeTabId ? { activeTabId: leaf.activeTabId } : {}) });
  },
  setPaneActiveTab: (paneId, tabId) => {
    set({ focusedPaneId: paneId });
    get().setActive(tabId);
  },
  splitPaneWithTab: (targetPaneId, dir, before, tabId) => {
    const source = findLeafOfTab(get().layout, tabId);
    if (!source) return;
    if (source.id === targetPaneId && source.tabIds.length < 2) return;
    const newPaneId = crypto.randomUUID();
    const stripped = removeTabFromLeaves(get().layout, tabId);
    const inserted = insertBeside(stripped, targetPaneId, dir, before, createLeaf(newPaneId, [tabId], tabId), crypto.randomUUID());
    const collapsed = collapseEmpty(inserted, newPaneId);
    set({ layout: collapsed.root, focusedPaneId: collapsed.focusedPaneId, activeTabId: tabId });
  },
  moveTabToPane: (tabId, targetPaneId, index) => {
    const source = findLeafOfTab(get().layout, tabId);
    if (!source) return;
    const moved = moveTab(get().layout, tabId, targetPaneId, index);
    const collapsed = collapseEmpty(moved, targetPaneId);
    set({ layout: collapsed.root, focusedPaneId: collapsed.focusedPaneId, activeTabId: tabId });
  },
  resizeSplit: (splitId, sizes) => {
    set({ layout: replaceSizes(get().layout, splitId, sizes) });
  },
});
```

W `DesktopApp/src/store/index.ts`:

1. dopisz importy:

```ts
import { createPanesSlice, ROOT_PANE_ID, type PanesSlice } from './panesSlice';
import { reconcilePanes } from '../lib/paneTree';
```

2. rozszerz typ i kompozycję:

```ts
export type AppState = SettingsSlice & ProjectsSlice & SessionsSlice & TabsSlice & ActionsSlice & GitSlice & ClickUpSlice & PanesSlice;

export const useStore = create<AppState>()((...a) => ({
  ...createSettingsSlice(...a),
  ...createProjectsSlice(...a),
  ...createSessionsSlice(...a),
  ...createTabsSlice(...a),
  ...createActionsSlice(...a),
  ...createGitSlice(...a),
  ...createClickUpSlice(...a),
  ...createPanesSlice(...a),
}));
```

3. dodaj subskrypcję uzgadniającą **przed** istniejącą subskrypcją persystencji (kolejność ma znaczenie: persystencja musi widzieć już uzgodniony layout):

```ts
let prevActiveTabId = useStore.getState().activeTabId;

useStore.subscribe((state) => {
  const next = reconcilePanes({
    layout: state.layout,
    activeTabId: state.activeTabId,
    focusedPaneId: state.focusedPaneId,
    tabIds: state.tabs.map(t => t.id),
    prevActiveTabId,
  });
  prevActiveTabId = next.activeTabId;
  if (
    next.layout === state.layout
    && next.activeTabId === state.activeTabId
    && next.focusedPaneId === state.focusedPaneId
  ) return;
  useStore.setState(next);
});
```

4. w `DesktopApp/src/store/tabsSlice.ts` zawęź szukanie zakładki podglądu do panelu sfokusowanego — zamień w `openSessionTab`:

```ts
    const preview = get().tabs.find(t => t.kind === 'session' && t.preview);
```

na:

```ts
    const focused = findLeaf((get() as AppState).layout, (get() as AppState).focusedPaneId);
    const preview = get().tabs.find(t => t.kind === 'session' && t.preview && (focused?.tabIds.includes(t.id) ?? true));
```

i dopisz import `import { findLeaf } from '../lib/paneTree';` na górze `tabsSlice.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd DesktopApp && npm test && npm run lint`
Expected: PASS — cały zestaw, nie tylko nowy plik (subskrypcja dotyka wszystkich testów store'a).

- [ ] **Step 5: Commit**

```bash
cd DesktopApp && git add src/store/panesSlice.ts src/store/panesSlice.test.ts src/store/index.ts src/store/tabsSlice.ts
git commit -m "feat(desktop): slice paneli i uzgadnianie layoutu w store"
```

---

### Task 6: Reguła grupowania — grupa dopiero od dwóch zakładek

**Files:**
- Modify: `DesktopApp/src/lib/tabGrouping.ts`
- Modify: `DesktopApp/src/lib/tabGrouping.test.ts`
- Modify: `DesktopApp/src/components/center/TabBar.tsx` (podmiana wywołania)

**Interfaces:**
- Consumes: `Tab`, `Project`, `getProjectColor`.
- Produces:
  ```ts
  export type TabBarItem =
    | { kind: 'single'; tab: Tab; color: string }
    | { kind: 'group'; projectId: number; name: string; color: string; tabs: Tab[] };
  export function layoutTabBar(tabs: Tab[], projects: Project[]): TabBarItem[];
  ```
  `groupTabsByProject` zostaje wyeksportowane (używa go `layoutTabBar` i istniejące testy grupowania).

Kolejność wyniku: najpierw zakładki-single w kolejności z `tabs`, potem grupy w kolejności pierwszego wystąpienia projektu.

- [ ] **Step 1: Write the failing test**

Dopisz do `DesktopApp/src/lib/tabGrouping.test.ts`:

```ts
import { layoutTabBar } from './tabGrouping';

describe('layoutTabBar', () => {
  it('hoists single-tab projects to the front, outside groups', () => {
    const tabs = [tab('a', 1), tab('b', 2), tab('c', 1)];
    const items = layoutTabBar(tabs, projects);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ kind: 'single' });
    expect(items[0].kind === 'single' && items[0].tab.id).toBe('b');
    expect(items[1]).toMatchObject({ kind: 'group', projectId: 1 });
    expect(items[1].kind === 'group' && items[1].tabs.map(t => t.id)).toEqual(['a', 'c']);
  });

  it('emits two singles when two projects have one tab each', () => {
    const items = layoutTabBar([tab('a', 1), tab('b', 2)], projects);
    expect(items.map(i => i.kind)).toEqual(['single', 'single']);
    expect(items[0].kind === 'single' && items[0].color).toBe(getProjectColor(projects[0]));
    expect(items[1].kind === 'single' && items[1].color).toBe(getProjectColor(projects[1]));
  });

  it('emits a single group when everything belongs to one project', () => {
    const items = layoutTabBar([tab('a', 1), tab('c', 1)], projects);
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe('group');
  });

  it('returns an empty array for no tabs', () => {
    expect(layoutTabBar([], projects)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd DesktopApp && npm test -- src/lib/tabGrouping.test.ts`
Expected: FAIL — `layoutTabBar is not a function`.

- [ ] **Step 3: Write minimal implementation**

Dopisz do `DesktopApp/src/lib/tabGrouping.ts`:

```ts
export type TabBarItem =
  | { kind: 'single'; tab: Tab; color: string }
  | { kind: 'group'; projectId: number; name: string; color: string; tabs: Tab[] };

export function layoutTabBar(tabs: Tab[], projects: Project[]): TabBarItem[] {
  const groups = groupTabsByProject(tabs, projects);
  const singles = new Map(groups.filter(g => g.tabs.length === 1).map(g => [g.projectId, g]));
  const hoisted: TabBarItem[] = tabs
    .filter(t => singles.has(t.projectId))
    .map(t => ({ kind: 'single', tab: t, color: singles.get(t.projectId)!.color }));
  const rest: TabBarItem[] = groups
    .filter(g => g.tabs.length > 1)
    .map(g => ({ kind: 'group', projectId: g.projectId, name: g.name, color: g.color, tabs: g.tabs }));
  return [...hoisted, ...rest];
}
```

W `TabBar.tsx` podmień import `groupTabsByProject` na `layoutTabBar`, usuń `groups`/`showGroups` i wstaw:

```ts
  const items = useMemo(() => layoutTabBar(tabs, projects), [tabs, projects]);
  const showHeaders = items.length > 1;
```

Cały blok renderujący zawartość paska (dotychczasowe `{showGroups ? … : tabs.map(renderTab)}`) zastąp:

```tsx
          {items.map((item, i) => (
            <div key={item.kind === 'single' ? item.tab.id : `group:${item.projectId}`} className="contents">
              {i > 0 && <div className="w-2 shrink-0" />}
              {item.kind === 'single' ? (
                renderTab(item.tab)
              ) : (
                <div
                  className="flex items-end shrink-0"
                  style={showHeaders ? { borderBottom: `2px solid ${item.color}` } : undefined}
                >
                  {showHeaders && (
                    <div
                      onClick={() => toggleCollapse(item.projectId)}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setCtxMenu(null);
                        setGroupMenu({ projectId: item.projectId, x: e.clientX, y: e.clientY });
                      }}
                      className="flex items-center px-2 py-1 cursor-pointer text-[10px] shrink-0 select-none"
                    >
                      <span className="mr-1 text-[8px]">{collapsed.has(item.projectId) ? '▶' : '▼'}</span>
                      <span className="font-semibold" style={{ color: item.color }}>{item.name}</span>
                      {collapsed.has(item.projectId) && (
                        <span
                          className="ml-1 px-1.5 rounded-full text-[9px]"
                          style={{ backgroundColor: `${item.color}33`, color: item.color }}
                        >
                          {item.tabs.length}
                        </span>
                      )}
                    </div>
                  )}
                  {(!showHeaders || !collapsed.has(item.projectId)) && item.tabs.map(renderTab)}
                </div>
              )}
            </div>
          ))}
```

Kolorowanie krawędzi zakładek dochodzi w Tasku 7.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd DesktopApp && npm test && npm run lint`
Expected: PASS. Jeśli `TabBar.test.tsx` sprawdza obecność nagłówka grupy przy jednym projekcie — zaktualizuj asercję zgodnie z nową regułą.

- [ ] **Step 5: Commit**

```bash
cd DesktopApp && git add src/lib/tabGrouping.ts src/lib/tabGrouping.test.ts src/components/center/TabBar.tsx
git commit -m "feat(desktop): grupa w pasku zakładek dopiero od dwóch zakładek projektu"
```

---

### Task 7: Pasek zakładek per panel i kolor projektu na krawędzi

**Files:**
- Modify: `DesktopApp/src/components/center/TabBar.tsx`
- Modify: `DesktopApp/src/components/center/TabBar.test.tsx`

**Interfaces:**
- Consumes: `layoutTabBar` (Task 6), `PanesSlice`, `findLeaf`, `ROOT_PANE_ID` (Task 5), `getProjectColor`.
- Produces: `TabBar` przyjmuje `paneId?: string` (domyślnie `focusedPaneId`) i renderuje wyłącznie zakładki tego liścia; klik w zakładkę woła `setPaneActiveTab(paneId, tabId)`.

- [ ] **Step 1: Write the failing test**

Dopisz do `DesktopApp/src/components/center/TabBar.test.tsx`:

```ts
import { createLeaf, insertBeside } from '../../lib/paneTree';
import { ROOT_PANE_ID } from '../../store/panesSlice';
import { getProjectColor } from '../../lib/projectColors';

describe('TabBar per pane', () => {
  it('renders only the tabs of its own pane', () => {
    useStore.setState({
      tabs: [
        { kind: 'terminal', id: 't1', projectId: 1, title: 'Lewy' },
        { kind: 'terminal', id: 't2', projectId: 1, title: 'Prawy' },
      ],
      activeTabId: 't1',
      projects: [{ id: 1, name: 'P', path: '/p' }] as never,
      layout: insertBeside(createLeaf(ROOT_PANE_ID, ['t1'], 't1'), ROOT_PANE_ID, 'row', false, createLeaf('p2', ['t2'], 't2'), 's1'),
      focusedPaneId: ROOT_PANE_ID,
    });
    render(<TabBar paneId="p2" />);
    expect(screen.queryByText('Lewy')).toBeNull();
    expect(screen.getByText('Prawy')).toBeTruthy();
  });

  it('paints every tab with its project colour on the left edge', () => {
    useStore.setState({
      tabs: [{ kind: 'terminal', id: 't1', projectId: 1, title: 'Lewy' }],
      activeTabId: 't1',
      projects: [{ id: 1, name: 'P', path: '/p', color: '#ff0000' }] as never,
      layout: createLeaf(ROOT_PANE_ID, ['t1'], 't1'),
      focusedPaneId: ROOT_PANE_ID,
    });
    const { container } = render(<TabBar />);
    const el = container.querySelector('[data-tab-id="t1"]') as HTMLElement;
    expect(el.style.borderLeftColor).toBe('rgb(255, 0, 0)');
    expect(getProjectColor({ id: 1, color: '#ff0000' } as never)).toBe('#ff0000');
  });

  it('activates a tab through its own pane', () => {
    useStore.setState({
      tabs: [
        { kind: 'terminal', id: 't1', projectId: 1, title: 'Lewy' },
        { kind: 'terminal', id: 't2', projectId: 1, title: 'Prawy' },
      ],
      activeTabId: 't1',
      projects: [{ id: 1, name: 'P', path: '/p' }] as never,
      layout: insertBeside(createLeaf(ROOT_PANE_ID, ['t1'], 't1'), ROOT_PANE_ID, 'row', false, createLeaf('p2', ['t2'], 't2'), 's1'),
      focusedPaneId: ROOT_PANE_ID,
    });
    render(<TabBar paneId="p2" />);
    fireEvent.click(screen.getByText('Prawy'));
    expect(useStore.getState().focusedPaneId).toBe('p2');
    expect(useStore.getState().activeTabId).toBe('t2');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd DesktopApp && npm test -- src/components/center/TabBar.test.tsx`
Expected: FAIL — `TabBar` renderuje wszystkie zakładki, `borderLeftColor` jest pusty.

- [ ] **Step 3: Write minimal implementation**

W `TabBar.tsx`:

```ts
export function TabBar({ detachedProjectId, paneId }: { detachedProjectId?: number; paneId?: string } = {}) {
  const allTabs = useStore(s => s.tabs);
  const focusedPaneId = useStore(s => s.focusedPaneId);
  const resolvedPaneId = paneId ?? focusedPaneId;
  const leaf = useStore(useShallow(s => findLeaf(s.layout, resolvedPaneId)?.tabIds ?? []));
  const tabs = useMemo(
    () => leaf.map(id => allTabs.find(t => t.id === id)).filter((t): t is Tab => !!t),
    [leaf, allTabs],
  );
  const setPaneActiveTab = useStore(s => s.setPaneActiveTab);
```

Zostaw `const active = useStore(s => s.activeTabId);` — używają go efekt przewijania do aktywnej zakładki, efekt rozwijania grupy i skrót `Ctrl+W`. Do stylowania dołóż aktywną zakładkę **tego** panelu:

```ts
  const leafActiveTabId = useStore(s => findLeaf(s.layout, resolvedPaneId)?.activeTabId ?? null);
  const projectColor = (projectId: number) =>
    getProjectColor(projects.find(p => p.id === projectId) ?? { id: projectId, color: null });
```

W `renderTab` podmień `onClick` i klasy oraz dołóż kolor krawędzi:

```tsx
      onClick={() => setPaneActiveTab(resolvedPaneId, t.id)}
      style={{ borderLeftWidth: 2, borderLeftStyle: 'solid', borderLeftColor: projectColor(t.projectId) }}
      className={`group relative flex items-center px-3 py-1 text-[11px] border-x border-t cursor-pointer shrink-0 ${
        t.id === leafActiveTabId
          ? (resolvedPaneId === focusedPaneId
              ? 'bg-bg-elev border-border text-fg'
              : 'bg-bg-elev border-border text-muted')
          : 'bg-bg border-transparent text-muted hover:text-fg'
      }`}
```

Import: `import { getProjectColor } from '../../lib/projectColors';`, `import { findLeaf } from '../../lib/paneTree';`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd DesktopApp && npm test && npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd DesktopApp && git add src/components/center/TabBar.tsx src/components/center/TabBar.test.tsx
git commit -m "feat(desktop): pasek zakładek per panel z kolorem projektu"
```

---

### Task 8: PaneLayout — renderowanie paneli i warstw treści

**Files:**
- Create: `DesktopApp/src/components/center/PaneLayout.tsx`
- Create: `DesktopApp/src/components/center/PaneLayout.test.tsx`
- Modify: `DesktopApp/src/components/center/CenterPanel.tsx`
- Modify: `DesktopApp/src/components/center/TabContent.tsx`

**Interfaces:**
- Consumes: `computePaneRects`, `TAB_BAR_HEIGHT` (Task 4), `leaves`, `findLeaf` (Task 1), `TabBar` z `paneId` (Task 7), `TabPanel` z `TabContent.tsx`.
- Produces: `PaneLayout({ detachedProjectId }: { detachedProjectId?: number })`; `TabContent.tsx` eksportuje `TabPanel` (dotąd lokalny).

Kluczowy niezmiennik: warstwy treści są rodzeństwem w jednym kontenerze `relative` i przy przenoszeniu zakładki między panelami zmienia się wyłącznie ich `style`.

- [ ] **Step 1: Write the failing test**

Utwórz `DesktopApp/src/components/center/PaneLayout.test.tsx`:

```tsx
import { useEffect } from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, render } from '@testing-library/react';

const counters = vi.hoisted(() => ({ terminalMounts: 0 }));

vi.mock('../terminal/TerminalView', () => ({
  TerminalView: ({ visible }: { visible?: boolean }) => {
    useEffect(() => { counters.terminalMounts += 1; }, []);
    return <div data-testid="terminal" data-visible={String(visible)} />;
  },
}));
vi.mock('../history/HistoryView', () => ({ HistoryView: () => <div data-testid="history" /> }));
vi.mock('../history/SubagentView', () => ({ SubagentView: () => <div data-testid="subagent" /> }));

vi.stubGlobal('ResizeObserver', class {
  observe() {}
  unobserve() {}
  disconnect() {}
});
Element.prototype.scrollIntoView = vi.fn();

import { useStore } from '../../store';
import { PaneLayout } from './PaneLayout';
import { createLeaf, insertBeside, leaves } from '../../lib/paneTree';
import { ROOT_PANE_ID } from '../../store/panesSlice';
import type { Tab } from '../../store/tabsSlice';

const terminalTab = (id: string, title: string): Tab => ({ kind: 'terminal', id, projectId: 1, title });

describe('PaneLayout', () => {
  beforeEach(() => {
    counters.terminalMounts = 0;
    useStore.setState({
      tabs: [terminalTab('t1', 'Lewy'), terminalTab('t2', 'Prawy')],
      activeTabId: 't1',
      mruOrder: [],
      projects: [{ id: 1, name: 'P', path: '/p' }] as never,
      layout: createLeaf(ROOT_PANE_ID, ['t1', 't2'], 't1'),
      focusedPaneId: ROOT_PANE_ID,
    });
  });

  it('positions a single pane over the whole area', () => {
    const { container } = render(<PaneLayout />);
    const region = container.querySelector(`[data-pane-id="${ROOT_PANE_ID}"]`) as HTMLElement;
    expect(region.style.left).toBe('0%');
    expect(region.style.width).toBe('100%');
  });

  it('positions two panes side by side after a split', () => {
    act(() => { useStore.getState().splitPaneWithTab(ROOT_PANE_ID, 'row', false, 't2'); });
    const { container } = render(<PaneLayout />);
    const ids = leaves(useStore.getState().layout).map(l => l.id);
    const right = container.querySelector(`[data-pane-id="${ids[1]}"]`) as HTMLElement;
    expect(right.style.left).toBe('50%');
    expect(right.style.width).toBe('50%');
  });

  it('shows the active tab of every pane at once', () => {
    const { container } = render(<PaneLayout />);
    act(() => { useStore.getState().splitPaneWithTab(ROOT_PANE_ID, 'row', false, 't2'); });
    const visible = container.querySelectorAll('[data-testid="terminal"][data-visible="true"]');
    expect(visible).toHaveLength(2);
  });

  it('never remounts a terminal when its tab moves to another pane', () => {
    const { container } = render(<PaneLayout />);
    expect(counters.terminalMounts).toBe(2);
    const before = container.querySelector('[data-tab-layer="t2"]');

    act(() => { useStore.getState().splitPaneWithTab(ROOT_PANE_ID, 'row', false, 't2'); });

    expect(counters.terminalMounts).toBe(2);
    expect(container.querySelector('[data-tab-layer="t2"]')).toBe(before);
  });

  it('renders the empty-state hint when no tab is open', () => {
    act(() => {
      useStore.setState({ tabs: [], activeTabId: null, layout: createLeaf(ROOT_PANE_ID), focusedPaneId: ROOT_PANE_ID });
    });
    const { getByText } = render(<PaneLayout />);
    expect(getByText('Wybierz sesję z lewej')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd DesktopApp && npm test -- src/components/center/PaneLayout.test.tsx`
Expected: FAIL — `Failed to resolve import "./PaneLayout"`.

- [ ] **Step 3: Write minimal implementation**

W `TabContent.tsx` zmień `function TabPanel` na `export function TabPanel` (reszta pliku bez zmian — `TabContent` zostaje na potrzeby istniejących testów i okien odłączonych do Tasku 13).

Utwórz `DesktopApp/src/components/center/PaneLayout.tsx`:

```tsx
import { useMemo } from 'react';
import { useStore } from '../../store';
import { useShallow } from 'zustand/react/shallow';
import { computePaneRects, TAB_BAR_HEIGHT } from '../../lib/paneGeometry';
import { leaves } from '../../lib/paneTree';
import { TabBar } from './TabBar';
import { TabPanel } from './TabContent';

export function PaneLayout({ detachedProjectId }: { detachedProjectId?: number } = {}) {
  const layout = useStore(s => s.layout);
  const tabs = useStore(useShallow(s => s.tabs));
  const rects = useMemo(() => computePaneRects(layout), [layout]);
  const panes = useMemo(() => leaves(layout), [layout]);
  const ownerOf = useMemo(() => {
    const map = new Map<string, { paneId: string; active: boolean }>();
    for (const pane of panes) {
      for (const tabId of pane.tabIds) map.set(tabId, { paneId: pane.id, active: pane.activeTabId === tabId });
    }
    return map;
  }, [panes]);

  return (
    <div className="flex-1 relative overflow-hidden">
      {panes.map(pane => {
        const rect = rects.get(pane.id);
        if (!rect) return null;
        return (
          <div
            key={pane.id}
            data-pane-id={pane.id}
            className="absolute"
            style={{
              left: `${rect.left}%`,
              top: `${rect.top}%`,
              width: `${rect.width}%`,
              height: `${TAB_BAR_HEIGHT}px`,
            }}
          >
            <TabBar paneId={pane.id} detachedProjectId={detachedProjectId} />
          </div>
        );
      })}
      {tabs.map(tab => {
        const owner = ownerOf.get(tab.id);
        const rect = owner ? rects.get(owner.paneId) : undefined;
        if (!owner || !rect) return null;
        return (
          <div
            key={tab.id}
            data-tab-layer={tab.id}
            className={`absolute ${owner.active ? '' : 'invisible pointer-events-none'}`}
            style={{
              left: `${rect.left}%`,
              top: `calc(${rect.top}% + ${TAB_BAR_HEIGHT}px)`,
              width: `${rect.width}%`,
              height: `calc(${rect.height}% - ${TAB_BAR_HEIGHT}px)`,
            }}
          >
            <TabPanel tab={tab} visible={owner.active} />
          </div>
        );
      })}
      {tabs.length === 0 && (
        <div className="absolute inset-0 grid place-items-center text-muted text-[13px]">
          {detachedProjectId != null ? 'Otwórz nową sesję przyciskiem + na pasku zakładek' : 'Wybierz sesję z lewej'}
        </div>
      )}
    </div>
  );
}
```

W `CenterPanel.tsx`:

```tsx
import { PaneLayout } from './PaneLayout';

export function CenterPanel() {
  return (
    <main className="h-full bg-bg flex flex-col">
      <PaneLayout />
    </main>
  );
}
```

Uwaga: `TabBar` renderuje dziś `return null` gdy `tabs.length === 0 && detachedProjectId == null` — zostaw to, pusty korzeń nie pokazuje wtedy paska.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd DesktopApp && npm test && npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd DesktopApp && git add src/components/center/PaneLayout.tsx src/components/center/PaneLayout.test.tsx src/components/center/CenterPanel.tsx src/components/center/TabContent.tsx
git commit -m "feat(desktop): renderowanie paneli i warstw treści przez PaneLayout"
```

---

### Task 9: Resizery między panelami

**Files:**
- Create: `DesktopApp/src/components/center/PaneResizers.tsx`
- Modify: `DesktopApp/src/components/center/PaneLayout.tsx`
- Test: `DesktopApp/src/components/center/PaneLayout.test.tsx`

**Interfaces:**
- Consumes: `computePaneRects`, `clampSizes`, `MIN_PANE_WIDTH`, `MIN_PANE_HEIGHT`, `TAB_BAR_HEIGHT` (Task 4), `resizeSplit` (Task 5).
- Produces: `PaneResizers({ layout, containerRef })` renderujący uchwyt na każdej granicy każdego splitu; `PaneLayout` renderuje go nad warstwami treści.

Granica `i` splitu leży w miejscu skumulowanej sumy `sizes[0..i]` wewnątrz prostokąta tego splitu, dlatego `computePaneRects` nie wystarcza — potrzebny jest wariant zwracający prostokąty **splitów**.

- [ ] **Step 1: Write the failing test**

Dopisz do `DesktopApp/src/lib/paneGeometry.test.ts`:

```ts
import { computeSplitBoundaries } from './paneGeometry';

describe('computeSplitBoundaries', () => {
  it('returns one boundary per gap, positioned at the cumulative size', () => {
    const bounds = computeSplitBoundaries(tree);
    expect(bounds).toHaveLength(2);
    expect(bounds[0]).toMatchObject({ splitId: 's1', index: 0, dir: 'row', left: 50, top: 0, length: 100, extent: 100 });
    expect(bounds[1]).toMatchObject({ splitId: 's2', index: 0, dir: 'col', left: 50, top: 25, length: 50, extent: 100 });
  });

  it('reports the extent of a nested split along its own axis', () => {
    const nested: PaneNode = {
      kind: 'split', id: 'outer', dir: 'row', sizes: [0.25, 0.75],
      children: [
        createLeaf('x', ['a'], 'a'),
        { kind: 'split', id: 'inner', dir: 'row', sizes: [0.5, 0.5], children: [createLeaf('y', ['b'], 'b'), createLeaf('z', ['c'], 'c')] },
      ],
    };
    const inner = computeSplitBoundaries(nested).find(b => b.splitId === 'inner');
    expect(inner?.extent).toBe(75);
  });

  it('returns nothing for a lone leaf', () => {
    expect(computeSplitBoundaries(createLeaf('p1', ['a'], 'a'))).toEqual([]);
  });
});
```

Dopisz do `PaneLayout.test.tsx`:

```tsx
  it('renders a resizer for each split boundary', () => {
    act(() => { useStore.getState().splitPaneWithTab(ROOT_PANE_ID, 'row', false, 't2'); });
    const { container } = render(<PaneLayout />);
    expect(container.querySelectorAll('[role="separator"]')).toHaveLength(1);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd DesktopApp && npm test -- src/lib/paneGeometry.test.ts src/components/center/PaneLayout.test.tsx`
Expected: FAIL — `computeSplitBoundaries is not a function`, brak elementów `role="separator"`.

- [ ] **Step 3: Write minimal implementation**

Dopisz do `paneGeometry.ts`:

```ts
export type SplitBoundary = {
  splitId: string;
  index: number;
  dir: 'row' | 'col';
  sizes: number[];
  left: number;
  top: number;
  length: number;
  extent: number;
};

export function computeSplitBoundaries(root: PaneNode): SplitBoundary[] {
  const out: SplitBoundary[] = [];
  const walk = (node: PaneNode, rect: PaneRect) => {
    if (node.kind === 'leaf') return;
    let offset = 0;
    node.children.forEach((child, i) => {
      const share = node.sizes[i];
      const childRect: PaneRect = node.dir === 'row'
        ? { left: rect.left + rect.width * offset, top: rect.top, width: rect.width * share, height: rect.height }
        : { left: rect.left, top: rect.top + rect.height * offset, width: rect.width, height: rect.height * share };
      walk(child, childRect);
      offset += share;
      if (i < node.children.length - 1) {
        out.push({
          splitId: node.id,
          index: i,
          dir: node.dir,
          sizes: node.sizes,
          left: node.dir === 'row' ? rect.left + rect.width * offset : rect.left,
          top: node.dir === 'row' ? rect.top : rect.top + rect.height * offset,
          length: node.dir === 'row' ? rect.height : rect.width,
          extent: node.dir === 'row' ? rect.width : rect.height,
        });
      }
    });
  };
  walk(root, { left: 0, top: 0, width: 100, height: 100 });
  return out;
}
```

Utwórz `DesktopApp/src/components/center/PaneResizers.tsx`:

```tsx
import { useCallback, type RefObject } from 'react';
import { useStore } from '../../store';
import { clampSizes, computeSplitBoundaries, MIN_PANE_HEIGHT, MIN_PANE_WIDTH, TAB_BAR_HEIGHT, type SplitBoundary } from '../../lib/paneGeometry';
import type { PaneNode } from '../../lib/paneTree';

export function PaneResizers({ layout, containerRef }: { layout: PaneNode; containerRef: RefObject<HTMLDivElement | null> }) {
  const resizeSplit = useStore(s => s.resizeSplit);
  const boundaries = computeSplitBoundaries(layout);

  const startDrag = useCallback((e: React.MouseEvent, boundary: SplitBoundary) => {
    e.preventDefault();
    const container = containerRef.current;
    if (!container) return;
    const box = container.getBoundingClientRect();
    const horizontal = boundary.dir === 'row';
    const totalPx = ((horizontal ? box.width : box.height) * boundary.extent) / 100;
    const startPx = horizontal ? e.clientX : e.clientY;
    const startFraction = boundary.sizes[boundary.index];
    const minPx = horizontal ? MIN_PANE_WIDTH : MIN_PANE_HEIGHT + TAB_BAR_HEIGHT;

    const move = (ev: MouseEvent) => {
      const delta = (horizontal ? ev.clientX : ev.clientY) - startPx;
      const next = startFraction + delta / totalPx;
      resizeSplit(boundary.splitId, clampSizes(boundary.sizes, boundary.index, next, totalPx, minPx));
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }, [containerRef, resizeSplit]);

  return (
    <>
      {boundaries.map(b => (
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
              ? { left: `${b.left}%`, top: `${b.top}%`, width: 5, height: `${b.length}%` }
              : { left: `${b.left}%`, top: `${b.top}%`, width: `${b.length}%`, height: 5 }
          }
        />
      ))}
    </>
  );
}
```

W `PaneLayout.tsx` dodaj `const containerRef = useRef<HTMLDivElement>(null);`, przypnij go do zewnętrznego `div`, i wyrenderuj `<PaneResizers layout={layout} containerRef={containerRef} />` po warstwach treści.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd DesktopApp && npm test && npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd DesktopApp && git add src/lib/paneGeometry.ts src/lib/paneGeometry.test.ts src/components/center/PaneResizers.tsx src/components/center/PaneLayout.tsx src/components/center/PaneLayout.test.tsx
git commit -m "feat(desktop): resizery granic paneli"
```

---

### Task 10: Fokus panelu i sfokusowany terminal agenta

**Files:**
- Modify: `DesktopApp/src/components/center/PaneLayout.tsx`
- Modify: `DesktopApp/src/components/center/TabContent.tsx`
- Modify: `DesktopApp/src/components/terminal/TerminalView.tsx`
- Test: `DesktopApp/src/components/center/PaneLayout.test.tsx`

**Interfaces:**
- Consumes: `focusPane` (Task 5).
- Produces: `TabPanel` przyjmuje dodatkowo `focused: boolean` i przekazuje je do `TerminalView` jako prop `focused`; `TerminalView` ustawia `activeAgentPtyId` tylko gdy `visible && focused`.

- [ ] **Step 1: Write the failing test**

Dopisz do `PaneLayout.test.tsx`:

```tsx
  it('focuses a pane when its content area is clicked', () => {
    act(() => { useStore.getState().splitPaneWithTab(ROOT_PANE_ID, 'row', false, 't2'); });
    const ids = leaves(useStore.getState().layout).map(l => l.id);
    act(() => { useStore.getState().focusPane(ids[1]); });
    const { container } = render(<PaneLayout />);

    fireEvent.mouseDown(container.querySelector(`[data-pane-content="${ids[0]}"]`) as HTMLElement);

    expect(useStore.getState().focusedPaneId).toBe(ids[0]);
    expect(useStore.getState().activeTabId).toBe('t1');
  });

  it('marks only the focused pane terminal as focused', () => {
    act(() => { useStore.getState().splitPaneWithTab(ROOT_PANE_ID, 'row', false, 't2'); });
    const { container } = render(<PaneLayout />);
    const focused = container.querySelectorAll('[data-testid="terminal"][data-focused="true"]');
    expect(focused).toHaveLength(1);
  });
```

Rozszerz mock `TerminalView` w tym pliku o `data-focused`:

```tsx
vi.mock('../terminal/TerminalView', () => ({
  TerminalView: ({ visible, focused }: { visible?: boolean; focused?: boolean }) => {
    useEffect(() => { counters.terminalMounts += 1; }, []);
    return <div data-testid="terminal" data-visible={String(visible)} data-focused={String(!!focused)} />;
  },
}));
```

Dodaj też import `fireEvent` z `@testing-library/react`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd DesktopApp && npm test -- src/components/center/PaneLayout.test.tsx`
Expected: FAIL — brak `data-pane-content`, `data-focused` zawsze `"false"`.

- [ ] **Step 3: Write minimal implementation**

W `PaneLayout.tsx` owiń warstwę treści atrybutem i uchwytem fokusu (`capture`, bo textarea xterma przechwytuje `mousedown`):

```tsx
          <div
            key={tab.id}
            data-tab-layer={tab.id}
            data-pane-content={owner.paneId}
            onMouseDownCapture={() => focusPane(owner.paneId)}
            …
          >
            <TabPanel tab={tab} visible={owner.active} focused={owner.paneId === focusedPaneId} />
          </div>
```

z `const focusPane = useStore(s => s.focusPane);` oraz `const focusedPaneId = useStore(s => s.focusedPaneId);`.

Ten sam `onMouseDownCapture` dodaj do regionu paska zakładek (`data-pane-id`).

W `TabContent.tsx` przepuść `focused` przez `TabPanel` i `SessionBody` do każdego `TerminalView` (`focused={focused}`); domyślna wartość `focused = true`, żeby istniejące użycia `TabContent` nie zmieniły zachowania.

W `TerminalView.tsx`:

```ts
export function TerminalView({ projectId, kind, provider, sessionId, fresh, actionId, visible = true, focused = true }: Props) {
```

(dodaj `focused?: boolean;` do typu `Props`) i zmień efekt:

```ts
  useEffect(() => {
    if (kind !== 'agent' || !agentPtyId || !visible || !focused) return;
    setActiveAgentPtyId(agentPtyId);
    return () => setActiveAgentPtyId(null);
  }, [kind, agentPtyId, visible, focused, setActiveAgentPtyId]);
```

Efekt z `term.focus()` przy zmianie `visible` (linia ~296) zawęź do `if (!visible || !focused …) return;` w części wołającej `term.focus()` — flush `pendingWrites` i `fit.fit()` muszą działać niezależnie od fokusu, bo panel jest widoczny.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd DesktopApp && npm test && npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd DesktopApp && git add src/components/center/PaneLayout.tsx src/components/center/PaneLayout.test.tsx src/components/center/TabContent.tsx src/components/terminal/TerminalView.tsx
git commit -m "feat(desktop): fokus panelu i sfokusowany terminal agenta"
```

---

### Task 11: Przeciąganie zakładek i strefy zrzutu

**Files:**
- Create: `DesktopApp/src/components/center/usePaneDrag.ts`
- Create: `DesktopApp/src/components/center/PaneDragOverlay.tsx`
- Modify: `DesktopApp/src/components/center/PaneLayout.tsx`
- Modify: `DesktopApp/src/components/center/TabBar.tsx`
- Test: `DesktopApp/src/components/center/PaneLayout.test.tsx`

**Interfaces:**
- Consumes: `hitTestPane`, `dropZone`, `canSplit`, `insertionIndex`, `computePaneRects`, `TAB_BAR_HEIGHT` (Task 4), `splitPaneWithTab`, `moveTabToPane` (Task 5).
- Produces:
  ```ts
  export type PaneDragState = { tabId: string; target: { paneId: string; zone: DropZone; rect: PaneRect } | null };
  export function usePaneDrag(containerRef: RefObject<HTMLDivElement | null>): {
    drag: PaneDragState | null;
    beginDrag: (tabId: string, e: React.PointerEvent) => void;
  };
  ```
  `TabBar` przyjmuje `onTabPointerDown?: (tabId: string, e: React.PointerEvent) => void`.

Reguły: próg 4px; zrzut na krawędź → `splitPaneWithTab`; zrzut w środek lub na pasek zakładek → `moveTabToPane` (indeks z `insertionIndex` po pomiarze elementów `[data-tab-id]` w docelowym pasku, dla środka — koniec listy); zrzut poza kontenerem lub na źródłowy panel z jedną zakładką → anulowanie.

- [ ] **Step 1: Write the failing test**

Dopisz do `PaneLayout.test.tsx`:

```tsx
  const pointerAt = (x: number, y: number) => ({ clientX: x, clientY: y, pointerId: 1, button: 0 });

  const stubContainerBox = (container: HTMLElement) => {
    const root = container.firstElementChild as HTMLElement;
    root.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 1000, bottom: 800, width: 1000, height: 800, toJSON: () => ({}) });
  };

  it('splits the pane when a tab is dropped on its right edge', () => {
    const { container } = render(<PaneLayout />);
    stubContainerBox(container);
    const tab = container.querySelector('[data-tab-id="t2"]') as HTMLElement;

    fireEvent.pointerDown(tab, pointerAt(10, 10));
    fireEvent.pointerMove(window, pointerAt(960, 400));
    fireEvent.pointerUp(window, pointerAt(960, 400));

    expect(leaves(useStore.getState().layout)).toHaveLength(2);
    expect(useStore.getState().activeTabId).toBe('t2');
  });

  it('ignores a pointer movement below the drag threshold', () => {
    const { container } = render(<PaneLayout />);
    stubContainerBox(container);
    const tab = container.querySelector('[data-tab-id="t2"]') as HTMLElement;

    fireEvent.pointerDown(tab, pointerAt(10, 10));
    fireEvent.pointerMove(window, pointerAt(12, 11));
    fireEvent.pointerUp(window, pointerAt(12, 11));

    expect(leaves(useStore.getState().layout)).toHaveLength(1);
  });

  it('moves the tab without splitting when dropped in the centre of another pane', () => {
    act(() => { useStore.getState().splitPaneWithTab(ROOT_PANE_ID, 'row', false, 't2'); });
    const { container } = render(<PaneLayout />);
    stubContainerBox(container);
    const ids = leaves(useStore.getState().layout).map(l => l.id);
    const tab = container.querySelector('[data-tab-id="t1"]') as HTMLElement;

    fireEvent.pointerDown(tab, pointerAt(10, 10));
    fireEvent.pointerMove(window, pointerAt(750, 400));
    fireEvent.pointerUp(window, pointerAt(750, 400));

    expect(leaves(useStore.getState().layout)).toHaveLength(1);
    expect(useStore.getState().layout).toMatchObject({ id: ids[1] });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd DesktopApp && npm test -- src/components/center/PaneLayout.test.tsx`
Expected: FAIL — layout nie reaguje na zdarzenia wskaźnika.

- [ ] **Step 3: Write minimal implementation**

Utwórz `DesktopApp/src/components/center/usePaneDrag.ts`:

```ts
import { useCallback, useRef, useState, type RefObject } from 'react';
import { useStore } from '../../store';
import {
  canSplit,
  computePaneRects,
  dropZone,
  hitTestPane,
  insertionIndex,
  TAB_BAR_HEIGHT,
  type DropZone,
  type PaneRect,
} from '../../lib/paneGeometry';
import { findLeaf } from '../../lib/paneTree';

const DRAG_THRESHOLD = 4;

export type PaneDragState = { tabId: string; target: { paneId: string; zone: DropZone; rect: PaneRect } | null };

export function usePaneDrag(containerRef: RefObject<HTMLDivElement | null>) {
  const [drag, setDrag] = useState<PaneDragState | null>(null);
  const dragRef = useRef<PaneDragState | null>(null);
  dragRef.current = drag;

  const beginDrag = useCallback((tabId: string, e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const origin = { x: e.clientX, y: e.clientY };
    let started = false;

    const resolve = (ev: PointerEvent): PaneDragState['target'] => {
      const container = containerRef.current;
      if (!container) return null;
      const box = container.getBoundingClientRect();
      const rects = computePaneRects(useStore.getState().layout);
      const hit = hitTestPane(rects, { width: box.width, height: box.height }, { x: ev.clientX - box.left, y: ev.clientY - box.top });
      if (!hit) return null;
      const rect = rects.get(hit.paneId)!;
      const overTabBar = hit.local.y <= TAB_BAR_HEIGHT;
      const zone: DropZone = overTabBar ? 'center' : dropZone(hit.local);
      if (zone !== 'center' && !canSplit(zone, { width: hit.local.width, height: hit.local.height })) return null;
      return { paneId: hit.paneId, zone, rect };
    };

    const move = (ev: PointerEvent) => {
      if (!started) {
        if (Math.abs(ev.clientX - origin.x) < DRAG_THRESHOLD && Math.abs(ev.clientY - origin.y) < DRAG_THRESHOLD) return;
        started = true;
      }
      setDrag({ tabId, target: resolve(ev) });
    };

    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      const current = started ? resolve(ev) : null;
      setDrag(null);
      if (!current) return;
      const state = useStore.getState();
      if (current.zone === 'center') {
        const leaf = findLeaf(state.layout, current.paneId);
        if (!leaf) return;
        const container = containerRef.current;
        const bar = container?.querySelector(`[data-pane-id="${current.paneId}"]`);
        const tabRects = bar
          ? Array.from(bar.querySelectorAll('[data-tab-id]')).map(el => {
              const r = (el as HTMLElement).getBoundingClientRect();
              return { id: (el as HTMLElement).dataset.tabId ?? '', left: r.left, width: r.width };
            })
          : [];
        const index = tabRects.length > 0 ? insertionIndex(tabRects, ev.clientX) : leaf.tabIds.length;
        state.moveTabToPane(tabId, current.paneId, index);
        return;
      }
      const dir = current.zone === 'left' || current.zone === 'right' ? 'row' : 'col';
      const before = current.zone === 'left' || current.zone === 'top';
      state.splitPaneWithTab(current.paneId, dir, before, tabId);
    };

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }, [containerRef]);

  return { drag, beginDrag };
}
```

Utwórz `DesktopApp/src/components/center/PaneDragOverlay.tsx`:

```tsx
import type { PaneDragState } from './usePaneDrag';

export function PaneDragOverlay({ drag }: { drag: PaneDragState | null }) {
  if (!drag) return null;
  const t = drag.target;
  const box = !t
    ? null
    : t.zone === 'center'
      ? t.rect
      : t.zone === 'left'
        ? { ...t.rect, width: t.rect.width / 2 }
        : t.zone === 'right'
          ? { ...t.rect, left: t.rect.left + t.rect.width / 2, width: t.rect.width / 2 }
          : t.zone === 'top'
            ? { ...t.rect, height: t.rect.height / 2 }
            : { ...t.rect, top: t.rect.top + t.rect.height / 2, height: t.rect.height / 2 };

  return (
    <div className="absolute inset-0 z-40">
      {box && (
        <div
          data-drop-preview
          className="absolute bg-accent/20 border-2 border-accent pointer-events-none"
          style={{ left: `${box.left}%`, top: `${box.top}%`, width: `${box.width}%`, height: `${box.height}%` }}
        />
      )}
    </div>
  );
}
```

W `TabBar.tsx` dodaj prop `onTabPointerDown` i przypnij go w `renderTab`:

```tsx
      onPointerDown={(e) => onTabPointerDown?.(t.id, e)}
```

W `PaneLayout.tsx`: `const { drag, beginDrag } = usePaneDrag(containerRef);`, przekaż `onTabPointerDown={beginDrag}` do każdego `TabBar` i wyrenderuj `<PaneDragOverlay drag={drag} />` na końcu kontenera. Nakładka jest pełnoekranowa podczas przeciągania, więc blokuje zaznaczanie w xtermie.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd DesktopApp && npm test && npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd DesktopApp && git add src/components/center/usePaneDrag.ts src/components/center/PaneDragOverlay.tsx src/components/center/PaneLayout.tsx src/components/center/PaneLayout.test.tsx src/components/center/TabBar.tsx
git commit -m "feat(desktop): przeciąganie zakładek między panelami i strefy zrzutu"
```

---

### Task 12: Persystencja layoutu

**Files:**
- Modify: `DesktopApp/src/store/index.ts`
- Test: `DesktopApp/src/store/restoreTabs.test.ts`

**Interfaces:**
- Consumes: `PaneNode`, `createLeaf`, `leaves` (Task 1), `ROOT_PANE_ID` (Task 5).
- Produces: `export function sanitizeRestoredLayout(raw: unknown, tabIds: string[], focusedPaneId: unknown): { layout: PaneNode; focusedPaneId: string }`.

Zasada: każde odchylenie od poprawnego drzewa degraduje do jednego liścia `ROOT_PANE_ID` ze wszystkimi zakładkami.

- [ ] **Step 1: Write the failing test**

Dopisz do `DesktopApp/src/store/restoreTabs.test.ts`:

```ts
import { sanitizeRestoredLayout } from './index';
import { createLeaf } from '../lib/paneTree';
import { ROOT_PANE_ID } from './panesSlice';

describe('sanitizeRestoredLayout', () => {
  it('keeps a valid tree and drops tabs that did not survive', () => {
    const raw = {
      kind: 'split', id: 's1', dir: 'row', sizes: [0.5, 0.5],
      children: [createLeaf('p1', ['a', 'ghost'], 'a'), createLeaf('p2', ['b'], 'b')],
    };
    const out = sanitizeRestoredLayout(raw, ['a', 'b'], 'p2');
    expect(out.layout.kind).toBe('split');
    expect(out.focusedPaneId).toBe('p2');
  });

  it('collapses a pane left empty after sanitisation', () => {
    const raw = {
      kind: 'split', id: 's1', dir: 'row', sizes: [0.5, 0.5],
      children: [createLeaf('p1', ['a'], 'a'), createLeaf('p2', ['ghost'], 'ghost')],
    };
    const out = sanitizeRestoredLayout(raw, ['a'], 'p2');
    expect(out.layout).toMatchObject({ kind: 'leaf', id: 'p1' });
    expect(out.focusedPaneId).toBe('p1');
  });

  it('falls back to a single root leaf for a malformed tree', () => {
    const out = sanitizeRestoredLayout({ kind: 'split', id: 's1' }, ['a', 'b'], 'nope');
    expect(out.layout).toMatchObject({ kind: 'leaf', id: ROOT_PANE_ID, tabIds: ['a', 'b'] });
    expect(out.focusedPaneId).toBe(ROOT_PANE_ID);
  });

  it('falls back when the tree is missing entirely', () => {
    const out = sanitizeRestoredLayout(undefined, ['a'], undefined);
    expect(out.layout).toMatchObject({ kind: 'leaf', id: ROOT_PANE_ID, tabIds: ['a'] });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd DesktopApp && npm test -- src/store/restoreTabs.test.ts`
Expected: FAIL — `sanitizeRestoredLayout is not a function`.

- [ ] **Step 3: Write minimal implementation**

W `DesktopApp/src/store/index.ts`:

```ts
import { collapseEmpty, createLeaf, leaves, mapLeaves, type PaneNode } from '../lib/paneTree';

type PersistedTabs = {
  tabs: PersistedTab[];
  activeTabId: string | null;
  layout?: unknown;
  focusedPaneId?: unknown;
};

function isPaneNode(raw: unknown): raw is PaneNode {
  if (!raw || typeof raw !== 'object') return false;
  const node = raw as Record<string, unknown>;
  if (node.kind === 'leaf') {
    return typeof node.id === 'string'
      && Array.isArray(node.tabIds)
      && node.tabIds.every(id => typeof id === 'string')
      && (node.activeTabId === null || typeof node.activeTabId === 'string');
  }
  if (node.kind !== 'split') return false;
  return typeof node.id === 'string'
    && (node.dir === 'row' || node.dir === 'col')
    && Array.isArray(node.sizes)
    && node.sizes.every(s => typeof s === 'number' && s > 0)
    && Array.isArray(node.children)
    && node.children.length >= 2
    && node.children.length === node.sizes.length
    && node.children.every(isPaneNode);
}

export function sanitizeRestoredLayout(
  raw: unknown,
  tabIds: string[],
  focusedPaneId: unknown,
): { layout: PaneNode; focusedPaneId: string } {
  const fallback = { layout: createLeaf(ROOT_PANE_ID, tabIds, tabIds[tabIds.length - 1] ?? null), focusedPaneId: ROOT_PANE_ID };
  if (!isPaneNode(raw)) return fallback;

  const known = new Set(tabIds);
  const pruned = mapLeaves(raw, leaf => {
    const kept = leaf.tabIds.filter(id => known.has(id));
    return kept.length === leaf.tabIds.length ? leaf : { ...leaf, tabIds: kept };
  });
  const placed = new Set(leaves(pruned).flatMap(l => l.tabIds));
  if (tabIds.some(id => !placed.has(id))) return fallback;

  const ids = leaves(pruned).map(l => l.id);
  if (new Set(ids).size !== ids.length) return fallback;

  const focus = typeof focusedPaneId === 'string' && ids.includes(focusedPaneId) ? focusedPaneId : ids[0];
  const collapsed = collapseEmpty(pruned, focus);
  return { layout: collapsed.root, focusedPaneId: collapsed.focusedPaneId };
}
```

W `loadTabsFromLocalStorage` zwróć dodatkowo surowe `layout` i `focusedPaneId`, a w bloku restore (gałąź `else`, `store/index.ts:341`) zastosuj:

```ts
  const savedTabs = loadTabsFromLocalStorage();
  if (savedTabs && savedTabs.tabs.length > 0) {
    const tabs = savedTabs.tabs.map(t => ({ ...t, mode: 'history' as const }));
    const panes = sanitizeRestoredLayout(savedTabs.layout, tabs.map(t => t.id), savedTabs.focusedPaneId);
    useStore.setState({
      tabs,
      activeTabId: savedTabs.activeTabId,
      navHistory: savedTabs.activeTabId ? [savedTabs.activeTabId] : [],
      navIndex: 0,
      layout: panes.layout,
      focusedPaneId: panes.focusedPaneId,
    });
  }
```

W `writeTabsToLocalStorage` zapisz layout ograniczony do zakładek sesji (pozostałe rodzaje i tak nie persystują):

```ts
  const keep = new Set(sessionTabs.map(t => t.id));
  const prunedLayout = collapseEmpty(
    mapLeaves(state.layout, leaf => {
      const tabIds = leaf.tabIds.filter(id => keep.has(id));
      return tabIds.length === leaf.tabIds.length ? leaf : { ...leaf, tabIds, activeTabId: tabIds.includes(leaf.activeTabId ?? '') ? leaf.activeTabId : (tabIds[tabIds.length - 1] ?? null) };
    }),
    state.focusedPaneId,
  );
  try {
    localStorage.setItem(TABS_PERSIST_KEY, JSON.stringify({
      tabs: sessionTabs,
      activeTabId,
      layout: prunedLayout.root,
      focusedPaneId: prunedLayout.focusedPaneId,
    }));
  } catch { /* storage full */ }
```

Rozszerz klucz wyzwalający zapis o layout:

```ts
let prevTabsJson = JSON.stringify(useStore.getState().tabs) + '|' + (useStore.getState().activeTabId ?? '') + '|' + JSON.stringify(useStore.getState().layout);
```

i analogicznie wewnątrz subskrypcji.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd DesktopApp && npm test && npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd DesktopApp && git add src/store/index.ts src/store/restoreTabs.test.ts
git commit -m "feat(desktop): persystencja układu paneli"
```

---

### Task 13: Attention dla widocznych zakładek i okna odłączone

**Files:**
- Modify: `DesktopApp/src/components/layout/AppShell.tsx`
- Modify: `DesktopApp/src/components/layout/DetachedShell.tsx`
- Test: `DesktopApp/src/components/layout/DetachedShell.test.tsx`
- Create: `DesktopApp/src/lib/visibleTabs.ts`
- Create: `DesktopApp/src/lib/visibleTabs.test.ts`

**Interfaces:**
- Consumes: `leaves` (Task 1), `PaneNode`, `Tab`.
- Produces: `export function visibleSessionIds(layout: PaneNode, tabs: Tab[]): string[]` — identyfikatory sesji (`linkedSessionId ?? sessionId`) aktywnych zakładek wszystkich paneli.

`DetachedShell` seeduje pojedynczy panel (`createLeaf(ROOT_PANE_ID, tabIds, activeTabId)`) i renderuje `PaneLayout` zamiast pary `TabBar` + `TabContent`.

- [ ] **Step 1: Write the failing test**

Utwórz `DesktopApp/src/lib/visibleTabs.test.ts`:

```ts
// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { createLeaf, insertBeside } from './paneTree';
import { visibleSessionIds } from './visibleTabs';
import type { Tab } from '../store/tabsSlice';

const session = (id: string, sessionId: string, linked?: string): Tab => ({
  kind: 'session', id, projectId: 1, sessionId, title: id, mode: 'terminal',
  ...(linked ? { linkedSessionId: linked } : {}),
});

describe('visibleSessionIds', () => {
  it('returns the active session of every pane, preferring the linked id', () => {
    const layout = insertBeside(createLeaf('p1', ['a', 'b'], 'a'), 'p1', 'row', false, createLeaf('p2', ['c'], 'c'), 's1');
    const tabs = [session('a', 's-a'), session('b', 's-b'), session('c', 'new-x', 's-real')];
    expect(visibleSessionIds(layout, tabs)).toEqual(['s-a', 's-real']);
  });

  it('skips panes whose active tab is not a session', () => {
    const layout = createLeaf('p1', ['t1'], 't1');
    const tabs: Tab[] = [{ kind: 'terminal', id: 't1', projectId: 1, title: 'Terminal' }];
    expect(visibleSessionIds(layout, tabs)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd DesktopApp && npm test -- src/lib/visibleTabs.test.ts`
Expected: FAIL — `Failed to resolve import "./visibleTabs"`.

- [ ] **Step 3: Write minimal implementation**

Utwórz `DesktopApp/src/lib/visibleTabs.ts`:

```ts
import { leaves, type PaneNode } from './paneTree';
import type { Tab } from '../store/tabsSlice';

export function visibleSessionIds(layout: PaneNode, tabs: Tab[]): string[] {
  return leaves(layout)
    .map(leaf => tabs.find(t => t.id === leaf.activeTabId))
    .filter((t): t is Extract<Tab, { kind: 'session' }> => t?.kind === 'session')
    .map(t => t.linkedSessionId ?? t.sessionId);
}
```

W `AppShell.tsx`:

- w `handle` (obsługa `AttentionEvent`) zamień wyliczenie `activeSessionId` na `const visible = visibleSessionIds(state.layout, state.tabs);` i `const isActiveFocused = document.hasFocus() && visible.includes(e.sessionId);`
- w efekcie czyszczącym attention po zmianie zakładki (linia ~149) wyczyść wszystkie widoczne:

```ts
  useEffect(() => {
    if (!document.hasFocus()) return;
    const state = useStore.getState();
    for (const sessionId of visibleSessionIds(state.layout, state.tabs)) state.clearAttention(sessionId);
  }, [activeTabId]);
```

W `DetachedShell.tsx` zamień renderowanie `<TabBar …/>` + `<TabContent …/>` na `<PaneLayout detachedProjectId={…} />` (ten sam prop, który dziś dostaje `TabBar`), a w `store/index.ts` w gałęziach `windowMode?.view === 'session'` i `=== 'group'` dopisz do `useStore.setState` seed layoutu:

```ts
    layout: createLeaf(ROOT_PANE_ID, tabs.map(t => t.id), activeTabId),
    focusedPaneId: ROOT_PANE_ID,
```

(dla trybu `session`: `createLeaf(ROOT_PANE_ID, [tab.id], tab.id)`).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd DesktopApp && npm test && npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd DesktopApp && git add src/lib/visibleTabs.ts src/lib/visibleTabs.test.ts src/components/layout/AppShell.tsx src/components/layout/DetachedShell.tsx src/components/layout/DetachedShell.test.tsx src/store/index.ts
git commit -m "feat(desktop): attention dla wszystkich widocznych paneli i seed layoutu w oknach odłączonych"
```

---

## Weryfikacja końcowa

- [ ] `cd DesktopApp && npm test` — cały zestaw zielony.
- [ ] `cd DesktopApp && npm run lint` — zero błędów.
- [ ] `cd DesktopApp && npm run tauri dev` i ręczne QA:
  - przeciągnięcie zakładki na prawą krawędź dzieli obszar na dwa, oba terminale żyją i mają poprawny rozmiar,
  - trzeci podział w prawo daje trzy kolumny (spłaszczenie), nie drabinkę,
  - przeciągnięcie ostatniej zakładki z panelu zwija ten panel,
  - prawy panel (Git/Actions) podąża za panelem, w którym kliknięto,
  - zakładki z dwóch projektów w jednym panelu stoją poza grupami, na początku, z kolorem projektu na krawędzi,
  - restart aplikacji odtwarza układ paneli,
  - „Wstaw do aktywnej sesji" w ClickUp trafia w terminal sfokusowanego panelu.
