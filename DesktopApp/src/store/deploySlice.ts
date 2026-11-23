import type { StateCreator } from 'zustand';
import { tauri } from '../lib/tauri';
import type { DeployFlow, ProposalView, RepoFlow, TrackingView } from '../types';

export type DeploySlice = {
  repoFlowsByProject: Record<number, RepoFlow[]>;
  trackings: TrackingView[];
  proposals: ProposalView[];
  loadRepoFlows: (projectId: number) => Promise<void>;
  saveFlow: (projectId: number, flow: DeployFlow) => Promise<void>;
  deleteFlow: (projectId: number, repoPath: string) => Promise<void>;
  loadTrackings: () => Promise<void>;
  retryTracking: (id: number) => Promise<void>;
  dismissTracking: (id: number) => Promise<void>;
  loadProposals: () => Promise<void>;
  resolveProposal: (proposalId: string, approve: boolean) => Promise<void>;
};

let loadSequence = 0;
let proposalSequence = 0;
const repoFlowSequence: Record<number, number> = {};

export const createDeploySlice: StateCreator<DeploySlice> = (set, get) => ({
  repoFlowsByProject: {},
  trackings: [],
  proposals: [],
  loadRepoFlows: async (projectId) => {
    const token = (repoFlowSequence[projectId] ?? 0) + 1;
    repoFlowSequence[projectId] = token;
    const flows = await tauri.deployListRepoFlows(projectId);
    if (repoFlowSequence[projectId] !== token) return;
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
  loadProposals: async () => {
    proposalSequence += 1;
    const token = proposalSequence;
    const proposals = await tauri.deployListProposals();
    if (token === proposalSequence) set({ proposals });
  },
  resolveProposal: async (proposalId, approve) => {
    try {
      await tauri.deployResolveProposal(proposalId, approve);
    } catch (error) {
      await get().loadProposals().catch(reloadError => {
        console.error('[deploy] reloading proposals failed', reloadError);
      });
      throw error;
    }
    proposalSequence += 1;
    set({ proposals: get().proposals.filter(view => view.proposal.id !== proposalId) });
  },
});
