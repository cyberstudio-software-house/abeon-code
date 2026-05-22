import { useStore } from '../../store';
import type { SessionMeta } from '../../types';

type Props = { meta: SessionMeta; tabId: string };

export function HistoryHeader({ meta, tabId }: Props) {
  const setMode = useStore(s => s.setSessionMode);
  return (
    <header className="px-6 py-4 border-b border-border bg-bg">
      <div className="text-[10px] text-muted mb-1">
        sesja {meta.id} · {new Date(meta.lastModified).toLocaleString('pl-PL')}
      </div>
      <div className="flex items-center gap-3">
        <h2 className="text-[20px] font-medium text-fg">{meta.title}</h2>
        <span className="text-[10px] text-success">● aktywna</span>
      </div>
      <div className="flex items-center gap-2 mt-2 text-[11px] text-fg-secondary">
        <span>{meta.messageCount} tur</span>
        <span className="text-muted">·</span>
        <span>{meta.gitBranch ?? 'no branch'}</span>
      </div>
      <div className="flex items-center gap-2 mt-3">
        <button
          onClick={() => setMode(tabId, 'terminal')}
          className="px-3 py-1.5 bg-fg text-bg text-[12px] font-medium hover:opacity-90 flex items-center gap-1.5"
        >
          <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="9 18 15 12 9 6" />
            <line x1="15" y1="12" x2="15" y2="12" />
          </svg>
          Kontynuuj w terminalu
        </button>
        <button className="px-3 py-1.5 bg-bg-elev text-fg-secondary text-[12px] hover:text-fg">
          Wyeksportuj transkrypt
        </button>
      </div>
    </header>
  );
}
