import { useStore } from '../../store';
import { HistoryView } from '../history/HistoryView';
import { SubagentView } from '../history/SubagentView';
import { TerminalView } from '../terminal/TerminalView';
import { ProviderPicker } from './ProviderPicker';
import type { Tab } from '../../store/tabsSlice';

type SessionTab = Extract<Tab, { kind: 'session' }>;

const layer = (visible: boolean) => `absolute inset-0 ${visible ? '' : 'invisible pointer-events-none'}`;

function SessionBody({ tab, visible }: { tab: SessionTab; visible: boolean }) {
  if (tab.mode === 'history') {
    const historySessionId = tab.linkedSessionId ?? tab.sessionId;
    return (
      <div className={layer(visible)}>
        <HistoryView projectId={tab.projectId} sessionId={historySessionId} tabId={tab.id} provider={tab.provider ?? 'claude'} />
      </div>
    );
  }
  const provider = tab.provider ?? 'claude';
  if (tab.fresh) {
    return (
      <div className={layer(visible)}>
        <TerminalView
          projectId={tab.projectId}
          kind="agent"
          provider={provider}
          sessionId={provider === 'claude' ? tab.sessionId : undefined}
          fresh
          visible={visible}
        />
      </div>
    );
  }
  const resumeId = tab.linkedSessionId ?? (tab.sessionId.startsWith('new-') ? undefined : tab.sessionId);
  return (
    <div className={layer(visible)}>
      <TerminalView projectId={tab.projectId} kind="agent" provider={provider} sessionId={resumeId} visible={visible} />
    </div>
  );
}

export function TabPanel({ tab, visible }: { tab: Tab; visible: boolean }) {
  if (tab.kind === 'providerPicker') {
    return (
      <div className={layer(visible)}>
        <ProviderPicker tabId={tab.id} />
      </div>
    );
  }
  if (tab.kind === 'session') {
    const agentId = tab.viewingSubagentId;
    const subagentSessionId = tab.linkedSessionId ?? tab.sessionId;
    return (
      <>
        <SessionBody tab={tab} visible={visible && !agentId} />
        {agentId ? (
          <div className={layer(visible)}>
            <SubagentView projectId={tab.projectId} sessionId={subagentSessionId} agentId={agentId} tabId={tab.id} />
          </div>
        ) : null}
      </>
    );
  }
  if (tab.kind === 'action') {
    return (
      <div className={layer(visible)}>
        <TerminalView projectId={tab.projectId} kind="action" actionId={tab.actionId} tabId={tab.id} visible={visible} />
      </div>
    );
  }
  if (tab.kind === 'terminal') {
    return (
      <div className={layer(visible)}>
        <TerminalView projectId={tab.projectId} kind="shell" visible={visible} />
      </div>
    );
  }
  return null;
}

export function TabContent({ detached = false }: { detached?: boolean } = {}) {
  const tabs = useStore(s => s.tabs);
  const active = useStore(s => s.activeTabId);

  if (tabs.length === 0) {
    return (
      <div className="flex-1 grid place-items-center text-muted text-[13px]">
        {detached ? 'Otwórz nową sesję przyciskiem + na pasku zakładek' : 'Wybierz sesję z lewej'}
      </div>
    );
  }

  return (
    <div className="flex-1 relative">
      {tabs.map(t => (
        <TabPanel key={t.id} tab={t} visible={t.id === active} />
      ))}
    </div>
  );
}
