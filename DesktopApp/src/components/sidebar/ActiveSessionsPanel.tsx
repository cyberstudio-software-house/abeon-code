import { useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../../store';
import { buildActiveSessionRows, type ActiveSessionRow } from '../../lib/activeSessions';
import { ACTIVITY_TEXT, ACTIVITY_LABEL } from '../../lib/activity';
import { PROVIDER_ICON } from '../../lib/providers';
import { formatRelative } from '../../lib/format';
import { Icon } from '../shared/Icon';

export function ActiveSessionsPanel() {
  const showActiveSessions = useStore(s => s.showActiveSessions);
  const activeSessions = useStore(useShallow(s => s.activeSessions));
  const attentionSessions = useStore(s => s.attentionSessions);
  const sessionsByProject = useStore(s => s.sessionsByProject);
  const projects = useStore(useShallow(s => s.projects));
  const openTab = useStore(s => s.openSessionTab);
  const clearAttention = useStore(s => s.clearAttention);
  const [collapsed, setCollapsed] = useState(false);

  const rows = useMemo(
    () => buildActiveSessionRows(activeSessions, attentionSessions, sessionsByProject, projects),
    [activeSessions, attentionSessions, sessionsByProject, projects],
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
        <ul className="mt-1 space-y-0.5 max-h-48 overflow-y-auto scroll-thin">
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
  return (
    <li
      onClick={onClick}
      className="pr-2 py-1 pl-1 text-[12px] cursor-pointer flex items-center gap-2 text-fg hover:bg-bg-elev rounded"
      title={`${row.projectName} — ${ACTIVITY_LABEL[row.activity]}`}
    >
      <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: row.color }} />
      {row.attention ? (
        <span className="shrink-0 inline-flex" title="Czeka na Twoją odpowiedź">
          <Icon name="bell" className="w-3 h-3 text-accent" aria-label="Czeka na Twoją odpowiedź" />
        </span>
      ) : (
        <span className="shrink-0 inline-flex" title={ACTIVITY_LABEL[row.activity]}>
          <Icon name={PROVIDER_ICON[row.provider]} className={`w-3 h-3 ${ACTIVITY_TEXT[row.activity]}`} strokeWidth={2.5} />
        </span>
      )}
      <span className="truncate flex-1 min-w-0">{row.title}</span>
      <span className="text-[10px] text-muted truncate max-w-[72px] shrink-0">{row.projectName}</span>
      <span className="font-mono text-[10px] text-muted shrink-0">{formatRelative(row.lastModified)}</span>
    </li>
  );
}
