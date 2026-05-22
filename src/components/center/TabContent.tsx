import { useStore } from '../../store';
import { HistoryView } from '../history/HistoryView';
import { TerminalView } from '../terminal/TerminalView';

export function TabContent() {
  const tabs = useStore(s => s.tabs);
  const active = useStore(s => s.activeTabId);
  const tab = tabs.find(t => t.id === active);
  if (!tab) return <div className="flex-1 grid place-items-center text-muted">Wybierz sesję z lewej</div>;

  if (tab.kind === 'session' && tab.mode === 'history') {
    return <HistoryView projectId={tab.projectId} sessionId={tab.sessionId} tabId={tab.id} />;
  }
  if (tab.kind === 'session' && tab.mode === 'terminal') {
    return <TerminalView projectId={tab.projectId} kind="claude" sessionId={tab.sessionId} />;
  }
  if (tab.kind === 'action') {
    return <TerminalView projectId={tab.projectId} kind="action" actionId={tab.actionId} />;
  }
  return null;
}
