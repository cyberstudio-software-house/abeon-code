import { useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../../store';
import { buildActiveSessionRows, type ActiveSessionRow } from '../../lib/activeSessions';
import { ACTIVITY_TEXT, ACTIVITY_LABEL, ACTIVITY_ICON } from '../../lib/activity';
import { PROVIDER_ICON } from '../../lib/providers';
import { formatRelative } from '../../lib/format';
import { Icon } from '../shared/Icon';
import { useSubagentRow } from '../../hooks/useSubagentRow';
import { SubagentBadge } from './SubagentBadge';
import { SubagentList } from './SubagentList';

export function ActiveSessionsPanel() {
  const showActiveSessions = useStore(s => s.showActiveSessions);
  const activeSessions = useStore(useShallow(s => s.activeSessions));
  const attentionSessions = useStore(s => s.attentionSessions);
  const sessionsByProject = useStore(s => s.sessionsByProject);
  const projects = useStore(useShallow(s => s.projects));
  const tabs = useStore(useShallow(s => s.tabs));
  const openTab = useStore(s => s.openSessionTab);
  const clearAttention = useStore(s => s.clearAttention);
  const [collapsed, setCollapsed] = useState(false);

  const openSessionIds = useMemo(() => {
    const ids = new Set<string>();
    for (const t of tabs) {
      if (t.kind !== 'session') continue;
      ids.add(t.sessionId);
      if (t.linkedSessionId) ids.add(t.linkedSessionId);
    }
    return ids;
  }, [tabs]);

  const rows = useMemo(
    () => buildActiveSessionRows(activeSessions, attentionSessions, sessionsByProject, projects, openSessionIds),
    [activeSessions, attentionSessions, sessionsByProject, projects, openSessionIds],
  );

  if (!showActiveSessions || rows.length === 0) return null;

  return (
    <div className="mt-3">
      <button
        onClick={() => setCollapsed(c => !c)}
        className="w-full flex items-center justify-between text-[10px] tracking-[0.14em] uppercase text-muted font-medium px-1"
      >
        <span className="flex items-center gap-1.5">
          <Icon name="chevR" className={`w-2.5 h-2.5 transition-transform ${collapsed ? '' : 'rotate-90'}`} strokeWidth={2.5} />
          Aktywne
        </span>
        <span className="font-mono tabular-nums">{rows.length}</span>
      </button>
      {!collapsed && (
        <ul className="mt-1.5 space-y-1.5 max-h-76 overflow-y-auto scroll-thin">
          {rows.map(row => (
            <ActiveSessionRowItem
              key={row.sessionId}
              row={row}
              onClick={() => { openTab(row.projectId, row.sessionId, row.title, row.provider); clearAttention(row.sessionId); }}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function ActiveSessionRowItem({ row, onClick }: { row: ActiveSessionRow; onClick: () => void }) {
  const { expanded, agents, error: agentsError, toggleAgents, pickAgent } = useSubagentRow({
    projectId: row.projectId,
    sessionId: row.sessionId,
    title: row.title,
    provider: row.provider,
    runningAgents: row.runningAgents,
    totalAgents: row.totalAgents,
  });

  return (
    <li>
      <div
        onClick={onClick}
        className={`pl-2.5 pr-2 py-1.5 cursor-pointer rounded-md border border-l-[3px] bg-bg-elev hover:bg-bg-elev-2 transition-colors ${
          row.attention ? 'border-accent/50' : 'border-border'
        }`}
        style={{ borderLeftColor: row.color }}
        title={`${row.title}\n${row.projectName} — ${ACTIVITY_LABEL[row.activity]}`}
      >
        <div className="flex items-start gap-2">
          <span className="flex-1 min-w-0 text-[12.5px] leading-snug font-medium text-fg line-clamp-2 break-words">
            {row.title}
          </span>
          {row.attention ? (
            <span className="shrink-0 inline-flex mt-0.5" title="Czeka na Twoją odpowiedź">
              <Icon name="bell" className="w-3 h-3 text-accent" aria-label="Czeka na Twoją odpowiedź" />
            </span>
          ) : (
            <span className="shrink-0 inline-flex mt-0.5" title={ACTIVITY_LABEL[row.activity]}>
              <Icon
                name={ACTIVITY_ICON[row.activity]}
                className={`w-3 h-3 ${ACTIVITY_TEXT[row.activity]} ${row.activity === 'running' ? 'animate-spin' : ''}`}
                strokeWidth={2.5}
              />
            </span>
          )}
        </div>
        <div className="mt-1 flex items-center gap-1.5 text-[11px]">
          <span className="truncate flex-1 min-w-0" style={{ color: row.color }}>{row.projectName}</span>
          <SubagentBadge running={row.runningAgents} total={row.totalAgents} expanded={expanded} onToggle={toggleAgents} />
          <Icon name={PROVIDER_ICON[row.provider]} className="w-2.5 h-2.5 text-muted shrink-0" strokeWidth={2.5} />
          <span className="font-mono text-[10px] text-muted shrink-0">{formatRelative(row.lastModified)}</span>
        </div>
      </div>
      {expanded && (
        <ul className="mt-0.5">
          <SubagentList agents={agents} error={agentsError} onPick={pickAgent} />
        </ul>
      )}
    </li>
  );
}
