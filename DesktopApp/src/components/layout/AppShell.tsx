import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { toast } from 'sonner';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { Sidebar } from '../sidebar/Sidebar';
import { CenterPanel } from '../center/CenterPanel';
import { RightPanel } from '../right/RightPanel';
import { TabSwitcher } from '../center/TabSwitcher';
import { ProjectLauncher } from '../center/ProjectLauncher';
import { freezeTabPersistence, useStore } from '../../store';
import { dirtyFileTabIds, isFileDirty } from '../../store/filesSlice';
import { matchesShortcut } from '../../lib/shortcuts';
import { tauri } from '../../lib/tauri';
import type { AttentionEvent } from '../../lib/tauri';
import { processManager } from '../../lib/processManager';
import { formatWindowTitle } from '../../lib/windowTitle';
import { shouldNotify } from '../../lib/attention';
import { visibleSessionIds } from '../../lib/visibleTabs';
import { useMouseNavigation } from '../../hooks/useMouseNavigation';
import { usePresenceReporter } from '../../lib/usePresenceReporter';
import { useSupervisorSnapshot } from '../../lib/useSupervisorSnapshot';
import { useSupervisorAutoOpen } from '../../lib/useSupervisorAutoOpen';
import { useNotesSync } from '../../lib/useNotesSync';
import { useFilesSync } from '../../lib/useFilesSync';
import { SupervisorPanel } from '../supervisor/SupervisorPanel';
import { openProjectPath } from '../../lib/openProject';
import { AppHeader } from './AppHeader';
import { DragHandle, clamp } from './DragHandle';
import { checkForUpdate, type AvailableUpdate } from '../../lib/updater';
import { UpdateDialog } from '../dialogs/UpdateDialog';
import { ConfirmDialog } from '../dialogs/ConfirmDialog';
import { useUnsavedFilesPrompt } from '../dialogs/useUnsavedFilesPrompt';
import { RestoreSessionsDialog } from '../dialogs/RestoreSessionsDialog';
import { useWindowCloseGuard } from './useWindowCloseGuard';
import { SettingsView } from '../settings/SettingsView';

const LEFT_MIN = 200;
const LEFT_MAX = 420;
const RIGHT_MIN = 220;
const RIGHT_MAX = 480;
const OTHER_WINDOW_FILES_MESSAGE =
  'Masz niezapisane pliki w innym oknie. Zapisz je lub zamknij to okno i spróbuj ponownie.';
const FILE_CHECK_FAILED_MESSAGE =
  'Nie udało się sprawdzić niezapisanych plików w innych oknach — aktualizacja wstrzymana';

