import { useEffect, useMemo, useRef } from 'react';
import { useStore } from '../../store';
import { useShallow } from 'zustand/react/shallow';
import { groupTabsByProject } from '../../lib/tabGrouping';
import { findLeaf } from '../../lib/paneTree';
import { getProjectColor } from '../../lib/projectColors';
import type { Tab } from '../../store/tabsSlice';
import { TabItem } from './TabItem';
import { actionIconColor, useTabBarActions } from './useTabBarActions';

const ROW_SCROLL =
  'flex items-end h-full px-2 gap-0.5 overflow-x-auto [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]';

export function StackedTabBar({ detachedProjectId, paneId, onTabPointerDown }: {
  detachedProjectId?: number;
  paneId?: string;
  onTabPointerDown?: (tabId: string, e: React.PointerEvent) => void;
} = {}) {
  const allTabs = useStore(s => s.tabs);
  const focusedPaneId = useStore(s => s.focusedPaneId);
  const resolvedPaneId = paneId ?? focusedPaneId;
  const paneTabIds = useStore(useShallow(s => findLeaf(s.layout, resolvedPaneId)?.tabIds ?? []));
  const tabs = useMemo(
    () => paneTabIds.map(id => allTabs.find(t => t.id === id)).filter((t): t is Tab => !!t),
    [paneTabIds, allTabs],
  );
  const paneActiveTabId = useStore(s => findLeaf(s.layout, resolvedPaneId)?.activeTabId ?? null);
  const active = useStore(s => s.activeTabId);
  const mruOrder = useStore(useShallow(s => s.mruOrder));
  const setPaneActiveTab = useStore(s => s.setPaneActiveTab);
  const openNewSessionTab = useStore(s => s.openNewSessionTab);
  const openNewTerminalTab = useStore(s => s.openNewTerminalTab);
  const projects = useStore(useShallow(s => s.projects));
  const sessionRowRef = useRef<HTMLDivElement>(null);

  const bar = useTabBarActions(tabs, detachedProjectId);

  const groups = useMemo(() => groupTabsByProject(tabs, projects), [tabs, projects]);
  const selectedProjectId =
    tabs.find(t => t.id === paneActiveTabId)?.projectId ?? groups[0]?.projectId ?? detachedProjectId ?? null;
  const sessionTabs = useMemo(
    () => tabs.filter(t => t.projectId === selectedProjectId),
    [tabs, selectedProjectId],
  );

  const selectProject = (projectId: number) => {
    const target =
      mruOrder.find(id => tabs.some(t => t.id === id && t.projectId === projectId))
      ?? tabs.find(t => t.projectId === projectId)?.id;
    if (target) setPaneActiveTab(resolvedPaneId, target);
  };

  useEffect(() => {
    if (!active || !sessionRowRef.current) return;
    const el = sessionRowRef.current.querySelector(`[data-tab-id="${active}"]`);
    if (el) el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [active]);

  if (tabs.length === 0 && detachedProjectId == null) return null;

  return (
    <>
      <div className="flex flex-col h-full bg-bg border-b border-border">
        <div
          onWheel={(e) => {
            const el = e.currentTarget;
            if (e.deltaY !== 0) { el.scrollLeft += e.deltaY; e.preventDefault(); }
          }}
          className={`${ROW_SCROLL} h-7 border-b border-border/60`}
        >
          {groups.map(group => {
            const selected = group.projectId === selectedProjectId;
            return (
              <div
                key={group.projectId}
                data-project-tab-id={group.projectId}
                onClick={() => selectProject(group.projectId)}
                onContextMenu={(e) => bar.showGroupMenu(e, group.projectId)}
                style={{ borderBottomWidth: 2, borderBottomStyle: 'solid', borderBottomColor: selected ? group.color : 'transparent' }}
                className={`flex items-center gap-1.5 px-2.5 py-1 text-[11px] cursor-pointer shrink-0 select-none ${
                  selected ? 'text-fg' : 'text-muted hover:text-fg'
                }`}
              >
                <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: group.color }} />
                <span className="font-semibold truncate max-w-[180px]">{group.name}</span>
                <span
                  className="px-1.5 rounded-full text-[9px]"
                  style={{ backgroundColor: `${group.color}33`, color: group.color }}
                >
                  {group.tabs.length}
                </span>
              </div>
            );
          })}
        </div>

        <div
          ref={sessionRowRef}
          onWheel={(e) => {
            const el = e.currentTarget;
            if (e.deltaY !== 0) { el.scrollLeft += e.deltaY; e.preventDefault(); }
          }}
          className={`${ROW_SCROLL} h-8`}
        >
          {sessionTabs.map(t => (
            <TabItem
              key={t.id}
              tab={t}
              active={t.id === paneActiveTabId}
              paneFocused={resolvedPaneId === focusedPaneId}
              color={getProjectColor(projects.find(p => p.id === t.projectId) ?? { id: t.projectId, color: null })}
              actionColor={t.kind === 'action' ? actionIconColor(bar.runningActions[t.actionId]) : undefined}
              editing={bar.editingId === t.id}
              inputRef={bar.inputRef}
              onActivate={() => setPaneActiveTab(resolvedPaneId, t.id)}
              onPointerDown={(e) => onTabPointerDown?.(t.id, e)}
              onMiddleClick={() => bar.closeWithGuard(t.id)}
              onContextMenu={(e) => bar.showTabMenu(e, t)}
              onBeginRename={() => bar.setEditingId(t.id)}
              onCommitRename={() => bar.commitRename(t.id)}
              onCancelRename={() => bar.setEditingId(null)}
              onClose={(e) => bar.requestClose(e, t.id)}
            />
          ))}
          {selectedProjectId != null && (
            <div className="flex items-end shrink-0 ml-1 gap-0.5">
              <button
                onClick={() => openNewSessionTab(selectedProjectId)}
                title="Nowa sesja"
                className="px-2 py-1 text-[11px] text-muted hover:text-fg"
              >+</button>
              <button
                onClick={() => openNewTerminalTab(selectedProjectId)}
                title="Nowy terminal"
                className="px-2 py-1 text-[11px] text-muted hover:text-fg"
              >$</button>
            </div>
          )}
        </div>
      </div>
      {bar.overlays}
    </>
  );
}
