import { Markdown } from '../Markdown';
import { formatClock } from '../../../lib/formatClock';

export function UserBubble({ text, timestamp }: { text: string; timestamp: number }) {
  return (
    <article className="flex flex-col gap-1.5 py-2.5">
      <div className="flex items-center gap-2 text-[11.5px] text-muted">
        <span className="font-medium text-fg-secondary">Ty</span>
        <span className="font-mono">{formatClock(timestamp)}</span>
      </div>
      <div className="rounded-[10px] border border-border-raised bg-bg-elev-2 px-3.5 py-3 text-[13.5px] leading-[1.6] text-fg-strong">
        <Markdown text={text} />
      </div>
    </article>
  );
}
