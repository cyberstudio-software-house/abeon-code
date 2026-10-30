import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

vi.mock('@tauri-apps/api/webviewWindow', () => ({
  getCurrentWebviewWindow: () => ({ onCloseRequested: async () => () => {}, destroy: async () => {}, label: 'main' }),
}));
vi.mock('../sidebar/Sidebar', () => ({ Sidebar: () => <div /> }));
vi.mock('../center/CenterPanel', () => ({
  CenterPanel: () => (
    <div data-pane-id="left">
      <div data-tab-layer="session:s1"><button>Terminal s1</button></div>
    </div>
  ),
}));
vi.mock('../supervisor/SupervisorPanel', () => ({ SupervisorPanel: () => <div /> }));
vi.mock('../right/RightPanel', () => ({ RightPanel: () => <div /> }));
vi.mock('../center/TabSwitcher', () => ({ TabSwitcher: () => <div /> }));
vi.mock('../center/ProjectLauncher', () => ({ ProjectLauncher: () => <div /> }));
vi.mock('../../lib/updater', () => ({ checkForUpdate: async () => null }));

import { useStore } from '../../store';
import { tauri } from '../../lib/tauri';
import type { AttentionEvent } from '../../lib/tauri';
import type { SessionRebound } from '../../types';
import { createLeaf } from '../../lib/paneTree';
import { processManager } from '../../lib/processManager';
import { AppShell } from './AppShell';

const sessionTab = (id: string, sessionId: string) => ({
  kind: 'session' as const, id, projectId: 1, sessionId, title: sessionId, mode: 'terminal' as const,
});

// Left pane shows s1 with s3 hidden behind it, right pane shows s2.
const twoPaneLayout = {
  kind: 'split' as const,
  id: 'outer',
  dir: 'row' as const,
  sizes: [0.5, 0.5],
  children: [
    createLeaf('left', ['session:s1', 'session:s3'], 'session:s1'),
    createLeaf('right', ['session:s2'], 'session:s2'),
  ],
};

