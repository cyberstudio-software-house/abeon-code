import type { StateCreator } from 'zustand';
import type { GroupWindowMode, SessionWindowMode } from '../lib/windowMode';
import type { Provider } from '../types';
import type { SettingsSlice } from './settingsSlice';
import type { AppState } from './index';
import { pushNav, stepBack, stepForward, pruneNav } from '../lib/navHistory';

export type Tab =
  | { kind: 'session'; id: string; projectId: number; sessionId: string; linkedSessionId?: string; title: string; mode: 'history' | 'terminal'; fresh?: boolean; preview?: boolean; provider?: Provider }
  | { kind: 'action'; id: string; projectId: number; actionId: number; title: string; status: 'running' | 'exited'; exitCode?: number }
  | { kind: 'terminal'; id: string; projectId: number; title: string }
  | { kind: 'providerPicker'; id: string; projectId: number; title: string };

export type TabsSlice = {
  tabs: Tab[];
  activeTabId: string | null;
  mruOrder: string[];
  navHistory: string[];
  navIndex: number;
  activeAgentPtyId: string | null;
  setActiveAgentPtyId: (id: string | null) => void;
  openSessionTab: (projectId: number, sessionId: string, title: string, provider?: Provider) => void;
  openNewSessionTab: (projectId: number) => void;
  openNewTerminalTab: (projectId: number) => void;
  startSessionTab: (projectId: number, provider: Provider) => void;
  chooseProvider: (tabId: string, provider: Provider) => void;
  setSessionMode: (tabId: string, mode: 'history' | 'terminal') => void;
  closeTab: (id: string) => void;
  detachTabs: (ids: string[]) => void;
  setActive: (id: string) => void;
  goBack: () => void;
  goForward: () => void;
  renameTab: (id: string, title: string) => void;
  linkNewSession: (tabId: string, realSessionId: string) => void;
  upsertActionTab: (tab: Extract<Tab, { kind: 'action' }>) => void;
};

const sessionTabId = (sessionId: string) => `session:${sessionId}`;

export function selectActiveSession(
  state: Pick<TabsSlice, 'tabs' | 'activeTabId'>,
): { sessionId: string; provider: Provider } | null {
  const tab = state.tabs.find(t => t.id === state.activeTabId);
  if (!tab || tab.kind !== 'session') return null;
  return { sessionId: tab.linkedSessionId ?? tab.sessionId, provider: tab.provider ?? 'claude' };
}

export function sessionTabFromMode(mode: SessionWindowMode): Extract<Tab, { kind: 'session' }> {
  return {
    kind: 'session',
    id: sessionTabId(mode.sessionId),
    projectId: mode.projectId,
    sessionId: mode.sessionId,
    ...(mode.linkedSessionId ? { linkedSessionId: mode.linkedSessionId } : {}),
    title: mode.title,
    mode: 'terminal',
    ...(mode.fresh ? { fresh: true } : {}),
    ...(mode.provider ? { provider: mode.provider } : {}),
  };
}

export function tabsFromGroupMode(mode: GroupWindowMode): Tab[] {
  return mode.tabs.map((t): Tab => {
    if (t.kind === 'session') {
      return {
        kind: 'session',
        id: t.id,
        projectId: mode.projectId,
        sessionId: t.sessionId,
        ...(t.linkedSessionId ? { linkedSessionId: t.linkedSessionId } : {}),
        title: t.title,
        mode: t.mode,
        ...(t.fresh ? { fresh: true } : {}),
        ...(t.preview ? { preview: true } : {}),
        ...(t.provider ? { provider: t.provider } : {}),
      };
    }
    if (t.kind === 'action') {
      return {
        kind: 'action',
        id: t.id,
        projectId: mode.projectId,
        actionId: t.actionId,
        title: t.title,
        status: t.status,
        ...(t.exitCode != null ? { exitCode: t.exitCode } : {}),
      };
    }
    if (t.kind === 'terminal') {
      return { kind: 'terminal', id: t.id, projectId: mode.projectId, title: t.title };
    }
    return { kind: 'providerPicker', id: t.id, projectId: mode.projectId, title: t.title };
  });
}

const moveToFront = (order: string[], id: string) => [id, ...order.filter(x => x !== id)];

const withNav = (get: () => TabsSlice, id: string) => {
  const nav = pushNav({ history: get().navHistory, index: get().navIndex }, id);
  return { navHistory: nav.history, navIndex: nav.index };
};

