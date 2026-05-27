import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from './index';

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

  it('upsertActionTab promotes the action tab to the front', () => {
    useStore.setState({ mruOrder: ['t1'] });
    useStore.getState().upsertActionTab({
      kind: 'action', id: 'action:5', projectId: 1, actionId: 5, title: 'Build', status: 'running',
    });
    expect(useStore.getState().mruOrder[0]).toBe('action:5');
  });
});
