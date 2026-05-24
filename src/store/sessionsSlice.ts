import type { StateCreator } from 'zustand';
import { tauri } from '../lib/tauri';
import type { SessionActivity, SessionMeta } from '../types';
import type { TabsSlice } from './tabsSlice';
import type { AppState } from './index';

const PAGE = 5;

export type SessionsSlice = {
  sessionsByProject: Record<number, { items: SessionMeta[]; hasMore: boolean }>;
  loadInitialSessions: (projectId: number) => Promise<void>;
  loadMoreSessions: (projectId: number) => Promise<void>;
  renameSession: (projectId: number, sessionId: string, title: string) => Promise<void>;
  patchActivity: (sessionId: string, activity: SessionActivity) => void;
};

export const selectSessionActivity =
  (sid: string) => (s: AppState): SessionActivity => {
    for (const proj of Object.values(s.sessionsByProject)) {
      const found = proj.items.find(x => x.id === sid);
      if (found) return found.activity;
    }
    return 'idle';
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
  patchActivity: (sessionId, activity) => {
    const current = get().sessionsByProject;
    let changed = false;
    const next: typeof current = {};
    for (const [pid, bucket] of Object.entries(current)) {
      const idx = bucket.items.findIndex(s => s.id === sessionId);
      if (idx >= 0) {
        const existing = bucket.items[idx];
        if (existing.activity !== activity) {
          const items = bucket.items.slice();
          items[idx] = { ...existing, activity };
          next[Number(pid)] = { ...bucket, items };
          changed = true;
          continue;
        }
      }
      next[Number(pid)] = bucket;
    }
    if (changed) set({ sessionsByProject: next });
  },
});
