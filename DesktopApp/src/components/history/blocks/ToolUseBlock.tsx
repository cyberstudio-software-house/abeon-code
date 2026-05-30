import { Icon } from '../../shared/Icon';

type Props = { name: string; inputSummary: string; rawInput: unknown };

const TOOL_ICONS: Record<string, string> = {
  Read: 'file',
  Edit: 'edit',
  Write: 'file',
  Bash: 'terminal',
  Agent: 'sparkles',
};

export function ToolUseBlock({ name, inputSummary, rawInput }: Props) {
  const iconName = TOOL_ICONS[name] ?? 'tool';
  return (
    <details className="my-2 ml-16 group">
      <summary className="flex items-center gap-2.5 cursor-pointer rounded-md bg-bg-elev border border-border/50 px-3.5 py-2 text-[12px] hover:bg-bg-elev-2 hover:border-border transition-colors">
        <Icon name={iconName} className="w-3.5 h-3.5 text-muted shrink-0" />
        <span className="font-semibold text-fg">{name}</span>
        <span className="text-muted">·</span>
        <span className="text-fg-secondary truncate">{inputSummary}</span>
      </summary>
      <pre className="mt-1.5 text-[11px] overflow-x-auto bg-bg-elev border border-border/30 rounded-md p-3.5 font-mono text-fg-secondary max-h-[400px] overflow-y-auto scroll-thin">
        {JSON.stringify(rawInput, null, 2)}
      </pre>
    </details>
  );
}
