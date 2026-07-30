import { describe, it, expect } from 'vitest';
import { sanitizeRestoredLayout, sanitizeRestoredTabs } from './index';
import { createLeaf } from '../lib/paneTree';
import { ROOT_PANE_ID } from './panesSlice';

describe('sanitizeRestoredTabs', () => {
  it('drops unlinked new- placeholder tabs (orphaned, point at nothing on disk)', () => {
    const out = sanitizeRestoredTabs([
      { kind: 'session', id: 'session:new-1', projectId: 1, sessionId: 'new-1', title: 'New session' },
      { kind: 'session', id: 'session:abc', projectId: 1, sessionId: 'abc', title: 'Real' },
      { kind: 'session', id: 'session:new-2', projectId: 1, sessionId: 'new-2', linkedSessionId: 'real-2', title: 'Linked' },
    ]);
    expect(out.map(t => t.sessionId)).toEqual(['abc', 'new-2']);
  });

  it('keeps deterministic real-id session tabs', () => {
    const out = sanitizeRestoredTabs([
      { kind: 'session', id: 'session:11111111-2222-3333-4444-555555555555', projectId: 2, sessionId: '11111111-2222-3333-4444-555555555555', title: 'Fix bug' },
    ]);
    expect(out).toHaveLength(1);
  });

  it('rejects malformed entries', () => {
    const out = sanitizeRestoredTabs([
      // @ts-expect-error intentionally malformed
      { kind: 'session', id: 5, sessionId: 'x', projectId: 1, title: 't' },
      // @ts-expect-error intentionally malformed
      { kind: 'terminal', id: 'terminal:1', projectId: 1, title: 't' },
    ]);
    expect(out).toHaveLength(0);
  });

  it('strips unknown provider but keeps the tab', () => {
    const out = sanitizeRestoredTabs([
      // @ts-expect-error deliberately invalid provider from old/corrupt localStorage
      { kind: 'session', id: 'session:abc', projectId: 1, sessionId: 'abc', title: 'T', provider: 'future-provider' },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].provider).toBeUndefined();
  });
});

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

  it('falls back when a tab is absent from the tree rather than dropping it', () => {
    const raw = {
      kind: 'split', id: 's1', dir: 'row', sizes: [0.5, 0.5],
      children: [createLeaf('p1', ['a'], 'a'), createLeaf('p2', ['b'], 'b')],
    };
    const out = sanitizeRestoredLayout(raw, ['a', 'b', 'c'], 'p1');
    expect(out.layout).toMatchObject({ kind: 'leaf', id: ROOT_PANE_ID, tabIds: ['a', 'b', 'c'] });
    expect(out.focusedPaneId).toBe(ROOT_PANE_ID);
  });

  it('falls back when two panes share an id', () => {
    const raw = {
      kind: 'split', id: 's1', dir: 'row', sizes: [0.5, 0.5],
      children: [createLeaf('p1', ['a'], 'a'), createLeaf('p1', ['b'], 'b')],
    };
    const out = sanitizeRestoredLayout(raw, ['a', 'b'], 'p1');
    expect(out.layout).toMatchObject({ kind: 'leaf', id: ROOT_PANE_ID, tabIds: ['a', 'b'] });
    expect(out.focusedPaneId).toBe(ROOT_PANE_ID);
  });

  const malformed: [string, unknown][] = [
    ['an unknown node kind', { kind: 'row', id: 'p1', tabIds: ['a', 'b'], activeTabId: 'a' }],
    ['a non-string leaf id', { kind: 'leaf', id: 1, tabIds: ['a', 'b'], activeTabId: 'a' }],
    ['a non-string tab id', { kind: 'leaf', id: 'p1', tabIds: ['a', 'b', 7], activeTabId: 'a' }],
    ['an undefined activeTabId', { kind: 'leaf', id: 'p1', tabIds: ['a', 'b'] }],
    ['a non-string split id', {
      kind: 'split', id: 2, dir: 'row', sizes: [0.5, 0.5],
      children: [createLeaf('p1', ['a'], 'a'), createLeaf('p2', ['b'], 'b')],
    }],
    ['an unknown direction', {
      kind: 'split', id: 's1', dir: 'diag', sizes: [0.5, 0.5],
      children: [createLeaf('p1', ['a'], 'a'), createLeaf('p2', ['b'], 'b')],
    }],
    ['a non-positive size', {
      kind: 'split', id: 's1', dir: 'row', sizes: [1, 0],
      children: [createLeaf('p1', ['a'], 'a'), createLeaf('p2', ['b'], 'b')],
    }],
    ['more sizes than children', {
      kind: 'split', id: 's1', dir: 'row', sizes: [0.3, 0.3, 0.4],
      children: [createLeaf('p1', ['a'], 'a'), createLeaf('p2', ['b'], 'b')],
    }],
    ['a split with a single child', {
      kind: 'split', id: 's1', dir: 'row', sizes: [1],
      children: [createLeaf('p1', ['a', 'b'], 'a')],
    }],
    ['sizes that do not sum to one', {
      kind: 'split', id: 's1', dir: 'row', sizes: [5, 5],
      children: [createLeaf('p1', ['a'], 'a'), createLeaf('p2', ['b'], 'b')],
    }],
    ['the same tab in two leaves', {
      kind: 'split', id: 's1', dir: 'row', sizes: [0.5, 0.5],
      children: [createLeaf('p1', ['a', 'b'], 'a'), createLeaf('p2', ['b'], 'b')],
    }],
    ['a malformed nested child', {
      kind: 'split', id: 's1', dir: 'row', sizes: [0.5, 0.5],
      children: [createLeaf('p1', ['a'], 'a'), { kind: 'leaf', id: 'p2', tabIds: ['b'], activeTabId: 5 }],
    }],
  ];

  it.each(malformed)('falls back for a tree with %s', (_label, raw) => {
    const out = sanitizeRestoredLayout(raw, ['a', 'b'], 'p1');
    expect(out.layout).toMatchObject({ kind: 'leaf', id: ROOT_PANE_ID, tabIds: ['a', 'b'] });
    expect(out.focusedPaneId).toBe(ROOT_PANE_ID);
  });
});
