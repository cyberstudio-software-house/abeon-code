import { useState } from 'react';
import { Markdown } from '../Markdown';
export function ThinkingBlock({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="text-[11px] text-muted italic my-1 ml-14">
      <button onClick={() => setOpen(o => !o)} className="hover:text-fg">
        {open ? '▾' : '▸'} thinking ({text.length} znaków)
      </button>
      {open && <div className="mt-1 pl-3 border-l border-border"><Markdown text={text} /></div>}
    </div>
  );
}