describe('AppShell attention across panes', () => {
  let handler: (e: AttentionEvent) => void;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    vi.spyOn(tauri, 'setWindowTitle').mockResolvedValue(undefined);
    vi.spyOn(tauri, 'showAttentionNotification').mockResolvedValue(undefined);
    vi.spyOn(tauri, 'onCliOpenPath').mockResolvedValue(() => {});
    vi.spyOn(tauri, 'onNotificationActivate').mockResolvedValue(() => {});
    vi.spyOn(tauri, 'listSessions').mockResolvedValue([]);
    let captured: ((e: AttentionEvent) => void) | null = null;
    vi.spyOn(tauri, 'onSessionAttention').mockImplementation(async (cb) => {
      captured = cb;
      return () => {};
    });
    useStore.setState({
      tabs: [sessionTab('session:s1', 's1'), sessionTab('session:s2', 's2'), sessionTab('session:s3', 's3')],
      activeTabId: 'session:s1',
      layout: twoPaneLayout,
      focusedPaneId: 'left',
      attentionSessions: new Set<string>(),
      notificationsEnabled: true,
      notificationTrigger: 'both',
      sessionsByProject: {},
    });
    render(<AppShell />);
    await waitFor(() => expect(captured).not.toBeNull());
    handler = captured!;
  });

  it('links a terminal\'s new session id to the tab that owns it', async () => {
    let rebound: ((event: SessionRebound) => void) | null = null;
    vi.spyOn(tauri, 'onSupervisorSessionRebound').mockImplementation(async (cb) => {
      rebound = cb;
      return () => {};
    });
    act(() => {
      useStore.setState({ tabs: [{ ...sessionTab('session:s1', 's1'), ptyId: 'pty-1' }, sessionTab('session:s2', 's2')] });
    });
    render(<AppShell />);
    await waitFor(() => expect(rebound).not.toBeNull());
    act(() => { rebound!({ ptyId: 'pty-1', sessionId: 's9' }); });
    expect(useStore.getState().tabs.map(t => t.kind === 'session' ? t.linkedSessionId : null)).toEqual(['s9', undefined]);
  });

  it('leaves a session shown in another pane alone but flags a hidden one', () => {
    act(() => { handler({ sessionId: 's2', reason: 'hook', message: null }); });
    act(() => { handler({ sessionId: 's3', reason: 'hook', message: null }); });

    expect(useStore.getState().attentionSessions.has('s2')).toBe(false);
    expect(useStore.getState().attentionSessions.has('s3')).toBe(true);
    expect(tauri.showAttentionNotification).toHaveBeenCalledTimes(1);
    expect(tauri.showAttentionNotification).toHaveBeenCalledWith('s3', expect.any(String), expect.any(String));
  });

  it('clears attention for a session revealed by closing a tab in another pane', () => {
    act(() => {
      useStore.setState({
        tabs: [
          sessionTab('session:s1', 's1'), sessionTab('session:s2', 's2'),
          sessionTab('session:s3', 's3'), sessionTab('session:s4', 's4'),
        ],
        activeTabId: 'session:s1',
        layout: {
          kind: 'split' as const,
          id: 'outer',
          dir: 'row' as const,
          sizes: [0.5, 0.5],
          children: [
            createLeaf('left', ['session:s1', 'session:s3'], 'session:s1'),
            createLeaf('right', ['session:s2', 'session:s4'], 'session:s4'),
          ],
        },
        focusedPaneId: 'left',
      });
    });
    act(() => { useStore.setState({ attentionSessions: new Set(['s2']) }); });

    act(() => { useStore.getState().closeTab('session:s4'); });

    expect(useStore.getState().activeTabId).toBe('session:s1');
    expect(useStore.getState().attentionSessions.has('s2')).toBe(false);
  });

  it('clears attention for every visible pane when the active tab changes', () => {
    act(() => { useStore.setState({ attentionSessions: new Set(['s1', 's2', 's3']) }); });

    act(() => { useStore.getState().setActive('session:s3'); });

    const attention = useStore.getState().attentionSessions;
    expect(attention.has('s3')).toBe(false);
    expect(attention.has('s2')).toBe(false);
    expect(attention.has('s1')).toBe(true);
  });

  it('mounts the app header with the project row of the focused pane', () => {
    const header = document.querySelector('header[data-tauri-drag-region]') as HTMLElement;
    expect(header.textContent).toContain('AbeonCode');
    expect(header.querySelector('[data-project-tab-id="1"]')).not.toBeNull();
    expect(header.textContent).toContain('3 aktywne sesje');
  });

  it('toggles the drawer of the active session on mod+t', () => {
    act(() => { useStore.setState({ drawers: {}, drawerTerminals: {}, shortcutOverrides: {} }); });
    fireEvent.keyDown(document, { key: 't', ctrlKey: true });
    expect(useStore.getState().drawers['session:s1']?.open).toBe(true);
    expect(useStore.getState().tabs.some(t => t.kind === 'terminal')).toBe(false);
  });

  it('keeps the drawer open and requests focus on mod+t when DOM focus is outside it', () => {
    act(() => { useStore.setState({ drawers: {}, drawerTerminals: {}, shortcutOverrides: {} }); });
    act(() => { useStore.getState().toggleTerminalDrawer('session:s1'); });
    (document.activeElement as HTMLElement | null)?.blur();
    expect(document.activeElement).toBe(document.body);

    fireEvent.keyDown(document, { key: 't', ctrlKey: true });

    expect(useStore.getState().drawers['session:s1']).toMatchObject({ open: true, hasFocus: true, focusRequest: 1 });
  });

  it('hides the drawer on mod+t when DOM focus is inside it', () => {
    act(() => { useStore.setState({ drawers: {}, drawerTerminals: {}, shortcutOverrides: {} }); });
    act(() => { useStore.getState().toggleTerminalDrawer('session:s1'); });
    const host = document.createElement('div');
    host.setAttribute('data-drawer-owner', 'session:s1');
    const input = document.createElement('textarea');
    host.appendChild(input);
    document.body.appendChild(host);
    input.focus();
    expect(document.activeElement).toBe(input);

    fireEvent.keyDown(document, { key: 't', ctrlKey: true });

    expect(useStore.getState().drawers['session:s1']?.open).toBe(false);
    host.remove();
  });
});

