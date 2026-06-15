import { useCallback, useEffect, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { isPermissionGranted, requestPermission, sendNotification, onAction } from '@tauri-apps/plugin-notification';
import { type PluginListener } from '@tauri-apps/api/core';
import { Sidebar } from '../sidebar/Sidebar';
import { CenterPanel } from '../center/CenterPanel';
import { RightPanel } from '../right/RightPanel';
import { TitleBar } from './TitleBar';
import { TabSwitcher } from '../center/TabSwitcher';
import { useStore } from '../../store';
import { matchesShortcut } from '../../lib/shortcuts';
import { tauri } from '../../lib/tauri';
import type { AttentionEvent } from '../../lib/tauri';
import { processManager } from '../../lib/processManager';
import { formatWindowTitle } from '../../lib/windowTitle';
import { shouldNotify } from '../../lib/attention';
import { DragHandle, clamp } from './DragHandle';
import { checkForUpdate, type AvailableUpdate } from '../../lib/updater';
import { UpdateDialog } from '../dialogs/UpdateDialog';

const LEFT_MIN = 200;
const LEFT_MAX = 420;
const RIGHT_MIN = 220;
const RIGHT_MAX = 480;

export function AppShell() {
  const leftWidth = useStore(s => s.leftWidth);
  const rightWidth = useStore(s => s.rightWidth);
  const setLeftWidth = useStore(s => s.setLeftWidth);
  const setRightWidth = useStore(s => s.setRightWidth);
  const tabs = useStore(s => s.tabs);
  const activeTabId = useStore(s => s.activeTabId);
  const hasActiveProject = tabs.some(t => t.id === activeTabId);
  const activeTabTitle = useStore(s => s.tabs.find(t => t.id === s.activeTabId)?.title ?? null);
  const activeProjectName = useStore(s => {
    const tab = s.tabs.find(t => t.id === s.activeTabId);
    return tab ? (s.projects.find(p => p.id === tab.projectId)?.name ?? null) : null;
  });
  const startActivityPolling = useStore(s => s.startActivityPolling);
  const stopActivityPolling = useStore(s => s.stopActivityPolling);

  useEffect(() => {
    startActivityPolling();
    return () => stopActivityPolling();
  }, [startActivityPolling, stopActivityPolling]);

  useEffect(() => {
    void tauri.setWindowTitle(formatWindowTitle(activeTabTitle, activeProjectName));
  }, [activeTabTitle, activeProjectName]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;

      const state = useStore.getState();
      const activeTab = state.tabs.find(t => t.id === state.activeTabId);
      const projectId = activeTab?.projectId;

      if (matchesShortcut(e, 'newSession', state.shortcutOverrides) && projectId != null) {
        e.preventDefault();
        e.stopPropagation();
        state.openNewSessionTab(projectId);
        return;
      }

      if (matchesShortcut(e, 'newTerminal', state.shortcutOverrides) && projectId != null) {
        e.preventDefault();
        e.stopPropagation();
        state.openNewTerminalTab(projectId);
        return;
      }

      if (!e.shiftKey && !e.altKey && e.key >= '1' && e.key <= '9' && projectId != null) {
        const action = (state.actionsByProject[projectId] ?? [])[Number(e.key) - 1];
        if (!action) return;
        e.preventDefault();
        e.stopPropagation();
        processManager.start(projectId, action);
      }
    };
    document.addEventListener('keydown', onKey, { capture: true });
    return () => document.removeEventListener('keydown', onKey, { capture: true });
  }, []);

  useEffect(() => {
    let unlistenEvent: (() => void) | null = null;
    let unlistenAction: PluginListener | null = null;
    let lastNotified: { sessionId: string; projectId: number; title: string } | null = null;

    const resolveSession = (sessionId: string) => {
      const state = useStore.getState();
      for (const bucket of Object.values(state.sessionsByProject)) {
        const found = bucket.items.find(s => s.id === sessionId);
        if (found) return { projectId: found.projectId, title: found.title };
      }
      return null;
    };

    const focusSession = (target: { sessionId: string; projectId: number; title: string }) => {
      const win = getCurrentWindow();
      void win.unminimize().then(() => win.show()).then(() => win.setFocus());
      useStore.getState().openSessionTab(target.projectId, target.sessionId, target.title);
      useStore.getState().clearAttention(target.sessionId);
    };

    const handle = (e: AttentionEvent) => {
      const state = useStore.getState();
      const activeTab = state.tabs.find(t => t.id === state.activeTabId);
      const activeSessionId = activeTab?.kind === 'session'
        ? (activeTab.linkedSessionId ?? activeTab.sessionId)
        : null;
      const isActiveFocused = document.hasFocus() && activeSessionId === e.sessionId;

      if (isActiveFocused) return;

      state.markAttention(e.sessionId);

      if (!shouldNotify({
        enabled: state.notificationsEnabled,
        trigger: state.notificationTrigger,
        reason: e.reason,
        isActiveFocused,
      })) return;

      const resolved = resolveSession(e.sessionId);
      const title = resolved?.title ?? 'Sesja';
      if (resolved) lastNotified = { sessionId: e.sessionId, projectId: resolved.projectId, title };

      void (async () => {
        let granted = await isPermissionGranted();
        if (!granted) granted = (await requestPermission()) === 'granted';
        if (!granted) return;
        sendNotification({
          title: 'AbeonCode — sesja czeka',
          body: e.message ?? `„${title}" czeka na Twoją odpowiedź`,
        });
      })();
    };

    tauri.onSessionAttention(handle).then(fn => { unlistenEvent = fn; });
    onAction(() => { if (lastNotified) focusSession(lastNotified); })
      .then(fn => { unlistenAction = fn; })
      .catch(() => { /* onAction unsupported on this platform — bell icon is the fallback */ });

    return () => {
      if (unlistenEvent) unlistenEvent();
      if (unlistenAction) void unlistenAction.unregister();
    };
  }, []);

  useEffect(() => {
    if (!document.hasFocus()) return;
    const state = useStore.getState();
    const activeTab = state.tabs.find(t => t.id === state.activeTabId);
    if (activeTab?.kind === 'session') {
      state.clearAttention(activeTab.linkedSessionId ?? activeTab.sessionId);
    }
  }, [activeTabId]);

  const onLeftDrag = useCallback(
    (delta: number) => setLeftWidth(clamp(leftWidth + delta, LEFT_MIN, LEFT_MAX)),
    [leftWidth, setLeftWidth],
  );
  const onRightDrag = useCallback(
    (delta: number) => setRightWidth(clamp(rightWidth - delta, RIGHT_MIN, RIGHT_MAX)),
    [rightWidth, setRightWidth],
  );

  const [update, setUpdate] = useState<AvailableUpdate | null>(null);
  const [updateBusy, setUpdateBusy] = useState(false);
  const [updateProgress, setUpdateProgress] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    void checkForUpdate().then((u) => { if (!cancelled && u) setUpdate(u); });
    return () => { cancelled = true; };
  }, []);

  const runUpdate = useCallback(async () => {
    if (!update) return;
    setUpdateProgress(null);
    setUpdateBusy(true);
    try {
      await update.downloadAndInstall((downloaded, total) => {
        setUpdateProgress(total ? Math.min(1, downloaded / total) : null);
      });
      await update.relaunch();
    } catch (err) {
      console.error('Update install failed', err);
      setUpdateBusy(false);
      setUpdateProgress(null);
      setUpdate(null);
    }
  }, [update]);

  return (
    <div className="flex flex-col h-full w-full overflow-hidden bg-bg">
      <TitleBar />
      <div className="flex flex-1 min-h-0">
        <div style={{ width: leftWidth }} className="h-full flex-shrink-0">
          <Sidebar />
        </div>
        <DragHandle onDrag={onLeftDrag} ariaLabel="Resize sidebar" />
        <div className="flex-1 h-full min-w-0">
          <CenterPanel />
        </div>
        {hasActiveProject && (
          <>
            <DragHandle onDrag={onRightDrag} ariaLabel="Resize right panel" />
            <div style={{ width: rightWidth }} className="h-full flex-shrink-0">
              <RightPanel />
            </div>
          </>
        )}
      </div>
      <TabSwitcher />
      {update && (
        <UpdateDialog
          version={update.version}
          notes={update.notes}
          busy={updateBusy}
          progress={updateProgress}
          onUpdate={() => void runUpdate()}
          onLater={() => setUpdate(null)}
        />
      )}
    </div>
  );
}
