import { useRef, useState } from 'react';
import type { SessionMeta } from '../../types';
import { useStore } from '../../store';
import { IconBtn } from '../shared/IconBtn';

type Props = { meta: SessionMeta };

export function HistoryHeader({ meta }: Props) {
  const [editing, setEditing] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const rename = useStore(s => s.renameSession);

  const commitRename = () => {
    const value = inputRef.current?.value.trim();
    if (value && value !== meta.title) {
      rename(meta.projectId, meta.id, value);
    }
    setEditing(false);
  };

  return (
    <header className="px-7 pt-[18px] pb-3.5 border-b border-border bg-bg shrink-0">
      <div className="font-mono text-[10px] text-muted tracking-wide">
        sesja {meta.id.slice(0, 8)} · {new Date(meta.lastModified).toLocaleString('pl-PL')}
      </div>
      <div className="mt-1.5 flex items-baseline gap-3.5">
        {editing ? (
          <input
            ref={inputRef}
            defaultValue={meta.title}
            autoFocus
            onFocus={e => e.target.select()}
            onBlur={commitRename}
            onKeyDown={e => {
              if (e.key === 'Enter') commitRename();
              if (e.key === 'Escape') setEditing(false);
            }}
            className="m-0 text-[20px] font-medium tracking-[-0.3px] bg-transparent border-b-2 border-accent outline-none text-fg flex-1 min-w-0"
          />
        ) : (
          <h1
            className="m-0 text-[20px] font-medium tracking-[-0.3px] cursor-pointer hover:text-accent transition-colors"
            onClick={() => setEditing(true)}
            title="Kliknij, aby zmienić nazwę"
          >
            {meta.title}
          </h1>
        )}
        <span className="inline-flex items-center gap-1.5 text-[10px] font-mono text-accent bg-bg-elev-2 px-[7px] py-0.5 rounded-full">
          <span className="w-1 h-1 rounded-full bg-accent" />
          aktywna
        </span>
        <div className="ml-auto flex gap-1.5">
          <IconBtn icon="copy" label="Kopiuj ID sesji" />
          <IconBtn icon="branch" label="Fork sesji" />
          <IconBtn icon="more" label="Więcej akcji" />
        </div>
      </div>
      <div className="mt-2.5 flex gap-[18px] text-[11px] text-fg-secondary font-mono">
        <span>{meta.messageCount} tur</span>
        <span className="text-muted">·</span>
        <span>{meta.gitBranch ?? 'no branch'}</span>
      </div>
    </header>
  );
}
