import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { toast } from 'sonner';
import { buildNotesWindowUrl, notesWindowLabel } from './windowMode';

export async function openNotesWindow(projectId: number, projectName: string): Promise<void> {
  const label = notesWindowLabel(projectId);
  const existing = await WebviewWindow.getByLabel(label);
  if (existing) {
    await existing.setFocus();
    return;
  }

  const win = new WebviewWindow(label, {
    url: buildNotesWindowUrl(projectId),
    title: `Notatki — ${projectName}`,
    width: 920,
    height: 680,
    minWidth: 720,
    minHeight: 520,
    titleBarStyle: 'overlay',
    hiddenTitle: true,
  });

  await win.once('tauri://error', async (event) => {
    try {
      const existing = await WebviewWindow.getByLabel(label);
      if (existing) {
        await existing.setFocus();
        return;
      }
    } catch (error) {
      console.error('[notes] window recovery failed', error);
    }
    console.error('[notes] window create failed', event);
    toast.error('Nie udało się otworzyć okna notatek');
  });
}
