import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../../store';
import { useShallow } from 'zustand/react/shallow';
import { ACTIVITY_DOT, ACTIVITY_LABEL } from '../../lib/activity';
import { selectSessionActivity } from '../../store/sessionsSlice';
import { ConfirmDialog } from '../dialogs/ConfirmDialog';
import { matchesShortcut } from '../../lib/shortcuts';
import { layoutTabBar } from '../../lib/tabGrouping';
import { processManager } from '../../lib/processManager';
import type { RunningAction } from '../../store/actionsSlice';
import { actionTone } from '../../lib/actionStatus';
import { isTabLiveProcess } from '../../lib/tabProcess';
import { TabContextMenu } from './TabContextMenu';
import { GroupContextMenu } from './GroupContextMenu';
import { detachSessionTab } from '../../lib/detachSession';
import { detachProjectGroup, focusExistingGroupWindow, summarizeDetach, detachSummaryMessage } from '../../lib/detachGroup';
import { findLeaf } from '../../lib/paneTree';
import { getProjectColor } from '../../lib/projectColors';
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

const ACTION_TONE_TEXT: Record<string, string> = {
  idle: 'text-muted',
  running: 'text-success',
  error: 'text-danger',
  stopped: 'text-muted',
};

function actionIconColor(r: RunningAction | undefined): string {
  return ACTION_TONE_TEXT[actionTone(r)];
}