describe('AppShell settings view', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    vi.spyOn(tauri, 'setWindowTitle').mockResolvedValue(undefined);
    vi.spyOn(tauri, 'onCliOpenPath').mockResolvedValue(() => {});
    vi.spyOn(tauri, 'onNotificationActivate').mockResolvedValue(() => {});
    vi.spyOn(tauri, 'onSessionAttention').mockResolvedValue(() => {});
    vi.spyOn(tauri, 'listSessions').mockResolvedValue([]);
    vi.spyOn(tauri, 'getGitUser').mockResolvedValue({ name: 'Ada Lovelace', initials: 'AL', email: 'ada@example.com' });
    vi.spyOn(tauri, 'listAvailableShells').mockResolvedValue([]);
    vi.spyOn(tauri, 'detectDefaultShell').mockResolvedValue(null);
    vi.spyOn(tauri, 'listAvailableEditors').mockResolvedValue([]);
    useStore.setState({
      tabs: [sessionTab('session:s1', 's1')],
      activeTabId: 'session:s1',
      layout: createLeaf('left', ['session:s1'], 'session:s1'),
      focusedPaneId: 'left',
      settingsOpen: false,
      settingsCategory: 'general',
    });
  });

  it('keeps the panes mounted under the settings view', async () => {
    render(<AppShell />);
    const body = screen.getByRole('separator', { name: 'Resize sidebar' }).parentElement as HTMLElement;
    const pane = document.querySelector('[data-pane-id]');
    const layer = document.querySelector('[data-tab-layer]');
    const header = document.querySelector('header[data-tauri-drag-region]') as HTMLElement;
    expect(body).not.toHaveAttribute('inert');

    await act(async () => { useStore.getState().openSettings(); });

    expect(document.querySelector('[data-pane-id]')).toBe(pane);
    expect(document.querySelector('[data-tab-layer]')).toBe(layer);
    expect(body).toHaveAttribute('inert');
    expect(layer?.closest('[inert]')).toBe(body);
    expect(screen.getByRole('navigation', { name: 'Kategorie ustawień' })).toBeInTheDocument();
    expect(within(header).getByRole('navigation', { name: 'Ścieżka' })).toHaveTextContent(/^Ustawienia\s*\/\s*Ogólne$/);
    expect(header.querySelector('[data-project-tab-id]')).toBeNull();

    await act(async () => { useStore.getState().closeSettings(); });

    expect(document.querySelector('[data-tab-layer]')).toBe(layer);
    expect(body).not.toHaveAttribute('inert');
    expect(screen.queryByRole('navigation', { name: 'Kategorie ustawień' })).toBeNull();
    expect(header.querySelector('[data-project-tab-id="1"]')).not.toBeNull();
  });

  it('blocks the shell while open and restores focus on close', async () => {
    render(<AppShell />);
    const button = screen.getByRole('button', { name: 'Terminal s1' });
    button.focus();
    expect(document.activeElement).toBe(button);

    await act(async () => { useStore.getState().openSettings(); });

    expect(document.activeElement).not.toBe(button);

    await act(async () => { fireEvent.keyDown(document, { key: 'Escape' }); });

    expect(useStore.getState().settingsOpen).toBe(false);
    expect(document.activeElement).toBe(button);
  });

  it('ignores global shortcuts while settings are open', async () => {
    const openNewSessionTab = vi.fn();
    const openTerminal = vi.fn();
    const start = vi.spyOn(processManager, 'start').mockResolvedValue(undefined);
    const action = { id: 7, projectId: 1, name: 'build', command: 'make' };
    useStore.setState({ openNewSessionTab, openTerminal, actionsByProject: { 1: [action] } } as never);
    render(<AppShell />);

    await act(async () => { useStore.getState().openSettings(); });
    fireEvent.keyDown(document, { key: 'n', ctrlKey: true });
    fireEvent.keyDown(document, { key: 't', ctrlKey: true });
    fireEvent.keyDown(document, { key: '1', ctrlKey: true });

    expect(openNewSessionTab).not.toHaveBeenCalled();
    expect(openTerminal).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();

    await act(async () => { useStore.getState().closeSettings(); });
    fireEvent.keyDown(document, { key: 'n', ctrlKey: true });
    fireEvent.keyDown(document, { key: 't', ctrlKey: true });
    fireEvent.keyDown(document, { key: '1', ctrlKey: true });

    expect(openNewSessionTab).toHaveBeenCalledWith(1);
    expect(openTerminal).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith(1, action);
  });
});
