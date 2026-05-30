import { useState } from 'react';

const PREVIEW = 300;
type Props = { content: string; isError: boolean };

export function ToolResultBlock({ content, isError }: Props) {
  const [expanded, setExpanded] = useState(content.length <= PREVIEW);
  const shown = expanded ? content : content.slice(0, PREVIEW) + '…';
  return (
    <div
      className={`my-2 ml-16 rounded-md border p-3.5 text-[12px] font-mono ${
        isError
          ? 'bg-danger/8 border-danger/20 text-danger'
          : 'bg-bg-elev border-border/30 text-fg-secondary'
      }`}
    >
      <div className="text-[10px] text-muted mb-1.5 uppercase tracking-wider font-sans">
        {isError ? 'Błąd' : 'Wynik'}
      </div>
      <pre className="whitespace-pre-wrap break-words leading-relaxed max-h-[500px] overflow-y-auto scroll-thin">
        {shown}
      </pre>
      {content.length > PREVIEW && (
        <button
          onClick={() => setExpanded(e => !e)}
          className="mt-2 text-accent text-[11px] hover:underline"
        >
          {expanded ? 'Zwiń' : `Rozwiń (${content.length} znaków)`}
        </button>
      )}
    </div>
  );
}
