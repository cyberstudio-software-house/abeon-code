import type { StateCreator } from 'zustand';
import {
  collapseEmpty,
  createLeaf,
  insertBeside,
  leaves,
  removeTabFromLeaves,
  replaceSplitSizes,
  type PaneNode,
} from '../lib/paneTree';
import { neighborInDirection, type Direction } from '../lib/drawerGeometry';
import type { Tab } from './tabsSlice';
import type { AppState } from './index';

export type DrawerTerminal = { id: string; ownerTabId: string; projectId: number; title: string };

export type TerminalDrawer = {
  open: boolean;
  hasFocus: boolean;
  layout: PaneNode;
  focusedTerminalId: string;
};

export type TerminalDrawersSlice = {
  drawers: Record<string, TerminalDrawer>;
  drawerTerminals: Record<string, DrawerTerminal>;
  drawerDragSize: number | null;
  drawerClosePrompt: string | null;
  toggleTerminalDrawer: (tabId: string) => void;
  showTerminalDrawer: (tabId: string) => void;
  hideTerminalDrawer: (tabId: string) => void;
  splitDrawerTerminal: (tabId: string, dir: 'row' | 'col') => void;
  focusDrawerTerminal: (tabId: string, terminalId: string) => void;
  focusDrawerSession: (tabId: string) => void;
  moveDrawerFocus: (tabId: string, dir: Direction) => void;
  closeDrawerTerminal: (terminalId: string) => void;
  requestCloseDrawerTerminal: (terminalId: string) => void;
  cancelCloseDrawerTerminal: () => void;
  resizeDrawerSplit: (tabId: string, splitId: string, sizes: number[]) => void;
  setDrawerDragSize: (size: number | null) => void;
};

const DRAWER_TERMINAL_TITLE = 'Terminal';

const newTerminalId = () => `terminal:${crypto.randomUUID()}`;
const terminalLeaf = (id: string) => createLeaf(id, [id], id);

export const toTerminalTab = (terminal: DrawerTerminal): Extract<Tab, { kind: 'terminal' }> => ({
  kind: 'terminal',
  id: terminal.id,
  projectId: terminal.projectId,
  title: terminal.title,
});

export function countDrawerTerminals(state: Pick<TerminalDrawersSlice, 'drawerTerminals'>, ownerTabId: string): number {
  return Object.values(state.drawerTerminals).filter(t => t.ownerTabId === ownerTabId).length;
}

type DrawerMaps = Pick<TerminalDrawersSlice, 'drawers' | 'drawerTerminals'>;

export function withoutDrawerTerminal(maps: DrawerMaps, terminalId: string): DrawerMaps | null {
  const terminal = maps.drawerTerminals[terminalId];
  if (!terminal) return null;
  const { [terminalId]: _removed, ...drawerTerminals } = maps.drawerTerminals;
  const drawer = maps.drawers[terminal.ownerTabId];
  if (!drawer) return { drawers: maps.drawers, drawerTerminals };
  const stripped = removeTabFromLeaves(drawer.layout, terminalId);
  if (leaves(stripped).every(leaf => leaf.tabIds.length === 0)) {
    const { [terminal.ownerTabId]: _closed, ...drawers } = maps.drawers;
    return { drawers, drawerTerminals };
  }
  const collapsed = collapseEmpty(stripped, drawer.focusedTerminalId);
  return {
    drawers: {
      ...maps.drawers,
      [terminal.ownerTabId]: { ...drawer, layout: collapsed.root, focusedTerminalId: collapsed.focusedPaneId },
    },
    drawerTerminals,
  };
}

