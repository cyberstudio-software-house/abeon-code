import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { toast } from 'sonner';
import type { Tab } from '../store/tabsSlice';
import { buildSessionWindowUrl, sessionWindowLabel } from './windowMode';

export async function detachSessionTab(
  tab: Extract<Tab, { kind: 'session' }>,
  closeTab: (id: string) => void,
): Promise<void> {
  const label = sessionWindowLabel(tab.sessionId);

  // Guard against two PTYs for the same session: focus an existing window.
  const existing = await WebviewWindow.getByLabel(label);
  if (existing) {
    await existing.setFocus();
    return;
  }

  const url = buildSessionWindowUrl({
    projectId: tab.projectId,
    sessionId: tab.sessionId,
    linkedSessionId: tab.linkedSessionId,
    title: tab.title,
    fresh: tab.fresh ?? false,
  });

  const win = new WebviewWindow(label, {
    url,
    title: tab.title,
    width: 1100,
    height: 760,
    minWidth: 720,
    minHeight: 500,
    titleBarStyle: 'overlay',
    hiddenTitle: true,
  });

  let unlistenCreated: (() => void) | undefined;
  let unlistenError: (() => void) | undefined;

  unlistenCreated = await win.once('tauri://created', () => {
    closeTab(tab.id);
    unlistenError?.();
  });
  unlistenError = await win.once('tauri://error', (e) => {
    console.error('[detach] window create failed', e);
    toast.error('Nie udało się otworzyć okna sesji');
    unlistenCreated?.();
  });
}
