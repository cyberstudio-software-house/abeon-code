import { useCallback, useEffect, useState } from 'react';
import { flushSync } from 'react-dom';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { TitleBar } from './TitleBar';
import { TabBar } from '../center/TabBar';
import { TabContent } from '../center/TabContent';
import { RightPanel } from '../right/RightPanel';
import { DragHandle, clamp } from './DragHandle';
import { ConfirmDialog } from '../dialogs/ConfirmDialog';
import { useStore } from '../../store';
import { tauri } from '../../lib/tauri';
import { processManager } from '../../lib/processManager';
import { formatWindowTitle } from '../../lib/windowTitle';
import { isTabLiveProcess } from '../../lib/tabProcess';
import type { WindowMode } from '../../lib/windowMode';

const RIGHT_MIN = 220;
const RIGHT_MAX = 480;

export function DetachedShell({ mode }: { mode: WindowMode }) {
  const isGroup = mode.view === 'group';
  const rightWidth = useStore(s => s.rightWidth);
  const setRightWidth = useStore(s => s.setRightWidth);
  const loadProjects = useStore(s => s.loadProjects);

  const activeTabTitle = useStore(s => s.tabs.find(t => t.id === s.activeTabId)?.title ?? null);
  const activeProjectName = useStore(s => {
    const tab = s.tabs.find(t => t.id === s.activeTabId);
    return tab ? (s.projects.find(p => p.id === tab.projectId)?.name ?? null) : null;
  });

  const [confirming, setConfirming] = useState(false);

  useEffect(() => { void loadProjects(); }, [loadProjects]);

  useEffect(() => {
    void tauri.setWindowTitle(formatWindowTitle(activeTabTitle, activeProjectName));
  }, [activeTabTitle, activeProjectName]);

  // The source window holds on to its action tabs until it hears this: the store
  // boot already adopted their PTYs here, so releasing them there loses no output.
  useEffect(() => {
    if (!isGroup) return;
    void tauri.emitDetachReady(getCurrentWebviewWindow().label);
  }, [isGroup]);

  // Closing the window ends every session in it. Prompt when any PTY is live; the
  // confirm path unmounts TabContent (flushSync) so TerminalView's cleanup kills
  // the PTYs before the window closes — otherwise the processes orphan.
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
          {mode.view === 'group' && <TabBar detachedProjectId={mode.projectId} />}
          <TabContent />
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
