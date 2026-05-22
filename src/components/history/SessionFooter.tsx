import { useStore } from '../../store';
import { Icon } from '../shared/Icon';

type Props = { sessionId: string; tabId: string };

export function SessionFooter({ sessionId, tabId }: Props) {
  const setMode = useStore(s => s.setSessionMode);

  return (
    <div className="border-t border-border px-7 py-3.5 bg-bg-elev flex items-center gap-3 shrink-0">
      <div className="flex-1 text-[12px] text-fg-secondary">
        Kontynuacja podmieni historię na terminal:{' '}
        <span className="font-mono text-fg">claude --resume {sessionId.slice(0, 8)}</span>
      </div>
      <button className="border border-border bg-bg-elev px-3.5 py-2 text-[12px] text-fg-secondary hover:text-fg hover:bg-bg-elev-2 transition-colors">
        Wyeksportuj transkrypt
      </button>
      <button
        onClick={() => setMode(tabId, 'terminal')}
        className="inline-flex items-center gap-2 bg-fg text-bg px-4 py-2.5 text-[12px] font-medium hover:opacity-90 transition-opacity"
      >
        <Icon name="arrow" className="w-3 h-3" strokeWidth={2.5} />
        Kontynuuj w terminalu
      </button>
    </div>
  );
}
