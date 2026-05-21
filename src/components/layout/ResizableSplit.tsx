import { useCallback, useRef, type ReactNode } from "react";

type Props = {
  leftWidth: number;
  minLeft: number;
  maxLeft: number;
  left: ReactNode;
  right: ReactNode;
  onResize: (width: number) => void;
};

export function ResizableSplit({
  leftWidth,
  minLeft,
  maxLeft,
  left,
  right,
  onResize,
}: Props) {
  const dragging = useRef(false);
  const startX = useRef(0);
  const startWidth = useRef(0);

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      dragging.current = true;
      startX.current = e.clientX;
      startWidth.current = leftWidth;
      const onMove = (ev: MouseEvent) => {
        if (!dragging.current) return;
        const delta = ev.clientX - startX.current;
        const next = Math.max(
          minLeft,
          Math.min(maxLeft, startWidth.current + delta)
        );
        onResize(next);
      };
      const onUp = () => {
        dragging.current = false;
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [leftWidth, minLeft, maxLeft, onResize]
  );

  return (
    <div className="flex h-full w-full overflow-hidden">
      <div style={{ width: leftWidth, flexShrink: 0 }} className="h-full">
        {left}
      </div>
      <div
        onMouseDown={onMouseDown}
        className="w-px cursor-col-resize bg-border hover:bg-accent transition-colors"
        role="separator"
        aria-orientation="vertical"
      />
      <div className="flex-1 h-full min-w-0">{right}</div>
    </div>
  );
}
