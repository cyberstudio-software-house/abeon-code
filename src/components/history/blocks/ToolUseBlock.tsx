type Props = { name: string; inputSummary: string; rawInput: unknown };
export function ToolUseBlock({ name, inputSummary, rawInput }: Props) {
  return (
    <details className="my-1.5 ml-14">
      <summary className="flex items-center gap-2 cursor-pointer bg-bg-elev px-3 py-1 text-[11px] hover:bg-bg-elev-2">
        <span className="font-semibold text-fg">{name}</span>
        <span className="text-muted">·</span>
        <span className="text-fg-secondary truncate">{inputSummary}</span>
      </summary>
      <pre className="mt-1 text-[11px] overflow-x-auto bg-bg-elev p-3 font-mono text-fg-secondary">
        {JSON.stringify(rawInput, null, 2)}
      </pre>
    </details>
  );
}
