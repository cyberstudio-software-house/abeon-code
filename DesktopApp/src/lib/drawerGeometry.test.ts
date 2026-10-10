import { describe, it, expect } from 'vitest';
import {
  DRAWER_DEFAULT_SIZE,
  DRAWER_HEADER_HEIGHT,
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

describe('computeCollapsedDrawerLayout', () => {
  it('reserves a bar at the bottom of the content and gives the session the rest', () => {
    const r = computeCollapsedDrawerLayout(paneContentRect(FULL, 32));
    expect(lenRectStyle(r.session)).toEqual({
      left: '0%', top: 'calc(0% + 32px)', width: '100%', height: 'calc(100% - 60px)',
    });
    expect(lenRectStyle(r.bar)).toEqual({
      left: '0%', top: 'calc(100% - 28px)', width: '100%', height: 'calc(0% + 28px)',
    });
  });

  it('keeps the bar inside an offset pane', () => {
    const r = computeCollapsedDrawerLayout(paneContentRect({ left: 50, top: 50, width: 50, height: 50 }, 32));
    expect(lenRectStyle(r.bar)).toEqual({
      left: '50%', top: 'calc(100% - 28px)', width: '50%', height: 'calc(0% + 28px)',
    });
    expect(cssLen(r.session.height)).toBe('calc(50% - 60px)');
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
