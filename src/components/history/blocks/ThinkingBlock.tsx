import { useState } from 'react';
import { Markdown } from '../Markdown';
import { Icon } from '../../shared/Icon';

export function ThinkingBlock({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="my-2 ml-16">
      <button
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-2 text-[12px] text-muted hover:text-fg-secondary transition-colors"
      >
        <Icon
          name="chevR"
          className={`w-3 h-3 transition-transform ${open ? 'rotate-90' : ''}`}
        />
        <span className="italic">Myślenie</span>
        <span className="text-[10px] font-mono">({text.length} znaków)</span>
      </button>
      {open && (
        <div className="mt-2 pl-4 border-l-2 border-border text-[13px] text-fg-secondary/80 italic">
          <Markdown text={text} />
        </div>
      )}
    </div>
  );
}
