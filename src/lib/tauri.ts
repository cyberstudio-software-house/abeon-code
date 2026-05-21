import { invoke } from '@tauri-apps/api/core';
import type { Project } from '../types';

export const tauri = {
  listProjects: () => invoke<Project[]>('list_projects'),
  addProject: (name: string, path: string) =>
    invoke<Project>('add_project', { name, path }),
  updateProject: (id: number, patch: { name?: string; color?: string }) =>
    invoke<Project>('update_project', { id, ...patch }),
  removeProject: (id: number) => invoke<void>('remove_project', { id }),
  reorderProjects: (ids: number[]) => invoke<void>('reorder_projects', { ids }),
};
