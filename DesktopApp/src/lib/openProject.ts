import { tauri } from './tauri';
import { useStore } from '../store';

export async function openProjectPath(path: string): Promise<void> {
  try {
    const project = await tauri.findOrCreateProject(path);
    await useStore.getState().loadProjects();
    useStore.getState().openNewSessionTab(project.id);
  } catch (err) {
    console.error('[cli] openProjectPath failed', path, err);
  }
}
