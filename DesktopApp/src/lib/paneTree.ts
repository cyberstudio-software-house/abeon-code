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
