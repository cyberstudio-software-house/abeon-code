import { Markdown } from '../Markdown';

export function UserBubble({ text }: { text: string }) {
  return (
    <div className="flex gap-5 my-5 pt-5 border-t border-border/40">
      <div className="w-11 shrink-0 pt-0.5">
        <span className="inline-flex items-center justify-center w-7 h-7 rounded-full bg-accent/15 text-[10px] font-bold text-accent tracking-wide">
          TY
        </span>
      </div>
      <div className="flex-1 min-w-0 text-[14px] text-fg leading-relaxed">
        <Markdown text={text} />
      </div>
    </div>
  );
}
