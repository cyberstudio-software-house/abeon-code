export type PaneLeaf = { kind: 'leaf'; id: string; tabIds: string[]; activeTabId: string | null };
export type PaneSplit = { kind: 'split'; id: string; dir: 'row' | 'col'; sizes: number[]; children: PaneNode[] };
export type PaneNode = PaneLeaf | PaneSplit;

export function createLeaf(id: string, tabIds: string[] = [], activeTabId: string | null = null): PaneLeaf {
  return { kind: 'leaf', id, tabIds, activeTabId };
}

export function leaves(node: PaneNode): PaneLeaf[] {
  if (node.kind === 'leaf') return [node];
  return node.children.flatMap(leaves);
}

export function findLeaf(node: PaneNode, paneId: string): PaneLeaf | null {
  return leaves(node).find(l => l.id === paneId) ?? null;
}

export function findLeafOfTab(node: PaneNode, tabId: string): PaneLeaf | null {
  return leaves(node).find(l => l.tabIds.includes(tabId)) ?? null;
}

export function mapLeaves(node: PaneNode, fn: (leaf: PaneLeaf) => PaneLeaf): PaneNode {
  if (node.kind === 'leaf') return fn(node);
  const children = node.children.map(child => mapLeaves(child, fn));
  return children.every((child, i) => child === node.children[i]) ? node : { ...node, children };
}

function pickActive(tabIds: string[], current: string | null): string | null {
  if (current && tabIds.includes(current)) return current;
  return tabIds[tabIds.length - 1] ?? null;
}

export function removeTabFromLeaves(root: PaneNode, tabId: string): PaneNode {
  return mapLeaves(root, leaf => {
    if (!leaf.tabIds.includes(tabId)) return leaf;
    const tabIds = leaf.tabIds.filter(id => id !== tabId);
    return { ...leaf, tabIds, activeTabId: pickActive(tabIds, leaf.activeTabId) };
  });
}

export function insertBeside(
  root: PaneNode,
  targetPaneId: string,
  dir: 'row' | 'col',
  before: boolean,
  newLeaf: PaneLeaf,
  splitId: string,
): PaneNode {
  if (root.kind === 'split') {
    const idx = root.children.findIndex(c => c.kind === 'leaf' && c.id === targetPaneId);
    if (idx !== -1 && root.dir === dir) {
      const half = root.sizes[idx] / 2;
      const sizes = [...root.sizes];
      sizes[idx] = half;
      sizes.splice(before ? idx : idx + 1, 0, half);
      const children = [...root.children];
      children.splice(before ? idx : idx + 1, 0, newLeaf);
      return { ...root, sizes, children };
    }
    const children = root.children.map(c => insertBeside(c, targetPaneId, dir, before, newLeaf, splitId));
    return children.every((c, i) => c === root.children[i]) ? root : { ...root, children };
  }
  if (root.id !== targetPaneId) return root;
  return {
    kind: 'split',
    id: splitId,
    dir,
    sizes: [0.5, 0.5],
    children: before ? [newLeaf, root] : [root, newLeaf],
  };
}

export function moveTab(root: PaneNode, tabId: string, targetPaneId: string, index: number): PaneNode {
  if (!findLeaf(root, targetPaneId)) return root;
  const stripped = removeTabFromLeaves(root, tabId);
  return mapLeaves(stripped, leaf => {
    if (leaf.id !== targetPaneId) return leaf;
    const tabIds = [...leaf.tabIds];
    tabIds.splice(Math.max(0, Math.min(index, tabIds.length)), 0, tabId);
    return { ...leaf, tabIds, activeTabId: tabId };
  });
}

export function collapseEmpty(root: PaneNode, focusedPaneId: string): { root: PaneNode; focusedPaneId: string } {
  const removed: string[] = [];

  const walk = (node: PaneNode): PaneNode | null => {
    if (node.kind === 'leaf') {
      if (node.tabIds.length > 0) return node;
      removed.push(node.id);
      return null;
    }
    const kept: PaneNode[] = [];
    const sizes: number[] = [];
    node.children.forEach((child, i) => {
      const next = walk(child);
      if (next === null) return;
      kept.push(next);
      sizes.push(node.sizes[i]);
    });
    if (kept.length === 0) return null;
    if (kept.length === 1) return kept[0];
    const total = sizes.reduce((a, b) => a + b, 0);
    const normalized = sizes.map(s => s / total);
    const unchanged = kept.length === node.children.length && kept.every((c, i) => c === node.children[i]);
    return unchanged ? node : { ...node, children: kept, sizes: normalized };
  };

  const next = walk(root);
  if (next === null) {
    const empty = leaves(root)[0] ?? createLeaf(focusedPaneId);
    return { root: empty, focusedPaneId: empty.id };
  }
  if (!removed.includes(focusedPaneId)) return { root: next, focusedPaneId };

  const order = leaves(root).map(l => l.id);
  const survivors = new Set(leaves(next).map(l => l.id));
  const at = order.indexOf(focusedPaneId);
  for (let i = at - 1; i >= 0; i--) if (survivors.has(order[i])) return { root: next, focusedPaneId: order[i] };
  for (let i = at + 1; i < order.length; i++) if (survivors.has(order[i])) return { root: next, focusedPaneId: order[i] };
  return { root: next, focusedPaneId: leaves(next)[0].id };
}

export type PanesSnapshot = { layout: PaneNode; activeTabId: string | null; focusedPaneId: string };

export function reconcilePanes(
  input: PanesSnapshot & { tabIds: string[]; prevActiveTabId: string | null },
): PanesSnapshot {
  const known = new Set(input.tabIds);
  let layout = mapLeaves(input.layout, leaf => {
    const tabIds = leaf.tabIds.filter(id => known.has(id));
    return tabIds.length === leaf.tabIds.length ? leaf : { ...leaf, tabIds };
  });

  const placed = new Set(leaves(layout).flatMap(l => l.tabIds));
  const missing = input.tabIds.filter(id => !placed.has(id));
  if (missing.length > 0) {
    const host = findLeaf(layout, input.focusedPaneId) ? input.focusedPaneId : leaves(layout)[0].id;
    layout = mapLeaves(layout, leaf =>
      leaf.id === host ? { ...leaf, tabIds: [...leaf.tabIds, ...missing] } : leaf,
    );
  }

  const collapsed = collapseEmpty(layout, input.focusedPaneId);
  layout = collapsed.root;
  let focusedPaneId = collapsed.focusedPaneId;

  let activeTabId = input.activeTabId;
  if (activeTabId !== input.prevActiveTabId) {
    const owner = activeTabId ? findLeafOfTab(layout, activeTabId) : null;
    if (owner) focusedPaneId = owner.id;
  }

  layout = mapLeaves(layout, leaf => {
    const next = activeTabId && leaf.tabIds.includes(activeTabId)
      ? activeTabId
      : pickActive(leaf.tabIds, leaf.activeTabId);
    return next === leaf.activeTabId ? leaf : { ...leaf, activeTabId: next };
  });

  const focused = findLeaf(layout, focusedPaneId);
  if (focused && focused.activeTabId !== activeTabId) activeTabId = focused.activeTabId;

  return { layout, activeTabId, focusedPaneId };
}
