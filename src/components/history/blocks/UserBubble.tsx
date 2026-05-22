import { Markdown } from '../Markdown';
export function UserBubble({ text }: { text: string }) {
  return (
    <div className="flex gap-4 my-3">
      <div className="w-10 shrink-0 pt-1">
        <span className="text-[10px] text-muted font-medium">TY</span>
      </div>
      <div className="flex-1 min-w-0 text-[13.5px] text-fg">
        <Markdown text={text} />
      </div>
    </div>
  );
}
