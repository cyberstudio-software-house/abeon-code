import { useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../../store';
import { buildActiveSessionRows, type ActiveSessionRow } from '../../lib/activeSessions';
import { ACTIVITY_DOT, ACTIVITY_LABEL, activityPulses } from '../../lib/activity';
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
    <section className="shrink-0 flex flex-col gap-1.5">
      <button
        onClick={() => setCollapsed(c => !c)}
        aria-expanded={!collapsed}
        className="w-full flex items-center justify-between text-[11px] tracking-[0.06em] uppercase text-label font-medium px-1.5"
      >
        <span className="flex items-center gap-1.5">
          <Icon name="chevR" className={`w-2.5 h-2.5 transition-transform ${collapsed ? '' : 'rotate-90'}`} strokeWidth={2.5} />
          Aktywne
        </span>
        <span className="font-mono tabular-nums">{rows.length}</span>
      </button>
      {!collapsed && (
        <ul className="flex flex-col gap-1.5 max-h-76 overflow-y-auto scroll-thin">
          {rows.map(row => (
            <ActiveSessionRowItem
              key={row.sessionId}
              row={row}
              onClick={() => { openTab(row.projectId, row.sessionId, row.title, row.provider); clearAttention(row.sessionId); }}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function ActiveSessionRowItem({ row, onClick }: { row: ActiveSessionRow; onClick: () => void }) {
  const messageCount = useStore(s =>
    s.sessionsByProject[row.projectId]?.items.find(x => x.id === row.sessionId)?.messageCount,
  );
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
        className={`flex flex-col gap-1 px-3 py-2.5 cursor-pointer rounded-[10px] border bg-bg-elev-2 hover:bg-track transition-colors ${
          row.attention ? 'border-info/50' : 'border-border-raised'
        }`}
        title={`${row.title}\n${row.projectName} — ${ACTIVITY_LABEL[row.activity]}`}
      >
        <div className="flex items-center gap-2">
          {row.attention ? (
            <span className="shrink-0 inline-flex" title="Czeka na Twoją odpowiedź">
              <Icon name="bell" className="w-[13px] h-[13px] text-info" aria-label="Czeka na Twoją odpowiedź" />
            </span>
          ) : (
            <span
              aria-hidden="true"
              title={ACTIVITY_LABEL[row.activity]}
              className={`w-[7px] h-[7px] shrink-0 rounded-full ${ACTIVITY_DOT[row.activity]}${activityPulses(row.activity) ? ' activity-pulse' : ''}`}
            />
          )}
          <span className="flex-1 min-w-0 text-[13px] font-medium text-fg-strong truncate">
            {row.title}
          </span>
        </div>
        <div className="pl-[15px] flex items-center gap-1.5 text-[11.5px] text-muted">
          <span className="truncate min-w-0 text-info">{row.projectName}</span>
          {messageCount !== undefined && (
            <>
              <span aria-hidden="true">·</span>
              <span className="shrink-0">{messageCount} wiad.</span>
            </>
          )}
          <span aria-hidden="true">·</span>
          <span className="shrink-0">{formatRelative(row.lastModified)}</span>
          <span className="flex-1" />
          <SubagentBadge running={row.runningAgents} total={row.totalAgents} expanded={expanded} onToggle={toggleAgents} />
          <Icon name={PROVIDER_ICON[row.provider]} className="w-2.5 h-2.5 text-label shrink-0" strokeWidth={2.5} />
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
