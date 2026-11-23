import type { StateCreator } from 'zustand';
import { tauri } from '../lib/tauri';
import type { DeployFlow, ProposalOutcome, ProposalView, RepoFlow, TrackingView } from '../types';

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
  resolveProposal: (proposalId: string, approve: boolean, expectedBase: number | null) => Promise<ProposalOutcome>;
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
  resolveProposal: async (proposalId, approve, expectedBase) => {
    const reload = () => get().loadProposals().catch(error => {
      console.error('[deploy] reloading proposals failed', error);
    });
    proposalSequence += 1;
    let outcome: ProposalOutcome;
    try {
      outcome = await tauri.deployResolveProposal(proposalId, approve, expectedBase);
    } catch (error) {
      await reload();
      throw error;
    }
    if (outcome === 'resolved') {
      set({ proposals: get().proposals.filter(view => view.proposal.id !== proposalId) });
    }
    await reload();
    return outcome;
  },
});
