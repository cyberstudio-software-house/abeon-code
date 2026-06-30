import { useEffect, useState } from 'react';
import { useStore } from '../../store';
import { tauri } from '../../lib/tauri';
import type { ClickUpTaskRef } from '../../types/ClickUpTaskRef';
import { Icon } from '../shared/Icon';

export function LinkClickUpTaskDialog({ projectId, onClose }: { projectId: number; onClose: () => void }) {
  const linkTask = useStore(s => s.linkTask);
  const linked = useStore(s => s.linksByProject[projectId] ?? []);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<ClickUpTaskRef[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setResults([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      setBusy(true);
      setError(null);
      try {
        const found = await tauri.clickupSearchTasks(projectId, q);
        if (!cancelled) setResults(found);
      } catch (e) {
        if (!cancelled) {
          setResults([]);
          setError(String(e));
        }
      } finally {
        if (!cancelled) setBusy(false);
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, projectId]);

  const isLinked = (id: string) => linked.some(l => l.taskId === id);
  const onPick = async (id: string) => {
    await linkTask(projectId, id);
    onClose();
  };

  return (
    <div className="fixed inset-0 bg-black/50 grid place-items-center z-50" onClick={onClose}>
      <div
        className="bg-bg-elev border border-border w-[560px] max-h-[70vh] flex flex-col p-4"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-2.5 py-[7px] bg-bg border border-border rounded-md mb-3">
          <Icon name="search" className="w-[13px] h-[13px] text-muted" />
          <input
            autoFocus
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Szukaj po nazwie lub wklej ID/URL…"
            className="bg-transparent outline-none text-[12px] text-fg flex-1 placeholder:text-muted"
          />
        </div>
        {busy && <p className="text-[11px] text-muted px-2">Szukam…</p>}
        {error && <p className="text-[11px] text-danger px-2">{error}</p>}
        <div className="space-y-0.5 overflow-auto">
          {results.map(t => (
            <button
              key={t.id}
              disabled={isLinked(t.id)}
              onClick={() => onPick(t.id)}
              className="w-full text-left px-2 py-1 hover:bg-bg-elev-2 text-[11px] flex items-center gap-2 disabled:opacity-40"
            >
              <span className="text-muted font-mono">{t.customId ?? t.id.slice(0, 6)}</span>
              <span className="flex-1 truncate text-fg">{t.name}</span>
              {t.status && <span className="text-[10px] text-fg-secondary">{t.status}</span>}
              {isLinked(t.id) && <span className="text-[10px] text-fg-secondary">powiązane</span>}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
