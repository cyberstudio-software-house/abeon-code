import type { StateCreator } from 'zustand';
import type { Provider } from '../types';

export type Tab =
  | { kind: 'session'; id: string; projectId: number; sessionId: string; linkedSessionId?: string; title: string; mode: 'history' | 'terminal'; fresh?: boolean; provider?: Provider }
  | { kind: 'action'; id: string; projectId: number; actionId: number; title: string; status: 'running' | 'exited'; exitCode?: number }
  | { kind: 'terminal'; id: string; projectId: number; title: string };

export type TabsSlice = {
  tabs: Tab[];
  activeTabId: string | null;
  mruOrder: string[];
  openSessionTab: (projectId: number, sessionId: string, title: string) => void;
  openNewSessionTab: (projectId: number) => void;
  openNewTerminalTab: (projectId: number) => void;
  setSessionMode: (tabId: string, mode: 'history' | 'terminal') => void;
  closeTab: (id: string) => void;
  setActive: (id: string) => void;
  renameTab: (id: string, title: string) => void;
  linkNewSession: (tabId: string, realSessionId: string) => void;
  upsertActionTab: (tab: Extract<Tab, { kind: 'action' }>) => void;
};

const sessionTabId = (sessionId: string) => `session:${sessionId}`;

const moveToFront = (order: string[], id: string) => [id, ...order.filter(x => x !== id)];

export const createTabsSlice: StateCreator<TabsSlice> = (set, get) => ({
  tabs: [],
  activeTabId: null,
  mruOrder: [],
  openSessionTab: (projectId, sessionId, title) => {
    const id = sessionTabId(sessionId);
    const existing = get().tabs.find(t => t.id === id || (t.kind === 'session' && t.linkedSessionId === sessionId));
    if (existing) { set({ activeTabId: existing.id, mruOrder: moveToFront(get().mruOrder, existing.id) }); return; }
    set({
      tabs: [...get().tabs, { kind: 'session', id, projectId, sessionId, title, mode: 'history' }],
      activeTabId: id,
      mruOrder: moveToFront(get().mruOrder, id),
    });
  },
  openNewSessionTab: (projectId) => {
    const sessionId = crypto.randomUUID();
    const id = sessionTabId(sessionId);
    set({
      tabs: [...get().tabs, { kind: 'session', id, projectId, sessionId, title: 'New session', mode: 'terminal', fresh: true }],
      activeTabId: id,
      mruOrder: moveToFront(get().mruOrder, id),
    });
  },
  openNewTerminalTab: (projectId) => {
    const id = `terminal:${crypto.randomUUID()}`;
    set({
      tabs: [...get().tabs, { kind: 'terminal', id, projectId, title: 'Terminal' }],
      activeTabId: id,
      mruOrder: moveToFront(get().mruOrder, id),
    });
  },
  setSessionMode: (tabId, mode) => set({
    tabs: get().tabs.map(t => t.id === tabId && t.kind === 'session' ? { ...t, mode, fresh: false } : t),
  }),
  closeTab: (id) => {
    const tabs = get().tabs.filter(t => t.id !== id);
    const mruOrder = get().mruOrder.filter(x => x !== id);
    const activeTabId = get().activeTabId === id ? (tabs[tabs.length - 1]?.id ?? null) : get().activeTabId;
    set({ tabs, activeTabId, mruOrder });
  },
  setActive: (id) => set({ activeTabId: id, mruOrder: moveToFront(get().mruOrder, id) }),
  renameTab: (id, title) => set({
    tabs: get().tabs.map(t => t.id === id ? { ...t, title } : t),
  }),
  linkNewSession: (tabId, realSessionId) => set({
    tabs: get().tabs.map(t =>
      t.id === tabId && t.kind === 'session' ? { ...t, linkedSessionId: realSessionId } : t
    ),
  }),
  upsertActionTab: (tab) => {
    const existing = get().tabs.find(t => t.id === tab.id);
    const mruOrder = moveToFront(get().mruOrder, tab.id);
    if (existing) {
      set({ tabs: get().tabs.map(t => t.id === tab.id ? tab : t), activeTabId: tab.id, mruOrder });
    } else {
      set({ tabs: [...get().tabs, tab], activeTabId: tab.id, mruOrder });
    }
  },
});
