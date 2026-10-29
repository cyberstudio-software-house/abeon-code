import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from './index';
import { ROOT_PANE_ID } from './panesSlice';
import { createLeaf } from '../lib/paneTree';
import type { Tab } from './tabsSlice';

const session = (id: string, projectId = 1): Tab => ({
  kind: 'session', id, projectId, sessionId: id.replace('session:', ''), title: id, mode: 'terminal',
});

const panelOpen = () => useStore.getState().supervisorPanelOpen;

beforeEach(() => {
  useStore.setState({
    tabs: [session('session:a'), session('session:b')],
    activeTabId: 'session:a',
    mruOrder: ['session:a', 'session:b'],
    navHistory: ['session:b', 'session:a'],
    navIndex: 1,
    layout: createLeaf(ROOT_PANE_ID, ['session:a', 'session:b'], 'session:a'),
    focusedPaneId: ROOT_PANE_ID,
    drawers: {},
    drawerTerminals: {},
    enabledProviders: ['claude'],
    supervisorPanelOpen: true,
  });
});

describe('opening a tab while the supervisor panel is open', () => {
  it('closes the panel when the already active session is clicked', () => {
    useStore.getState().openSessionTab(1, 'a', 'A');
    expect(panelOpen()).toBe(false);
  });

  it('closes the panel when another session opens', () => {
    useStore.getState().openSessionTab(1, 'c', 'C');
    expect(panelOpen()).toBe(false);
    expect(useStore.getState().activeTabId).toBe('session:c');
  });

  it('closes the panel when a new session starts', () => {
    useStore.getState().openNewSessionTab(1);
    expect(panelOpen()).toBe(false);
  });

  it('closes the panel when a terminal tab opens', () => {
    useStore.getState().openNewTerminalTab(2);
    expect(panelOpen()).toBe(false);
  });

  it('closes the panel when the active session shows its terminal drawer', () => {
    useStore.getState().openTerminal(1, { toggle: false });
    expect(panelOpen()).toBe(false);
  });

  it('closes the panel when a tab is activated', () => {
    useStore.getState().setActive('session:b');
    expect(panelOpen()).toBe(false);
  });

  it('closes the panel when navigating back', () => {
    useStore.getState().goBack();
    expect(panelOpen()).toBe(false);
    expect(useStore.getState().activeTabId).toBe('session:b');
  });

  it('keeps the panel open when a session starts in the background', () => {
    useStore.getState().startBackgroundSessionTab(1, 'prompt');
    expect(panelOpen()).toBe(true);
  });
});
