import { Markdown } from '../Markdown';
export function AssistantBubble({ text }: { text: string }) {
  return (
    <div className="flex justify-start my-2">
      <div className="max-w-[85%] bg-bg-elev text-fg rounded-2xl rounded-tl-sm px-3 py-2 text-sm border border-border">
        <Markdown text={text} />
      </div>
    </div>
  );
}
