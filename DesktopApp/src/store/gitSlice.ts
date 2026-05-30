import type { StateCreator } from 'zustand';
import { tauri } from '../lib/tauri';
import type { GitStatus } from '../types';

export type GitSlice = {
  gitByProject: Record<number, GitStatus>;
  refreshGit: (projectId: number) => Promise<void>;
};

export const createGitSlice: StateCreator<GitSlice> = (set, get) => ({
  gitByProject: {},
  refreshGit: async (projectId) => {
    const st = await tauri.gitStatus(projectId);
    set({ gitByProject: { ...get().gitByProject, [projectId]: st } });
  },
});
