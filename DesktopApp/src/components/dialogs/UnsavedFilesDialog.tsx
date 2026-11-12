import { useEffect, useRef } from 'react';

type Props = {
  files: string[];
  onSave: () => void;
  onDiscard: () => void;
  onCancel: () => void;
  busy?: boolean;
  error?: string;
};

export function UnsavedFilesDialog({ files, onSave, onDiscard, onCancel, busy = false, error }: Props) {
  const saveRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!busy) saveRef.current?.focus();
  }, [busy]);
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      onCancel();
    };
    document.addEventListener('keydown', onKeyDown, { capture: true });
    return () => document.removeEventListener('keydown', onKeyDown, { capture: true });
  }, [onCancel]);
  return (
    <div className="dialog-backdrop">
      <div role="dialog" aria-modal="true" className="dialog-panel p-5 w-[440px]">
        <h2 className="text-[14px] font-semibold mb-2">Niezapisane zmiany</h2>
        <p className="text-[13px] text-fg-secondary mb-3">
          {files.length === 1 ? 'Ten plik ma niezapisane zmiany:' : 'Te pliki mają niezapisane zmiany:'}
        </p>
        <ul className="mb-4 max-h-56 overflow-auto border border-border">
          {files.map((file, index) => (
            <li
              key={`${index}:${file}`}
              className="px-3 py-1.5 text-[12px] text-fg truncate border-b border-border last:border-b-0"
              title={file}
            >
              {file}
            </li>
          ))}
        </ul>
        {error && <p role="alert" className="text-[12px] text-danger mb-3">{error}</p>}
        <div className="flex justify-end gap-2">
          <button onClick={onCancel} className="btn-secondary">Anuluj</button>
          <button onClick={onDiscard} disabled={busy} className="btn-danger">Odrzuć zmiany</button>
          <button ref={saveRef} onClick={onSave} disabled={busy} className="btn-primary">Zapisz</button>
        </div>
      </div>
    </div>
  );
}
