import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from './index';
import { ROOT_PANE_ID } from './panesSlice';
import { createLeaf, leaves, type PaneSplit } from '../lib/paneTree';
import type { Tab } from './tabsSlice';

const session = (id: string, projectId = 1, extra: Partial<Extract<Tab, { kind: 'session' }>> = {}): Tab => ({
  kind: 'session', id, projectId, sessionId: id, title: id, mode: 'terminal', ...extra,
});

const drawer = () => useStore.getState().drawers.s1;
const terminalIds = () => leaves(drawer().layout).map(l => l.id);

beforeEach(() => {
  useStore.setState({
    tabs: [session('s1')],
    activeTabId: 's1',
    mruOrder: [],
    navHistory: [],
    navIndex: 0,
    layout: createLeaf(ROOT_PANE_ID, ['s1'], 's1'),
    focusedPaneId: ROOT_PANE_ID,
    drawers: {},
    drawerTerminals: {},
    drawerDragSize: null,
    drawerClosePrompt: null,
  });
});

describe('terminal drawer toggle', () => {
  it('creates a focused drawer with one shell on first toggle', () => {
    useStore.getState().toggleTerminalDrawer('s1');
    expect(drawer()).toMatchObject({ open: true, hasFocus: true });
    const [id] = terminalIds();
    expect(id.startsWith('terminal:')).toBe(true);
    expect(drawer().focusedTerminalId).toBe(id);
    expect(useStore.getState().drawerTerminals[id]).toEqual({ id, ownerTabId: 's1', projectId: 1, title: 'Terminal' });
  });

  it('moves the keyboard into a visible drawer before hiding it', () => {
    useStore.getState().toggleTerminalDrawer('s1');
    useStore.getState().focusDrawerSession('s1');
    expect(drawer().hasFocus).toBe(false);

    useStore.getState().toggleTerminalDrawer('s1');
    expect(drawer()).toMatchObject({ open: true, hasFocus: true });

    useStore.getState().toggleTerminalDrawer('s1');
    expect(drawer()).toMatchObject({ open: false, hasFocus: false });
    expect(terminalIds()).toHaveLength(1);
  });

  it('reopens a hidden drawer with its terminals intact', () => {
    useStore.getState().toggleTerminalDrawer('s1');
    const [id] = terminalIds();
    useStore.getState().hideTerminalDrawer('s1');
    useStore.getState().toggleTerminalDrawer('s1');
    expect(drawer()).toMatchObject({ open: true, hasFocus: true, focusedTerminalId: id });
  });

  it('never hides the drawer through show', () => {
    useStore.getState().showTerminalDrawer('s1');
    useStore.getState().showTerminalDrawer('s1');
    expect(drawer()).toMatchObject({ open: true, hasFocus: true });
  });

  it('ignores tabs that are not sessions', () => {
    useStore.setState({ tabs: [{ kind: 'terminal', id: 't1', projectId: 1, title: 'T' }] });
    useStore.getState().toggleTerminalDrawer('t1');
    expect(useStore.getState().drawers).toEqual({});
  });

  it('pins a preview tab when it gets a drawer', () => {
    useStore.setState({ tabs: [session('s1', 1, { mode: 'history', preview: true })] });
    useStore.getState().toggleTerminalDrawer('s1');
    const tab = useStore.getState().tabs[0];
    expect(tab.kind === 'session' && tab.preview).toBe(false);
  });
});

