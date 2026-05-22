import { useStore } from '../../store';
import type { SessionMeta } from '../../types';

type Props = { meta: SessionMeta; tabId: string };

export function HistoryHeader({ meta, tabId }: Props) {
  const setMode = useStore(s => s.setSessionMode);
  return (
    <header className="flex items-center justify-between px-4 py-3 border-b border-border bg-bg">
      <div>
        <h2 className="text-sm font-semibold text-fg truncate">{meta.title}</h2>
        <div className="text-[11px] text-muted mt-0.5">
          {meta.messageCount} wiadomości · {meta.gitBranch ?? 'no branch'} · {new Date(meta.lastModified).toLocaleString('pl-PL')}
        </div>
      </div>
      <button
        onClick={() => setMode(tabId, 'terminal')}
        className="px-3 py-1.5 bg-accent text-accent-fg rounded text-xs font-semibold hover:opacity-90"
      >
        ▶ Kontynuuj sesję
      </button>
    </header>
  );
}
