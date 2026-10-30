import { useEffect, useRef } from 'react';
import { IconBtn } from '../shared/IconBtn';
import { Icon } from '../shared/Icon';

type Props = {
  query: string;
  onQueryChange: (q: string) => void;
  count: number;
  activeIndex: number;
  onNext: () => void;
  onPrev: () => void;
  onClose: () => void;
  hasOlderUnloaded: boolean;
};

export function HistorySearchBar({
  query, onQueryChange, count, activeIndex, onNext, onPrev, onClose, hasOlderUnloaded,
}: Props) {
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const counter = query.trim() === ''
    ? ''
    : count === 0
      ? '0 wyników'
      : `${activeIndex + 1} z ${count}`;

  return (
    <div className="flex shrink-0 flex-col gap-1 border-b border-border bg-console py-2 pl-7 pr-4">
      <div className="flex items-center gap-2">
        <Icon name="search" className="h-3.5 w-3.5 shrink-0 text-muted" />
        <input
          ref={inputRef}
          value={query}
          onChange={e => onQueryChange(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') { e.preventDefault(); e.shiftKey ? onPrev() : onNext(); }
            if (e.key === 'Escape') { e.preventDefault(); onClose(); }
          }}
          placeholder="Szukaj w sesji…"
          aria-label="Szukaj w sesji"
          className="h-[30px] min-w-0 flex-1 rounded-[7px] border border-border-strong bg-field px-2 text-[12.5px] text-fg outline-none placeholder:text-muted focus:border-border-focus"
        />
        <span className="min-w-[3ch] text-right font-mono text-[11.5px] tabular-nums text-muted">{counter}</span>
        <IconBtn icon="chevU" label="Poprzednie" tone="ghost" size="sm" onClick={onPrev} />
        <IconBtn icon="chevron" label="Następne" tone="ghost" size="sm" onClick={onNext} />
        <IconBtn icon="close" label="Zamknij" tone="ghost" size="sm" onClick={onClose} />
      </div>
      {hasOlderUnloaded && (
        <div className="font-mono text-[10px] text-muted">
          Uwaga: starsze wiadomości nie są wczytane i nie są przeszukiwane.
        </div>
      )}
    </div>
  );
}