export const createTerminalDrawersSlice: StateCreator<AppState, [], [], TerminalDrawersSlice> = (set, get) => {
  const patchDrawer = (tabId: string, patch: Partial<TerminalDrawer>) => {
    const drawer = get().drawers[tabId];
    if (!drawer) return;
    set({ drawers: { ...get().drawers, [tabId]: { ...drawer, ...patch } } });
  };

  const reveal = (tabId: string, hideWhenFocused: boolean) => {
    const drawer = get().drawers[tabId];
    if (drawer) {
      if (!drawer.open || !drawer.hasFocus) patchDrawer(tabId, { open: true, hasFocus: true });
      else if (hideWhenFocused) patchDrawer(tabId, { open: false, hasFocus: false });
      return;
    }
    const owner = get().tabs.find(t => t.id === tabId);
    if (!owner || owner.kind !== 'session') return;
    const id = newTerminalId();
    set({
      drawers: {
        ...get().drawers,
        [tabId]: { open: true, hasFocus: true, layout: terminalLeaf(id), focusedTerminalId: id },
      },
      drawerTerminals: {
        ...get().drawerTerminals,
        [id]: { id, ownerTabId: tabId, projectId: owner.projectId, title: DRAWER_TERMINAL_TITLE },
      },
      tabs: owner.preview ? get().tabs.map(t => (t.id === tabId ? { ...owner, preview: false } : t)) : get().tabs,
    });
  };

  return {
    drawers: {},
    drawerTerminals: {},
    drawerDragSize: null,
    drawerClosePrompt: null,
    toggleTerminalDrawer: (tabId) => reveal(tabId, true),
    showTerminalDrawer: (tabId) => reveal(tabId, false),
    hideTerminalDrawer: (tabId) => patchDrawer(tabId, { open: false, hasFocus: false }),
    splitDrawerTerminal: (tabId, dir) => {
      const drawer = get().drawers[tabId];
      const owner = get().tabs.find(t => t.id === tabId);
      if (!drawer || !owner) return;
      const id = newTerminalId();
      set({
        drawers: {
          ...get().drawers,
          [tabId]: {
            open: true,
            hasFocus: true,
            focusedTerminalId: id,
            layout: insertBeside(drawer.layout, drawer.focusedTerminalId, dir, false, terminalLeaf(id), crypto.randomUUID()),
          },
        },
        drawerTerminals: {
          ...get().drawerTerminals,
          [id]: { id, ownerTabId: tabId, projectId: owner.projectId, title: DRAWER_TERMINAL_TITLE },
        },
      });
    },
    focusDrawerTerminal: (tabId, terminalId) => {
      const drawer = get().drawers[tabId];
      if (!drawer || get().drawerTerminals[terminalId]?.ownerTabId !== tabId) return;
      if (drawer.hasFocus && drawer.focusedTerminalId === terminalId) return;
      patchDrawer(tabId, { hasFocus: true, focusedTerminalId: terminalId });
    },
    focusDrawerSession: (tabId) => {
      if (get().drawers[tabId]?.hasFocus) patchDrawer(tabId, { hasFocus: false });
    },
    moveDrawerFocus: (tabId, dir) => {
      const drawer = get().drawers[tabId];
      if (!drawer) return;
      const next = neighborInDirection(drawer.layout, drawer.focusedTerminalId, dir);
      if (next) patchDrawer(tabId, { hasFocus: true, focusedTerminalId: next });
    },
    closeDrawerTerminal: (terminalId) => {
      const next = withoutDrawerTerminal(get(), terminalId);
      if (!next) return;
      const prompt = get().drawerClosePrompt;
      set({ ...next, drawerClosePrompt: prompt === terminalId ? null : prompt });
    },
    requestCloseDrawerTerminal: (terminalId) => {
      if (get().drawerTerminals[terminalId]) set({ drawerClosePrompt: terminalId });
    },
    cancelCloseDrawerTerminal: () => set({ drawerClosePrompt: null }),
    resizeDrawerSplit: (tabId, splitId, sizes) => {
      const drawer = get().drawers[tabId];
      if (drawer) patchDrawer(tabId, { layout: replaceSplitSizes(drawer.layout, splitId, sizes) });
    },
    setDrawerDragSize: (drawerDragSize) => set({ drawerDragSize }),
  };
};
