import type { RefObject } from 'react';
import { useStore } from '../../store';
import { selectSessionActivity } from '../../store/sessionsSlice';
import { ACTIVITY_DOT, ACTIVITY_LABEL } from '../../lib/activity';
import type { Tab } from '../../store/tabsSlice';
import { Icon } from '../shared/Icon';

export function TabActivityDot({ tabId, sessionId }: { tabId: string; sessionId: string }) {
  const activity = useStore(selectSessionActivity(tabId, sessionId));
  const attention = useStore(s => {
    const tab = s.tabs.find(t => t.id === tabId);
    const realId = (tab?.kind === 'session' && tab.linkedSessionId) || sessionId;
    return s.attentionSessions.has(realId);
  });
  if (attention) {
    return (
      <span className="mr-1.5 inline-flex" title="Czeka na Twoją odpowiedź">
        <Icon name="bell" className="w-3 h-3 text-accent" aria-label="Czeka na Twoją odpowiedź" />
      </span>
    );
  }
  return (
    <span
      className={`mr-1.5 w-[5px] h-[5px] rounded-full ${ACTIVITY_DOT[activity]}`}
      title={ACTIVITY_LABEL[activity]}
    />
  );
}

function TabIcon({ tab, actionColor }: { tab: Tab; actionColor?: string }) {
  if (tab.kind === 'session') return <>{tab.mode === 'terminal' ? '›' : '◇'}</>;
  if (tab.kind === 'terminal') return <>$</>;
  if (tab.kind === 'providerPicker') return <>+</>;
  return <span className={actionColor ?? 'text-muted'}>▶</span>;
}

export type TabItemProps = {
  tab: Tab;
  active: boolean;
  paneFocused: boolean;
  color: string;
  actionColor?: string;
  editing: boolean;
  inputRef: RefObject<HTMLInputElement | null>;
  onActivate: () => void;
  onPointerDown?: (e: React.PointerEvent) => void;
  onMiddleClick: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onBeginRename: () => void;
  onCommitRename: () => void;
  onCancelRename: () => void;
  onClose: (e: React.MouseEvent) => void;
};

export function TabItem({
  tab, active, paneFocused, color, actionColor, editing, inputRef,
  onActivate, onPointerDown, onMiddleClick, onContextMenu,
  onBeginRename, onCommitRename, onCancelRename, onClose,
}: TabItemProps) {
  return (
    <div
      data-tab-id={tab.id}
      onClick={onActivate}
      onPointerDown={(e) => {
        if (editing) return;
        onPointerDown?.(e);
      }}
      onMouseDown={(e) => {
        if (e.button === 1) {
          e.preventDefault();
          e.stopPropagation();
          onMiddleClick();
        }
      }}
      onContextMenu={onContextMenu}
      style={{ borderLeftWidth: 2, borderLeftStyle: 'solid', borderLeftColor: color }}
      className={`group relative flex items-center px-3 py-1 text-[11px] border-x border-t cursor-pointer shrink-0 ${
        active
          ? (paneFocused ? 'bg-bg-elev border-border text-fg' : 'bg-bg-elev border-border text-muted')
          : 'bg-bg border-transparent text-muted hover:text-fg'
      }`}
    >
      {tab.kind === 'session' && <TabActivityDot tabId={tab.id} sessionId={tab.sessionId} />}
      <span className="mr-1.5 text-muted">
        <TabIcon tab={tab} actionColor={actionColor} />
      </span>
      {editing ? (
        <input
          ref={inputRef}
          defaultValue={tab.title}
          autoFocus
          onFocus={e => e.target.select()}
          onBlur={onCommitRename}
          onKeyDown={e => {
            if (e.key === 'Enter') onCommitRename();
            if (e.key === 'Escape') onCancelRename();
          }}
          onClick={e => e.stopPropagation()}
          className="bg-transparent border-b border-accent outline-none text-[11px] text-fg w-[120px]"
        />
      ) : (
        <span
          className={`truncate max-w-[160px] inline-block align-middle ${tab.kind === 'session' && tab.preview ? 'italic' : ''}`}
          onDoubleClick={(e) => {
            e.stopPropagation();
            onBeginRename();
          }}
        >
          {tab.title}
        </span>
      )}
      <span
        onClick={onClose}
        className="ml-2 text-muted hover:text-danger opacity-0 group-hover:opacity-100"
      >×</span>
    </div>
  );
}
