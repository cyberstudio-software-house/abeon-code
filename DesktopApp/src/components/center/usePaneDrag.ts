import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { useStore } from '../../store';
import {
  canSplit,
  computePaneRects,
  dropZone,
  hitTestPane,
  insertionIndex,
  TAB_BAR_HEIGHT,
  type DropZone,
  type PaneRect,
} from '../../lib/paneGeometry';
import { findLeaf, findLeafOfTab, type PaneNode } from '../../lib/paneTree';

const DRAG_THRESHOLD = 4;

export type PaneDragState = { tabId: string; target: { paneId: string; zone: DropZone; rect: PaneRect } | null };

// moveTab splices the tab in after pulling it out, so an index measured on the strip the user
// still sees is one too far right whenever the tab travels rightwards inside its own pane.
function postRemovalIndex(root: PaneNode, tabId: string, targetPaneId: string, measured: number): number {
  const source = findLeafOfTab(root, tabId);
  if (!source || source.id !== targetPaneId) return measured;
  const at = source.tabIds.indexOf(tabId);
  return at !== -1 && at < measured ? measured - 1 : measured;
}

export function usePaneDrag(containerRef: RefObject<HTMLDivElement | null>) {
  const [drag, setDrag] = useState<PaneDragState | null>(null);
  const handlersRef = useRef<{ move: (e: PointerEvent) => void; up: (e: PointerEvent) => void } | null>(null);

  const detach = useCallback(() => {
    const handlers = handlersRef.current;
    if (!handlers) return;
    window.removeEventListener('pointermove', handlers.move);
    window.removeEventListener('pointerup', handlers.up);
    handlersRef.current = null;
    setDrag(null);
  }, []);

  useEffect(() => detach, [detach]);

  const beginDrag = useCallback((tabId: string, e: React.PointerEvent) => {
    detach();
    if (e.button !== 0) return;
    const origin = { x: e.clientX, y: e.clientY };
    let started = false;

    const resolve = (ev: PointerEvent): PaneDragState['target'] => {
      const container = containerRef.current;
      if (!container) return null;
      const box = container.getBoundingClientRect();
      const rects = computePaneRects(useStore.getState().layout);
      const hit = hitTestPane(
        rects,
        { width: box.width, height: box.height },
        { x: ev.clientX - box.left, y: ev.clientY - box.top },
      );
      if (!hit) return null;
      const rect = rects.get(hit.paneId);
      if (!rect) return null;
      const overTabBar = hit.local.y <= TAB_BAR_HEIGHT;
      const zone: DropZone = overTabBar ? 'center' : dropZone(hit.local);
      if (zone !== 'center' && !canSplit(zone, { width: hit.local.width, height: hit.local.height })) return null;
      return { paneId: hit.paneId, zone, rect };
    };

    const move = (ev: PointerEvent) => {
      if (!started) {
        if (Math.abs(ev.clientX - origin.x) < DRAG_THRESHOLD && Math.abs(ev.clientY - origin.y) < DRAG_THRESHOLD) return;
        started = true;
      }
      setDrag({ tabId, target: resolve(ev) });
    };

    const up = (ev: PointerEvent) => {
      const dropped = started ? resolve(ev) : null;
      detach();
      if (!dropped) return;
      const state = useStore.getState();
      if (dropped.zone === 'center') {
        const leaf = findLeaf(state.layout, dropped.paneId);
        if (!leaf) return;
        const bar = containerRef.current?.querySelector(`[data-pane-id="${dropped.paneId}"]`);
        const tabRects = bar
          ? Array.from(bar.querySelectorAll('[data-tab-id]')).map(el => {
              const box = (el as HTMLElement).getBoundingClientRect();
              return { id: (el as HTMLElement).dataset.tabId ?? '', left: box.left, width: box.width };
            })
          : [];
        const measured = tabRects.length > 0 ? insertionIndex(tabRects, ev.clientX) : leaf.tabIds.length;
        state.moveTabToPane(tabId, dropped.paneId, postRemovalIndex(state.layout, tabId, dropped.paneId, measured));
        return;
      }
      const dir = dropped.zone === 'left' || dropped.zone === 'right' ? 'row' : 'col';
      const before = dropped.zone === 'left' || dropped.zone === 'top';
      state.splitPaneWithTab(dropped.paneId, dir, before, tabId);
    };

    handlersRef.current = { move, up };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }, [containerRef, detach]);

  return { drag, beginDrag };
}
