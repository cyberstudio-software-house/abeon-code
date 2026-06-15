import type { StateCreator } from 'zustand';
import { tauri } from '../lib/tauri';
import type { SessionActivity, SessionMeta } from '../types';
import type { TabsSlice } from './tabsSlice';
import type { AppState } from './index';

const PAGE = 5;

let pollIntervalId: ReturnType<typeof setInterval> | null = null;
let focusHandler: (() => void) | null = null;
let blurHandler: (() => void) | null = null;

const POLL_INTERVAL_MS = 10_000;

function clearPoll() {
  if (pollIntervalId !== null) {
    clearInterval(pollIntervalId);
    pollIntervalId = null;
  }
}

export type SessionsSlice = {
  sessionsByProject: Record<number, { items: SessionMeta[]; hasMore: boolean }>;
  loadInitialSessions: (projectId: number) => Promise<void>;
  loadMoreSessions: (projectId: number) => Promise<void>;
  renameSession: (projectId: number, sessionId: string, title: string) => Promise<void>;
  patchActivity: (sessionId: string, activity: SessionActivity) => void;
  attentionSessions: Set<string>;
  markAttention: (sessionId: string) => void;
  clearAttention: (sessionId: string) => void;
  refreshActivity: (projectId: number) => Promise<void>;
  scheduleNewSessionRefresh: (projectId: number) => void;
  startActivityPolling: () => void;
  stopActivityPolling: () => void;
};

const NEW_SESSION_REFRESH_DELAYS_MS = [800, 2000, 4000];

export const selectSessionActivity =
  (tabId: string, sessionId: string) => (s: AppState): SessionActivity => {
    const tab = s.tabs.find(t => t.id === tabId);
    const realId = (tab?.kind === 'session' && tab.linkedSessionId) || sessionId;
    for (const proj of Object.values(s.sessionsByProject)) {
      const found = proj.items.find(x => x.id === realId);
      if (found) return found.activity;
    }
    return 'idle';
  };

export const createSessionsSlice: StateCreator<SessionsSlice & TabsSlice, [], [], SessionsSlice> = (set, get) => ({
  sessionsByProject: {},
  attentionSessions: new Set<string>(),
  markAttention: (sessionId) => {
    const cur = get().attentionSessions;
    if (cur.has(sessionId)) return;
    const next = new Set(cur);
    next.add(sessionId);
    set({ attentionSessions: next });
  },
  clearAttention: (sessionId) => {
    const cur = get().attentionSessions;
    if (!cur.has(sessionId)) return;
    const next = new Set(cur);
    next.delete(sessionId);
    set({ attentionSessions: next });
  },
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
    if (activity === 'running') get().clearAttention(sessionId);
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
  refreshActivity: async (projectId) => {
    const current = get().sessionsByProject[projectId];
    if (!current) return;
    const limit = current.items.length + PAGE;
    const fresh = await tauri.listSessions(projectId, limit, 0);
    const currentIds = new Set(current.items.map(s => s.id));
    const newSessions: SessionMeta[] = [];
    for (const s of fresh) {
      if (currentIds.has(s.id)) break;
      newSessions.push(s);
    }
    const freshById = new Map(fresh.map(s => [s.id, s]));
    const refreshedExisting = current.items.map(s => {
      const freshMeta = freshById.get(s.id);
      return freshMeta ? { ...s, activity: freshMeta.activity } : s;
    });
    set({ sessionsByProject: {
      ...get().sessionsByProject,
      [projectId]: {
        items: [...newSessions, ...refreshedExisting],
        hasMore: current.hasMore,
      },
    }});

    const { tabs, renameTab, linkNewSession } = get() as AppState;
    const unlinkedNewTabs = tabs.filter(
      (t): t is Extract<typeof t, { kind: 'session' }> =>
        t.kind === 'session' && t.projectId === projectId
        && t.sessionId.startsWith('new-') && !t.linkedSessionId
    );
    if (unlinkedNewTabs.length > 0 && newSessions.length > 0) {
      const pool = [...newSessions];
      for (const tab of unlinkedNewTabs) {
        const idx = pool.findIndex(s => s.provider === (tab.provider ?? 'claude'));
        if (idx < 0) continue;
        const [s] = pool.splice(idx, 1);
        linkNewSession(tab.id, s.id);
        renameTab(tab.id, s.title);
      }
    }

    for (const tab of (get() as AppState).tabs) {
      if (tab.kind !== 'session') continue;
      const sid = tab.linkedSessionId ?? tab.sessionId;
      const freshMeta = freshById.get(sid);
      if (freshMeta && freshMeta.title !== tab.title) {
        renameTab(tab.id, freshMeta.title);
      }
    }
  },
  scheduleNewSessionRefresh: (projectId) => {
    for (const delay of NEW_SESSION_REFRESH_DELAYS_MS) {
      setTimeout(() => {
        get().refreshActivity(projectId).catch(() => {});
        (get() as AppState).loadActivity().catch(() => {});
      }, delay);
    }
  },
  startActivityPolling: () => {
    const tick = () => {
      const projectIds = Object.keys(get().sessionsByProject).map(Number);
      for (const pid of projectIds) {
        get().refreshActivity(pid).catch(() => {});
      }
      (get() as AppState).loadActivity().catch(() => {});
    };
    focusHandler = () => {
      clearPoll();
      tick();
      pollIntervalId = setInterval(tick, POLL_INTERVAL_MS);
    };
    blurHandler = () => clearPoll();
    window.addEventListener('focus', focusHandler);
    window.addEventListener('blur', blurHandler);
    if (document.hasFocus()) focusHandler();
  },
  stopActivityPolling: () => {
    clearPoll();
    if (focusHandler) window.removeEventListener('focus', focusHandler);
    if (blurHandler) window.removeEventListener('blur', blurHandler);
    focusHandler = null;
    blurHandler = null;
  },
});
