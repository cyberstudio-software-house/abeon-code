import { describe, it, expect } from 'vitest';
import { computePaneLayers } from './paneLayers';
import { lenRectStyle, paneContentRect } from './drawerGeometry';
import { createLeaf, type PaneNode } from './paneTree';
import type { Tab } from '../store/tabsSlice';
import type { DrawerTerminal, TerminalDrawer } from '../store/terminalDrawersSlice';

const s1: Tab = { kind: 'session', id: 'session:s1', projectId: 1, sessionId: 's1', title: 'S1', mode: 'terminal' };
const t0: Tab = { kind: 'terminal', id: 'terminal:0', projectId: 1, title: 'T0' };
const FULL = { left: 0, top: 0, width: 100, height: 100 };
const drawerTerminal = (id: string): DrawerTerminal => ({ id, ownerTabId: 'session:s1', projectId: 1, title: 'Terminal' });

function run(opts: { drawer?: Partial<TerminalDrawer>; layout?: PaneNode; focusedPaneId?: string; tabs?: Tab[] } = {}) {
  const drawer: TerminalDrawer | undefined = opts.drawer
    ? { open: true, hasFocus: true, focusRequest: 3, layout: createLeaf('terminal:d1', ['terminal:d1'], 'terminal:d1'), focusedTerminalId: 'terminal:d1', ...opts.drawer }
    : undefined;
  return computePaneLayers({
    tabs: opts.tabs ?? [s1],
    layout: opts.layout ?? createLeaf('root', (opts.tabs ?? [s1]).map(t => t.id), 'session:s1'),
    focusedPaneId: opts.focusedPaneId ?? 'root',
    barHeight: 32,
    drawers: drawer ? { 'session:s1': drawer } : {},
    drawerTerminals: drawer ? { 'terminal:d1': drawerTerminal('terminal:d1') } : {},
    drawerSize: 0.35,
  });
}

describe('computePaneLayers', () => {
  it('gives a tab without a drawer the whole pane content', () => {
    const { layers, visibleDrawers } = run();
    expect(layers).toHaveLength(1);
    expect(lenRectStyle(layers[0].rect)).toEqual(lenRectStyle(paneContentRect(FULL, 32)));
    expect(layers[0]).toMatchObject({ visible: true, focused: true, takeFocus: true, drawerOwnerId: null });
    expect(visibleDrawers).toEqual([]);
  });

  it('lets a focused drawer take the keyboard from its session', () => {
    const { layers, visibleDrawers } = run({ drawer: {} });
    const session = layers.find(l => l.tab.id === 'session:s1')!;
    const terminal = layers.find(l => l.tab.id === 'terminal:d1')!;
    expect(session).toMatchObject({ visible: true, focused: true, takeFocus: false });
    expect(terminal).toMatchObject({ visible: true, focused: true, takeFocus: true, drawerOwnerId: 'session:s1' });
    expect(terminal.tab).toEqual({ kind: 'terminal', id: 'terminal:d1', projectId: 1, title: 'Terminal' });
    expect(lenRectStyle(session.rect).height).toBe('calc(65% - 20.8px)');
    expect(visibleDrawers).toHaveLength(1);
  });

  it('hands the focus request only to the focused drawer terminal', () => {
    const { layers } = run({ drawer: {} });
    expect(layers.find(l => l.tab.id === 'terminal:d1')!.focusToken).toBe(3);
    expect(layers.find(l => l.tab.id === 'session:s1')!.focusToken).toBeUndefined();
    const unfocused = run({ drawer: { hasFocus: false } }).layers;
    expect(unfocused.every(l => l.focusToken === undefined)).toBe(true);
  });

  it('keeps the session keyboard while the drawer is open but unfocused', () => {
    const { layers } = run({ drawer: { hasFocus: false } });
    expect(layers.find(l => l.tab.id === 'session:s1')!.takeFocus).toBe(true);
    expect(layers.find(l => l.tab.id === 'terminal:d1')!).toMatchObject({ visible: true, focused: false });
  });

  it('hides the terminals of a hidden drawer and restores the full session', () => {
    const { layers, visibleDrawers } = run({ drawer: { open: false, hasFocus: false } });
    const session = layers.find(l => l.tab.id === 'session:s1')!;
    expect(lenRectStyle(session.rect)).toEqual(lenRectStyle(paneContentRect(FULL, 32)));
    expect(layers.find(l => l.tab.id === 'terminal:d1')!.visible).toBe(false);
    expect(visibleDrawers).toEqual([]);
  });

  it('hides the drawer of a session that is not the active tab of its pane', () => {
    const { layers, visibleDrawers } = run({
      drawer: {},
      tabs: [s1, t0],
      layout: createLeaf('root', ['session:s1', 'terminal:0'], 'terminal:0'),
    });
    expect(layers.find(l => l.tab.id === 'terminal:d1')!.visible).toBe(false);
    expect(visibleDrawers).toEqual([]);
  });

  it('never focuses a drawer terminal in an unfocused pane', () => {
    const { layers } = run({ drawer: {}, focusedPaneId: 'elsewhere' });
    expect(layers.find(l => l.tab.id === 'terminal:d1')!).toMatchObject({ visible: true, focused: false, takeFocus: false });
  });

  it('sorts layers by id', () => {
    const { layers } = run({ drawer: {}, tabs: [t0, s1], layout: createLeaf('root', ['terminal:0', 'session:s1'], 'session:s1') });
    expect(layers.map(l => l.tab.id)).toEqual(['session:s1', 'terminal:0', 'terminal:d1']);
  });

  it('skips tabs that are not placed in any pane', () => {
    const { layers } = run({ drawer: {}, layout: createLeaf('root') });
    expect(layers).toEqual([]);
  });
});
