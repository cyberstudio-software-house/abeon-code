import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../../store';
import { useShallow } from 'zustand/react/shallow';
import { layoutTabBar } from '../../lib/tabGrouping';
import { findLeaf } from '../../lib/paneTree';
import { getProjectColor } from '../../lib/projectColors';
import type { Tab } from '../../store/tabsSlice';
import { TabItem } from './TabItem';
import { actionIconColor, useTabBarActions } from './useTabBarActions';

export function TabBar({ detachedProjectId, paneId, onTabPointerDown }: {
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
  const setPaneActiveTab = useStore(s => s.setPaneActiveTab);
  const openNewSessionTab = useStore(s => s.openNewSessionTab);
  const openNewTerminalTab = useStore(s => s.openNewTerminalTab);
  const projects = useStore(useShallow(s => s.projects));
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const scrollRef = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  const bar = useTabBarActions(tabs, detachedProjectId);

  const items = useMemo(() => layoutTabBar(tabs, projects), [tabs, projects]);
  const showHeaders = items.length > 1;

  const projectColor = (projectId: number) =>
    getProjectColor(projects.find(p => p.id === projectId) ?? { id: projectId, color: null });

  const toggleCollapse = (projectId: number) =>
    setCollapsed(prev => {
      const next = new Set(prev);
      if (next.has(projectId)) next.delete(projectId); else next.add(projectId);
      return next;
    });

  useEffect(() => {
    if (!active) return;
    const tab = tabs.find(t => t.id === active);
    if (tab && collapsed.has(tab.projectId)) {
      setCollapsed(prev => {
        const next = new Set(prev);
        next.delete(tab.projectId);
        return next;
      });
    }
  }, [active]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const check = () => {
      setCanScrollLeft(el.scrollLeft > 0);
      setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
    };
    check();
    el.addEventListener('scroll', check);
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => { el.removeEventListener('scroll', check); ro.disconnect(); };
  }, [tabs, collapsed]);

  useEffect(() => {
    if (!active || !scrollRef.current) return;
    const el = scrollRef.current.querySelector(`[data-tab-id="${active}"]`);
    if (el) el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [active]);

  const renderTab = (t: Tab) => (
    <TabItem
      key={t.id}
      tab={t}
      active={t.id === paneActiveTabId}
      paneFocused={resolvedPaneId === focusedPaneId}
      color={projectColor(t.projectId)}
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
  );

  if (tabs.length === 0 && detachedProjectId == null) return null;

  return (
    <>
      <div className="relative flex h-8 border-b border-border bg-bg items-end">
        <button
          onClick={() => scrollRef.current?.scrollBy({ left: -200, behavior: 'smooth' })}
          className={`absolute left-0 z-10 h-full px-1.5 text-sm bg-gradient-to-r from-bg from-60% to-transparent transition-opacity ${
            canScrollLeft ? 'opacity-100' : 'opacity-0 pointer-events-none'
          }`}
        >‹</button>
        <div
          ref={scrollRef}
          onWheel={(e) => {
            if (scrollRef.current && e.deltaY !== 0) {
              scrollRef.current.scrollLeft += e.deltaY;
              e.preventDefault();
            }
          }}
          className="flex items-end h-full px-2 gap-0.5 overflow-x-auto [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]"
        >
          {items.map((item, i) => (
            <div key={item.kind === 'single' ? item.tab.id : `group:${item.projectId}`} className="contents">
              {i > 0 && <div className="w-2 shrink-0" />}
              {item.kind === 'single' ? (
                renderTab(item.tab)
              ) : (
                <div
                  className={`flex items-end shrink-0 ${showHeaders ? '' : 'gap-0.5'}`}
                  style={showHeaders ? { borderBottom: `2px solid ${item.color}` } : undefined}
                >
                  {showHeaders && (
                    <div
                      onClick={() => toggleCollapse(item.projectId)}
                      onContextMenu={(e) => bar.showGroupMenu(e, item.projectId)}
                      className="flex items-center px-2 py-1 cursor-pointer text-[10px] shrink-0 select-none"
                    >
                      <span className="mr-1 text-[8px]">{collapsed.has(item.projectId) ? '▶' : '▼'}</span>
                      <span className="font-semibold" style={{ color: item.color }}>{item.name}</span>
                      {collapsed.has(item.projectId) && (
                        <span
                          className="ml-1 px-1.5 rounded-full text-[9px]"
                          style={{ backgroundColor: `${item.color}33`, color: item.color }}
                        >
                          {item.tabs.length}
                        </span>
                      )}
                    </div>
                  )}
                  {(!showHeaders || !collapsed.has(item.projectId)) && item.tabs.map(renderTab)}
                </div>
              )}
            </div>
          ))}
          {detachedProjectId != null && (
            <div className="flex items-end shrink-0 ml-1 gap-0.5">
              <button
                onClick={() => openNewSessionTab(detachedProjectId)}
                title="Nowa sesja"
                className="px-2 py-1 text-[11px] text-muted hover:text-fg"
              >+</button>
              <button
                onClick={() => openNewTerminalTab(detachedProjectId)}
                title="Nowy terminal"
                className="px-2 py-1 text-[11px] text-muted hover:text-fg"
              >$</button>
            </div>
          )}
        </div>
        <button
          onClick={() => scrollRef.current?.scrollBy({ left: 200, behavior: 'smooth' })}
          className={`absolute right-0 z-10 h-full px-1.5 text-sm bg-gradient-to-l from-bg from-60% to-transparent transition-opacity ${
            canScrollRight ? 'opacity-100' : 'opacity-0 pointer-events-none'
          }`}
        >›</button>
      </div>
      {bar.overlays}
    </>
  );
}
