import { useCallback, useEffect, useRef, type ReactNode } from "react";

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
  const handlersRef = useRef<{
    move: (e: MouseEvent) => void;
    up: () => void;
  } | null>(null);

  const detach = useCallback(() => {
    if (handlersRef.current) {
      window.removeEventListener("mousemove", handlersRef.current.move);
      window.removeEventListener("mouseup", handlersRef.current.up);
      handlersRef.current = null;
    }
    dragging.current = false;
  }, []);

  useEffect(() => detach, [detach]);

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      dragging.current = true;
      startX.current = e.clientX;
      startWidth.current = leftWidth;
      const move = (ev: MouseEvent) => {
        if (!dragging.current) return;
        const delta = ev.clientX - startX.current;
        const next = Math.max(
          minLeft,
          Math.min(maxLeft, startWidth.current + delta)
        );
        onResize(next);
      };
      const up = () => detach();
      handlersRef.current = { move, up };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    },
    [leftWidth, minLeft, maxLeft, onResize, detach]
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
        aria-valuenow={leftWidth}
        aria-valuemin={minLeft}
        aria-valuemax={maxLeft}
      />
      <div className="flex-1 h-full min-w-0">{right}</div>
    </div>
  );
}
