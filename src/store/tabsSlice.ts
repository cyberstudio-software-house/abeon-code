import type { StateCreator } from 'zustand';

export type Tab =
  | { kind: 'session'; id: string; projectId: number; sessionId: string; title: string; mode: 'history' | 'terminal' }
  | { kind: 'action'; id: string; projectId: number; actionId: number; title: string; status: 'running' | 'exited' };

export type TabsSlice = {
  tabs: Tab[];
  activeTabId: string | null;
  openSessionTab: (projectId: number, sessionId: string, title: string) => void;
  openNewSessionTab: (projectId: number) => void;
  setSessionMode: (tabId: string, mode: 'history' | 'terminal') => void;
  closeTab: (id: string) => void;
  setActive: (id: string) => void;
  upsertActionTab: (tab: Extract<Tab, { kind: 'action' }>) => void;
};

const sessionTabId = (sessionId: string) => `session:${sessionId}`;

export const createTabsSlice: StateCreator<TabsSlice> = (set, get) => ({
  tabs: [],
  activeTabId: null,
  openSessionTab: (projectId, sessionId, title) => {
    const id = sessionTabId(sessionId);
    const existing = get().tabs.find(t => t.id === id);
    if (existing) { set({ activeTabId: id }); return; }
    set({
      tabs: [...get().tabs, { kind: 'session', id, projectId, sessionId, title, mode: 'history' }],
      activeTabId: id,
    });
  },
  openNewSessionTab: (projectId) => {
    const sessionId = `new-${crypto.randomUUID()}`;
    const id = sessionTabId(sessionId);
    set({
      tabs: [...get().tabs, { kind: 'session', id, projectId, sessionId, title: 'New session', mode: 'terminal' }],
      activeTabId: id,
    });
  },
  setSessionMode: (tabId, mode) => set({
    tabs: get().tabs.map(t => t.id === tabId && t.kind === 'session' ? { ...t, mode } : t),
  }),
  closeTab: (id) => {
    const tabs = get().tabs.filter(t => t.id !== id);
    const activeTabId = get().activeTabId === id ? (tabs[tabs.length - 1]?.id ?? null) : get().activeTabId;
    set({ tabs, activeTabId });
  },
  setActive: (id) => set({ activeTabId: id }),
  upsertActionTab: (tab) => {
    const existing = get().tabs.find(t => t.id === tab.id);
    if (existing) {
      set({ tabs: get().tabs.map(t => t.id === tab.id ? tab : t), activeTabId: tab.id });
    } else {
      set({ tabs: [...get().tabs, tab], activeTabId: tab.id });
    }
  },
});
