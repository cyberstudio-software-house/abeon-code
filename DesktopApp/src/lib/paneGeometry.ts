import type { PaneNode } from './paneTree';

export const TAB_BAR_HEIGHT = 32;
export const MIN_PANE_WIDTH = 240;
export const MIN_PANE_HEIGHT = 120;
const EDGE_BAND = 0.25;

export type PaneRect = { left: number; top: number; width: number; height: number };
export type DropZone = 'left' | 'right' | 'top' | 'bottom' | 'center';

export function computePaneRects(root: PaneNode): Map<string, PaneRect> {
  const out = new Map<string, PaneRect>();
  const walk = (node: PaneNode, rect: PaneRect) => {
    if (node.kind === 'leaf') {
      out.set(node.id, rect);
      return;
    }
    let offset = 0;
    node.children.forEach((child, i) => {
      const share = node.sizes[i];
      const next: PaneRect = node.dir === 'row'
        ? { left: rect.left + rect.width * offset, top: rect.top, width: rect.width * share, height: rect.height }
        : { left: rect.left, top: rect.top + rect.height * offset, width: rect.width, height: rect.height * share };
      walk(child, next);
      offset += share;
    });
  };
  walk(root, { left: 0, top: 0, width: 100, height: 100 });
  return out;
}

export function hitTestPane(
  rects: Map<string, PaneRect>,
  container: { width: number; height: number },
  point: { x: number; y: number },
): { paneId: string; local: { x: number; y: number; width: number; height: number } } | null {
  if (point.x < 0 || point.y < 0 || point.x > container.width || point.y > container.height) return null;
  for (const [paneId, rect] of rects) {
    const left = (rect.left / 100) * container.width;
    const top = (rect.top / 100) * container.height;
    const width = (rect.width / 100) * container.width;
    const height = (rect.height / 100) * container.height;
    if (point.x >= left && point.x <= left + width && point.y >= top && point.y <= top + height) {
      return { paneId, local: { x: point.x - left, y: point.y - top, width, height } };
    }
  }
  return null;
}

export function dropZone(local: { x: number; y: number; width: number; height: number }): DropZone {
  const ratios: Array<[DropZone, number]> = [
    ['left', local.x / local.width],
    ['right', 1 - local.x / local.width],
    ['top', local.y / local.height],
    ['bottom', 1 - local.y / local.height],
  ];
  const nearest = ratios.reduce((best, cur) => (cur[1] < best[1] ? cur : best));
  return nearest[1] < EDGE_BAND ? nearest[0] : 'center';
}

export function canSplit(zone: DropZone, size: { width: number; height: number }): boolean {
  if (zone === 'center') return true;
  if (zone === 'left' || zone === 'right') return size.width >= MIN_PANE_WIDTH * 2;
  return size.height >= (MIN_PANE_HEIGHT + TAB_BAR_HEIGHT) * 2;
}

export function insertionIndex(tabRects: Array<{ id: string; left: number; width: number }>, x: number): number {
  const at = tabRects.findIndex(r => x < r.left + r.width / 2);
  return at === -1 ? tabRects.length : at;
}

export function clampSizes(sizes: number[], index: number, next: number, totalPx: number, minPx: number): number[] {
  const pair = sizes[index] + sizes[index + 1];
  const min = minPx / totalPx;
  const clamped = Math.max(min, Math.min(pair - min, next));
  const out = [...sizes];
  out[index] = clamped;
  out[index + 1] = pair - clamped;
  return out;
}