export const createTabsSlice: StateCreator<TabsSlice & SettingsSlice, [], [], TabsSlice> = (set, get) => ({
  tabs: [],
  activeTabId: null,
  mruOrder: [],
  navHistory: [],
  navIndex: 0,
  activeAgentPtyId: null,
  setActiveAgentPtyId: (id) => set({ activeAgentPtyId: id }),
  openSessionTab: (projectId, sessionId, title, provider) => {
    const id = sessionTabId(sessionId);
    const existing = get().tabs.find(t => t.id === id || (t.kind === 'session' && t.linkedSessionId === sessionId));
    if (existing) { set({ activeTabId: existing.id, mruOrder: moveToFront(get().mruOrder, existing.id), ...withNav(get, existing.id) }); return; }
    const tab: Tab = { kind: 'session', id, projectId, sessionId, title, mode: 'history', preview: true, ...(provider ? { provider } : {}) };
    const preview = get().tabs.find(t => t.kind === 'session' && t.preview);
    if (preview) {
      const nav = pushNav(pruneNav({ history: get().navHistory, index: get().navIndex }, preview.id), id);
      set({
        tabs: get().tabs.map(t => t.id === preview.id ? tab : t),
        activeTabId: id,
        mruOrder: moveToFront(get().mruOrder.filter(x => x !== preview.id), id),
        navHistory: nav.history,
        navIndex: nav.index,
      });
      return;
    }
    set({
      tabs: [...get().tabs, tab],
      activeTabId: id,
      mruOrder: moveToFront(get().mruOrder, id),
      ...withNav(get, id),
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
        ...withNav(get, id),
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
      ...withNav(get, id),
    });
    (get() as AppState).scheduleNewSessionRefresh(projectId);
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
      navHistory: get().navHistory.map(x => x === tabId ? id : x),
    });
    (get() as AppState).scheduleNewSessionRefresh(picker.projectId);
  },
  openNewTerminalTab: (projectId) => {
    const id = `terminal:${crypto.randomUUID()}`;
    set({
      tabs: [...get().tabs, { kind: 'terminal', id, projectId, title: 'Terminal' }],
      activeTabId: id,
      mruOrder: moveToFront(get().mruOrder, id),
      ...withNav(get, id),
    });
  },
  setSessionMode: (tabId, mode) => set({
    tabs: get().tabs.map(t => t.id === tabId && t.kind === 'session' ? { ...t, mode, fresh: false, preview: false } : t),
  }),
  closeTab: (id) => {
    const tabs = get().tabs.filter(t => t.id !== id);
    const mruOrder = get().mruOrder.filter(x => x !== id);
    const wasActive = get().activeTabId === id;
    const activeTabId = wasActive ? (tabs[tabs.length - 1]?.id ?? null) : get().activeTabId;
    let nav = pruneNav({ history: get().navHistory, index: get().navIndex }, id);
    if (wasActive && activeTabId) {
      const idx = nav.history.lastIndexOf(activeTabId);
      if (idx !== -1) nav = { history: nav.history, index: idx };
    }
    set({ tabs, activeTabId, mruOrder, navHistory: nav.history, navIndex: nav.index });
  },
  detachTabs: (ids) => {
    const removed = new Set(ids);
    const tabs = get().tabs.filter(t => !removed.has(t.id));
    const mruOrder = get().mruOrder.filter(x => !removed.has(x));
    const prevActive = get().activeTabId;
    const wasActive = !!prevActive && removed.has(prevActive);
    const activeTabId = wasActive ? (tabs[tabs.length - 1]?.id ?? null) : prevActive;
    let nav = { history: get().navHistory, index: get().navIndex };
    for (const id of ids) nav = pruneNav(nav, id);
    if (wasActive && activeTabId) {
      const idx = nav.history.lastIndexOf(activeTabId);
      if (idx !== -1) nav = { history: nav.history, index: idx };
    }
    set({ tabs, activeTabId, mruOrder, navHistory: nav.history, navIndex: nav.index });
  },
  setActive: (id) => set({ activeTabId: id, mruOrder: moveToFront(get().mruOrder, id), ...withNav(get, id) }),
  goBack: () => {
    const step = stepBack({ history: get().navHistory, index: get().navIndex });
    if (!step) return;
    set({ navIndex: step.index, activeTabId: step.targetId, mruOrder: moveToFront(get().mruOrder, step.targetId) });
  },
  goForward: () => {
    const step = stepForward({ history: get().navHistory, index: get().navIndex });
    if (!step) return;
    set({ navIndex: step.index, activeTabId: step.targetId, mruOrder: moveToFront(get().mruOrder, step.targetId) });
  },
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
    const nav = withNav(get, tab.id);
    if (existing) {
      set({ tabs: get().tabs.map(t => t.id === tab.id ? tab : t), activeTabId: tab.id, mruOrder, ...nav });
    } else {
      set({ tabs: [...get().tabs, tab], activeTabId: tab.id, mruOrder, ...nav });
    }
  },
});
