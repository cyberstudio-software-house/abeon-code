import { useStore } from '../../store';
import { HistoryView } from '../history/HistoryView';
import { TerminalView } from '../terminal/TerminalView';

function TabPanel({ tab, visible }: { tab: any; visible: boolean }) {
  if (tab.kind === 'session' && tab.mode === 'history') {
    return (
      <div className={`h-full ${visible ? '' : 'hidden'}`}>
        <HistoryView projectId={tab.projectId} sessionId={tab.sessionId} tabId={tab.id} />
      </div>
    );
  }
  if (tab.kind === 'session' && tab.mode === 'terminal') {
    return (
      <div className={`h-full ${visible ? '' : 'hidden'}`}>
        <TerminalView projectId={tab.projectId} kind="claude" sessionId={tab.sessionId} />
      </div>
    );
  }
  if (tab.kind === 'action') {
    return (
      <div className={`h-full ${visible ? '' : 'hidden'}`}>
        <TerminalView projectId={tab.projectId} kind="action" actionId={tab.actionId} />
      </div>
    );
  }
  return null;
}

export function TabContent() {
  const tabs = useStore(s => s.tabs);
  const active = useStore(s => s.activeTabId);

  if (tabs.length === 0) {
    return <div className="flex-1 grid place-items-center text-muted text-[13px]">Wybierz sesję z lewej</div>;
  }

  return (
    <div className="flex-1 relative">
      {tabs.map(t => (
        <TabPanel key={t.id} tab={t} visible={t.id === active} />
      ))}
    </div>
  );
}
