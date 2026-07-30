// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { createLeaf, type PaneNode } from './paneTree';
import {
  canSplit,
  clampSizes,
  computePaneRects,
  computeSplitBoundaries,
  dropZone,
  hitTestPane,
  insertionIndex,
  MIN_PANE_HEIGHT,
  MIN_PANE_WIDTH,
  TAB_BAR_HEIGHT,
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
    expect(dropZone({ width: 400, height: 800, x: 10, y: 10 })).toBe('top');
    expect(dropZone({ width: 800, height: 400, x: 10, y: 10 })).toBe('left');
  });

  it('refuses a split that would go below the minimum', () => {
    expect(canSplit('left', { width: MIN_PANE_WIDTH * 2 - 1, height: 600 })).toBe(false);
    expect(canSplit('left', { width: MIN_PANE_WIDTH * 2, height: 600 })).toBe(true);
    expect(canSplit('center', { width: 10, height: 10 })).toBe(true);
  });

  it('demands room for a tab bar in each half of a vertical split', () => {
    const half = MIN_PANE_HEIGHT + TAB_BAR_HEIGHT;
    expect(canSplit('top', { width: 800, height: half * 2 - 1 })).toBe(false);
    expect(canSplit('bottom', { width: 800, height: half * 2 })).toBe(true);
    expect(canSplit('top', { width: 800, height: MIN_PANE_HEIGHT * 2 })).toBe(false);
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

  it('splits the pair evenly instead of going negative when the split is narrower than the minimum', () => {
    const out = clampSizes([0.5, 0.5], 0, 0.9, 200, 240);
    expect(out[0]).toBeCloseTo(0.5);
    expect(out[1]).toBeCloseTo(0.5);

    const nested = clampSizes([0.4, 0.3, 0.3], 1, 0.9, 500, 400);
    expect(nested[0]).toBeCloseTo(0.4);
    expect(nested[1]).toBeCloseTo(0.3);
    expect(nested[2]).toBeCloseTo(0.3);
  });
});
