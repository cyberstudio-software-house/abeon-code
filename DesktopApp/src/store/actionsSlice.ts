import type { StateCreator } from 'zustand';
import { tauri } from '../lib/tauri';
import type { Action } from '../types';

export type RunningAction = { actionId: number; ptyId: string; tabId: string };

export type ActionsSlice = {
  actionsByProject: Record<number, Action[]>;
  runningActions: Record<number, RunningAction>;
  loadActions: (projectId: number) => Promise<void>;
  markRunning: (actionId: number, ptyId: string, tabId: string) => void;
  markStopped: (actionId: number) => void;
  removeAction: (id: number) => Promise<void>;
};

export const createActionsSlice: StateCreator<ActionsSlice> = (set, get) => ({
  actionsByProject: {},
  runningActions: {},
  loadActions: async (projectId) => {
    const items = await tauri.listActions(projectId);
    set({ actionsByProject: { ...get().actionsByProject, [projectId]: items } });
  },
  markRunning: (actionId, ptyId, tabId) =>
    set({ runningActions: { ...get().runningActions, [actionId]: { actionId, ptyId, tabId } } }),
  markStopped: (actionId) => {
    const next = { ...get().runningActions };
    delete next[actionId];
    set({ runningActions: next });
  },
  removeAction: async (id) => {
    await tauri.removeAction(id);
    const byProj = { ...get().actionsByProject };
    for (const pid of Object.keys(byProj)) {
      byProj[Number(pid)] = byProj[Number(pid)].filter(a => a.id !== id);
    }
    set({ actionsByProject: byProj });
  },
});