export function AppShell() {
  const leftWidth = useStore(s => s.leftWidth);
  const rightWidth = useStore(s => s.rightWidth);
  const setLeftWidth = useStore(s => s.setLeftWidth);
  const setRightWidth = useStore(s => s.setRightWidth);
  const tabs = useStore(s => s.tabs);
  const activeTabId = useStore(s => s.activeTabId);
  const layout = useStore(s => s.layout);
  const settingsOpen = useStore(s => s.settingsOpen);
  const focusBeforeSettings = useRef<HTMLElement | null>(null);
  const hasActiveProject = tabs.some(t => t.id === activeTabId);
  const activeTabTitle = useStore(s => s.tabs.find(t => t.id === s.activeTabId)?.title ?? null);
  const activeProjectName = useStore(s => {
    const tab = s.tabs.find(t => t.id === s.activeTabId);
    return tab ? (s.projects.find(p => p.id === tab.projectId)?.name ?? null) : null;
  });
  const projects = useStore(s => s.projects);
  const pendingResumeTabIds = useStore(s => s.pendingResumeTabIds);
  const resumePendingSessions = useStore(s => s.resumePendingSessions);
  const dismissPendingResume = useStore(s => s.dismissPendingResume);
  const restorableSessions = useMemo(
    () => tabs
      .filter(t => pendingResumeTabIds.includes(t.id))
      .map(t => ({ id: t.id, title: t.title, projectName: projects.find(p => p.id === t.projectId)?.name ?? null })),
    [tabs, pendingResumeTabIds, projects],
  );
  const startActivityPolling = useStore(s => s.startActivityPolling);
  const stopActivityPolling = useStore(s => s.stopActivityPolling);
  const { prompt: promptUnsavedFiles, dialog: unsavedFilesDialog } = useUnsavedFilesPrompt();
  const { confirmingClose, cancelClose, notesLossDialog } = useWindowCloseGuard(promptUnsavedFiles);

  usePresenceReporter();
  useSupervisorSnapshot();
  useSupervisorAutoOpen();
  useNotesSync();
  useFilesSync();

  useEffect(() => {
    startActivityPolling();
    return () => stopActivityPolling();
  }, [startActivityPolling, stopActivityPolling]);

  useEffect(() => {
    void tauri.setWindowTitle(formatWindowTitle(activeTabTitle, activeProjectName));
  }, [activeTabTitle, activeProjectName]);

  useEffect(() => useStore.subscribe((state, prev) => {
    if (!state.settingsOpen || prev.settingsOpen) return;
    const active = document.activeElement;
    focusBeforeSettings.current = active instanceof HTMLElement && active !== document.body ? active : null;
    focusBeforeSettings.current?.blur();
  }), []);

  useEffect(() => {
    if (settingsOpen) return;
    const target = focusBeforeSettings.current;
    focusBeforeSettings.current = null;
    if (target?.isConnected) target.focus();
  }, [settingsOpen]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (useStore.getState().settingsOpen) return;
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
        const active = document.activeElement;
        const inDrawer = active instanceof Element && !!active.closest(`[data-drawer-owner="${state.activeTabId}"]`);
        state.openTerminal(projectId, { toggle: inDrawer });
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
    let unlistenActivate: (() => void) | null = null;

    const resolveSession = (sessionId: string) => {
      const state = useStore.getState();
      for (const bucket of Object.values(state.sessionsByProject)) {
        const found = bucket.items.find(s => s.id === sessionId);
        if (found) return { projectId: found.projectId, title: found.title };
      }
      return null;
    };

    const focusSession = (target: { sessionId: string; projectId: number; title: string }) => {
      useStore.getState().openSessionTab(target.projectId, target.sessionId, target.title);
      useStore.getState().clearAttention(target.sessionId);
    };

    const handle = (e: AttentionEvent) => {
      const state = useStore.getState();
      const visible = visibleSessionIds(state.layout, state.tabs);
      const isActiveFocused = document.hasFocus() && visible.includes(e.sessionId);

      if (isActiveFocused) return;

      state.markAttention(e.sessionId);

      if (!shouldNotify({
        enabled: state.notificationsEnabled,
        trigger: state.notificationTrigger,
        reason: e.reason,
        isActiveFocused,
      })) return;

      const title = resolveSession(e.sessionId)?.title ?? 'Sesja';
      void tauri.showAttentionNotification(
        e.sessionId,
        'AbeonCode — sesja czeka',
        e.message ?? `„${title}" czeka na Twoją odpowiedź`,
      );
    };

    tauri.onSessionAttention(handle).then(fn => { unlistenEvent = fn; });
    tauri.onNotificationActivate(sessionId => {
      const resolved = resolveSession(sessionId);
      if (resolved) focusSession({ sessionId, projectId: resolved.projectId, title: resolved.title });
    }).then(fn => { unlistenActivate = fn; });

    return () => {
      if (unlistenEvent) unlistenEvent();
      if (unlistenActivate) unlistenActivate();
    };
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    tauri.onCliOpenPath((req) => { void openProjectPath(req); })
      .then(fn => { unlisten = fn; });
    return () => { if (unlisten) unlisten(); };
  }, []);

  useEffect(() => {
    if (!document.hasFocus()) return;
    const state = useStore.getState();
    for (const sessionId of visibleSessionIds(state.layout, state.tabs)) state.clearAttention(sessionId);
  }, [activeTabId, layout]);

  const confirmClose = () => {
    const state = useStore.getState();
    freezeTabPersistence();
    for (const tab of state.tabs) {
      if (tab.kind === 'action') processManager.dismiss(tab.actionId);
    }
    flushSync(() => state.detachTabs(state.tabs.map(t => t.id)));
    void getCurrentWebviewWindow().destroy();
  };

  useMouseNavigation();

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
    const holdUpdate = () => {
      setUpdateBusy(false);
      setUpdateProgress(null);
      return true;
    };
    const holdForUnsavedNotes = async () => {
      if (await useStore.getState().settleNoteDraftsForExit()) return false;
      toast.error('Nie udało się zapisać notatki — ponowne uruchomienie wstrzymane');
      return holdUpdate();
    };
    const discardedContent = new Map<string, string>();
    const holdForUnsavedFiles = async () => {
      const { fileBuffers } = useStore.getState();
      const dirtyFileIds = dirtyFileTabIds(useStore.getState())
        .filter(id => discardedContent.get(id) !== fileBuffers[id]?.content);
      if (dirtyFileIds.length > 0) {
        if (!(await promptUnsavedFiles(dirtyFileIds))) return holdUpdate();
        const remaining = useStore.getState().fileBuffers;
        for (const id of dirtyFileIds) {
          const buffer = remaining[id];
          if (buffer && isFileDirty(buffer)) discardedContent.set(id, buffer.content);
        }
      }
      let dirtyElsewhere: number;
      try {
        dirtyElsewhere = await tauri.dirtyFilesInOtherWindows();
      } catch (err) {
        console.error('Unsaved files check failed', err);
        toast.error(FILE_CHECK_FAILED_MESSAGE);
        return holdUpdate();
      }
      if (dirtyElsewhere === 0) return false;
      toast.error(OTHER_WINDOW_FILES_MESSAGE);
      return holdUpdate();
    };
    try {
      if (await holdForUnsavedFiles()) return;
      await update.download((downloaded, total) => {
        setUpdateProgress(total ? Math.min(1, downloaded / total) : null);
      });
      if (await holdForUnsavedFiles()) return;
      if (await holdForUnsavedNotes()) return;
      await update.install();
      if (await holdForUnsavedFiles()) return;
      if (await holdForUnsavedNotes()) return;
      await update.relaunch();
    } catch (err) {
      console.error('Update install failed', err);
      setUpdateBusy(false);
      setUpdateProgress(null);
      setUpdate(null);
    }
  }, [update, promptUnsavedFiles]);

  return (
    <div className="relative flex flex-col h-full w-full overflow-hidden bg-bg">
      <AppHeader variant={{ kind: 'main' }} />
      <div inert={settingsOpen} className="flex flex-1 min-h-0 bg-bg px-1 pb-1">
        <div style={{ width: leftWidth }} className="h-full flex-shrink-0 p-1">
          <Sidebar />
        </div>
        <DragHandle onDrag={onLeftDrag} ariaLabel="Resize sidebar" />
        <div className="relative flex-1 h-full min-w-0">
          <CenterPanel />
          <SupervisorPanel />
        </div>
        {hasActiveProject && (
          <>
            <DragHandle onDrag={onRightDrag} ariaLabel="Resize right panel" />
            <div style={{ width: rightWidth }} className="h-full flex-shrink-0 p-1">
              <RightPanel />
            </div>
          </>
        )}
      </div>
      {settingsOpen && <SettingsView />}
      <TabSwitcher />
      <ProjectLauncher />
      {restorableSessions.length > 0 && (
        <RestoreSessionsDialog
          sessions={restorableSessions}
          onResume={resumePendingSessions}
          onDismiss={dismissPendingResume}
        />
      )}
      {notesLossDialog}
      {confirmingClose && (
        <ConfirmDialog
          title="Zamknąć AbeonCode?"
          message="Zamknięcie okna zakończy działające w nim procesy."
          onCancel={cancelClose}
          onConfirm={confirmClose}
        />
      )}
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
      {unsavedFilesDialog}
    </div>
  );
}
