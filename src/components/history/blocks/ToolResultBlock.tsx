import { useState } from 'react';
const PREVIEW = 200;
type Props = { content: string; isError: boolean };
export function ToolResultBlock({ content, isError }: Props) {
  const [expanded, setExpanded] = useState(content.length <= PREVIEW);
  const shown = expanded ? content : content.slice(0, PREVIEW) + (content.length > PREVIEW ? '…' : '');
  return (
    <div className={`my-1.5 ml-14 p-3 text-[11px] font-mono ${isError ? 'bg-danger/10 text-danger' : 'bg-bg-elev text-fg-secondary'}`}>
      <div className="text-[10px] text-muted mb-1">tool_result{isError ? ' (error)' : ''}</div>
      <pre className="whitespace-pre-wrap break-words">{shown}</pre>
      {content.length > PREVIEW && (
        <button onClick={() => setExpanded(e => !e)} className="mt-1 text-accent text-[11px]">
          {expanded ? 'zwiń' : 'rozwiń'}
        </button>
      )}
    </div>
  );
}
