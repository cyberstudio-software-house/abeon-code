import { useCallback, useEffect, useRef, type RefObject } from 'react';
import { useStore } from '../../store';
import {
  clampSizes,
  computeSplitBoundaries,
  MIN_PANE_HEIGHT,
  MIN_PANE_WIDTH,
  TAB_BAR_HEIGHT,
  type SplitBoundary,
} from '../../lib/paneGeometry';
import type { PaneNode } from '../../lib/paneTree';

export function PaneResizers({ layout, containerRef }: { layout: PaneNode; containerRef: RefObject<HTMLDivElement | null> }) {
  const resizeSplit = useStore(s => s.resizeSplit);
  const boundaries = computeSplitBoundaries(layout);
  const handlersRef = useRef<{ move: (e: MouseEvent) => void; up: () => void } | null>(null);

  const detach = useCallback(() => {
    if (!handlersRef.current) return;
    window.removeEventListener('mousemove', handlersRef.current.move);
    window.removeEventListener('mouseup', handlersRef.current.up);
    handlersRef.current = null;
  }, []);

  useEffect(() => detach, [detach]);

  const startDrag = useCallback((e: React.MouseEvent, boundary: SplitBoundary) => {
    detach();
    e.preventDefault();
    const container = containerRef.current;
    if (!container) return;
    const box = container.getBoundingClientRect();
    const horizontal = boundary.dir === 'row';
    const totalPx = ((horizontal ? box.width : box.height) * boundary.extent) / 100;
    if (totalPx <= 0) return;
    const startPx = horizontal ? e.clientX : e.clientY;
    const startFraction = boundary.sizes[boundary.index];
    const minPx = horizontal ? MIN_PANE_WIDTH : MIN_PANE_HEIGHT + TAB_BAR_HEIGHT;

    const move = (ev: MouseEvent) => {
      const delta = (horizontal ? ev.clientX : ev.clientY) - startPx;
      const next = startFraction + delta / totalPx;
      resizeSplit(boundary.splitId, clampSizes(boundary.sizes, boundary.index, next, totalPx, minPx));
    };
    const up = () => detach();
    handlersRef.current = { move, up };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }, [containerRef, detach, resizeSplit]);

  return (
    <>
      {boundaries.map(b => (
        <div
          key={`${b.splitId}:${b.index}`}
          role="separator"
          aria-orientation={b.dir === 'row' ? 'vertical' : 'horizontal'}
          onMouseDown={e => startDrag(e, b)}
          className={`absolute z-30 bg-border hover:bg-accent transition-colors ${
            b.dir === 'row' ? 'cursor-col-resize -translate-x-1/2' : 'cursor-row-resize -translate-y-1/2'
          }`}
          style={
            b.dir === 'row'
              ? { left: `${b.left}%`, top: `${b.top}%`, width: 5, height: `${b.length}%` }
              : { left: `${b.left}%`, top: `${b.top}%`, width: `${b.length}%`, height: 5 }
          }
        />
      ))}
    </>
  );
}