describe('terminal drawer splits', () => {
  it('splits beside the focused terminal and focuses the new one', () => {
    useStore.getState().toggleTerminalDrawer('s1');
    const [first] = terminalIds();
    useStore.getState().splitDrawerTerminal('s1', 'row');
    const root = drawer().layout as PaneSplit;
    expect(root.kind).toBe('split');
    expect(root.dir).toBe('row');
    const [, second] = terminalIds();
    expect(terminalIds()).toEqual([first, second]);
    expect(drawer().focusedTerminalId).toBe(second);
    expect(useStore.getState().drawerTerminals[second].ownerTabId).toBe('s1');
  });

  it('nests a split of the other direction', () => {
    useStore.getState().toggleTerminalDrawer('s1');
    useStore.getState().splitDrawerTerminal('s1', 'row');
    useStore.getState().splitDrawerTerminal('s1', 'col');
    const root = drawer().layout as PaneSplit;
    expect(root.children[1].kind).toBe('split');
    expect(terminalIds()).toHaveLength(3);
  });

  it('moves focus to the neighbour in a direction', () => {
    useStore.getState().toggleTerminalDrawer('s1');
    useStore.getState().splitDrawerTerminal('s1', 'row');
    const [first, second] = terminalIds();
    useStore.getState().moveDrawerFocus('s1', 'left');
    expect(drawer().focusedTerminalId).toBe(first);
    useStore.getState().moveDrawerFocus('s1', 'left');
    expect(drawer().focusedTerminalId).toBe(first);
    useStore.getState().moveDrawerFocus('s1', 'right');
    expect(drawer().focusedTerminalId).toBe(second);
  });

  it('focuses a clicked terminal only when it belongs to the drawer', () => {
    useStore.getState().toggleTerminalDrawer('s1');
    useStore.getState().splitDrawerTerminal('s1', 'row');
    const [first] = terminalIds();
    useStore.getState().focusDrawerSession('s1');
    useStore.getState().focusDrawerTerminal('s1', first);
    expect(drawer()).toMatchObject({ hasFocus: true, focusedTerminalId: first });
    useStore.getState().focusDrawerTerminal('s1', 'terminal:foreign');
    expect(drawer().focusedTerminalId).toBe(first);
  });

  it('resizes a split inside the drawer', () => {
    useStore.getState().toggleTerminalDrawer('s1');
    useStore.getState().splitDrawerTerminal('s1', 'row');
    const splitId = (drawer().layout as PaneSplit).id;
    useStore.getState().resizeDrawerSplit('s1', splitId, [0.7, 0.3]);
    expect((drawer().layout as PaneSplit).sizes).toEqual([0.7, 0.3]);
  });
});

describe('closing drawer terminals', () => {
  it('focuses the neighbour when the focused terminal closes', () => {
    useStore.getState().toggleTerminalDrawer('s1');
    useStore.getState().splitDrawerTerminal('s1', 'row');
    const [first, second] = terminalIds();
    useStore.getState().closeDrawerTerminal(second);
    expect(terminalIds()).toEqual([first]);
    expect(drawer().layout.kind).toBe('leaf');
    expect(drawer().focusedTerminalId).toBe(first);
    expect(useStore.getState().drawerTerminals[second]).toBeUndefined();
  });

  it('removes the drawer with its last terminal', () => {
    useStore.getState().toggleTerminalDrawer('s1');
    const [id] = terminalIds();
    useStore.getState().closeDrawerTerminal(id);
    expect(useStore.getState().drawers).toEqual({});
    expect(useStore.getState().drawerTerminals).toEqual({});
  });

  it('clears a close prompt whose terminal is gone', () => {
    useStore.getState().toggleTerminalDrawer('s1');
    useStore.getState().splitDrawerTerminal('s1', 'row');
    const [first, second] = terminalIds();
    useStore.getState().requestCloseDrawerTerminal(second);
    useStore.getState().closeDrawerTerminal(first);
    expect(useStore.getState().drawerClosePrompt).toBe(second);
    useStore.getState().closeDrawerTerminal(second);
    expect(useStore.getState().drawerClosePrompt).toBeNull();
  });

  it('refuses a close prompt for an unknown terminal', () => {
    useStore.getState().requestCloseDrawerTerminal('terminal:none');
    expect(useStore.getState().drawerClosePrompt).toBeNull();
  });
});

describe('drawer size setting', () => {
  it('persists the drawer size with the other settings', () => {
    useStore.getState().setTerminalDrawerSize(0.5);
    const persisted = JSON.parse(localStorage.getItem('abeoncode.settings') ?? '{}');
    expect(persisted.terminalDrawerSize).toBe(0.5);
  });
});
