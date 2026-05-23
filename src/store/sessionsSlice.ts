import type { StateCreator } from 'zustand';
import { tauri } from '../lib/tauri';
import type { SessionMeta } from '../types';
import type { TabsSlice } from './tabsSlice';

const PAGE = 5;

export type SessionsSlice = {
  sessionsByProject: Record<number, { items: SessionMeta[]; hasMore: boolean }>;
  loadInitialSessions: (projectId: number) => Promise<void>;
  loadMoreSessions: (projectId: number) => Promise<void>;
  renameSession: (projectId: number, sessionId: string, title: string) => Promise<void>;
};

export const createSessionsSlice: StateCreator<SessionsSlice & TabsSlice, [], [], SessionsSlice> = (set, get) => ({
  sessionsByProject: {},
  loadInitialSessions: async (projectId) => {
    const items = await tauri.listSessions(projectId, PAGE, 0);
    set({ sessionsByProject: {
      ...get().sessionsByProject,
      [projectId]: { items, hasMore: items.length === PAGE },
    }});
  },
  loadMoreSessions: async (projectId) => {
    const current = get().sessionsByProject[projectId];
    if (!current) return;
    const more = await tauri.listSessions(projectId, PAGE, current.items.length);
    set({ sessionsByProject: {
      ...get().sessionsByProject,
      [projectId]: {
        items: [...current.items, ...more],
        hasMore: more.length === PAGE,
      },
    }});
  },
  renameSession: async (projectId, sessionId, title) => {
    await tauri.renameSession(projectId, sessionId, title);
    const current = get().sessionsByProject[projectId];
    if (current) {
      set({ sessionsByProject: {
        ...get().sessionsByProject,
        [projectId]: {
          ...current,
          items: current.items.map(s => s.id === sessionId ? { ...s, title } : s),
        },
      }});
    }
    get().renameTab(`session:${sessionId}`, title);
  },
});
