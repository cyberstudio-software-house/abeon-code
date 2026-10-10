import { computePaneRects } from './paneGeometry';
import {
  computeCollapsedDrawerLayout,
  computeDrawerLayout,
  paneContentRect,
  type DrawerLayoutRects,
  type LenRect,
} from './drawerGeometry';
import { leaves, type PaneNode } from './paneTree';
import type { Tab } from '../store/tabsSlice';
import { toTerminalTab, type DrawerTerminal, type TerminalDrawer } from '../store/terminalDrawersSlice';

export type PaneLayer = {
  tab: Tab;
  paneId: string;
  rect: LenRect;
  visible: boolean;
  focused: boolean;
  takeFocus: boolean;
  drawerOwnerId: string | null;
  focusToken: number | undefined;
};

export type VisibleDrawer = {
  ownerTabId: string;
  paneId: string;
  rects: DrawerLayoutRects;
  drawer: TerminalDrawer;
};

export type CollapsedDrawer = {
  ownerTabId: string;
  paneId: string;
  rect: LenRect;
  terminalCount: number;
};

export function computePaneLayers(input: {
  tabs: Tab[];
  layout: PaneNode;
  focusedPaneId: string;
  barHeight: number;
  drawers: Record<string, TerminalDrawer>;
  drawerTerminals: Record<string, DrawerTerminal>;
  drawerSize: number;
}): { layers: PaneLayer[]; visibleDrawers: VisibleDrawer[]; collapsedDrawers: CollapsedDrawer[] } {
  const rects = computePaneRects(input.layout);
  const owners = new Map<string, { paneId: string; active: boolean }>();
  for (const pane of leaves(input.layout)) {
    for (const tabId of pane.tabIds) owners.set(tabId, { paneId: pane.id, active: pane.activeTabId === tabId });
  }

  const layers: PaneLayer[] = [];
  const visibleDrawers: VisibleDrawer[] = [];
  const collapsedDrawers: CollapsedDrawer[] = [];
  for (const tab of input.tabs) {
    const owner = owners.get(tab.id);
    const paneRect = owner ? rects.get(owner.paneId) : undefined;
    if (!owner || !paneRect) continue;
    const paneFocused = owner.paneId === input.focusedPaneId;
    const content = paneContentRect(paneRect, input.barHeight);
    const drawer = tab.kind === 'session' ? input.drawers[tab.id] : undefined;
    if (!drawer) {
      layers.push({ tab, paneId: owner.paneId, rect: content, visible: owner.active, focused: paneFocused, takeFocus: paneFocused, drawerOwnerId: null, focusToken: undefined });
      continue;
    }
    const drawerRects = computeDrawerLayout(paneRect, input.barHeight, input.drawerSize, drawer.layout);
    const collapsedRects = computeCollapsedDrawerLayout(content);
    const drawerShown = owner.active && drawer.open;
    layers.push({
      tab,
      paneId: owner.paneId,
      rect: drawer.open ? drawerRects.session : collapsedRects.session,
      visible: owner.active,
      focused: paneFocused,
      takeFocus: paneFocused && !(drawer.open && drawer.hasFocus),
      drawerOwnerId: null,
      focusToken: undefined,
    });
    for (const [terminalId, rect] of drawerRects.terminals) {
      const terminal = input.drawerTerminals[terminalId];
      if (!terminal) continue;
      const focused = drawerShown && paneFocused && drawer.hasFocus && drawer.focusedTerminalId === terminalId;
      layers.push({ tab: toTerminalTab(terminal), paneId: owner.paneId, rect, visible: drawerShown, focused, takeFocus: focused, drawerOwnerId: tab.id, focusToken: focused ? drawer.focusRequest : undefined });
    }
    if (drawerShown) visibleDrawers.push({ ownerTabId: tab.id, paneId: owner.paneId, rects: drawerRects, drawer });
    else if (owner.active) {
      collapsedDrawers.push({ ownerTabId: tab.id, paneId: owner.paneId, rect: collapsedRects.bar, terminalCount: drawerRects.terminals.size });
    }
  }
  layers.sort((a, b) => (a.tab.id < b.tab.id ? -1 : a.tab.id > b.tab.id ? 1 : 0));
  return { layers, visibleDrawers, collapsedDrawers };
}
