import type { StateCreator } from 'zustand';
import {
  collapseEmpty,
  createLeaf,
  findLeaf,
  findLeafOfTab,
  insertBeside,
  moveTab,
  removeTabFromLeaves,
  type PaneNode,
} from '../lib/paneTree';
import type { TabsSlice } from './tabsSlice';

export const ROOT_PANE_ID = 'root';

export type PanesSlice = {
  layout: PaneNode;
  focusedPaneId: string;
  focusPane: (paneId: string) => void;
  setPaneActiveTab: (paneId: string, tabId: string) => void;
  splitPaneWithTab: (targetPaneId: string, dir: 'row' | 'col', before: boolean, tabId: string) => void;
  moveTabToPane: (tabId: string, targetPaneId: string, index: number) => void;
  resizeSplit: (splitId: string, sizes: number[]) => void;
};

export function selectPaneOfTab(state: { layout: PaneNode }, tabId: string): string | null {
  return findLeafOfTab(state.layout, tabId)?.id ?? null;
}

function replaceSizes(node: PaneNode, splitId: string, sizes: number[]): PaneNode {
  if (node.kind === 'leaf') return node;
  if (node.id === splitId) return { ...node, sizes };
  const children = node.children.map(c => replaceSizes(c, splitId, sizes));
  return children.every((c, i) => c === node.children[i]) ? node : { ...node, children };
}

export const createPanesSlice: StateCreator<PanesSlice & TabsSlice, [], [], PanesSlice> = (set, get) => ({
  layout: createLeaf(ROOT_PANE_ID),
  focusedPaneId: ROOT_PANE_ID,
  focusPane: (paneId) => {
    const leaf = findLeaf(get().layout, paneId);
    if (!leaf) return;
    set({ focusedPaneId: paneId, ...(leaf.activeTabId ? { activeTabId: leaf.activeTabId } : {}) });
  },
  setPaneActiveTab: (paneId, tabId) => {
    set({ focusedPaneId: paneId });
    get().setActive(tabId);
  },
  splitPaneWithTab: (targetPaneId, dir, before, tabId) => {
    const source = findLeafOfTab(get().layout, tabId);
    if (!source) return;
    if (source.id === targetPaneId && source.tabIds.length < 2) return;
    const newPaneId = crypto.randomUUID();
    const stripped = removeTabFromLeaves(get().layout, tabId);
    const inserted = insertBeside(stripped, targetPaneId, dir, before, createLeaf(newPaneId, [tabId], tabId), crypto.randomUUID());
    const collapsed = collapseEmpty(inserted, newPaneId);
    set({ layout: collapsed.root, focusedPaneId: collapsed.focusedPaneId, activeTabId: tabId });
  },
  moveTabToPane: (tabId, targetPaneId, index) => {
    const source = findLeafOfTab(get().layout, tabId);
    if (!source) return;
    const moved = moveTab(get().layout, tabId, targetPaneId, index);
    const collapsed = collapseEmpty(moved, targetPaneId);
    set({ layout: collapsed.root, focusedPaneId: collapsed.focusedPaneId, activeTabId: tabId });
  },
  resizeSplit: (splitId, sizes) => {
    set({ layout: replaceSizes(get().layout, splitId, sizes) });
  },
});
