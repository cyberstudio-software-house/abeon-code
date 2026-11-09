import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const { onCloseRequested, destroy, checkForUpdate, toastError } = vi.hoisted(() => ({
  onCloseRequested: vi.fn(),
  destroy: vi.fn(),
  checkForUpdate: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('@tauri-apps/api/webviewWindow', () => ({
  getCurrentWebviewWindow: () => ({ onCloseRequested, destroy, label: 'main' }),
}));
vi.mock('../sidebar/Sidebar', () => ({ Sidebar: () => <div /> }));
vi.mock('../center/CenterPanel', () => ({ CenterPanel: () => <div /> }));
vi.mock('../supervisor/SupervisorPanel', () => ({ SupervisorPanel: () => <div /> }));
vi.mock('../right/RightPanel', () => ({ RightPanel: () => <div /> }));
vi.mock('../center/TabSwitcher', () => ({ TabSwitcher: () => <div /> }));
vi.mock('../center/ProjectLauncher', () => ({ ProjectLauncher: () => <div /> }));
vi.mock('../../lib/updater', () => ({ checkForUpdate }));
vi.mock('sonner', () => ({ toast: { error: toastError } }));

import { useStore } from '../../store';
import { tauri } from '../../lib/tauri';
import { createLeaf } from '../../lib/paneTree';
import { ROOT_PANE_ID } from '../../store/panesSlice';
import type { Note } from '../../types';
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

const savedNote: Note = { id: 5, projectId: 1, content: 'X', createdAt: 1, updatedAt: 1 };

function seedDirtyNote() {
  useStore.setState({ noteDrafts: {} });
  useStore.getState().openNoteInPanel(savedNote);
  const key = Object.keys(useStore.getState().noteDrafts)[0];
  useStore.getState().editNoteDraft(key, 'XY');
}

const closeRequest = () => {
  const event = { preventDefault: vi.fn() };
  act(() => { onCloseRequested.mock.calls[0][0](event); });
  return event;
};

describe('AppShell lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    checkForUpdate.mockResolvedValue(null);
    useStore.setState({ noteDrafts: {} });
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
      expect(within(screen.getByText('Sesja a').closest('li') as HTMLElement).getByText('Alfa')).toBeTruthy();
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

    it('saves pending notes before closing', async () => {
      seed({ a: 'history' });
      vi.spyOn(tauri, 'updateNote').mockResolvedValue({ ...savedNote, content: 'XY', updatedAt: 2 });
      seedDirtyNote();
      render(<AppShell />);

      const event = closeRequest();

      expect(event.preventDefault).toHaveBeenCalled();
      await waitFor(() => expect(destroy).toHaveBeenCalledTimes(1));
      expect(tauri.updateNote).toHaveBeenCalledWith(5, 'XY');
    });

    it('asks before closing when a note cannot be saved', async () => {
      seed({ a: 'history' });
      vi.spyOn(tauri, 'updateNote').mockRejectedValue(new Error('disk'));
      seedDirtyNote();
      render(<AppShell />);

      closeRequest();

      expect(await screen.findByText('Nie udało się zapisać notatki')).toBeTruthy();
      expect(screen.getByText('Zamknięcie okna spowoduje utratę niezapisanej treści notatki.')).toBeTruthy();
      expect(destroy).not.toHaveBeenCalled();

      fireEvent.click(screen.getByText('Anuluj'));
      expect(screen.queryByText('Nie udało się zapisać notatki')).toBeNull();
      expect(destroy).not.toHaveBeenCalled();

      closeRequest();
      fireEvent.click(await screen.findByText('Zamknij mimo to'));
      expect(destroy).toHaveBeenCalledTimes(1);
    });

    it('saves notes and then asks about running sessions', async () => {
      seed({ a: 'terminal' });
      vi.spyOn(tauri, 'updateNote').mockResolvedValue({ ...savedNote, content: 'XY', updatedAt: 2 });
      seedDirtyNote();
      render(<AppShell />);

      closeRequest();

      expect(await screen.findByText('Zamknąć AbeonCode?')).toBeTruthy();
      expect(tauri.updateNote).toHaveBeenCalledWith(5, 'XY');
      expect(destroy).not.toHaveBeenCalled();
    });
  });

  describe('update relaunch', () => {
    const relaunch = vi.fn();

    const offerUpdate = () => {
      relaunch.mockResolvedValue(undefined);
      checkForUpdate.mockResolvedValue({
        version: '9.9.9', notes: '', downloadAndInstall: async () => {}, relaunch,
      });
    };

    it('saves notes before relaunching', async () => {
      offerUpdate();
      seed({ a: 'history' });
      vi.spyOn(tauri, 'updateNote').mockResolvedValue({ ...savedNote, content: 'XY', updatedAt: 2 });
      seedDirtyNote();
      render(<AppShell />);

      fireEvent.click(await screen.findByText('Zaktualizuj'));

      await waitFor(() => expect(relaunch).toHaveBeenCalledTimes(1));
      expect(tauri.updateNote).toHaveBeenCalledWith(5, 'XY');
    });

    it('does not relaunch when notes cannot be saved', async () => {
      offerUpdate();
      seed({ a: 'history' });
      vi.spyOn(tauri, 'updateNote').mockRejectedValue(new Error('disk'));
      seedDirtyNote();
      render(<AppShell />);

      fireEvent.click(await screen.findByText('Zaktualizuj'));

      await waitFor(() => expect(toastError).toHaveBeenCalledWith(
        'Nie udało się zapisać notatki — ponowne uruchomienie wstrzymane',
      ));
      expect(relaunch).not.toHaveBeenCalled();
      expect((await screen.findByText('Zaktualizuj')).closest('button')).not.toBeDisabled();
    });
  });
});
