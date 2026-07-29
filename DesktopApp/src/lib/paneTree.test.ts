// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  collapseEmpty,
  createLeaf,
  findLeaf,
  findLeafOfTab,
  insertBeside,
  leaves,
  mapLeaves,
  moveTab,
  removeTabFromLeaves,
  type PaneLeaf,
  type PaneNode,
  type PaneSplit,
} from './paneTree';

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
