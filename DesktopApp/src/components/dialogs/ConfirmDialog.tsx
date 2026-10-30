import { useEffect, useRef } from 'react';

type Props = { title: string; message: string; confirmLabel?: string; onConfirm: () => void; onCancel: () => void };
export function ConfirmDialog({ title, message, confirmLabel = 'Zamknij', onConfirm, onCancel }: Props) {
  const confirmRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    confirmRef.current?.focus();
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
    };
    document.addEventListener('keydown', onKeyDown, { capture: true });
    return () => document.removeEventListener('keydown', onKeyDown, { capture: true });
  }, [onCancel]);
  return (
    <div className="dialog-backdrop">
      <div role="dialog" aria-modal="true" className="dialog-panel p-5 w-[400px]">
        <h2 className="text-[14px] font-semibold mb-2">{title}</h2>
        <p className="text-[13px] text-fg-secondary mb-4">{message}</p>
        <div className="flex justify-end gap-2">
          <button onClick={onCancel} className="btn-secondary">Anuluj</button>
          <button ref={confirmRef} onClick={onConfirm} className="btn-danger">{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}
