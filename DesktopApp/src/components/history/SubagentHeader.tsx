import { Icon } from '../shared/Icon';

type Props = { agentType: string; description: string; onBack: () => void };

export function SubagentHeader({ agentType, description, onBack }: Props) {
  return (
    <div className="flex shrink-0 items-center gap-2.5 border-b border-border px-7 py-3 text-[12.5px]">
      <button
        type="button"
        onClick={onBack}
        className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-[7px] pr-2 text-icon transition-colors hover:text-fg-strong"
      >
        <Icon name="arrowLeft" className="h-3 w-3" />
        Wróć do sesji
      </button>
      <span aria-hidden="true" className="text-faint">·</span>
      <span className="shrink-0 font-medium text-fg-strong">{agentType}</span>
      <span className="truncate text-muted">{description}</span>
    </div>
  );
}
