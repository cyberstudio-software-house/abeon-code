import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from './index';
import { sessionTabFromMode, tabsFromGroupMode } from './tabsSlice';
import type { GroupWindowMode } from '../lib/windowMode';

describe('tabsSlice mruOrder', () => {
  beforeEach(() => {
    useStore.setState({ tabs: [], activeTabId: null, mruOrder: [] });
  });

  it('setActive moves the tab to the front of mruOrder', () => {
    useStore.setState({
      tabs: [
        { kind: 'terminal', id: 't1', projectId: 1, title: 'a' },
        { kind: 'terminal', id: 't2', projectId: 1, title: 'b' },
      ],
      mruOrder: ['t1', 't2'],
    });
    useStore.getState().setActive('t2');
    expect(useStore.getState().mruOrder).toEqual(['t2', 't1']);
    expect(useStore.getState().activeTabId).toBe('t2');
  });

  it('setActive does not duplicate an already-front tab', () => {
    useStore.setState({ mruOrder: ['t1', 't2'] });
    useStore.getState().setActive('t1');
    expect(useStore.getState().mruOrder).toEqual(['t1', 't2']);
  });

  it('openSessionTab promotes a new tab to the front', () => {
    useStore.setState({ mruOrder: ['t1'] });
    useStore.getState().openSessionTab(1, 'sess', 'Session');
    expect(useStore.getState().mruOrder[0]).toBe('session:sess');
  });

  it('openSessionTab focusing an existing tab promotes it', () => {
    useStore.setState({
      tabs: [
        { kind: 'session', id: 'session:sess', projectId: 1, sessionId: 'sess', title: 'S', mode: 'history' },
        { kind: 'terminal', id: 't2', projectId: 1, title: 'b' },
      ],
      mruOrder: ['t2', 'session:sess'],
    });
    useStore.getState().openSessionTab(1, 'sess', 'S');
    expect(useStore.getState().mruOrder).toEqual(['session:sess', 't2']);
  });

  it('closeTab removes the tab from mruOrder', () => {
    useStore.setState({
      tabs: [
        { kind: 'terminal', id: 't1', projectId: 1, title: 'a' },
        { kind: 'terminal', id: 't2', projectId: 1, title: 'b' },
      ],
      activeTabId: 't1',
      mruOrder: ['t1', 't2'],
    });
    useStore.getState().closeTab('t1');
    expect(useStore.getState().mruOrder).toEqual(['t2']);
  });

  it('openNewSessionTab creates a fresh tab with a real (non-placeholder) session id', () => {
    useStore.setState({ tabs: [], activeTabId: null, mruOrder: [] });
    useStore.getState().openNewSessionTab(7);
    const tab = useStore.getState().tabs[0];
    expect(tab.kind).toBe('session');
    if (tab.kind !== 'session') throw new Error('expected session tab');
    expect(tab.sessionId.startsWith('new-')).toBe(false);
    expect(tab.fresh).toBe(true);
    expect(tab.mode).toBe('terminal');
    expect(tab.id).toBe(`session:${tab.sessionId}`);
    expect(tab.sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  it('setSessionMode clears the fresh flag so re-entering terminal resumes (not re-creates)', () => {
    useStore.setState({
      tabs: [{ kind: 'session', id: 'session:uuid-x', projectId: 1, sessionId: 'uuid-x', title: 'New session', mode: 'terminal', fresh: true }],
    });
    useStore.getState().setSessionMode('session:uuid-x', 'history');
    const tab = useStore.getState().tabs[0];
    if (tab.kind !== 'session') throw new Error('expected session tab');
    expect(tab.mode).toBe('history');
    expect(tab.fresh).toBe(false);
  });

  it('upsertActionTab promotes the action tab to the front', () => {
    useStore.setState({ mruOrder: ['t1'] });
    useStore.getState().upsertActionTab({
      kind: 'action', id: 'action:5', projectId: 1, actionId: 5, title: 'Build', status: 'running',
    });
    expect(useStore.getState().mruOrder[0]).toBe('action:5');
  });
});

describe('sessionTabFromMode', () => {
  it('builds a terminal-mode session tab for a real session', () => {
    expect(sessionTabFromMode({ view: 'session', projectId: 2, sessionId: 'real-1', title: 'Hi', fresh: false })).toEqual({
      kind: 'session', id: 'session:real-1', projectId: 2, sessionId: 'real-1', title: 'Hi', mode: 'terminal',
    });
  });

  it('carries linkedSessionId and fresh flag', () => {
    expect(sessionTabFromMode({ view: 'session', projectId: 2, sessionId: 'new-1', linkedSessionId: 'real-9', title: 'Hi', fresh: true })).toEqual({
      kind: 'session', id: 'session:new-1', projectId: 2, sessionId: 'new-1', linkedSessionId: 'real-9', title: 'Hi', mode: 'terminal', fresh: true,
    });
  });
});

describe('tabsSlice navHistory', () => {
  beforeEach(() => {
    useStore.setState({ tabs: [], activeTabId: null, mruOrder: [], navHistory: [], navIndex: 0 });
  });

  const term = (id: string) => ({ kind: 'terminal' as const, id, projectId: 1, title: id });

  it('setActive pushes onto the navigation history', () => {
    useStore.setState({ tabs: [term('t1'), term('t2')] });
    useStore.getState().setActive('t1');
    useStore.getState().setActive('t2');
    expect(useStore.getState().navHistory).toEqual(['t1', 't2']);
    expect(useStore.getState().navIndex).toBe(1);
  });

  it('goBack moves the cursor without mutating navHistory', () => {
    useStore.setState({ tabs: [term('t1'), term('t2')], navHistory: ['t1', 't2'], navIndex: 1, mruOrder: ['t2', 't1'] });
    useStore.getState().goBack();
    expect(useStore.getState().activeTabId).toBe('t1');
    expect(useStore.getState().navIndex).toBe(0);
    expect(useStore.getState().navHistory).toEqual(['t1', 't2']);
    expect(useStore.getState().mruOrder[0]).toBe('t1');
  });

  it('goForward returns to the later tab', () => {
    useStore.setState({ tabs: [term('t1'), term('t2')], navHistory: ['t1', 't2'], navIndex: 0 });
    useStore.getState().goForward();
    expect(useStore.getState().activeTabId).toBe('t2');
    expect(useStore.getState().navIndex).toBe(1);
  });

  it('goBack at the start boundary is a no-op', () => {
    useStore.setState({ tabs: [term('t1')], navHistory: ['t1'], navIndex: 0, activeTabId: 't1' });
    useStore.getState().goBack();
    expect(useStore.getState().activeTabId).toBe('t1');
    expect(useStore.getState().navIndex).toBe(0);
  });

  it('activating a tab after goBack discards the forward branch', () => {
    useStore.setState({ tabs: [term('t1'), term('t2'), term('t3')], navHistory: ['t1', 't2'], navIndex: 1 });
    useStore.getState().goBack();              // cursor -> t1
    useStore.getState().setActive('t3');       // new navigation from t1
    expect(useStore.getState().navHistory).toEqual(['t1', 't3']);
    expect(useStore.getState().navIndex).toBe(1);
  });

  it('closeTab prunes the closed tab from navHistory', () => {
    useStore.setState({ tabs: [term('t1'), term('t2')], activeTabId: 't2', navHistory: ['t1', 't2'], navIndex: 1, mruOrder: ['t2', 't1'] });
    useStore.getState().closeTab('t2');
    expect(useStore.getState().navHistory).toEqual(['t1']);
    expect(useStore.getState().navIndex).toBe(0);
  });

  it('openSessionTab pushes the new tab onto navHistory', () => {
    useStore.getState().openSessionTab(1, 'sess', 'Session');
    expect(useStore.getState().navHistory).toEqual(['session:sess']);
    expect(useStore.getState().navIndex).toBe(0);
  });

  it('closing the active tab aligns the cursor to the fallback active tab', () => {
    useStore.setState({
      tabs: [term('a'), term('b'), term('c')],
      activeTabId: 'b',
      navHistory: ['c', 'a', 'b'],
      navIndex: 2,
      mruOrder: ['b', 'a', 'c'],
    });
    useStore.getState().closeTab('b');
    const s = useStore.getState();
    expect(s.activeTabId).toBe('c');
    expect(s.navHistory[s.navIndex]).toBe('c');
  });

  it('chooseProvider renames the picker id in navHistory without duplicating', () => {
    useStore.setState({ enabledProviders: ['claude', 'codex'] });
    useStore.getState().openNewSessionTab(1);
    const pickerId = useStore.getState().tabs[0].id;
    expect(useStore.getState().navHistory).toEqual([pickerId]);
    useStore.getState().chooseProvider(pickerId, 'codex');
    const newId = useStore.getState().tabs[0].id;
    expect(useStore.getState().navHistory).toEqual([newId]);
  });
});

describe('tabsSlice provider picker', () => {
  beforeEach(() => {
    useStore.setState({ tabs: [], activeTabId: null, mruOrder: [], enabledProviders: ['claude'] });
  });

  it('single provider: New session spawns a fresh claude tab directly', () => {
    useStore.getState().openNewSessionTab(1);
    const tab = useStore.getState().tabs[0];
    expect(tab.kind).toBe('session');
    if (tab.kind !== 'session') return;
    expect(tab.fresh).toBe(true);
    expect(tab.provider).toBe('claude');
    expect(tab.sessionId.startsWith('new-')).toBe(false);
  });

  it('single codex provider: fresh tab uses a new- placeholder id', () => {
    useStore.setState({ enabledProviders: ['codex'] });
    useStore.getState().openNewSessionTab(1);
    const tab = useStore.getState().tabs[0];
    if (tab.kind !== 'session') throw new Error('expected session tab');
    expect(tab.provider).toBe('codex');
    expect(tab.sessionId.startsWith('new-')).toBe(true);
  });

  it('multiple providers: New session opens a picker tab', () => {
    useStore.setState({ enabledProviders: ['claude', 'codex'] });
    useStore.getState().openNewSessionTab(1);
    const tab = useStore.getState().tabs[0];
    expect(tab.kind).toBe('providerPicker');
    expect(useStore.getState().activeTabId).toBe(tab.id);
  });

  it('chooseProvider replaces the picker with a fresh session tab in place', () => {
    useStore.setState({ enabledProviders: ['claude', 'codex'] });
    useStore.getState().openNewSessionTab(1);
    const pickerId = useStore.getState().tabs[0].id;
    useStore.getState().chooseProvider(pickerId, 'codex');
    const tabs = useStore.getState().tabs;
    expect(tabs).toHaveLength(1);
    const tab = tabs[0];
    if (tab.kind !== 'session') throw new Error('expected session tab');
    expect(tab.provider).toBe('codex');
    expect(tab.fresh).toBe(true);
    expect(tab.sessionId.startsWith('new-')).toBe(true);
    expect(useStore.getState().activeTabId).toBe(tab.id);
  });

  it('chooseProvider keeps the picker position in the tab strip', () => {
    useStore.setState({ enabledProviders: ['claude', 'codex'] });
    useStore.getState().openNewTerminalTab(1);
    useStore.getState().openNewSessionTab(1);
    useStore.getState().openNewTerminalTab(1);
    const pickerId = useStore.getState().tabs[1].id;
    useStore.getState().chooseProvider(pickerId, 'claude');
    const tabs = useStore.getState().tabs;
    expect(tabs).toHaveLength(3);
    expect(tabs[1].kind).toBe('session');
  });
});

describe('tabsSlice preview tabs', () => {
  beforeEach(() => {
    useStore.setState({ tabs: [], activeTabId: null, mruOrder: [], navHistory: [], navIndex: 0 });
  });

  it('opening an older session marks the tab as preview', () => {
    useStore.getState().openSessionTab(1, 'a', 'A');
    const tab = useStore.getState().tabs[0];
    if (tab.kind !== 'session') throw new Error('expected session tab');
    expect(tab.preview).toBe(true);
    expect(tab.mode).toBe('history');
  });

  it('browsing another older session reuses the preview slot instead of opening a new tab', () => {
    useStore.getState().openSessionTab(1, 'a', 'A');
    useStore.getState().openSessionTab(1, 'b', 'B');
    const tabs = useStore.getState().tabs;
    expect(tabs).toHaveLength(1);
    const tab = tabs[0];
    if (tab.kind !== 'session') throw new Error('expected session tab');
    expect(tab.sessionId).toBe('b');
    expect(tab.id).toBe('session:b');
    expect(tab.preview).toBe(true);
    expect(useStore.getState().activeTabId).toBe('session:b');
  });

  it('reusing the preview slot swaps its id in navHistory without duplicating', () => {
    useStore.getState().openSessionTab(1, 'a', 'A');
    useStore.getState().openSessionTab(1, 'b', 'B');
    expect(useStore.getState().navHistory).toEqual(['session:b']);
    expect(useStore.getState().navIndex).toBe(0);
    expect(useStore.getState().mruOrder).toEqual(['session:b']);
  });

  it('continuing in terminal pins the tab so the next older session opens beside it', () => {
    useStore.getState().openSessionTab(1, 'a', 'A');
    useStore.getState().setSessionMode('session:a', 'terminal');
    const pinned = useStore.getState().tabs[0];
    if (pinned.kind !== 'session') throw new Error('expected session tab');
    expect(pinned.preview).toBe(false);

    useStore.getState().openSessionTab(1, 'b', 'B');
    const tabs = useStore.getState().tabs;
    expect(tabs).toHaveLength(2);
    expect(tabs.map(t => t.id)).toEqual(['session:a', 'session:b']);
  });

  it('clicking a session that already has a pinned tab just activates it', () => {
    useStore.getState().openSessionTab(1, 'a', 'A');
    useStore.getState().setSessionMode('session:a', 'terminal');
    useStore.getState().openNewTerminalTab(1);
    useStore.getState().openSessionTab(1, 'a', 'A');
    const tabs = useStore.getState().tabs;
    expect(tabs).toHaveLength(2);
    expect(useStore.getState().activeTabId).toBe('session:a');
  });
});

describe('tabsSlice viewSubagent', () => {
  const sessionTab = { kind: 'session' as const, id: 'session:s1', projectId: 1, sessionId: 's1', title: 'S', mode: 'history' as const };

  beforeEach(() => {
    useStore.setState({ tabs: [sessionTab, { kind: 'terminal', id: 'session:s1-other', projectId: 1, title: 'T' }] });
  });

  it('sets viewingSubagentId on the matching session tab', () => {
    useStore.getState().viewSubagent('session:s1', 'agent-7');
    const tab = useStore.getState().tabs[0];
    if (tab.kind !== 'session') throw new Error('expected session tab');
    expect(tab.viewingSubagentId).toBe('agent-7');
  });

  it('drops the key entirely when agentId is null', () => {
    useStore.getState().viewSubagent('session:s1', 'agent-7');
    useStore.getState().viewSubagent('session:s1', null);
    const tab = useStore.getState().tabs[0];
    expect('viewingSubagentId' in tab).toBe(false);
  });

  it('leaves tabs of another kind and non-matching ids untouched', () => {
    useStore.getState().viewSubagent('session:s1-other', 'agent-7');
    useStore.getState().viewSubagent('session:nope', 'agent-7');
    expect(useStore.getState().tabs).toEqual([
      sessionTab,
      { kind: 'terminal', id: 'session:s1-other', projectId: 1, title: 'T' },
    ]);
  });
});

describe('tabsFromGroupMode', () => {
  it('maps the payload back to tabs and stamps the projectId', () => {
    const mode: GroupWindowMode = {
      view: 'group',
      projectId: 5,
      activeTabId: 'terminal:t1',
      tabs: [
        { kind: 'session', id: 'session:s1', sessionId: 's1', title: 'S', mode: 'history' },
        { kind: 'action', id: 'action:4', actionId: 4, title: 'dev', status: 'running', ptyId: 'pty-9' },
        { kind: 'terminal', id: 'terminal:t1', title: 'Terminal' },
      ],
    };
    expect(tabsFromGroupMode(mode)).toEqual([
      { kind: 'session', id: 'session:s1', projectId: 5, sessionId: 's1', title: 'S', mode: 'history' },
      { kind: 'action', id: 'action:4', projectId: 5, actionId: 4, title: 'dev', status: 'running' },
      { kind: 'terminal', id: 'terminal:t1', projectId: 5, title: 'Terminal' },
    ]);
  });
});

describe('tabsSlice detachTabs', () => {
  beforeEach(() => {
    useStore.setState({
      tabs: [
        { kind: 'terminal', id: 'a', projectId: 1, title: 'A' },
        { kind: 'terminal', id: 'b', projectId: 2, title: 'B' },
        { kind: 'terminal', id: 'c', projectId: 1, title: 'C' },
      ],
      activeTabId: 'c',
      mruOrder: ['c', 'b', 'a'],
      navHistory: ['a', 'b', 'c'],
      navIndex: 2,
    });
  });

  it('removes the given tabs and moves the active one to a survivor', () => {
    useStore.getState().detachTabs(['a', 'c']);
    const s = useStore.getState();
    expect(s.tabs.map(t => t.id)).toEqual(['b']);
    expect(s.activeTabId).toBe('b');
    expect(s.mruOrder).toEqual(['b']);
    expect(s.navHistory).toEqual(['b']);
    expect(s.navIndex).toBe(0);
  });

  it('keeps the active tab when it is not detached', () => {
    useStore.getState().detachTabs(['a']);
    const s = useStore.getState();
    expect(s.tabs.map(t => t.id)).toEqual(['b', 'c']);
    expect(s.activeTabId).toBe('c');
  });

  it('nulls the active tab when everything is detached', () => {
    useStore.getState().detachTabs(['a', 'b', 'c']);
    const s = useStore.getState();
    expect(s.tabs).toEqual([]);
    expect(s.activeTabId).toBeNull();
  });
});
