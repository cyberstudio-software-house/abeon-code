import { useStore } from '../../store';
import { HistoryView } from '../history/HistoryView';

export function TabContent() {
  const tabs = useStore(s => s.tabs);
  const active = useStore(s => s.activeTabId);
  const tab = tabs.find(t => t.id === active);
  if (!tab) return <div className="flex-1 grid place-items-center text-muted">Wybierz sesję z lewej</div>;

  if (tab.kind === 'session' && tab.mode === 'history') {
    return <HistoryView projectId={tab.projectId} sessionId={tab.sessionId} tabId={tab.id} />;
  }
  if (tab.kind === 'session' && tab.mode === 'terminal') {
    return <div className="flex-1 grid place-items-center text-muted">(Terminal — Phase 5)</div>;
  }
  return <div className="flex-1 grid place-items-center text-muted">(Action log — Phase 6)</div>;
}
