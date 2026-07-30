import type { PaneDragState } from './usePaneDrag';

export function PaneDragOverlay({ drag }: { drag: PaneDragState | null }) {
  if (!drag) return null;
  const t = drag.target;
  const box = !t
    ? null
    : t.zone === 'center'
      ? t.rect
      : t.zone === 'left'
        ? { ...t.rect, width: t.rect.width / 2 }
        : t.zone === 'right'
          ? { ...t.rect, left: t.rect.left + t.rect.width / 2, width: t.rect.width / 2 }
          : t.zone === 'top'
            ? { ...t.rect, height: t.rect.height / 2 }
            : { ...t.rect, top: t.rect.top + t.rect.height / 2, height: t.rect.height / 2 };

  return (
    <div className="absolute inset-0 z-40">
      {box && (
        <div
          data-drop-preview
          className="absolute bg-accent/20 border-2 border-accent pointer-events-none"
          style={{ left: `${box.left}%`, top: `${box.top}%`, width: `${box.width}%`, height: `${box.height}%` }}
        />
      )}
    </div>
  );
}
