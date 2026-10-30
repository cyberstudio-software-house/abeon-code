import { useState } from 'react';
import { Icon, type IconName } from '../../shared/Icon';

type Props = { name: string; inputSummary: string; rawInput: unknown; done?: boolean };

const TOOL_ICONS: Record<string, IconName> = {
  Read: 'file',
  Edit: 'edit',
  Write: 'file',
  Bash: 'terminal',
  Agent: 'sparkles',
};

export function ToolUseBlock({ name, inputSummary, rawInput, done = false }: Props) {
  const [open, setOpen] = useState(false);
  const iconName = TOOL_ICONS[name] ?? 'tool';
  return (
    <div className={`overflow-hidden rounded-[8px] border bg-console my-0.5 ${open ? 'border-border-raised' : 'border-border'}`}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(o => !o)}
        className="flex h-8 w-full items-center gap-2.5 px-2.5 text-left text-[12.5px] transition-colors hover:bg-bg-elev"
      >
        <Icon name={iconName} className="h-[13px] w-[13px] shrink-0 text-icon" />
        <span className="font-medium text-fg">{name}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-muted">{inputSummary}</span>
        {done && <Icon name="check" className="h-[13px] w-[13px] shrink-0 text-success" strokeWidth={1.8} />}
        {open && <Icon name="chevU" className="h-[13px] w-[13px] shrink-0 text-icon" />}
      </button>
      {open && (
        <pre className="m-0 max-h-[132px] overflow-auto whitespace-pre-wrap border-t border-border px-3 py-2.5 font-mono text-[11.5px] leading-[1.65] text-fg-secondary scroll-thin">
          {JSON.stringify(rawInput, null, 2)}
        </pre>
      )}
    </div>
  );
}
