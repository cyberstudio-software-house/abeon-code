import { Markdown } from '../Markdown';
import { formatClock } from '../../../lib/formatClock';

type Props = { text: string; timestamp: number; providerLabel: string };

export function AssistantBubble({ text, timestamp, providerLabel }: Props) {
  return (
    <article className="flex flex-col gap-2 py-2.5">
      <div className="flex items-center gap-2 text-[11.5px] text-muted">
        <span aria-hidden="true" className="text-accent">✻</span>
        <span className="font-medium text-fg-secondary">{providerLabel}</span>
        <span className="font-mono">{formatClock(timestamp)}</span>
      </div>
      <div className="min-w-0 text-[13.5px] leading-[1.65] text-fg">
        <Markdown text={text} />
      </div>
    </article>
  );
}
