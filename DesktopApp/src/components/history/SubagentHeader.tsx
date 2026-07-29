import { Icon } from '../shared/Icon';

type Props = { agentType: string; description: string; onBack: () => void };

export function SubagentHeader({ agentType, description, onBack }: Props) {
  return (
    <div className="flex items-center gap-2 px-3 py-2 border-b border-border text-[12px] shrink-0">
      <button
        type="button"
        onClick={onBack}
        className="inline-flex items-center gap-1 text-muted hover:text-fg shrink-0"
      >
        <Icon name="arrow" className="w-3 h-3 rotate-180" />
        Wróć do sesji
      </button>
      <span className="text-muted">·</span>
      <span className="font-medium shrink-0">{agentType}</span>
      <span className="truncate text-muted">{description}</span>
    </div>
  );
}
