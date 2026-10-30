import { useState } from 'react';
import { Markdown } from '../Markdown';
import { Icon } from '../../shared/Icon';

export function ThinkingBlock({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col gap-1 py-0.5">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(o => !o)}
        className="flex h-[26px] items-center gap-1.5 self-start rounded-[6px] pl-0.5 pr-1.5 text-[12px] text-muted transition-colors hover:text-fg-secondary"
      >
        <Icon
          name="chevR"
          className={`h-3 w-3 transition-transform ${open ? 'rotate-90' : ''}`}
        />
        <span>Myślenie</span>
        <span className="font-mono text-[11px]">{text.length.toLocaleString('pl-PL')} znaków</span>
      </button>
      {open && (
        <div className="border-l-2 border-border-raised pl-4 text-[13px] italic leading-[1.65] text-fg-secondary/80">
          <Markdown text={text} />
        </div>
      )}
    </div>
  );
}
