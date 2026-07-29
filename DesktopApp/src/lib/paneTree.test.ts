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
