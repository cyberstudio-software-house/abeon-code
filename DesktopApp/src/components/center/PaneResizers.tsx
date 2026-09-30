import { useCallback, useEffect, useRef, type RefObject } from 'react';
import { useStore } from '../../store';
import {
  clampSizes,
  computeSplitBoundaries,
  MIN_PANE_HEIGHT,
  MIN_PANE_WIDTH,
  tabBarHeight,
  type SplitBoundary,
} from '../../lib/paneGeometry';
import { cssLen, len, resolveLen, withinRect, type LenRect } from '../../lib/drawerGeometry';
import type { PaneNode } from '../../lib/paneTree';

const FULL_FRAME: LenRect = { left: len(0), top: len(0), width: len(100), height: len(100) };

type SplitResizersProps = {
  layout: PaneNode;
  containerRef: RefObject<HTMLDivElement | null>;
  frame: LenRect;
  minPx: (dir: 'row' | 'col') => number;
  onResize: (splitId: string, sizes: number[]) => void;
};

export function SplitResizers({ layout, containerRef, frame, minPx, onResize }: SplitResizersProps) {
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
    const framePx = horizontal ? resolveLen(frame.width, box.width) : resolveLen(frame.height, box.height);
    const totalPx = (framePx * boundary.extent) / 100;
    if (totalPx <= 0) return;
    const startPx = horizontal ? e.clientX : e.clientY;
    const startFraction = boundary.sizes[boundary.index];
    const min = minPx(boundary.dir);

    const move = (ev: MouseEvent) => {
      const delta = (horizontal ? ev.clientX : ev.clientY) - startPx;
      onResize(boundary.splitId, clampSizes(boundary.sizes, boundary.index, startFraction + delta / totalPx, totalPx, min));
    };
    const up = () => detach();
    handlersRef.current = { move, up };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }, [containerRef, detach, frame, minPx, onResize]);

  return (
    <>
      {boundaries.map(b => {
        const r = withinRect(frame, b.dir === 'row'
          ? { left: b.left, top: b.top, width: 0, height: b.length }
          : { left: b.left, top: b.top, width: b.length, height: 0 });
        return (
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
                ? { left: cssLen(r.left), top: cssLen(r.top), width: 5, height: cssLen(r.height) }
                : { left: cssLen(r.left), top: cssLen(r.top), width: cssLen(r.width), height: 5 }
            }
          />
        );
      })}
    </>
  );
}

export function PaneResizers({ layout, containerRef }: { layout: PaneNode; containerRef: RefObject<HTMLDivElement | null> }) {
  const resizeSplit = useStore(s => s.resizeSplit);
  const tabLayoutMode = useStore(s => s.tabLayoutMode);
  const minPx = useCallback(
    (dir: 'row' | 'col') => (dir === 'row' ? MIN_PANE_WIDTH : MIN_PANE_HEIGHT + tabBarHeight(tabLayoutMode)),
    [tabLayoutMode],
  );
  return <SplitResizers layout={layout} containerRef={containerRef} frame={FULL_FRAME} minPx={minPx} onResize={resizeSplit} />;
}
