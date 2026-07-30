import { useCallback, useEffect, useState } from 'react';
import { flushSync } from 'react-dom';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { TitleBar } from './TitleBar';
import { PaneLayout } from '../center/PaneLayout';
import { RightPanel } from '../right/RightPanel';
import { DragHandle, clamp } from './DragHandle';
import { ConfirmDialog } from '../dialogs/ConfirmDialog';
import { useStore, adoptedActions } from '../../store';
import { tauri } from '../../lib/tauri';
import { processManager } from '../../lib/processManager';
import { formatWindowTitle } from '../../lib/windowTitle';
import { isTabLiveProcess } from '../../lib/tabProcess';
import { visibleSessionIds } from '../../lib/visibleTabs';
import type { WindowMode } from '../../lib/windowMode';

const RIGHT_MIN = 220;
const RIGHT_MAX = 480;

export function DetachedShell({ mode }: { mode: WindowMode }) {
  const isGroup = mode.view === 'group';
  const projectId = mode.projectId;
  const rightWidth = useStore(s => s.rightWidth);
  const setRightWidth = useStore(s => s.setRightWidth);
  const loadProjects = useStore(s => s.loadProjects);
  const loadInitialSessions = useStore(s => s.loadInitialSessions);
  const startActivityPolling = useStore(s => s.startActivityPolling);
  const stopActivityPolling = useStore(s => s.stopActivityPolling);

  const activeTabTitle = useStore(s => s.tabs.find(t => t.id === s.activeTabId)?.title ?? null);
  const activeProjectName = useStore(s => {
    const tab = s.tabs.find(t => t.id === s.activeTabId);
    return tab ? (s.projects.find(p => p.id === tab.projectId)?.name ?? null) : null;
  });

  const [confirming, setConfirming] = useState(false);

  useEffect(() => { void loadProjects(); }, [loadProjects]);

  // Without the session list this window's activity dots would be stuck on
  // 'idle'; polling refreshActivity also links codex `new-` tabs to their rollout.
  useEffect(() => {
    if (!isGroup) return;
    void loadInitialSessions(projectId);
    startActivityPolling();
    return () => stopActivityPolling();
  }, [isGroup, projectId, loadInitialSessions, startActivityPolling, stopActivityPolling]);

  // Attention state only — the system notification stays the main window's job,
  // since the Rust event is broadcast to every webview and would fire twice.
  useEffect(() => {
    if (!isGroup) return;
    let unlisten: (() => void) | null = null;
    tauri.onSessionAttention((e) => {
      const state = useStore.getState();
      if (document.hasFocus() && visibleSessionIds(state.layout, state.tabs).includes(e.sessionId)) return;
      state.markAttention(e.sessionId);
    }).then(fn => { unlisten = fn; });
    return () => { if (unlisten) unlisten(); };
  }, [isGroup]);

  useEffect(() => {
    void tauri.setWindowTitle(formatWindowTitle(activeTabTitle, activeProjectName));
  }, [activeTabTitle, activeProjectName]);

  // The source window holds on to its action tabs until it hears this, and its
  // release() drops the PTY listeners — so readiness must wait for adoption.
  useEffect(() => {
    if (!isGroup) return;
    void adoptedActions.then(() => tauri.emitDetachReady(getCurrentWebviewWindow().label));
  }, [isGroup]);

  // Closing the window ends every session in it. Prompt when any PTY is live; the
  // confirm path unmounts the pane layers (flushSync) so TerminalView's cleanup
  // kills the PTYs before the window closes — otherwise the processes orphan.
  useEffect(() => {
    const win = getCurrentWebviewWindow();
    let unlisten: (() => void) | null = null;
    win.onCloseRequested((event) => {
      const state = useStore.getState();
      if (state.tabs.some(t => isTabLiveProcess(t, state.runningActions))) {
        event.preventDefault();
        setConfirming(true);
      }
    }).then(fn => { unlisten = fn; });
    return () => { if (unlisten) unlisten(); };
  }, []);

  const onRightDrag = useCallback(
    (delta: number) => setRightWidth(clamp(rightWidth - delta, RIGHT_MIN, RIGHT_MAX)),
    [rightWidth, setRightWidth],
  );

  const confirmClose = () => {
    const state = useStore.getState();
    for (const tab of state.tabs) {
      if (tab.kind === 'action') processManager.dismiss(tab.actionId);
    }
    flushSync(() => state.detachTabs(state.tabs.map(t => t.id)));
    // destroy(), not close(): the user already confirmed. close() re-emits
    // close-requested into this same guard, which can leave the window stuck
    // open on Linux/wry. destroy() force-closes after the PTYs are killed above.
    void getCurrentWebviewWindow().destroy();
  };

  return (
    <div className="flex flex-col h-full w-full overflow-hidden bg-bg">
      <TitleBar />
      <div className="flex flex-1 min-h-0">
        <main className="flex-1 h-full min-w-0 bg-bg flex flex-col">
          <PaneLayout detachedProjectId={isGroup ? projectId : undefined} />
        </main>
        <DragHandle onDrag={onRightDrag} ariaLabel="Resize right panel" />
        <div style={{ width: rightWidth }} className="h-full flex-shrink-0">
          <RightPanel />
        </div>
      </div>
      {confirming && (
        <ConfirmDialog
          title={isGroup ? 'Zamknąć okno projektu?' : 'Zamknąć sesję?'}
          message="Zamknięcie okna zakończy działające w nim procesy."
          onCancel={() => setConfirming(false)}
          onConfirm={confirmClose}
        />
      )}
    </div>
  );
}
