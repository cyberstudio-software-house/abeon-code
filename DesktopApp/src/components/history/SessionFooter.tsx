import { useStore } from '../../store';
import { Icon } from '../shared/Icon';

type Props = { sessionId: string; tabId: string };

export function SessionFooter({ sessionId, tabId }: Props) {
  const setMode = useStore(s => s.setSessionMode);

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2.5 border-t border-border bg-console py-3 pl-7 pr-3.5">
      <span className="min-w-0 flex-[1_1_260px] text-[12.5px] text-muted">
        Kontynuacja zamieni historię na terminal:{' '}
        <span className="font-mono text-[12px] text-fg-secondary">claude --resume {sessionId.slice(0, 8)}</span>
      </span>
      <button
        type="button"
        className="h-8 rounded-[8px] border border-border-strong bg-button px-3 text-[12.5px] text-fg transition-colors hover:bg-raised-strong"
      >
        Eksportuj transkrypt
      </button>
      <button
        type="button"
        onClick={() => setMode(tabId, 'terminal')}
        className="inline-flex h-8 items-center gap-2 rounded-[8px] bg-accent px-3.5 text-[12.5px] font-semibold text-accent-fg transition-colors hover:bg-accent-hover"
      >
        <Icon name="arrow" className="h-[13px] w-[13px]" strokeWidth={1.8} />
        Kontynuuj w terminalu
      </button>
    </div>
  );
}
