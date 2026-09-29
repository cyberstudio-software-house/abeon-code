import { toast } from 'sonner';
import { tauri } from './tauri';
import { formatTauriError } from './errors';
import { useStore } from '../store';
import type { OpenRequest } from '../types';

export async function openProjectPath(req: OpenRequest): Promise<void> {
  try {
    const project = await tauri.findOrCreateProject(req.path);
    await useStore.getState().loadProjects();
    const store = useStore.getState();
    if (!req.initialPrompt) {
      store.openNewSessionTab(project.id);
      return;
    }
    const tabId = store.startBackgroundSessionTab(project.id, req.initialPrompt);
    if (!req.background) useStore.getState().setActive(tabId);
  } catch (err) {
    console.error('[cli] openProjectPath failed', req.path, err);
    toast.error(`Nie udało się otworzyć sesji w ${req.path}: ${formatTauriError(err)}`);
  }
}
