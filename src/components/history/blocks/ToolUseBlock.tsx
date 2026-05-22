type Props = { name: string; inputSummary: string; rawInput: unknown };
export function ToolUseBlock({ name, inputSummary, rawInput }: Props) {
  return (
    <details className="my-2 mx-auto max-w-[85%] bg-bg-elev border border-dashed border-border rounded p-2 text-xs">
      <summary className="cursor-pointer text-muted hover:text-fg">
        <span className="text-success mr-2">▸ tool</span>
        <span className="font-mono">{name}</span>
        <span className="ml-2 text-muted">({inputSummary})</span>
      </summary>
      <pre className="mt-2 text-[11px] overflow-x-auto bg-bg p-2 rounded">
        {JSON.stringify(rawInput, null, 2)}
      </pre>
    </details>
  );
}
