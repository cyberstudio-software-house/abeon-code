import type { StateCreator } from 'zustand';
import { tauri } from '../lib/tauri';
import type { Project } from '../types';

export type ProjectsSlice = {
  projects: Project[];
  expandedProjectIds: Set<number>;
  loadProjects: () => Promise<void>;
  addProject: (name: string, path: string) => Promise<Project>;
  removeProject: (id: number) => Promise<void>;
  toggleProjectExpanded: (id: number) => void;
};

export const createProjectsSlice: StateCreator<ProjectsSlice> = (set, get) => ({
  projects: [],
  expandedProjectIds: new Set(),
  loadProjects: async () => set({ projects: await tauri.listProjects() }),
  addProject: async (name, path) => {
    const p = await tauri.addProject(name, path);
    set({ projects: [...get().projects, p] });
    return p;
  },
  removeProject: async (id) => {
    await tauri.removeProject(id);
    set({ projects: get().projects.filter(p => p.id !== id) });
  },
  toggleProjectExpanded: (id) => {
    const next = new Set(get().expandedProjectIds);
    if (next.has(id)) next.delete(id); else next.add(id);
    set({ expandedProjectIds: next });
  },
});
