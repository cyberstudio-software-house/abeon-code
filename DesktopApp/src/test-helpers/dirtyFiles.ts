import { vi } from 'vitest';
import { tauri } from '../lib/tauri';
import { fileName, fileTabId } from '../lib/fileText';
import { useStore } from '../store';

export function mockFileIo() {
  vi.spyOn(tauri, 'readProjectFile').mockResolvedValue({ kind: 'text', content: 'saved', version: 'v1', size: 5 });
  vi.spyOn(tauri, 'writeProjectFile').mockResolvedValue('v2');
  vi.spyOn(tauri, 'watchProjectDir').mockResolvedValue(undefined);
  vi.spyOn(tauri, 'unwatchProjectDir').mockResolvedValue(undefined);
  vi.spyOn(tauri, 'setDirtyFileCount').mockResolvedValue(undefined);
}

export async function seedDirtyFileTab(path: string, projectId = 1): Promise<string> {
  const id = fileTabId(projectId, path);
  useStore.setState((s) => ({
    tabs: [...s.tabs, { kind: 'file' as const, id, projectId, path, title: fileName(path) }],
  }));
  await useStore.getState().loadFileBuffer(id);
  useStore.getState().editFileBuffer(id, 'edited');
  return id;
}

export async function seedCleanFileTab(path: string, projectId = 1): Promise<string> {
  const id = fileTabId(projectId, path);
  useStore.setState((s) => ({
    tabs: [...s.tabs, { kind: 'file' as const, id, projectId, path, title: fileName(path) }],
  }));
  await useStore.getState().loadFileBuffer(id);
  return id;
}
