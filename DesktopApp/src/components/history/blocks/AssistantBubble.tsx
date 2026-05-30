import { Markdown } from '../Markdown';

export function AssistantBubble({ text }: { text: string }) {
  return (
    <div className="flex gap-5 my-5">
      <div className="w-11 shrink-0 pt-0.5">
        <span className="inline-flex items-center justify-center w-7 h-7 rounded-full bg-fg/10 text-[8px] font-bold text-fg-secondary tracking-wider">
          AI
        </span>
      </div>
      <div className="flex-1 min-w-0 text-[14px] text-fg-secondary leading-relaxed">
        <Markdown text={text} />
      </div>
    </div>
  );
}
