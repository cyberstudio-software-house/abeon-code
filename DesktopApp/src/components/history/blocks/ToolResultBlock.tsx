import { useState } from 'react';

const PREVIEW = 300;
type Props = { content: string; isError: boolean };

export function ToolResultBlock({ content, isError }: Props) {
  const [expanded, setExpanded] = useState(content.length <= PREVIEW);
  const shown = expanded ? content : content.slice(0, PREVIEW) + '…';
  return (
    <div
      className={`my-0.5 rounded-[8px] border px-3 py-2.5 font-mono text-[11.5px] ${
        isError
          ? 'border-danger/30 bg-danger/10 text-danger'
          : 'border-border bg-console text-fg-secondary'
      }`}
    >
      <div className="mb-1.5 font-sans text-[11px] font-medium text-muted">
        {isError ? 'Błąd' : 'Wynik'}
      </div>
      <pre className="m-0 max-h-[500px] overflow-y-auto whitespace-pre-wrap break-words leading-[1.65] scroll-thin">
        {shown}
      </pre>
      {content.length > PREVIEW && (
        <button
          onClick={() => setExpanded(e => !e)}
          className="mt-2 font-sans text-[11.5px] text-accent hover:underline"
        >
          {expanded ? 'Zwiń' : `Rozwiń (${content.length} znaków)`}
        </button>
      )}
    </div>
  );
}
