import type { StateCreator } from 'zustand';
import { tauri } from '../lib/tauri';
import type { Project } from '../types';
import type { SettingsSlice } from './settingsSlice';

export type ProjectsSlice = {
  projects: Project[];
  activity: Record<number, number>;
  activityOrder: number[];
  expandedProjectIds: Set<number>;
  loadProjects: () => Promise<void>;
  loadActivity: () => Promise<void>;
  addProject: (name: string, path: string) => Promise<Project>;
  removeProject: (id: number) => Promise<void>;
  updateProject: (id: number, patch: { name?: string; color?: string }) => Promise<void>;
  toggleProjectExpanded: (id: number) => void;
};

let activityInFlight = false;

export const createProjectsSlice: StateCreator<ProjectsSlice> = (set, get) => ({
  projects: [],
  activity: {},
  activityOrder: [],
  expandedProjectIds: new Set(),
  loadProjects: async () => set({ projects: await tauri.listProjects() }),
  loadActivity: async () => {
    if (activityInFlight) return;
    activityInFlight = true;
    try {
      const activity = await tauri.getProjectsActivity();
      const known = new Set(get().activityOrder);
      const appended = Object.keys(activity)
        .map(Number)
        .filter(id => !known.has(id))
        .sort((a, b) => (activity[b] ?? 0) - (activity[a] ?? 0));
      set({ activity, activityOrder: [...get().activityOrder, ...appended] });
    } catch (err) {
      console.error('[projects] loadActivity failed', err);
    } finally {
      activityInFlight = false;
    }
  },
  addProject: async (name, path) => {
    const p = await tauri.addProject(name, path);
    set({ projects: [...get().projects, p] });
    return p;
  },
  removeProject: async (id) => {
    await tauri.removeProject(id);
    set({ projects: get().projects.filter(p => p.id !== id) });
  },
  updateProject: async (id, patch) => {
    const updated = await tauri.updateProject(id, patch);
    set({ projects: get().projects.map(p => (p.id === id ? updated : p)) });
  },
  toggleProjectExpanded: (id) => {
    const next = new Set(get().expandedProjectIds);
    if (next.has(id)) next.delete(id); else next.add(id);
    set({ expandedProjectIds: next });
  },
});

export function selectSortedProjects(state: ProjectsSlice & SettingsSlice): Project[] {
  const arr = [...state.projects];
  switch (state.sortMode) {
    case 'manual':
      return arr.sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt - b.createdAt);
    case 'alpha':
      return arr.sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
      );
    case 'activity': {
      const order = state.activityOrder;
      if (order.length === 0) {
        const act = state.activity;
        return arr.sort((a, b) => (act[b.id] ?? 0) - (act[a.id] ?? 0));
      }
      const rank = new Map(order.map((id, i) => [id, i]));
      return arr.sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity));
    }
  }
}
