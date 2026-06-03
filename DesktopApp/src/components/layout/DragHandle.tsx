import { useCallback, useEffect, useRef } from 'react';

export function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

type DragHandleProps = {
  onDrag: (deltaX: number) => void;
  ariaLabel: string;
};

export function DragHandle({ onDrag, ariaLabel }: DragHandleProps) {
  const startX = useRef<number | null>(null);
  const onDragRef = useRef(onDrag);
  onDragRef.current = onDrag;
  const handlersRef = useRef<{ move: (e: MouseEvent) => void; up: () => void } | null>(null);

  const detach = useCallback(() => {
    if (handlersRef.current) {
      window.removeEventListener('mousemove', handlersRef.current.move);
      window.removeEventListener('mouseup', handlersRef.current.up);
      handlersRef.current = null;
    }
    startX.current = null;
  }, []);

  useEffect(() => detach, [detach]);

  const onMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    startX.current = e.clientX;
    const move = (ev: MouseEvent) => {
      if (startX.current === null) return;
      const delta = ev.clientX - startX.current;
      startX.current = ev.clientX;
      onDragRef.current(delta);
    };
    const up = () => detach();
    handlersRef.current = { move, up };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={ariaLabel}
      onMouseDown={onMouseDown}
      className="w-px cursor-col-resize bg-border hover:bg-accent transition-colors flex-shrink-0"
    />
  );
}
