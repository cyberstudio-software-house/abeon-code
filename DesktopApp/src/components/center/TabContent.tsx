import { useStore } from '../../store';
import { HistoryView } from '../history/HistoryView';
import { TerminalView } from '../terminal/TerminalView';
import type { Tab } from '../../store/tabsSlice';

function TabPanel({ tab, visible }: { tab: Tab; visible: boolean }) {
  if (tab.kind === 'session' && tab.mode === 'history') {
    const historySessionId = tab.linkedSessionId ?? tab.sessionId;
    return (
      <div className={`absolute inset-0 ${visible ? '' : 'invisible pointer-events-none'}`}>
        <HistoryView projectId={tab.projectId} sessionId={historySessionId} tabId={tab.id} />
      </div>
    );
  }
  if (tab.kind === 'session' && tab.mode === 'terminal') {
    if (tab.fresh) {
      return (
        <div className={`absolute inset-0 ${visible ? '' : 'invisible pointer-events-none'}`}>
          <TerminalView projectId={tab.projectId} kind="claude" sessionId={tab.sessionId} fresh visible={visible} />
        </div>
      );
    }
    const resumeId = tab.linkedSessionId ?? (tab.sessionId.startsWith('new-') ? undefined : tab.sessionId);
    return (
      <div className={`absolute inset-0 ${visible ? '' : 'invisible pointer-events-none'}`}>
        <TerminalView projectId={tab.projectId} kind="claude" sessionId={resumeId} visible={visible} />
      </div>
    );
  }
  if (tab.kind === 'action') {
    return (
      <div className={`absolute inset-0 ${visible ? '' : 'invisible pointer-events-none'}`}>
        <TerminalView projectId={tab.projectId} kind="action" actionId={tab.actionId} tabId={tab.id} visible={visible} />
      </div>
    );
  }
  if (tab.kind === 'terminal') {
    return (
      <div className={`absolute inset-0 ${visible ? '' : 'invisible pointer-events-none'}`}>
        <TerminalView projectId={tab.projectId} kind="shell" visible={visible} />
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
