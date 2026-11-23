import type { StateCreator } from 'zustand';
import { tauri } from '../lib/tauri';
import type { DeployFlow, RepoFlow, TrackingView } from '../types';

export type DeploySlice = {
  repoFlowsByProject: Record<number, RepoFlow[]>;
  trackings: TrackingView[];
  loadRepoFlows: (projectId: number) => Promise<void>;
  saveFlow: (projectId: number, flow: DeployFlow) => Promise<void>;
  deleteFlow: (projectId: number, repoPath: string) => Promise<void>;
  loadTrackings: () => Promise<void>;
  retryTracking: (id: number) => Promise<void>;
  dismissTracking: (id: number) => Promise<void>;
};

let loadSequence = 0;

export const createDeploySlice: StateCreator<DeploySlice> = (set, get) => ({
  repoFlowsByProject: {},
  trackings: [],
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
  loadTrackings: async () => {
    loadSequence += 1;
    const token = loadSequence;
    const trackings = await tauri.deployListTrackings();
    if (token === loadSequence) set({ trackings });
  },
  retryTracking: async (id) => {
    await tauri.deployRetry(id);
  },
  dismissTracking: async (id) => {
    await tauri.deployDismiss(id);
  },
});
