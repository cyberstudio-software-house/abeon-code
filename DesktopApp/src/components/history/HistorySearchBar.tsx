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
      : `${activeIndex + 1}/${count}`;

  return (
    <div className="shrink-0 border-b border-border bg-bg-elev px-8 py-2 flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <div className="flex items-center gap-2 flex-1 bg-bg border border-border rounded-md px-2.5 py-[6px]">
          <Icon name="search" className="w-[13px] h-[13px] text-muted" />
          <input
            ref={inputRef}
            value={query}
            onChange={e => onQueryChange(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') { e.preventDefault(); e.shiftKey ? onPrev() : onNext(); }
              if (e.key === 'Escape') { e.preventDefault(); onClose(); }
            }}
            placeholder="Szukaj w sesji…"
            className="bg-transparent outline-none text-[12px] text-fg flex-1 placeholder:text-muted"
          />
          <span className="text-[11px] text-muted font-mono tabular-nums min-w-[3ch] text-right">{counter}</span>
        </div>
        <IconBtn icon="chevU" label="Poprzednie" tone="ghost" size="sm" onClick={onPrev} />
        <IconBtn icon="chevron" label="Następne" tone="ghost" size="sm" onClick={onNext} />
        <IconBtn icon="close" label="Zamknij" tone="ghost" size="sm" onClick={onClose} />
      </div>
      {hasOlderUnloaded && (
        <div className="text-[10px] text-muted font-mono">
          Uwaga: starsze wiadomości nie są wczytane i nie są przeszukiwane.
        </div>
      )}
    </div>
  );
}
