import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';

const { onCloseRequested, destroy } = vi.hoisted(() => ({
  onCloseRequested: vi.fn(),
  destroy: vi.fn(),
}));

vi.mock('@tauri-apps/api/webviewWindow', () => ({
  getCurrentWebviewWindow: () => ({ onCloseRequested, destroy, label: 'main' }),
}));
vi.mock('../sidebar/Sidebar', () => ({ Sidebar: () => <div /> }));
vi.mock('../center/CenterPanel', () => ({ CenterPanel: () => <div /> }));
vi.mock('../right/RightPanel', () => ({ RightPanel: () => <div /> }));
vi.mock('./TitleBar', () => ({ TitleBar: () => <div /> }));
vi.mock('../center/TabSwitcher', () => ({ TabSwitcher: () => <div /> }));
vi.mock('../center/ProjectLauncher', () => ({ ProjectLauncher: () => <div /> }));
vi.mock('../../lib/updater', () => ({ checkForUpdate: async () => null }));

import { useStore } from '../../store';
import { tauri } from '../../lib/tauri';
import { createLeaf } from '../../lib/paneTree';
import { ROOT_PANE_ID } from '../../store/panesSlice';
import { AppShell } from './AppShell';

const sessionTab = (sessionId: string, mode: 'history' | 'terminal') => ({
  kind: 'session' as const, id: `session:${sessionId}`, projectId: 1, sessionId, title: `Sesja ${sessionId}`, mode,
});

function seed(modes: Record<string, 'history' | 'terminal'>, pendingResumeTabIds: string[] = []) {
  const tabs = Object.entries(modes).map(([sessionId, mode]) => sessionTab(sessionId, mode));
  useStore.setState({
    tabs,
    activeTabId: tabs[0]?.id ?? null,
    layout: createLeaf(ROOT_PANE_ID, tabs.map(t => t.id), tabs[0]?.id ?? null),
    focusedPaneId: ROOT_PANE_ID,
    pendingResumeTabIds,
    runningActions: {},
    drawers: {},
    drawerTerminals: {},
    projects: [{ id: 1, name: 'Alfa', path: '/a' }] as never,
  });
}

const modeOf = (sessionId: string) => {
  const tab = useStore.getState().tabs.find(t => t.id === `session:${sessionId}`);
  return tab?.kind === 'session' ? tab.mode : undefined;
};

const closeRequest = () => {
  const event = { preventDefault: vi.fn() };
  act(() => { onCloseRequested.mock.calls[0][0](event); });
  return event;
};

describe('AppShell lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    onCloseRequested.mockResolvedValue(() => {});
    vi.spyOn(tauri, 'setWindowTitle').mockResolvedValue(undefined);
    vi.spyOn(tauri, 'onCliOpenPath').mockResolvedValue(() => {});
    vi.spyOn(tauri, 'onNotificationActivate').mockResolvedValue(() => {});
    vi.spyOn(tauri, 'onSessionAttention').mockResolvedValue(() => {});
    vi.spyOn(tauri, 'listSessions').mockResolvedValue([]);
  });

  describe('session restore prompt', () => {
    it('offers the queued sessions with their project name', () => {
      seed({ a: 'history', b: 'history' }, ['session:a']);
      render(<AppShell />);

      expect(screen.getByText('Wznowić sesje sprzed zamknięcia?')).toBeTruthy();
      expect(screen.getByText('Sesja a')).toBeTruthy();
      expect(screen.getByText('Alfa')).toBeTruthy();
      expect(screen.queryByText('Sesja b')).toBeNull();
    });

    it('stays out of the way when nothing is queued', () => {
      seed({ a: 'history' });
      render(<AppShell />);

      expect(screen.queryByText('Wznowić sesje sprzed zamknięcia?')).toBeNull();
    });

    it('resumes the queued sessions and closes on confirmation', () => {
      seed({ a: 'history', b: 'history' }, ['session:a']);
      render(<AppShell />);

      fireEvent.click(screen.getByText('Wznów'));

      expect(modeOf('a')).toBe('terminal');
      expect(modeOf('b')).toBe('history');
      expect(screen.queryByText('Wznowić sesje sprzed zamknięcia?')).toBeNull();
    });

    it('leaves the sessions in history when declined', () => {
      seed({ a: 'history' }, ['session:a']);
      render(<AppShell />);

      fireEvent.click(screen.getByText('Nie teraz'));

      expect(modeOf('a')).toBe('history');
      expect(screen.queryByText('Wznowić sesje sprzed zamknięcia?')).toBeNull();
    });
  });

  describe('close guard', () => {
    it('lets the window close when no process is running', () => {
      seed({ a: 'history' });
      render(<AppShell />);

      const event = closeRequest();

      expect(event.preventDefault).not.toHaveBeenCalled();
      expect(screen.queryByText('Zamknąć AbeonCode?')).toBeNull();
    });

    it('asks before closing while a session is running', () => {
      seed({ a: 'terminal' });
      render(<AppShell />);

      const event = closeRequest();

      expect(event.preventDefault).toHaveBeenCalled();
      expect(screen.getByText('Zamknąć AbeonCode?')).toBeTruthy();
      expect(destroy).not.toHaveBeenCalled();
    });

    it('keeps the window and its sessions when the close is cancelled', () => {
      seed({ a: 'terminal' });
      render(<AppShell />);
      closeRequest();

      fireEvent.click(screen.getByText('Anuluj'));

      expect(screen.queryByText('Zamknąć AbeonCode?')).toBeNull();
      expect(modeOf('a')).toBe('terminal');
      expect(destroy).not.toHaveBeenCalled();
    });

    it('ends the sessions but keeps them saved as live when the close is confirmed', () => {
      seed({ a: 'terminal', b: 'history' });
      render(<AppShell />);
      closeRequest();

      fireEvent.click(screen.getByText('Zamknij'));

      const saved = JSON.parse(localStorage.getItem('abeoncode.tabs')!) as { tabs: { id: string; live?: boolean }[] };
      expect(useStore.getState().tabs).toEqual([]);
      expect(destroy).toHaveBeenCalledTimes(1);
      expect(saved.tabs.map(t => t.id)).toEqual(['session:a', 'session:b']);
      expect(saved.tabs.filter(t => t.live).map(t => t.id)).toEqual(['session:a']);
    });
  });
});
