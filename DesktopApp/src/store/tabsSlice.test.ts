import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from './index';
import { sessionTabFromMode } from './tabsSlice';

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
