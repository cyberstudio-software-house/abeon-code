import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
import { mockFileIo, seedDirtyFileTab } from '../../test-helpers/dirtyFiles';
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

function seedEmptiedNote() {
  useStore.setState({ noteDrafts: {} });
  useStore.getState().openNoteInPanel(savedNote);
  const key = Object.keys(useStore.getState().noteDrafts)[0];
  useStore.getState().editNoteDraft(key, '');
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
    vi.spyOn(tauri, 'dirtyFilesInOtherWindows').mockResolvedValue(0);
    mockFileIo();
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

    it('deletes an emptied note instead of saving it when closing', async () => {
      seed({ a: 'history' });
      vi.spyOn(tauri, 'updateNote').mockResolvedValue({ ...savedNote, content: '', updatedAt: 2 });
      vi.spyOn(tauri, 'deleteNote').mockResolvedValue(undefined);
      seedEmptiedNote();
      render(<AppShell />);

      const event = closeRequest();

      expect(event.preventDefault).toHaveBeenCalled();
      await waitFor(() => expect(destroy).toHaveBeenCalledTimes(1));
      expect(tauri.deleteNote).toHaveBeenCalledWith(5);
      expect(tauri.updateNote).not.toHaveBeenCalled();
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

    describe('unsaved files', () => {
      const dialogTitle = () => screen.queryByText('Niezapisane zmiany', { selector: 'h2' });

      beforeEach(async () => {
        useStore.setState({ fileBuffers: {} });
        seed({ a: 'history' });
        await seedDirtyFileTab('src/a.ts');
      });

      afterEach(() => {
        Object.keys(useStore.getState().fileBuffers).forEach(id => useStore.getState().dropFileBuffer(id));
        useStore.setState({ fileBuffers: {} });
      });

      it('holds the close and lists the dirty file', () => {
        render(<AppShell />);

        const event = closeRequest();

        expect(event.preventDefault).toHaveBeenCalled();
        expect(dialogTitle()).toBeTruthy();
        expect(screen.getByText('src/a.ts')).toBeTruthy();
        expect(destroy).not.toHaveBeenCalled();
      });

      it('keeps the window open when cancelled', () => {
        render(<AppShell />);
        closeRequest();

        fireEvent.click(screen.getByText('Anuluj'));

        expect(dialogTitle()).toBeNull();
        expect(destroy).not.toHaveBeenCalled();
        expect(tauri.writeProjectFile).not.toHaveBeenCalled();
      });

      it('closes the window after saving', async () => {
        render(<AppShell />);
        closeRequest();

        fireEvent.click(screen.getByText('Zapisz'));

        await waitFor(() => expect(destroy).toHaveBeenCalledTimes(1));
        expect(tauri.writeProjectFile).toHaveBeenCalledWith(1, 'src/a.ts', 'edited', 'v1', false);
      });

      it('closes the window after discarding, without writing', async () => {
        render(<AppShell />);
        closeRequest();

        fireEvent.click(screen.getByText('Odrzuć zmiany'));

        await waitFor(() => expect(destroy).toHaveBeenCalledTimes(1));
        expect(tauri.writeProjectFile).not.toHaveBeenCalled();
      });

      it('can still be closed after cancelling a save that never finishes', async () => {
        vi.spyOn(tauri, 'writeProjectFile').mockImplementation(() => new Promise<string>(() => undefined));
        render(<AppShell />);
        closeRequest();

        fireEvent.click(screen.getByText('Zapisz'));
        await waitFor(() => expect(screen.getByText('Odrzuć zmiany').closest('button')).toBeDisabled());
        fireEvent.click(screen.getByText('Anuluj'));

        expect(dialogTitle()).toBeNull();
        expect(destroy).not.toHaveBeenCalled();

        closeRequest();
        expect(dialogTitle()).toBeTruthy();
        fireEvent.click(screen.getByText('Odrzuć zmiany'));

        await waitFor(() => expect(destroy).toHaveBeenCalledTimes(1));
      });

      it('keeps the window and the dialog when saving fails', async () => {
        vi.spyOn(tauri, 'writeProjectFile').mockRejectedValue({ code: 'conflict', message: 'conflict: src/a.ts' });
        render(<AppShell />);
        closeRequest();

        fireEvent.click(screen.getByText('Zapisz'));

        expect(await screen.findByText('Plik src/a.ts zmienił się na dysku. Otwórz zakładkę pliku i wybierz „Wczytaj ponownie” albo „Zostaw moje”, a potem zapisz.')).toBeTruthy();
        expect(destroy).not.toHaveBeenCalled();
      });

      it('asks about running sessions after the files are resolved', async () => {
        seed({ a: 'terminal' });
        await seedDirtyFileTab('src/a.ts');
        render(<AppShell />);
        closeRequest();
        expect(screen.queryByText('Zamknąć AbeonCode?')).toBeNull();

        fireEvent.click(screen.getByText('Odrzuć zmiany'));

        expect(await screen.findByText('Zamknąć AbeonCode?')).toBeTruthy();
        expect(destroy).not.toHaveBeenCalled();
      });

      it('settles notes only after the files are resolved', async () => {
        const updateNote = vi.spyOn(tauri, 'updateNote').mockResolvedValue({ ...savedNote, content: 'XY', updatedAt: 2 });
        seedDirtyNote();
        render(<AppShell />);
        closeRequest();

        expect(updateNote).not.toHaveBeenCalled();
        fireEvent.click(screen.getByText('Odrzuć zmiany'));

        await waitFor(() => expect(destroy).toHaveBeenCalledTimes(1));
        expect(updateNote).toHaveBeenCalledWith(5, 'XY');
      });

      it('does not touch the notes when the close is cancelled', () => {
        const updateNote = vi.spyOn(tauri, 'updateNote').mockResolvedValue({ ...savedNote, content: 'XY', updatedAt: 2 });
        seedDirtyNote();
        render(<AppShell />);
        closeRequest();

        fireEvent.click(screen.getByText('Anuluj'));

        expect(updateNote).not.toHaveBeenCalled();
        expect(destroy).not.toHaveBeenCalled();
      });
    });
  });

  describe('update install', () => {
    const relaunch = vi.fn();
    const download = vi.fn();
    const install = vi.fn();
    const originalFlush = useStore.getState().settleNoteDraftsForExit;
    const calls: string[] = [];

    const offerUpdate = () => {
      let downloaded = false;
      let installed = false;
      relaunch.mockImplementation(async () => { calls.push('relaunch'); });
      download.mockImplementation(async () => {
        if (downloaded) return;
        downloaded = true;
        calls.push('download');
      });
      install.mockImplementation(async () => {
        if (installed) return;
        installed = true;
        calls.push('install');
      });
      checkForUpdate.mockResolvedValue({ version: '9.9.9', notes: '', download, install, relaunch });
    };

    const stubFlush = (results: boolean[]) => {
      const queue = [...results];
      useStore.setState({
        settleNoteDraftsForExit: vi.fn(async () => {
          calls.push('flush');
          return queue.shift() ?? true;
        }),
      });
    };

    const updateButton = async () => (await screen.findByText('Zaktualizuj')).closest('button');

    beforeEach(() => {
      calls.length = 0;
      relaunch.mockReset();
      download.mockReset();
      install.mockReset();
      seed({ a: 'history' });
    });

    afterEach(() => {
      useStore.setState({ settleNoteDraftsForExit: originalFlush });
    });

    it('downloads, saves notes, installs, saves notes again and relaunches in that order', async () => {
      offerUpdate();
      stubFlush([true, true]);
      render(<AppShell />);

      fireEvent.click(await screen.findByText('Zaktualizuj'));

      await waitFor(() => expect(relaunch).toHaveBeenCalledTimes(1));
      expect(calls).toEqual(['download', 'flush', 'install', 'flush', 'relaunch']);
    });

    it('does not relaunch when notes typed during the install cannot be saved', async () => {
      offerUpdate();
      stubFlush([true, false]);
      render(<AppShell />);

      fireEvent.click(await screen.findByText('Zaktualizuj'));

      await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
      expect(calls).toEqual(['download', 'flush', 'install', 'flush']);
      expect(relaunch).not.toHaveBeenCalled();
      expect(await updateButton()).not.toBeDisabled();
    });

    it('shows the download progress', async () => {
      offerUpdate();
      let finish!: () => void;
      download.mockImplementation((onProgress: (downloaded: number, total: number | null) => void) => new Promise<void>((resolve) => {
        onProgress(25, 100);
        finish = resolve;
      }));
      render(<AppShell />);

      fireEvent.click(await screen.findByText('Zaktualizuj'));

      expect(await screen.findByText('25%')).toBeTruthy();
      expect(screen.getByText('Pobieranie…')).toBeTruthy();
      await act(async () => { finish(); });
      await waitFor(() => expect(relaunch).toHaveBeenCalledTimes(1));
    });

    it('writes a pending note to disk after the download and before installing', async () => {
      offerUpdate();
      vi.spyOn(tauri, 'updateNote').mockImplementation(async () => {
        calls.push('save');
        return { ...savedNote, content: 'XY', updatedAt: 2 };
      });
      seedDirtyNote();
      render(<AppShell />);

      fireEvent.click(await screen.findByText('Zaktualizuj'));

      await waitFor(() => expect(relaunch).toHaveBeenCalledTimes(1));
      expect(calls).toEqual(['download', 'save', 'install', 'relaunch']);
    });

    it('deletes an emptied note instead of saving it before installing', async () => {
      offerUpdate();
      vi.spyOn(tauri, 'updateNote').mockResolvedValue({ ...savedNote, content: '', updatedAt: 2 });
      vi.spyOn(tauri, 'deleteNote').mockImplementation(async () => { calls.push('delete'); });
      seedEmptiedNote();
      render(<AppShell />);

      fireEvent.click(await screen.findByText('Zaktualizuj'));

      await waitFor(() => expect(relaunch).toHaveBeenCalledTimes(1));
      expect(calls).toEqual(['download', 'delete', 'install', 'relaunch']);
      expect(tauri.updateNote).not.toHaveBeenCalled();
    });

    it('does not install when notes cannot be saved', async () => {
      offerUpdate();
      vi.spyOn(tauri, 'updateNote').mockRejectedValue(new Error('disk'));
      seedDirtyNote();
      render(<AppShell />);

      fireEvent.click(await screen.findByText('Zaktualizuj'));

      await waitFor(() => expect(toastError).toHaveBeenCalledWith(
        'Nie udało się zapisać notatki — ponowne uruchomienie wstrzymane',
      ));
      expect(calls).toEqual(['download']);
      expect(install).not.toHaveBeenCalled();
      expect(relaunch).not.toHaveBeenCalled();
      expect(await updateButton()).not.toBeDisabled();
    });

    it('does not install when notes typed during the download cannot be saved', async () => {
      offerUpdate();
      stubFlush([false]);
      render(<AppShell />);

      fireEvent.click(await screen.findByText('Zaktualizuj'));

      await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
      expect(calls).toEqual(['download', 'flush']);
      expect(install).not.toHaveBeenCalled();
      expect(relaunch).not.toHaveBeenCalled();
      expect(await updateButton()).not.toBeDisabled();
    });

    it('closes the dialog and installs nothing when the download fails', async () => {
      offerUpdate();
      const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      download.mockRejectedValue(new Error('connection lost'));
      render(<AppShell />);

      fireEvent.click(await screen.findByText('Zaktualizuj'));

      await waitFor(() => expect(screen.queryByText('Zaktualizuj')).toBeNull());
      expect(install).not.toHaveBeenCalled();
      expect(error).toHaveBeenCalledWith('Update install failed', expect.any(Error));
      error.mockRestore();
    });

    describe('unsaved files', () => {
      const otherWindowsMessage =
        'Masz niezapisane pliki w innym oknie. Zapisz je lub zamknij to okno i spróbuj ponownie.';
      const dialogTitle = () => screen.queryByText('Niezapisane zmiany', { selector: 'h2' });

      beforeEach(() => {
        useStore.setState({ fileBuffers: {} });
      });

      afterEach(() => {
        Object.keys(useStore.getState().fileBuffers).forEach(id => useStore.getState().dropFileBuffer(id));
        useStore.setState({ fileBuffers: {} });
      });

      it('asks about this window\'s dirty files before downloading', async () => {
        offerUpdate();
        await seedDirtyFileTab('src/a.ts');
        render(<AppShell />);

        fireEvent.click(await screen.findByText('Zaktualizuj'));

        expect(await screen.findByText('src/a.ts')).toBeTruthy();
        expect(download).not.toHaveBeenCalled();
        expect(tauri.dirtyFilesInOtherWindows).not.toHaveBeenCalled();
      });

      it('does not download when cancelled and offers the update again', async () => {
        offerUpdate();
        await seedDirtyFileTab('src/a.ts');
        render(<AppShell />);
        fireEvent.click(await screen.findByText('Zaktualizuj'));

        fireEvent.click(await screen.findByText('Anuluj'));

        await waitFor(() => expect(dialogTitle()).toBeNull());
        expect(download).not.toHaveBeenCalled();
        expect(install).not.toHaveBeenCalled();
        expect(relaunch).not.toHaveBeenCalled();
        expect(await updateButton()).not.toBeDisabled();
      });

      it('installs after the files are saved', async () => {
        offerUpdate();
        await seedDirtyFileTab('src/a.ts');
        render(<AppShell />);
        fireEvent.click(await screen.findByText('Zaktualizuj'));

        fireEvent.click(await screen.findByText('Zapisz'));

        await waitFor(() => expect(relaunch).toHaveBeenCalledTimes(1));
        expect(tauri.writeProjectFile).toHaveBeenCalledOnce();
        expect(calls).toEqual(['download', 'install', 'relaunch']);
      });

      it('installs after the changes are discarded', async () => {
        offerUpdate();
        await seedDirtyFileTab('src/a.ts');
        render(<AppShell />);
        fireEvent.click(await screen.findByText('Zaktualizuj'));

        fireEvent.click(await screen.findByText('Odrzuć zmiany'));

        await waitFor(() => expect(relaunch).toHaveBeenCalledTimes(1));
        expect(tauri.writeProjectFile).not.toHaveBeenCalled();
      });

      it('asks again about a discarded file that is edited again during the download', async () => {
        offerUpdate();
        const id = await seedDirtyFileTab('src/a.ts');
        download.mockImplementation(async () => {
          calls.push('download');
          useStore.getState().editFileBuffer(id, 'edited again');
        });
        render(<AppShell />);
        fireEvent.click(await screen.findByText('Zaktualizuj'));
        fireEvent.click(await screen.findByText('Odrzuć zmiany'));

        expect(await screen.findByText('src/a.ts')).toBeTruthy();
        expect(install).not.toHaveBeenCalled();
        expect(relaunch).not.toHaveBeenCalled();
      });

      it('asks about the files before settling notes', async () => {
        offerUpdate();
        stubFlush([true]);
        await seedDirtyFileTab('src/a.ts');
        render(<AppShell />);
        fireEvent.click(await screen.findByText('Zaktualizuj'));
        await screen.findByText('src/a.ts');
        expect(calls).toEqual([]);

        fireEvent.click(screen.getByText('Odrzuć zmiany'));

        await waitFor(() => expect(relaunch).toHaveBeenCalledTimes(1));
        expect(calls).toEqual(['download', 'flush', 'install', 'flush', 'relaunch']);
      });

      it('refuses with a message and does not download when another window has unsaved files', async () => {
        offerUpdate();
        vi.spyOn(tauri, 'dirtyFilesInOtherWindows').mockResolvedValue(2);
        render(<AppShell />);

        fireEvent.click(await screen.findByText('Zaktualizuj'));

        await waitFor(() => expect(toastError).toHaveBeenCalledWith(otherWindowsMessage));
        expect(download).not.toHaveBeenCalled();
        expect(relaunch).not.toHaveBeenCalled();
        expect(await updateButton()).not.toBeDisabled();
      });

      it('checks the other windows before the download, before installing and again before relaunching', async () => {
        offerUpdate();
        vi.spyOn(tauri, 'dirtyFilesInOtherWindows').mockImplementation(async () => {
          calls.push('registry');
          return 0;
        });
        stubFlush([true, true]);
        render(<AppShell />);

        fireEvent.click(await screen.findByText('Zaktualizuj'));

        await waitFor(() => expect(relaunch).toHaveBeenCalledTimes(1));
        expect(calls).toEqual(['registry', 'download', 'registry', 'flush', 'install', 'registry', 'flush', 'relaunch']);
        expect(toastError).not.toHaveBeenCalled();
      });

      it('does not relaunch when another window gains unsaved files during the install, and a retry installs once and relaunches once', async () => {
        offerUpdate();
        vi.spyOn(tauri, 'dirtyFilesInOtherWindows')
          .mockResolvedValueOnce(0).mockResolvedValueOnce(0).mockResolvedValueOnce(1).mockResolvedValue(0);
        render(<AppShell />);

        fireEvent.click(await screen.findByText('Zaktualizuj'));

        await waitFor(() => expect(toastError).toHaveBeenCalledWith(otherWindowsMessage));
        expect(calls).toEqual(['download', 'install']);
        expect(relaunch).not.toHaveBeenCalled();
        expect(await updateButton()).not.toBeDisabled();

        fireEvent.click(await screen.findByText('Zaktualizuj'));

        await waitFor(() => expect(relaunch).toHaveBeenCalledTimes(1));
        expect(calls).toEqual(['download', 'install', 'relaunch']);
        expect(install).toHaveBeenCalledTimes(2);
      });

      it('asks again before relaunching when this window gains unsaved files during the install', async () => {
        offerUpdate();
        install.mockImplementation(async () => {
          calls.push('install');
          await seedDirtyFileTab('src/during-install.ts');
        });
        render(<AppShell />);
        fireEvent.click(await screen.findByText('Zaktualizuj'));

        expect(await screen.findByText('src/during-install.ts')).toBeTruthy();
        expect(relaunch).not.toHaveBeenCalled();
        fireEvent.click(screen.getByText('Anuluj'));

        await waitFor(() => expect(dialogTitle()).toBeNull());
        expect(calls).toEqual(['download', 'install']);
        expect(relaunch).not.toHaveBeenCalled();
        expect(await updateButton()).not.toBeDisabled();
      });

      it('downloads but does not install when another window gains unsaved files during the download, and installs on retry', async () => {
        offerUpdate();
        vi.spyOn(tauri, 'dirtyFilesInOtherWindows')
          .mockResolvedValueOnce(0).mockResolvedValueOnce(1).mockResolvedValue(0);
        render(<AppShell />);

        fireEvent.click(await screen.findByText('Zaktualizuj'));

        await waitFor(() => expect(toastError).toHaveBeenCalledWith(otherWindowsMessage));
        expect(calls).toEqual(['download']);
        expect(install).not.toHaveBeenCalled();
        expect(relaunch).not.toHaveBeenCalled();
        expect(await updateButton()).not.toBeDisabled();

        fireEvent.click(await screen.findByText('Zaktualizuj'));

        await waitFor(() => expect(relaunch).toHaveBeenCalledTimes(1));
        expect(calls).toEqual(['download', 'install', 'relaunch']);
        expect(download).toHaveBeenCalledTimes(2);
        expect(install).toHaveBeenCalledTimes(1);
      });

      it('asks again before installing when this window gains unsaved files during the download', async () => {
        offerUpdate();
        download.mockImplementation(async () => {
          calls.push('download');
          await seedDirtyFileTab('src/late.ts');
        });
        render(<AppShell />);
        fireEvent.click(await screen.findByText('Zaktualizuj'));

        expect(await screen.findByText('src/late.ts')).toBeTruthy();
        expect(install).not.toHaveBeenCalled();
        fireEvent.click(screen.getByText('Anuluj'));

        await waitFor(() => expect(dialogTitle()).toBeNull());
        expect(install).not.toHaveBeenCalled();
        expect(relaunch).not.toHaveBeenCalled();
        expect(await updateButton()).not.toBeDisabled();
      });

      it('holds the update when the registry cannot be read', async () => {
        offerUpdate();
        const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        vi.spyOn(tauri, 'dirtyFilesInOtherWindows').mockRejectedValue(new Error('ipc'));
        render(<AppShell />);

        fireEvent.click(await screen.findByText('Zaktualizuj'));

        await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
        expect(download).not.toHaveBeenCalled();
        expect(relaunch).not.toHaveBeenCalled();
        error.mockRestore();
      });
    });
  });
});