function TabIcon({ tab, actionColor }: { tab: Tab; actionColor?: string }) {
  if (tab.kind === 'session') return <>{tab.mode === 'terminal' ? '›' : '◇'}</>;
  if (tab.kind === 'terminal') return <>$</>;
  if (tab.kind === 'providerPicker') return <>+</>;
  return <span className={actionColor ?? 'text-muted'}>▶</span>;
}

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
  const closeTab = useStore(s => s.closeTab);
  const detachTabs = useStore(s => s.detachTabs);
  const renameTab = useStore(s => s.renameTab);
  const openNewSessionTab = useStore(s => s.openNewSessionTab);
  const openNewTerminalTab = useStore(s => s.openNewTerminalTab);
  const projects = useStore(useShallow(s => s.projects));
  const runningActions = useStore(s => s.runningActions);
  const [pendingClose, setPendingClose] = useState<string | null>(null);
  const [pendingDetach, setPendingDetach] = useState<{ projectId: number; message: string } | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{ tab: Tab; x: number; y: number } | null>(null);
  const [groupMenu, setGroupMenu] = useState<{ projectId: number; x: number; y: number } | null>(null);
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const inputRef = useRef<HTMLInputElement | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const ctxMenuRef = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

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

  const isActiveProcess = (id: string) => {
    const t = tabs.find(x => x.id === id);
    return t ? isTabLiveProcess(t, runningActions) : false;
  };

  const doClose = (id: string) => {
    const t = tabs.find(x => x.id === id);
    if (t?.kind === 'action') processManager.dismiss(t.actionId);
    closeTab(id);
  };

  const closeWithGuard = (id: string) => {
    if (isActiveProcess(id)) setPendingClose(id);
    else doClose(id);
  };

  const runDetach = (projectId: number) => {
    const state = useStore.getState();
    void detachProjectGroup({
      projectId,
      projectName: state.projects.find(p => p.id === projectId)?.name ?? 'Projekt',
      tabs: state.tabs.filter(t => t.projectId === projectId),
      activeTabId: state.activeTabId,
      runningActions: state.runningActions,
      detachTabs,
    });
  };

  const detachWithGuard = async (projectId: number) => {
    if (await focusExistingGroupWindow(projectId)) return;
    const state = useStore.getState();
    const groupTabs = state.tabs.filter(t => t.projectId === projectId);
    const message = detachSummaryMessage(summarizeDetach(groupTabs, state.runningActions));
    if (message) setPendingDetach({ projectId, message });
    else runDetach(projectId);
  };

  const requestClose = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    closeWithGuard(id);
  };

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const overrides = useStore.getState().shortcutOverrides;
      if (!matchesShortcut(e, 'closeTab', overrides)) return;
      if (!active) return;
      // Every pane mounts this listener; only the owner of the active tab may act,
      // otherwise the close guards below run against a tab this strip does not hold.
      if (!tabs.some(t => t.id === active)) return;
      e.preventDefault();
      e.stopPropagation();
      closeWithGuard(active);
    };
    document.addEventListener('keydown', onKeyDown, { capture: true });
    return () => document.removeEventListener('keydown', onKeyDown, { capture: true });
  }, [active, tabs, closeTab]);

  useEffect(() => {
    if (!ctxMenu && !groupMenu) return;
    const onDocClick = (e: MouseEvent) => {
      if (!ctxMenuRef.current?.contains(e.target as Node)) {
        setCtxMenu(null);
        setGroupMenu(null);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [ctxMenu, groupMenu]);

  const commitRename = (id: string) => {
    const value = inputRef.current?.value.trim();
    if (value) renameTab(id, value);
    setEditingId(null);
  };

  const renderTab = (t: Tab) => (
    <div
      key={t.id}
      data-tab-id={t.id}
      onClick={() => setPaneActiveTab(resolvedPaneId, t.id)}
      onPointerDown={(e) => onTabPointerDown?.(t.id, e)}
      onMouseDown={(e) => {
        if (e.button === 1) {
          e.preventDefault();
          e.stopPropagation();
          closeWithGuard(t.id);
        }
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        setCtxMenu({ tab: t, x: e.clientX, y: e.clientY });
      }}
      style={{ borderLeftWidth: 2, borderLeftStyle: 'solid', borderLeftColor: projectColor(t.projectId) }}
      className={`group relative flex items-center px-3 py-1 text-[11px] border-x border-t cursor-pointer shrink-0 ${
        t.id === paneActiveTabId
          ? (resolvedPaneId === focusedPaneId
              ? 'bg-bg-elev border-border text-fg'
              : 'bg-bg-elev border-border text-muted')
          : 'bg-bg border-transparent text-muted hover:text-fg'
      }`}
    >
      {t.kind === 'session' && <TabActivityDot tabId={t.id} sessionId={t.sessionId} />}
      <span className="mr-1.5 text-muted">
        <TabIcon tab={t} actionColor={t.kind === 'action' ? actionIconColor(runningActions[t.actionId]) : undefined} />
      </span>
      {editingId === t.id ? (
        <input
          ref={inputRef}
          defaultValue={t.title}
          autoFocus
          onFocus={e => e.target.select()}
          onBlur={() => commitRename(t.id)}
          onKeyDown={e => {
            if (e.key === 'Enter') commitRename(t.id);
            if (e.key === 'Escape') setEditingId(null);
          }}
          onClick={e => e.stopPropagation()}
          className="bg-transparent border-b border-accent outline-none text-[11px] text-fg w-[120px]"
        />
      ) : (
        <span
          className={`truncate max-w-[160px] inline-block align-middle ${t.kind === 'session' && t.preview ? 'italic' : ''}`}
          onDoubleClick={(e) => {
            e.stopPropagation();
            setEditingId(t.id);
          }}
        >
          {t.title}
        </span>
      )}
      <span
        onClick={(e) => requestClose(e, t.id)}
        className="ml-2 text-muted hover:text-danger opacity-0 group-hover:opacity-100"
      >×</span>
    </div>
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
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setCtxMenu(null);
                        setGroupMenu({ projectId: item.projectId, x: e.clientX, y: e.clientY });
                      }}
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
      {ctxMenu && (
        <div ref={ctxMenuRef} className="fixed z-50" style={{ left: ctxMenu.x, top: ctxMenu.y }}>
          <div className="w-48 rounded-md border border-border bg-bg shadow-lg">
            <TabContextMenu
              canDetach={ctxMenu.tab.kind === 'session' && detachedProjectId == null}
              canDetachGroup={detachedProjectId == null}
              onDetach={() => {
                if (ctxMenu.tab.kind === 'session') void detachSessionTab(ctxMenu.tab, closeTab);
              }}
              onDetachGroup={() => { void detachWithGuard(ctxMenu.tab.projectId); }}
              onRename={() => setEditingId(ctxMenu.tab.id)}
              onClose={() => closeWithGuard(ctxMenu.tab.id)}
              onCloseMenu={() => setCtxMenu(null)}
            />
          </div>
        </div>
      )}
      {groupMenu && (
        <div ref={ctxMenuRef} className="fixed z-50" style={{ left: groupMenu.x, top: groupMenu.y }}>
          <div className="w-52 rounded-md border border-border bg-bg shadow-lg">
            <GroupContextMenu
              onDetach={() => { void detachWithGuard(groupMenu.projectId); }}
              onCloseMenu={() => setGroupMenu(null)}
            />
          </div>
        </div>
      )}
      {pendingClose && (
        <ConfirmDialog
          title="Zamknąć aktywny tab?"
          message="W tym tabie działa aktywny proces. Zamknięcie zakończy go."
          onCancel={() => setPendingClose(null)}
          onConfirm={() => { doClose(pendingClose); setPendingClose(null); }}
        />
      )}
      {pendingDetach && (
        <ConfirmDialog
          title="Wydzielić grupę do nowego okna?"
          message={pendingDetach.message}
          confirmLabel="Wydziel"
          onCancel={() => setPendingDetach(null)}
          onConfirm={() => { runDetach(pendingDetach.projectId); setPendingDetach(null); }}
        />
      )}
    </>
  );
}
