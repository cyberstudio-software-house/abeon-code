import { useEffect, useMemo, useRef } from 'react';
import { useStore } from '../../store';
import { useShallow } from 'zustand/react/shallow';
import { findLeaf } from '../../lib/paneTree';
import { ACTIVITY_LABEL, ACTIVITY_SHORT_LABEL, ACTIVITY_TEXT } from '../../lib/activity';
import { selectSessionActivity } from '../../store/sessionsSlice';
import type { Tab } from '../../store/tabsSlice';
import { Icon } from '../shared/Icon';
import { TabItem } from './TabItem';
import { actionIconColor, useTabBarActions } from './useTabBarActions';

const ROW_SCROLL =
  'flex items-center min-w-0 gap-1 overflow-x-auto [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]';
const BAR_BUTTON = 'w-8 h-8 shrink-0 grid place-items-center rounded-lg text-icon hover:text-fg hover:bg-bg-elev-2';

export function usePaneTabs(paneId: string) {
  const allTabs = useStore(s => s.tabs);
  const paneTabIds = useStore(useShallow(s => findLeaf(s.layout, paneId)?.tabIds ?? []));
  const tabs = useMemo(
    () => paneTabIds.map(id => allTabs.find(t => t.id === id)).filter((t): t is Tab => !!t),
    [paneTabIds, allTabs],
  );
  const activeTabId = useStore(s => findLeaf(s.layout, paneId)?.activeTabId ?? null);
  const selectedProjectId = tabs.find(t => t.id === activeTabId)?.projectId ?? tabs[0]?.projectId ?? null;
  return { tabs, activeTabId, selectedProjectId };
}

function LiveSessionStatus({ tabId, sessionId }: { tabId: string; sessionId: string }) {
  const activity = useStore(selectSessionActivity(tabId, sessionId));
  return (
    <span
      title={ACTIVITY_LABEL[activity]}
      className={`px-2 shrink-0 whitespace-nowrap text-[12px] font-medium ${ACTIVITY_TEXT[activity]}`}
    >
      {ACTIVITY_SHORT_LABEL[activity]}
    </span>
  );
}

function PaneBarStatus({ tab }: { tab: Tab }) {
  if (tab.kind !== 'session') return null;
  if (tab.mode === 'history') {
    return (
      <span className="flex items-center gap-1.5 px-2 shrink-0 whitespace-nowrap text-[12px] text-muted">
        <Icon name="lock" className="w-3 h-3" />
        Tylko odczyt
      </span>
    );
  }
  return <LiveSessionStatus tabId={tab.id} sessionId={tab.sessionId} />;
}

export function PaneBar({ detachedProjectId, paneId, onTabPointerDown }: {
  detachedProjectId?: number;
  paneId?: string;
  onTabPointerDown?: (tabId: string, e: React.PointerEvent) => void;
} = {}) {
  const focusedPaneId = useStore(s => s.focusedPaneId);
  const resolvedPaneId = paneId ?? focusedPaneId;
  const { tabs, activeTabId: paneActiveTabId, selectedProjectId: paneProjectId } = usePaneTabs(resolvedPaneId);
  const active = useStore(s => s.activeTabId);
  const setPaneActiveTab = useStore(s => s.setPaneActiveTab);
  const openNewSessionTab = useStore(s => s.openNewSessionTab);
  const openTerminal = useStore(s => s.openTerminal);
  const sessionRowRef = useRef<HTMLDivElement>(null);

  const bar = useTabBarActions(tabs, detachedProjectId);

  const selectedProjectId = paneProjectId ?? detachedProjectId ?? null;
  const sessionTabs = useMemo(
    () => tabs.filter(t => t.projectId === selectedProjectId),
    [tabs, selectedProjectId],
  );
  const activeTab = tabs.find(t => t.id === paneActiveTabId);

  useEffect(() => {
    if (!active || !sessionRowRef.current) return;
    const el = sessionRowRef.current.querySelector(`[data-tab-id="${active}"]`);
    if (el) el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [active]);

  if (tabs.length === 0 && detachedProjectId == null) return null;

  return (
    <>
      <div className="flex items-center h-full gap-1 pl-2 pr-2.5">
        <div
          ref={sessionRowRef}
          onWheel={(e) => {
            const el = e.currentTarget;
            if (e.deltaY !== 0) { el.scrollLeft += e.deltaY; e.preventDefault(); }
          }}
          className={ROW_SCROLL}
        >
          {sessionTabs.map(t => (
            <TabItem
              key={t.id}
              tab={t}
              active={t.id === paneActiveTabId}
              paneFocused={resolvedPaneId === focusedPaneId}
              actionColor={t.kind === 'action' ? actionIconColor(bar.runningActions[t.actionId]) : undefined}
              editing={bar.editingId === t.id}
              inputRef={bar.inputRef}
              onActivate={() => setPaneActiveTab(resolvedPaneId, t.id)}
              onPointerDown={(e) => onTabPointerDown?.(t.id, e)}
              onMiddleClick={() => bar.closeWithGuard(t.id)}
              onContextMenu={(e) => bar.showTabMenu(e, t)}
              onBeginRename={() => { if (t.kind !== 'note' && t.kind !== 'file') bar.setEditingId(t.id); }}
              onCommitRename={() => bar.commitRename(t.id)}
              onCancelRename={() => bar.setEditingId(null)}
              onClose={(e) => bar.requestClose(e, t.id)}
            />
          ))}
        </div>
        {selectedProjectId != null && (
          <>
            <button
              onClick={() => openNewSessionTab(selectedProjectId)}
              title="Nowa sesja"
              aria-label="Nowa sesja"
              className={BAR_BUTTON}
            >
              <Icon name="plus" className="w-3.5 h-3.5" strokeWidth={2.25} />
            </button>
            <button
              onClick={() => openTerminal(selectedProjectId, { toggle: true })}
              title="Nowy terminal"
              aria-label="Nowy terminal"
              className={`${BAR_BUTTON} font-mono text-[13px]`}
            >$</button>
          </>
        )}
        <span className="flex-1" />
        {activeTab && <PaneBarStatus tab={activeTab} />}
      </div>
      {bar.overlays}
    </>
  );
}
