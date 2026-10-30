import { describe, it, expect } from 'vitest';
import {
  DRAWER_DEFAULT_SIZE,
  DRAWER_HEADER_HEIGHT,
  drawerCornerContact,
  DRAWER_MAX_SIZE,
  DRAWER_MIN_SIZE,
  addLen,
  clampDrawerSize,
  computeCollapsedDrawerLayout,
  computeDrawerLayout,
  cssLen,
  len,
  lenRectStyle,
  neighborInDirection,
  paneBarRect,
  paneContentRect,
  paneFrameRect,
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

describe('pane card geometry', () => {
  it('insets the frame by half the gap and keeps the bar and content inside its border', () => {
    expect(paneFrameRect(FULL)).toEqual({ left: len(0, 4), top: len(0, 4), width: len(100, -8), height: len(100, -8) });
    expect(paneBarRect(FULL, 48)).toEqual({ left: len(0, 5), top: len(0, 5), width: len(100, -10), height: len(0, 48) });
    expect(paneContentRect(FULL, 48)).toEqual({ left: len(0, 5), top: len(0, 53), width: len(100, -10), height: len(100, -58) });
  });

  it('insets the frame of a right half pane from its own edges', () => {
    expect(paneFrameRect({ left: 50, top: 0, width: 50, height: 100 })).toEqual({
      left: len(50, 4), top: len(0, 4), width: len(50, -8), height: len(100, -8),
    });
  });
});

describe('computeDrawerLayout', () => {
  it('keeps the plain content rect format of a pane without a drawer', () => {
    const c = paneContentRect(FULL, 32);
    expect(lenRectStyle(c)).toEqual({
      left: 'calc(0% + 5px)', top: 'calc(0% + 37px)', width: 'calc(100% - 10px)', height: 'calc(100% - 42px)',
    });
  });

  it('splits the content into session, header and body', () => {
    const r = computeDrawerLayout(FULL, 32, 0.35, single);
    expect(cssLen(r.session.height)).toBe('calc(65% - 27.3px)');
    expect(cssLen(r.header.top)).toBe('calc(65% + 9.7px)');
    expect(cssLen(r.header.height)).toBe(`calc(0% + ${DRAWER_HEADER_HEIGHT}px)`);
    expect(cssLen(r.body.top)).toBe('calc(65% + 45.7px)');
    expect(cssLen(r.body.height)).toBe('calc(35% - 50.7px)');
    expect(lenRectStyle(r.terminals.get('a')!)).toEqual(lenRectStyle(r.body));
    expect(lenRectStyle(r.content)).toEqual(lenRectStyle(paneContentRect(FULL, 32)));
  });

  it('lays terminals out inside the body of an offset pane', () => {
    const r = computeDrawerLayout({ left: 50, top: 0, width: 50, height: 100 }, 32, 0.5, row);
    expect(cssLen(r.header.left)).toBe('calc(50% + 5px)');
    expect(cssLen(r.header.width)).toBe('calc(50% - 10px)');
    expect(cssLen(r.terminals.get('b')!.left)).toBe('75%');
    expect(cssLen(r.terminals.get('b')!.width)).toBe('calc(25% - 5px)');
  });

  it('stacks a column split vertically inside the body', () => {
    const r = computeDrawerLayout(FULL, 32, 0.5, mixed);
    expect(cssLen(r.terminals.get('c')!.top)).toBe('calc(75% + 23.5px)');
    expect(cssLen(r.terminals.get('c')!.height)).toBe('calc(25% - 28.5px)');
  });
});

describe('computeCollapsedDrawerLayout', () => {
  it('reserves a bar at the bottom of the content and gives the session the rest', () => {
    const r = computeCollapsedDrawerLayout(paneContentRect(FULL, 32));
    expect(lenRectStyle(r.session)).toEqual({
      left: 'calc(0% + 5px)', top: 'calc(0% + 37px)', width: 'calc(100% - 10px)', height: 'calc(100% - 78px)',
    });
    expect(lenRectStyle(r.bar)).toEqual({
      left: 'calc(0% + 5px)', top: 'calc(100% - 41px)', width: 'calc(100% - 10px)', height: 'calc(0% + 36px)',
    });
  });

  it('keeps the bar inside an offset pane', () => {
    const r = computeCollapsedDrawerLayout(paneContentRect({ left: 50, top: 50, width: 50, height: 50 }, 32));
    expect(lenRectStyle(r.bar)).toEqual({
      left: 'calc(50% + 5px)', top: 'calc(100% - 41px)', width: 'calc(50% - 10px)', height: 'calc(0% + 36px)',
    });
    expect(cssLen(r.session.height)).toBe('calc(50% - 78px)');
  });
});

describe('drawerCornerContact', () => {
  it('marks the bottom corners a split shares with the drawer body', () => {
    expect(drawerCornerContact({ left: 0, top: 0, width: 50, height: 100 })).toEqual({ bottomLeft: true, bottomRight: false });
    expect(drawerCornerContact({ left: 50, top: 0, width: 50, height: 100 })).toEqual({ bottomLeft: false, bottomRight: true });
    expect(drawerCornerContact({ left: 0, top: 0, width: 100, height: 100 })).toEqual({ bottomLeft: true, bottomRight: true });
  });

  it('marks nothing for a split that does not reach the bottom', () => {
    expect(drawerCornerContact({ left: 0, top: 0, width: 100, height: 50 })).toEqual({ bottomLeft: false, bottomRight: false });
  });
});

describe('clampDrawerSize', () => {
  it('keeps the size inside the global range', () => {
    expect(clampDrawerSize(0.95, 1000)).toBe(DRAWER_MAX_SIZE);
    expect(clampDrawerSize(0.05, 1000)).toBe(DRAWER_MIN_SIZE);
  });

  it('protects the minimum session and drawer heights', () => {
    expect(clampDrawerSize(0.1, 500)).toBeCloseTo((120 + 36) / 500);
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
