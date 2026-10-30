import { useRef, useState } from 'react';
import type { SessionMeta } from '../../types';
import { formatRelative } from '../../lib/format';
import { useStore } from '../../store';
import { useSubagentRow } from '../../hooks/useSubagentRow';
import { ACTIVITY_DOT, ACTIVITY_LABEL, activityPulses } from '../../lib/activity';
import { PROVIDER_ICON } from '../../lib/providers';
import { Icon } from '../shared/Icon';
import { SubagentBadge } from './SubagentBadge';
import { SubagentList } from './SubagentList';

type Props = { session: SessionMeta; active?: boolean; onClick: () => void };

export function SessionItem({ session, active, onClick }: Props) {
  const [editing, setEditing] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const rename = useStore(s => s.renameSession);
  const hasAttention = useStore(s => s.attentionSessions.has(session.id));
  const hasOpenTab = useStore(s =>
    s.tabs.some(t => t.kind === 'session' && (t.sessionId === session.id || t.linkedSessionId === session.id)),
  );
  const { expanded, agents, error: agentsError, toggleAgents, pickAgent } = useSubagentRow({
    projectId: session.projectId,
    sessionId: session.id,
    title: session.title,
    provider: session.provider,
    runningAgents: session.runningAgents,
    totalAgents: session.totalAgents,
  });

  const commitRename = () => {
    const value = inputRef.current?.value.trim();
    if (value && value !== session.title) {
      rename(session.projectId, session.id, value);
    }
    setEditing(false);
  };

  return (
    <>
      <li
        onClick={onClick}
        className={`h-7 pl-2 pr-2 rounded-[7px] text-[12.5px] cursor-pointer flex items-center gap-2 transition-colors ${active ? 'bg-bg-elev-2 text-fg-strong' : 'text-fg-secondary hover:bg-bg-elev-2 hover:text-fg-strong'}`}
        title={session.title}
      >
        {hasAttention ? (
          <span className="shrink-0 inline-flex w-[7px] justify-center" title="Czeka na Twoją odpowiedź">
            <Icon name="bell" className="w-3 h-3 text-info" aria-label="Czeka na Twoją odpowiedź" />
          </span>
        ) : (
          <span
            aria-hidden="true"
            title={ACTIVITY_LABEL[session.activity]}
            className={`w-[7px] h-[7px] shrink-0 rounded-full ${ACTIVITY_DOT[session.activity]}${activityPulses(session.activity) ? ' activity-pulse' : ''}`}
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
            className="bg-transparent border-b border-accent outline-none text-[12.5px] text-fg-strong font-medium flex-1 min-w-0"
          />
        ) : (
          <span
            className={`truncate flex-1 min-w-0 ${hasOpenTab ? 'font-medium' : 'font-normal'}`}
            onDoubleClick={(e) => { e.stopPropagation(); setEditing(true); }}
          >
            {session.title}
          </span>
        )}
        <SubagentBadge
          running={session.runningAgents}
          total={session.totalAgents}
          expanded={expanded}
          onToggle={toggleAgents}
        />
        <Icon name={PROVIDER_ICON[session.provider]} className="w-2.5 h-2.5 text-label shrink-0" strokeWidth={2.5} />
        <span className="font-mono text-[11px] text-label shrink-0">{formatRelative(session.lastModified)}</span>
      </li>
      {expanded && <SubagentList agents={agents} error={agentsError} onPick={pickAgent} />}
    </>
  );
}
