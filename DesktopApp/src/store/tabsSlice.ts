import type { StateCreator } from 'zustand';
import type { Provider } from '../types';
import type { SettingsSlice } from './settingsSlice';

export type Tab =
  | { kind: 'session'; id: string; projectId: number; sessionId: string; linkedSessionId?: string; title: string; mode: 'history' | 'terminal'; fresh?: boolean; provider?: Provider }
  | { kind: 'action'; id: string; projectId: number; actionId: number; title: string; status: 'running' | 'exited'; exitCode?: number }
  | { kind: 'terminal'; id: string; projectId: number; title: string }
  | { kind: 'providerPicker'; id: string; projectId: number; title: string };

export type TabsSlice = {
  tabs: Tab[];
  activeTabId: string | null;
  mruOrder: string[];
  openSessionTab: (projectId: number, sessionId: string, title: string, provider?: Provider) => void;
  openNewSessionTab: (projectId: number) => void;
  openNewTerminalTab: (projectId: number) => void;
  startSessionTab: (projectId: number, provider: Provider) => void;
  chooseProvider: (tabId: string, provider: Provider) => void;
  setSessionMode: (tabId: string, mode: 'history' | 'terminal') => void;
  closeTab: (id: string) => void;
  setActive: (id: string) => void;
  renameTab: (id: string, title: string) => void;
  linkNewSession: (tabId: string, realSessionId: string) => void;
  upsertActionTab: (tab: Extract<Tab, { kind: 'action' }>) => void;
};

const sessionTabId = (sessionId: string) => `session:${sessionId}`;

const moveToFront = (order: string[], id: string) => [id, ...order.filter(x => x !== id)];

export const createTabsSlice: StateCreator<TabsSlice & SettingsSlice, [], [], TabsSlice> = (set, get) => ({
  tabs: [],
  activeTabId: null,
  mruOrder: [],
  openSessionTab: (projectId, sessionId, title, provider) => {
    const id = sessionTabId(sessionId);
    const existing = get().tabs.find(t => t.id === id || (t.kind === 'session' && t.linkedSessionId === sessionId));
    if (existing) { set({ activeTabId: existing.id, mruOrder: moveToFront(get().mruOrder, existing.id) }); return; }
    set({
      tabs: [...get().tabs, { kind: 'session', id, projectId, sessionId, title, mode: 'history', ...(provider ? { provider } : {}) }],
      activeTabId: id,
      mruOrder: moveToFront(get().mruOrder, id),
    });
  },
  openNewSessionTab: (projectId) => {
    const enabled = get().enabledProviders;
    if (enabled.length > 1) {
      const id = `picker:${crypto.randomUUID()}`;
      set({
        tabs: [...get().tabs, { kind: 'providerPicker', id, projectId, title: 'New session' }],
        activeTabId: id,
        mruOrder: moveToFront(get().mruOrder, id),
      });
      return;
    }
    get().startSessionTab(projectId, enabled[0] ?? 'claude');
  },
  startSessionTab: (projectId, provider) => {
    const sessionId = provider === 'claude' ? crypto.randomUUID() : `new-${crypto.randomUUID()}`;
    const id = sessionTabId(sessionId);
    set({
      tabs: [...get().tabs, { kind: 'session', id, projectId, sessionId, title: 'New session', mode: 'terminal', fresh: true, provider }],
      activeTabId: id,
      mruOrder: moveToFront(get().mruOrder, id),
    });
  },
  chooseProvider: (tabId, provider) => {
    const picker = get().tabs.find(t => t.id === tabId && t.kind === 'providerPicker');
    if (!picker || picker.kind !== 'providerPicker') return;
    const sessionId = provider === 'claude' ? crypto.randomUUID() : `new-${crypto.randomUUID()}`;
    const id = sessionTabId(sessionId);
    set({
      tabs: get().tabs.map(t => t.id === tabId
        ? { kind: 'session' as const, id, projectId: picker.projectId, sessionId, title: 'New session', mode: 'terminal' as const, fresh: true, provider }
        : t),
      activeTabId: id,
      mruOrder: get().mruOrder.map(x => x === tabId ? id : x),
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
