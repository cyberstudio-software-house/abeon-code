import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../../store';
import { Icon } from '../shared/Icon';
import { PROVIDER_LABEL, PROVIDER_ICON } from '../../lib/providers';

export function ProviderPicker({ tabId }: { tabId: string }) {
  const enabled = useStore(useShallow(s => s.enabledProviders));
  const choose = useStore(s => s.chooseProvider);

  return (
    <div className="h-full grid place-items-center bg-bg">
      <div className="text-center">
        <div className="text-[13px] text-muted mb-4">Wybierz CLI dla nowej sesji</div>
        <div className="flex gap-3 justify-center">
          {enabled.map(p => (
            <button
              key={p}
              onClick={() => choose(tabId, p)}
              className="flex flex-col items-center gap-2 px-6 py-5 border border-border bg-bg-elev hover:border-accent transition-colors"
            >
              <Icon name={PROVIDER_ICON[p]} className="w-8 h-8" strokeWidth={1.5} />
              <span className="text-[12px] font-medium">{PROVIDER_LABEL[p]}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
