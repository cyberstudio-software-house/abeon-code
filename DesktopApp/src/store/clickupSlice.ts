import type { StateCreator } from 'zustand';
import { tauri } from '../lib/tauri';
import type { ClickUpLink } from '../types/ClickUpLink';
import type { ClickUpProjectConfig } from '../types/ClickUpProjectConfig';
import type { ClickUpConnectionStatus } from '../types/ClickUpConnectionStatus';

export type ClickUpSlice = {
  linksByProject: Record<number, ClickUpLink[]>;
  configByProject: Record<number, ClickUpProjectConfig | null>;
  connectionStatus: ClickUpConnectionStatus;
  loadConnectionStatus: () => Promise<void>;
  loadLinks: (projectId: number) => Promise<void>;
  loadConfig: (projectId: number) => Promise<void>;
  linkTask: (projectId: number, taskId: string) => Promise<void>;
  unlinkTask: (projectId: number, taskId: string) => Promise<void>;
};

export const createClickUpSlice: StateCreator<ClickUpSlice> = (set, get) => ({
  linksByProject: {},
  configByProject: {},
  connectionStatus: 'absent',
  loadConnectionStatus: async () => {
    set({ connectionStatus: await tauri.clickupConnectionStatus() });
  },
  loadLinks: async (projectId) => {
    const links = await tauri.clickupListLinks(projectId);
    set({ linksByProject: { ...get().linksByProject, [projectId]: links } });
  },
  loadConfig: async (projectId) => {
    const config = await tauri.clickupGetConfig(projectId);
    set({ configByProject: { ...get().configByProject, [projectId]: config } });
  },
  linkTask: async (projectId, taskId) => {
    const link = await tauri.clickupLinkTask(projectId, taskId);
    const existing = get().linksByProject[projectId] ?? [];
    const next = [link, ...existing.filter(l => l.taskId !== link.taskId)];
    set({ linksByProject: { ...get().linksByProject, [projectId]: next } });
  },
  unlinkTask: async (projectId, taskId) => {
    await tauri.clickupUnlinkTask(projectId, taskId);
    const existing = get().linksByProject[projectId] ?? [];
    set({ linksByProject: { ...get().linksByProject, [projectId]: existing.filter(l => l.taskId !== taskId) } });
  },
});
