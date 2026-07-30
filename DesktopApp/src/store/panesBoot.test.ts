import { describe, it, expect } from 'vitest';
import { ROOT_PANE_ID } from './panesSlice';
import { findLeaf } from '../lib/paneTree';

// `./index` must stay a dynamic import: the boot blocks that restore tabs run at
// module evaluation, and this asserts what the layout looks like right after them.
describe('store boot', () => {
  it('folds tabs restored from localStorage into the root pane', async () => {
    localStorage.setItem('abeoncode.tabs', JSON.stringify({
      tabs: [
        { kind: 'session', id: 'session:a', projectId: 1, sessionId: 'a', title: 'A' },
        { kind: 'session', id: 'session:b', projectId: 1, sessionId: 'b', title: 'B' },
      ],
      activeTabId: 'session:b',
    }));

    const { useStore } = await import('./index');

    expect(useStore.getState().tabs.map(t => t.id)).toEqual(['session:a', 'session:b']);
    expect(findLeaf(useStore.getState().layout, ROOT_PANE_ID)?.tabIds).toEqual(['session:a', 'session:b']);
    expect(findLeaf(useStore.getState().layout, ROOT_PANE_ID)?.activeTabId).toBe('session:b');
    expect(useStore.getState().focusedPaneId).toBe(ROOT_PANE_ID);
    expect(useStore.getState().activeTabId).toBe('session:b');
  });
});
