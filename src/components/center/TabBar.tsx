import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../../store';
import { useShallow } from 'zustand/react/shallow';
import { ACTIVITY_DOT, ACTIVITY_LABEL } from '../../lib/activity';
import { selectSessionActivity } from '../../store/sessionsSlice';
import { ConfirmDialog } from '../dialogs/ConfirmDialog';
import { matchesShortcut } from '../../lib/shortcuts';
import { groupTabsByProject, getGroupColor } from '../../lib/tabGrouping';

function TabActivityDot({ tabId, sessionId }: { tabId: string; sessionId: string }) {
  const activity = useStore(selectSessionActivity(tabId, sessionId));
  return (
    <span
      className={`mr-1.5 w-[5px] h-[5px] rounded-full ${ACTIVITY_DOT[activity]}`}
      title={ACTIVITY_LABEL[activity]}
    />
  );
}

function TabIcon({ tab }: { tab: import('../../store/tabsSlice').Tab }) {
  if (tab.kind === 'session') return <>{tab.mode === 'terminal' ? '›' : '◇'}</>;
  if (tab.kind === 'terminal') return <>$</>;
  return <>▶</>;
}

export function TabBar() {
  const tabs = useStore(s => s.tabs);
  const active = useStore(s => s.activeTabId);
  const setActive = useStore(s => s.setActive);
  const closeTab = useStore(s => s.closeTab);
  const renameTab = useStore(s => s.renameTab);
  const projects = useStore(useShallow(s => s.projects));
  const [pendingClose, setPendingClose] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const inputRef = useRef<HTMLInputElement | null>(null);

  const groups = useMemo(() => groupTabsByProject(tabs, projects), [tabs, projects]);
  const showGroups = groups.length > 1;

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

  const isActiveProcess = (id: string) => {
    const t = tabs.find(x => x.id === id);
    return !!t && ((t.kind === 'session' && t.mode === 'terminal') || t.kind === 'action' || t.kind === 'terminal');
  };

  const closeWithGuard = (id: string) => {
    if (isActiveProcess(id)) setPendingClose(id);
    else closeTab(id);
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
      e.preventDefault();
      e.stopPropagation();
      closeWithGuard(active);
    };
    document.addEventListener('keydown', onKeyDown, { capture: true });
    return () => document.removeEventListener('keydown', onKeyDown, { capture: true });
  }, [active, tabs, closeTab]);

  const commitRename = (id: string) => {
    const value = inputRef.current?.value.trim();
    if (value) renameTab(id, value);
    setEditingId(null);
  };

  const renderTab = (t: import('../../store/tabsSlice').Tab) => (
    <div
      key={t.id}
      onClick={() => setActive(t.id)}
      onMouseDown={(e) => {
        if (e.button === 1) {
          e.preventDefault();
          e.stopPropagation();
          closeWithGuard(t.id);
        }
      }}
      className={`group relative flex items-center px-3 py-1 text-[11px] border-x border-t cursor-pointer shrink-0 ${
        t.id === active
          ? 'bg-bg-elev border-border text-fg'
          : 'bg-bg border-transparent text-muted hover:text-fg'
      }`}
    >
      {t.kind === 'session' && <TabActivityDot tabId={t.id} sessionId={t.sessionId} />}
      <span className="mr-1.5 text-muted">
        <TabIcon tab={t} />
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
          className="truncate max-w-[160px] inline-block align-middle"
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

  if (tabs.length === 0) return null;

  return (
    <>
      <div className="flex h-8 border-b border-border bg-bg px-2 gap-0.5 items-end overflow-x-auto [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]">
        {showGroups ? (
          groups.map((group, gi) => (
            <div key={group.projectId} className="contents">
              {gi > 0 && <div className="w-2 shrink-0" />}
              <div className="flex items-end shrink-0" style={{ borderBottom: `2px solid ${getGroupColor(gi)}` }}>
                <div
                  onClick={() => toggleCollapse(group.projectId)}
                  className="flex items-center px-2 py-1 cursor-pointer text-[10px] shrink-0 select-none"
                >
                  <span className="mr-1 text-[8px]">{collapsed.has(group.projectId) ? '▶' : '▼'}</span>
                  <span className="font-semibold" style={{ color: getGroupColor(gi) }}>{group.name}</span>
                  {collapsed.has(group.projectId) && (
                    <span
                      className="ml-1 px-1.5 rounded-full text-[9px]"
                      style={{ backgroundColor: `${getGroupColor(gi)}33`, color: getGroupColor(gi) }}
                    >
                      {group.tabs.length}
                    </span>
                  )}
                </div>
                {!collapsed.has(group.projectId) && group.tabs.map(renderTab)}
              </div>
            </div>
          ))
        ) : (
          tabs.map(renderTab)
        )}
      </div>
      {pendingClose && (
        <ConfirmDialog
          title="Zamknąć aktywny tab?"
          message="W tym tabie działa aktywny proces. Zamknięcie zakończy go."
          onCancel={() => setPendingClose(null)}
          onConfirm={() => { closeTab(pendingClose); setPendingClose(null); }}
        />
      )}
    </>
  );
}
