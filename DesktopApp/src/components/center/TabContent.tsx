import { useCallback, useState } from 'react';
import { HistoryView } from '../history/HistoryView';
import { SubagentView } from '../history/SubagentView';
import { TerminalView } from '../terminal/TerminalView';
import { ProviderPicker } from './ProviderPicker';
import { QuestionCard } from '../supervisor/QuestionCard';
import { NoteTabView } from '../notes/NoteTabView';
import { useStore } from '../../store';
import type { Tab } from '../../store/tabsSlice';
import type { Provider } from '../../types';

type SessionTab = Extract<Tab, { kind: 'session' }>;

const layer = (visible: boolean) => `absolute inset-0 ${visible ? '' : 'invisible pointer-events-none'}`;

function SessionBody({ tab, visible, focused = true, takeFocus, focusToken }: { tab: SessionTab; visible: boolean; focused?: boolean; takeFocus?: boolean; focusToken?: number }) {
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
          tabId={tab.id}
          sessionId={provider === 'claude' ? tab.sessionId : undefined}
          fresh
          visible={visible}
          focused={focused}
          takeFocus={takeFocus}
          focusToken={focusToken}
        />
      </div>
    );
  }
  return (
    <div className={layer(visible)}>
      <ResumedTerminal tab={tab} provider={provider} visible={visible} focused={focused} takeFocus={takeFocus} focusToken={focusToken} />
    </div>
  );
}

function ResumedTerminal({ tab, provider, visible, focused, takeFocus, focusToken }: { tab: SessionTab; provider: Provider; visible: boolean; focused: boolean; takeFocus?: boolean; focusToken?: number }) {
  const [resumeId] = useState(() => tab.linkedSessionId ?? (tab.sessionId.startsWith('new-') ? undefined : tab.sessionId));
  return <TerminalView projectId={tab.projectId} kind="agent" provider={provider} tabId={tab.id} sessionId={resumeId} visible={visible} focused={focused} takeFocus={takeFocus} focusToken={focusToken} />;
}

function SessionQuestionCard({ tab, visible, onDone }: { tab: SessionTab; visible: boolean; onDone: () => void }) {
  const liveSessionId = tab.linkedSessionId ?? tab.sessionId;
  const card = useStore(s => s.supervisor?.cards.find(c => c.sessionId === liveSessionId));
  if (tab.mode !== 'terminal' || !card) return null;
  return <QuestionCard key={card.questionId} card={card} visible={visible} onDone={onDone} />;
}

export function TabPanel({ tab, visible, focused = true, takeFocus, focusToken, onExit }: {
  tab: Tab;
  visible: boolean;
  focused?: boolean;
  takeFocus?: boolean;
  focusToken?: number;
  onExit?: (code: number) => void;
}) {
  const [cardFocusToken, setCardFocusToken] = useState(0);
  const returnFocusFromCard = useCallback(() => setCardFocusToken(token => token + 1), []);
  if (tab.kind === 'providerPicker') {
    return (
      <div className={layer(visible)}>
        <ProviderPicker tabId={tab.id} active={visible && focused} />
      </div>
    );
  }
  if (tab.kind === 'session') {
    const agentId = tab.viewingSubagentId;
    const subagentSessionId = tab.linkedSessionId ?? tab.sessionId;
    return (
      <>
        <SessionBody tab={tab} visible={visible && !agentId} focused={focused} takeFocus={takeFocus} focusToken={cardFocusToken} />
        {agentId ? (
          <div className={layer(visible)}>
            <SubagentView projectId={tab.projectId} sessionId={subagentSessionId} agentId={agentId} tabId={tab.id} />
          </div>
        ) : null}
        <SessionQuestionCard tab={tab} visible={visible} onDone={returnFocusFromCard} />
      </>
    );
  }
  if (tab.kind === 'action') {
    return (
      <div className={layer(visible)}>
        <TerminalView projectId={tab.projectId} kind="action" actionId={tab.actionId} tabId={tab.id} visible={visible} focused={focused} />
      </div>
    );
  }
  if (tab.kind === 'terminal') {
    return (
      <div className={layer(visible)}>
        <TerminalView projectId={tab.projectId} kind="shell" visible={visible} focused={focused} takeFocus={takeFocus} focusToken={focusToken} onExit={onExit} />
      </div>
    );
  }
  if (tab.kind === 'note') {
    return (
      <div className={layer(visible)}>
        <NoteTabView tab={tab} visible={visible} focused={focused} />
      </div>
    );
  }
  return null;
}
