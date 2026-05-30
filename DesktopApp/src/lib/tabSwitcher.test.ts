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
