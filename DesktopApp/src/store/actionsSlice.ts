import type { StateCreator } from 'zustand';
import { tauri } from '../lib/tauri';
import type { Action } from '../types';

export type ActionStatus = 'running' | 'exited';
export type RunningAction = { actionId: number; ptyId: string; status: ActionStatus; exitCode?: number };

export type ActionsSlice = {
  actionsByProject: Record<number, Action[]>;
  runningActions: Record<number, RunningAction>;
  loadActions: (projectId: number) => Promise<void>;
  setActionRunning: (actionId: number, ptyId: string) => void;
  setActionExited: (actionId: number, exitCode: number) => void;
  clearAction: (actionId: number) => void;
  removeAction: (id: number) => Promise<void>;
};

export const createActionsSlice: StateCreator<ActionsSlice> = (set, get) => ({
  actionsByProject: {},
  runningActions: {},
  loadActions: async (projectId) => {
    const items = await tauri.listActions(projectId);
    set({ actionsByProject: { ...get().actionsByProject, [projectId]: items } });
  },
  setActionRunning: (actionId, ptyId) =>
    set({ runningActions: { ...get().runningActions, [actionId]: { actionId, ptyId, status: 'running' } } }),
  setActionExited: (actionId, exitCode) => {
    const cur = get().runningActions[actionId];
    if (!cur) return;
    set({ runningActions: { ...get().runningActions, [actionId]: { ...cur, status: 'exited', exitCode } } });
  },
  clearAction: (actionId) => {
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
