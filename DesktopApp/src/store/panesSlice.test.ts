import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from './index';
import { ROOT_PANE_ID } from './panesSlice';
import { createLeaf, findLeaf, leaves } from '../lib/paneTree';
import type { Tab } from './tabsSlice';

const sessionTab = (id: string): Tab => ({
  kind: 'session', id, projectId: 1, sessionId: id, title: id, mode: 'history',
});

describe('panesSlice', () => {
  beforeEach(() => {
    useStore.setState({
      tabs: [], activeTabId: null, mruOrder: [], navHistory: [], navIndex: 0,
      layout: createLeaf(ROOT_PANE_ID), focusedPaneId: ROOT_PANE_ID,
    });
  });

  it('places a newly opened tab in the focused pane', () => {
    useStore.getState().openSessionTab(1, 's1', 'Sesja');
    expect(findLeaf(useStore.getState().layout, ROOT_PANE_ID)?.tabIds).toEqual(['session:s1']);
    expect(useStore.getState().activeTabId).toBe('session:s1');
  });

  it('splits a pane and moves the tab into the new one', () => {
    useStore.setState({ tabs: [sessionTab('t1'), sessionTab('t2')], activeTabId: 't1' });
    useStore.getState().splitPaneWithTab(ROOT_PANE_ID, 'row', false, 't2');
    const paneIds = leaves(useStore.getState().layout).map(l => l.id);
    expect(paneIds).toHaveLength(2);
    expect(findLeaf(useStore.getState().layout, paneIds[0])?.tabIds).toEqual(['t1']);
    expect(findLeaf(useStore.getState().layout, paneIds[1])?.tabIds).toEqual(['t2']);
    expect(useStore.getState().focusedPaneId).toBe(paneIds[1]);
    expect(useStore.getState().activeTabId).toBe('t2');
  });

  it('refuses to split a pane holding a single tab', () => {
    useStore.setState({ tabs: [sessionTab('t1')], activeTabId: 't1' });
    useStore.getState().splitPaneWithTab(ROOT_PANE_ID, 'row', false, 't1');
    expect(leaves(useStore.getState().layout)).toHaveLength(1);
    expect(leaves(useStore.getState().layout)[0].id).toBe(ROOT_PANE_ID);
  });

  it('collapses a pane when its last tab is closed', () => {
    useStore.setState({ tabs: [sessionTab('t1'), sessionTab('t2')], activeTabId: 't1' });
    useStore.getState().splitPaneWithTab(ROOT_PANE_ID, 'row', false, 't2');
    useStore.getState().closeTab('t2');
    expect(leaves(useStore.getState().layout)).toHaveLength(1);
    expect(useStore.getState().activeTabId).toBe('t1');
  });

  it('moves focus to the pane owning a tab activated from elsewhere', () => {
    useStore.setState({ tabs: [sessionTab('t1'), sessionTab('t2')], activeTabId: 't1' });
    useStore.getState().splitPaneWithTab(ROOT_PANE_ID, 'row', false, 't2');
    const [first] = leaves(useStore.getState().layout).map(l => l.id);
    useStore.getState().setActive('t1');
    expect(useStore.getState().focusedPaneId).toBe(first);
  });

  it('keeps one preview slot per pane', () => {
    useStore.getState().openSessionTab(1, 's1', 'Pierwsza');
    useStore.getState().openSessionTab(1, 's2', 'Druga');
    expect(useStore.getState().tabs.map(t => t.id)).toEqual(['session:s2']);

    useStore.setState({ tabs: [sessionTab('keep'), ...useStore.getState().tabs] });
    useStore.getState().splitPaneWithTab(useStore.getState().focusedPaneId, 'row', false, 'keep');
    useStore.getState().openSessionTab(1, 's3', 'Trzecia');
    expect(useStore.getState().tabs.map(t => t.id).sort()).toEqual(['keep', 'session:s2', 'session:s3'].sort());
  });
});
