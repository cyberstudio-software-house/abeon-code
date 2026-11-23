import type { StateCreator } from 'zustand';
import { tauri } from '../lib/tauri';
import type { DeployFlow, RepoFlow } from '../types';

export type DeploySlice = {
  repoFlowsByProject: Record<number, RepoFlow[]>;
  loadRepoFlows: (projectId: number) => Promise<void>;
  saveFlow: (projectId: number, flow: DeployFlow) => Promise<void>;
  deleteFlow: (projectId: number, repoPath: string) => Promise<void>;
};

export const createDeploySlice: StateCreator<DeploySlice> = (set, get) => ({
  repoFlowsByProject: {},
  loadRepoFlows: async (projectId) => {
    const flows = await tauri.deployListRepoFlows(projectId);
    set({ repoFlowsByProject: { ...get().repoFlowsByProject, [projectId]: flows } });
  },
  saveFlow: async (projectId, flow) => {
    await tauri.deploySaveFlow(flow);
    await get().loadRepoFlows(projectId);
  },
  deleteFlow: async (projectId, repoPath) => {
    await tauri.deployDeleteFlow(repoPath);
    await get().loadRepoFlows(projectId);
  },
});
