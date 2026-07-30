import { beforeEach, describe, it, expect, vi } from 'vitest';
import { ROOT_PANE_ID } from './panesSlice';
import { findLeaf, leaves, type PaneNode, type PaneSplit } from '../lib/paneTree';

// Re-importing `./index` re-runs its boot IPC calls; jsdom has no Tauri host, so
// stub just that boundary to keep the layout assertions free of transport noise.
vi.mock('../lib/tauri', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/tauri')>();
  return {
    ...actual,
    tauri: {
      ...actual.tauri,
      getAllSettings: async () => ({}),
      setSetting: async () => {},
      detectDefaultShell: async () => '',
      takePendingOpenPaths: async () => [],
    },
  };
});

// `./index` must stay a dynamic import: the boot blocks that restore tabs run at
// module evaluation, and this asserts what the layout looks like right after them.
describe('store boot', () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
  });

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

  it('restores a persisted split layout without flattening it', async () => {
    localStorage.setItem('abeoncode.tabs', JSON.stringify({
      tabs: [
        { kind: 'session', id: 'session:a', projectId: 1, sessionId: 'a', title: 'A' },
        { kind: 'session', id: 'session:b', projectId: 1, sessionId: 'b', title: 'B' },
      ],
      activeTabId: 'session:b',
      layout: {
        kind: 'split', id: 's1', dir: 'col', sizes: [0.4, 0.6],
        children: [
          { kind: 'leaf', id: 'p1', tabIds: ['session:a'], activeTabId: 'session:a' },
          { kind: 'leaf', id: 'p2', tabIds: ['session:b'], activeTabId: 'session:b' },
        ],
      },
      focusedPaneId: 'p2',
    }));

    const { useStore } = await import('./index');
    const layout = useStore.getState().layout as PaneSplit;

    expect(layout.kind).toBe('split');
    expect(layout.dir).toBe('col');
    expect(layout.sizes).toEqual([0.4, 0.6]);
    expect(leaves(layout).map(l => l.id)).toEqual(['p1', 'p2']);
    expect(findLeaf(layout, 'p1')?.tabIds).toEqual(['session:a']);
    expect(findLeaf(layout, 'p2')?.tabIds).toEqual(['session:b']);
    expect(findLeaf(layout, ROOT_PANE_ID)).toBeNull();
    expect(useStore.getState().focusedPaneId).toBe('p2');
    expect(useStore.getState().activeTabId).toBe('session:b');
  });

  it('repairs a persisted focus that names no surviving pane', async () => {
    localStorage.setItem('abeoncode.tabs', JSON.stringify({
      tabs: [
        { kind: 'session', id: 'session:a', projectId: 1, sessionId: 'a', title: 'A' },
        { kind: 'session', id: 'session:b', projectId: 1, sessionId: 'b', title: 'B' },
      ],
      activeTabId: 'session:b',
      layout: {
        kind: 'split', id: 's1', dir: 'row', sizes: [0.5, 0.5],
        children: [
          { kind: 'leaf', id: 'p1', tabIds: ['session:a'], activeTabId: 'session:a' },
          { kind: 'leaf', id: 'p2', tabIds: ['session:b'], activeTabId: 'session:b' },
        ],
      },
      focusedPaneId: 'p-gone',
    }));

    const { useStore } = await import('./index');

    expect(leaves(useStore.getState().layout).map(l => l.id)).toEqual(['p1', 'p2']);
    expect(useStore.getState().focusedPaneId).toBe('p1');
  });

  it('round-trips a split created at runtime through localStorage', async () => {
    localStorage.setItem('abeoncode.tabs', JSON.stringify({
      tabs: [
        { kind: 'session', id: 'session:a', projectId: 1, sessionId: 'a', title: 'A' },
        { kind: 'session', id: 'session:b', projectId: 1, sessionId: 'b', title: 'B' },
      ],
      activeTabId: 'session:b',
    }));

    const first = await import('./index');
    first.useStore.getState().splitPaneWithTab(ROOT_PANE_ID, 'row', false, 'session:b');
    const paneIds = leaves(first.useStore.getState().layout).map(l => l.id);
    const focusedPaneId = first.useStore.getState().focusedPaneId;
    expect(paneIds).toHaveLength(2);

    vi.resetModules();
    const second = await import('./index');
    const restored = second.useStore.getState();

    expect(restored.layout.kind).toBe('split');
    expect(leaves(restored.layout).map(l => l.id)).toEqual(paneIds);
    expect(findLeaf(restored.layout, paneIds[0])?.tabIds).toEqual(['session:a']);
    expect(findLeaf(restored.layout, paneIds[1])?.tabIds).toEqual(['session:b']);
    expect(restored.focusedPaneId).toBe(focusedPaneId);
  });

  it('prunes non-session tabs out of the persisted layout', async () => {
    localStorage.setItem('abeoncode.tabs', JSON.stringify({
      tabs: [{ kind: 'session', id: 'session:a', projectId: 1, sessionId: 'a', title: 'A' }],
      activeTabId: 'session:a',
    }));

    const { useStore } = await import('./index');
    useStore.getState().openNewTerminalTab(1);
    const terminalTabId = useStore.getState().activeTabId!;
    useStore.getState().splitPaneWithTab(ROOT_PANE_ID, 'row', false, terminalTabId);
    expect(leaves(useStore.getState().layout)).toHaveLength(2);

    const persisted = JSON.parse(localStorage.getItem('abeoncode.tabs')!) as {
      tabs: { id: string }[];
      layout: PaneNode;
      focusedPaneId: string;
    };

    expect(persisted.tabs.map(t => t.id)).toEqual(['session:a']);
    expect(JSON.stringify(persisted.layout)).not.toContain(terminalTabId);
    expect(persisted.layout).toMatchObject({ kind: 'leaf', id: ROOT_PANE_ID, tabIds: ['session:a'] });
    expect(persisted.focusedPaneId).toBe(ROOT_PANE_ID);
  });
});
