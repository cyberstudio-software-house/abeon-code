import { useEffect, useRef } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../../store';
import { Icon } from '../shared/Icon';
import { Kbd } from '../shared/Kbd';
import { PROVIDER_LABEL, PROVIDER_ICON } from '../../lib/providers';

export function ProviderPicker({ tabId, active = true }: { tabId: string; active?: boolean }) {
  const enabled = useStore(useShallow(s => s.enabledProviders));
  const choose = useStore(s => s.chooseProvider);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (active) rootRef.current?.focus();
  }, [active]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey || !/^[1-9]$/.test(e.key)) return;
    const provider = enabled[Number(e.key) - 1];
    if (!provider) return;
    e.preventDefault();
    e.stopPropagation();
    choose(tabId, provider);
  };

  return (
    <div ref={rootRef} tabIndex={-1} onKeyDown={onKeyDown} className="h-full grid place-items-center bg-bg outline-none">
      <div className="text-center">
        <div className="text-[13px] text-muted mb-4">Wybierz CLI dla nowej sesji</div>
        <div className="flex gap-3 justify-center">
          {enabled.map((p, i) => (
            <button
              key={p}
              onClick={() => choose(tabId, p)}
              className="relative flex flex-col items-center gap-2 px-6 py-5 border border-border bg-bg-elev hover:border-accent transition-colors"
            >
              {i < 9 && (
                <span className="absolute top-1.5 left-1.5">
                  <Kbd>{i + 1}</Kbd>
                </span>
              )}
              <Icon name={PROVIDER_ICON[p]} className="w-8 h-8" strokeWidth={1.5} />
              <span className="text-[12px] font-medium">{PROVIDER_LABEL[p]}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
