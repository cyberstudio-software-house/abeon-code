import { useState } from 'react';
const PREVIEW = 200;
type Props = { content: string; isError: boolean };
export function ToolResultBlock({ content, isError }: Props) {
  const [expanded, setExpanded] = useState(content.length <= PREVIEW);
  const shown = expanded ? content : content.slice(0, PREVIEW) + (content.length > PREVIEW ? '…' : '');
  return (
    <div className={`my-2 mx-auto max-w-[85%] border rounded p-2 text-xs font-mono ${isError ? 'border-danger bg-danger/10' : 'border-border bg-bg-elev'}`}>
      <div className="text-muted text-[10px] mb-1">tool_result{isError ? ' (error)' : ''}</div>
      <pre className="whitespace-pre-wrap break-words">{shown}</pre>
      {content.length > PREVIEW && (
        <button onClick={() => setExpanded(e => !e)} className="mt-1 text-accent text-[11px]">
          {expanded ? 'zwiń' : 'rozwiń'}
        </button>
      )}
    </div>
  );
}
