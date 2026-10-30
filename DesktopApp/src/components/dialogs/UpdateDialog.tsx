type Props = {
  version: string;
  notes: string;
  busy: boolean;
  progress: number | null;
  onUpdate: () => void;
  onLater: () => void;
};

export function UpdateDialog({ version, notes, busy, progress, onUpdate, onLater }: Props) {
  const percent = progress != null ? Math.round(progress * 100) : null;
  return (
    <div className="dialog-backdrop">
      <div role="dialog" aria-modal="true" className="dialog-panel p-5 w-[420px]">
        <h2 className="text-[14px] font-semibold mb-2">Dostępna aktualizacja</h2>
        <p className="text-[13px] text-fg-secondary mb-2">
          Nowa wersja <span className="text-fg font-medium">{version}</span> jest gotowa do instalacji.
        </p>
        {notes && (
          <pre className="text-[12px] text-fg-secondary mb-4 max-h-40 overflow-auto whitespace-pre-wrap">{notes}</pre>
        )}
        {busy && percent != null && (
          <div className="mb-4">
            <div className="h-1 rounded-full bg-track">
              <div className="h-1 rounded-full bg-accent" style={{ width: `${percent}%` }} />
            </div>
            <p className="text-[11px] text-fg-secondary mt-1">{percent}%</p>
          </div>
        )}
        <div className="flex justify-end gap-2">
          <button onClick={onLater} disabled={busy}
            className="btn-secondary">
            Później
          </button>
          <button onClick={onUpdate} disabled={busy}
            className="btn-primary">
            {busy ? 'Pobieranie…' : 'Zaktualizuj'}
          </button>
        </div>
      </div>
    </div>
  );
}
