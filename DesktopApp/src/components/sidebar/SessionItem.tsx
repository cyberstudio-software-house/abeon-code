import { useRef, useState } from 'react';
import type { SessionMeta } from '../../types';
import { formatRelative } from '../../lib/format';
import { useStore } from '../../store';
import { ACTIVITY_DOT, ACTIVITY_LABEL } from '../../lib/activity';
import { Icon } from '../shared/Icon';

type Props = { session: SessionMeta; active?: boolean; onClick: () => void };

export function SessionItem({ session, active, onClick }: Props) {
  const [editing, setEditing] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const rename = useStore(s => s.renameSession);

  const commitRename = () => {
    const value = inputRef.current?.value.trim();
    if (value && value !== session.title) {
      rename(session.projectId, session.id, value);
    }
    setEditing(false);
  };

  return (
    <li
      onClick={onClick}
      className={`pr-2 py-1 text-[12px] cursor-pointer flex items-center gap-2 ${active ? 'bg-bg-elev text-fg' : 'text-fg hover:bg-bg-elev'}`}
      title={session.title}
    >
      {useStore(s => s.attentionSessions.has(session.id)) ? (
        <span className="shrink-0 inline-flex" title="Czeka na Twoją odpowiedź">
          <Icon name="bell" className="w-3 h-3 text-accent" aria-label="Czeka na Twoją odpowiedź" />
        </span>
      ) : (
        <span
          className={`w-[5px] h-[5px] rounded-full shrink-0 ${ACTIVITY_DOT[session.activity]}`}
          title={ACTIVITY_LABEL[session.activity]}
        />
      )}
      {editing ? (
        <input
          ref={inputRef}
          defaultValue={session.title}
          autoFocus
          onFocus={e => e.target.select()}
          onBlur={commitRename}
          onKeyDown={e => {
            if (e.key === 'Enter') commitRename();
            if (e.key === 'Escape') setEditing(false);
          }}
          onClick={e => e.stopPropagation()}
          className="bg-transparent border-b border-accent outline-none text-[12px] text-fg font-medium flex-1 min-w-0"
        />
      ) : (
        <span
          className="truncate font-medium text-[12px] flex-1 min-w-0"
          onDoubleClick={(e) => { e.stopPropagation(); setEditing(true); }}
        >
          {session.title}
        </span>
      )}
      <span className="font-mono text-[10px] text-muted shrink-0">{formatRelative(session.lastModified)}</span>
    </li>
  );
}
