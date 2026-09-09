import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useStore } from '../../store';
import { matchesShortcut } from '../../lib/shortcuts';
import { processManager } from '../../lib/processManager';
import { isTabLiveProcess } from '../../lib/tabProcess';
import { actionTone } from '../../lib/actionStatus';
import type { RunningAction } from '../../store/actionsSlice';
import type { Tab } from '../../store/tabsSlice';
import { ConfirmDialog } from '../dialogs/ConfirmDialog';
import { TabContextMenu } from './TabContextMenu';
import { GroupContextMenu } from './GroupContextMenu';
import { detachSessionTab } from '../../lib/detachSession';
import { detachProjectGroup, focusExistingGroupWindow, summarizeDetach, detachSummaryMessage } from '../../lib/detachGroup';

const ACTION_TONE_TEXT: Record<string, string> = {
  idle: 'text-muted',
  running: 'text-success',
  error: 'text-danger',
  stopped: 'text-muted',
};

export function actionIconColor(r: RunningAction | undefined): string {
  return ACTION_TONE_TEXT[actionTone(r)];
}

export function useTabBarActions(tabs: Tab[], detachedProjectId?: number) {
  const active = useStore(s => s.activeTabId);
  const closeTab = useStore(s => s.closeTab);
  const detachTabs = useStore(s => s.detachTabs);
  const renameTab = useStore(s => s.renameTab);
  const runningActions = useStore(s => s.runningActions);
  const [pendingClose, setPendingClose] = useState<string | null>(null);
  const [pendingDetach, setPendingDetach] = useState<{ projectId: number; message: string } | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{ tab: Tab; x: number; y: number } | null>(null);
  const [groupMenu, setGroupMenu] = useState<{ projectId: number; x: number; y: number } | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const ctxMenuRef = useRef<HTMLDivElement>(null);

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

  const requestClose = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    closeWithGuard(id);
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

  const showTabMenu = (e: React.MouseEvent, tab: Tab) => {
    e.preventDefault();
    setGroupMenu(null);
    setCtxMenu({ tab, x: e.clientX, y: e.clientY });
  };

  const showGroupMenu = (e: React.MouseEvent, projectId: number) => {
    e.preventDefault();
    setCtxMenu(null);
    setGroupMenu({ projectId, x: e.clientX, y: e.clientY });
  };

  const commitRename = (id: string) => {
    const value = inputRef.current?.value.trim();
    if (value) renameTab(id, value);
    setEditingId(null);
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

  const overlays: ReactNode = (
    <>
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

  return {
    runningActions,
    editingId,
    setEditingId,
    inputRef,
    commitRename,
    closeWithGuard,
    requestClose,
    showTabMenu,
    showGroupMenu,
    overlays,
  };
}
