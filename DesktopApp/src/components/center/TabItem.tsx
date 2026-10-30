import type { RefObject } from 'react';
import { useStore } from '../../store';
import { selectSessionActivity } from '../../store/sessionsSlice';
import { ACTIVITY_DOT, ACTIVITY_LABEL, activityPulses } from '../../lib/activity';
import type { Tab } from '../../store/tabsSlice';
import type { SessionActivity } from '../../types';
import { Icon } from '../shared/Icon';

function useTabActivity(tabId: string, sessionId: string) {
  const activity = useStore(selectSessionActivity(tabId, sessionId));
  const attention = useStore(s => {
    const tab = s.tabs.find(t => t.id === tabId);
    const realId = (tab?.kind === 'session' && tab.linkedSessionId) || sessionId;
    return s.attentionSessions.has(realId);
  });
  return { activity, attention };
}

function AttentionBell({ className }: { className: string }) {
  return (
    <span className={`inline-flex ${className}`} title="Czeka na Twoją odpowiedź">
      <Icon name="bell" className="w-3 h-3 text-info" aria-label="Czeka na Twoją odpowiedź" />
    </span>
  );
}

const activityDotClass = (activity: SessionActivity) =>
  `rounded-full ${ACTIVITY_DOT[activity]}${activityPulses(activity) ? ' activity-pulse' : ''}`;

export function TabActivityDot({ tabId, sessionId }: { tabId: string; sessionId: string }) {
  const { activity, attention } = useTabActivity(tabId, sessionId);
  if (attention) return <AttentionBell className="mr-1.5" />;
  return <span className={`mr-1.5 w-[5px] h-[5px] ${activityDotClass(activity)}`} title={ACTIVITY_LABEL[activity]} />;
}

const MARKER_ICON = 'w-[13px] h-[13px] shrink-0 text-icon';

function SessionTabMarker({ tab }: { tab: Extract<Tab, { kind: 'session' }> }) {
  const { activity, attention } = useTabActivity(tab.id, tab.sessionId);
  if (attention) return <AttentionBell className="shrink-0" />;
  if (tab.mode === 'history') return <Icon name="history" className={MARKER_ICON} />;
  return <span className={`w-1.5 h-1.5 shrink-0 ${activityDotClass(activity)}`} title={ACTIVITY_LABEL[activity]} />;
}

function TabMarker({ tab, actionColor }: { tab: Tab; actionColor?: string }) {
  if (tab.kind === 'session') return <SessionTabMarker tab={tab} />;
  if (tab.kind === 'terminal') return <Icon name="terminal" className={MARKER_ICON} />;
  if (tab.kind === 'providerPicker') return <Icon name="plus" className={MARKER_ICON} />;
  return <span className={`w-1.5 h-1.5 shrink-0 rounded-full bg-current ${actionColor ?? 'text-muted'}`} />;
}

export type TabItemProps = {
  tab: Tab;
  active: boolean;
  paneFocused: boolean;
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
  tab, active, paneFocused, actionColor, editing, inputRef,
  onActivate, onPointerDown, onMiddleClick, onContextMenu,
  onBeginRename, onCommitRename, onCancelRename, onClose,
}: TabItemProps) {
  const chip = active
    ? `max-w-[340px] ${paneFocused ? 'bg-raised-strong text-fg-strong' : 'bg-field text-fg-secondary'}`
    : 'max-w-[280px] text-icon hover:text-fg hover:bg-bg-elev-2';
  return (
    <div
      data-tab-id={tab.id}
      aria-current={active ? 'page' : undefined}
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
      className={`group relative flex items-center gap-2 h-8 shrink-0 pl-2.5 pr-2 rounded-lg text-[12.5px] cursor-pointer select-none ${chip}`}
    >
      <TabMarker tab={tab} actionColor={actionColor} />
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
          className="bg-transparent border-b border-accent outline-none text-[12.5px] text-fg-strong w-[120px]"
        />
      ) : (
        <span
          className={`truncate min-w-0 ${tab.kind === 'session' && tab.preview ? 'italic' : ''}`}
          onDoubleClick={(e) => {
            e.stopPropagation();
            onBeginRename();
          }}
        >
          {tab.title}
        </span>
      )}
      <span
        role="button"
        aria-label="Zamknij tab"
        title="Zamknij tab"
        onClick={onClose}
        className={`shrink-0 grid place-items-center text-icon hover:text-danger ${active ? '' : 'opacity-0 group-hover:opacity-100'}`}
      >
        <Icon name="close" className="w-3 h-3" strokeWidth={2.4} />
      </span>
    </div>
  );
}
