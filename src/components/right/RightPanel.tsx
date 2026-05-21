export function RightPanel() {
  return (
    <aside className="h-full bg-bg-elev border-l border-border p-3 text-sm flex flex-col gap-3">
      <section className="flex-1 min-h-0">
        <div className="text-muted text-xs uppercase tracking-wide">Akcje</div>
        <div className="mt-2 text-muted">— brak projektu —</div>
      </section>
      <section className="flex-1 min-h-0">
        <div className="text-muted text-xs uppercase tracking-wide">Git</div>
        <div className="mt-2 text-muted">—</div>
      </section>
    </aside>
  );
}
