import { Markdown } from '../Markdown';
export function UserBubble({ text }: { text: string }) {
  return (
    <div className="flex justify-end my-2">
      <div className="max-w-[80%] bg-bg-elev-2 text-fg rounded-2xl rounded-tr-sm px-3 py-2 text-sm">
        <Markdown text={text} />
      </div>
    </div>
  );
}
