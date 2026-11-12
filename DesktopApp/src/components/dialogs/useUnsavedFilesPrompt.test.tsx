import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { tauri } from '../../lib/tauri';
import { useStore } from '../../store';
import { mockFileIo, seedDirtyFileTab } from '../../test-helpers/dirtyFiles';
import { useUnsavedFilesPrompt } from './useUnsavedFilesPrompt';

let outcome: Promise<boolean> | null = null;

function Harness({ tabIds }: { tabIds: string[] }) {
  const { prompt, dialog } = useUnsavedFilesPrompt();
  return (
    <>
      <button onClick={() => { outcome = prompt(tabIds); }}>ask</button>
      {dialog}
    </>
  );
}

const conflict = { code: 'conflict', message: 'conflict: src/b.ts' };
const instruction = 'Otwórz zakładkę pliku i wybierz „Wczytaj ponownie” albo „Zostaw moje”, a potem zapisz.';
const conflictText = (paths: string) => (
  paths.includes(',') ? `Pliki ${paths} zmieniły się na dysku. ${instruction}` : `Plik ${paths} zmienił się na dysku. ${instruction}`
);

describe('useUnsavedFilesPrompt', () => {
  let a: string;
  let b: string;

  const resetFiles = () => {
    Object.keys(useStore.getState().fileBuffers).forEach((id) => useStore.getState().dropFileBuffer(id));
    useStore.setState({ tabs: [], fileBuffers: {} });
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    outcome = null;
    resetFiles();
    mockFileIo();
    a = await seedDirtyFileTab('src/a.ts');
    b = await seedDirtyFileTab('src/b.ts');
  });

  afterEach(() => {
    resetFiles();
  });

  const ask = (tabIds: string[]) => {
    render(<Harness tabIds={tabIds} />);
    fireEvent.click(screen.getByText('ask'));
  };

  it('lists only the dirty files in scope by project-relative path', () => {
    ask([a]);

    expect(screen.getByText('src/a.ts')).toBeTruthy();
    expect(screen.queryByText('src/b.ts')).toBeNull();
  });

  it('resolves true after a successful save and writes every listed file', async () => {
    ask([a, b]);

    fireEvent.click(screen.getByText('Zapisz'));

    await expect(outcome).resolves.toBe(true);
    expect(tauri.writeProjectFile).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(screen.queryByText('Niezapisane zmiany')).toBeNull());
  });

  it('resolves true on discard without writing anything', async () => {
    ask([a]);

    fireEvent.click(screen.getByText('Odrzuć zmiany'));

    await expect(outcome).resolves.toBe(true);
    expect(tauri.writeProjectFile).not.toHaveBeenCalled();
    expect(useStore.getState().fileBuffers[a].content).toBe('edited');
  });

  it('resolves false on cancel', async () => {
    ask([a]);

    fireEvent.click(screen.getByText('Anuluj'));

    await expect(outcome).resolves.toBe(false);
    expect(screen.queryByText('Niezapisane zmiany')).toBeNull();
  });

  it('stays open, names the file that changed on disk and no longer lists the files that did save', async () => {
    vi.spyOn(tauri, 'writeProjectFile').mockImplementation(async (_project, path) => {
      if (path === 'src/b.ts') throw conflict;
      return 'v2';
    });
    ask([a, b]);

    fireEvent.click(screen.getByText('Zapisz'));

    expect(await screen.findByRole('alert')).toHaveTextContent(conflictText('src/b.ts'));
    expect(screen.queryByText('Nie udało się zapisać wszystkich plików.')).toBeNull();
    expect(screen.queryByText('src/a.ts')).toBeNull();
    expect(screen.getByText('src/b.ts')).toBeTruthy();
    expect(screen.getByText('Zapisz').closest('button')).not.toBeDisabled();
    await act(async () => {});
  });

  it('names every conflicting file', async () => {
    vi.spyOn(tauri, 'writeProjectFile').mockRejectedValue(conflict);
    ask([a, b]);

    fireEvent.click(screen.getByText('Zapisz'));

    expect(await screen.findByRole('alert')).toHaveTextContent(conflictText('src/a.ts, src/b.ts'));
    await act(async () => {});
  });

  it('keeps the generic text for a save that fails for another reason', async () => {
    vi.spyOn(tauri, 'writeProjectFile').mockRejectedValue({ code: 'io', message: 'disk full' });
    ask([a]);

    fireEvent.click(screen.getByText('Zapisz'));

    expect(await screen.findByRole('alert')).toHaveTextContent(/^Nie udało się zapisać wszystkich plików\.$/);
    await act(async () => {});
  });

  it('shows both texts when one file conflicts and another fails', async () => {
    vi.spyOn(tauri, 'writeProjectFile').mockImplementation(async (_project, path) => {
      throw path === 'src/b.ts' ? conflict : { code: 'io', message: 'disk full' };
    });
    ask([a, b]);

    fireEvent.click(screen.getByText('Zapisz'));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(conflictText('src/b.ts'));
    expect(alert).toHaveTextContent('Nie udało się zapisać wszystkich plików.');
    await act(async () => {});
  });

  it('names one conflicting file in the singular with the steps the tab offers', async () => {
    vi.spyOn(tauri, 'writeProjectFile').mockRejectedValue(conflict);
    ask([b]);

    fireEvent.click(screen.getByText('Zapisz'));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /^Plik src\/b\.ts zmienił się na dysku\. Otwórz zakładkę pliku i wybierz „Wczytaj ponownie” albo „Zostaw moje”, a potem zapisz\.$/,
    );
    await act(async () => {});
  });

  it('gives the keyboard back to Zapisz after a failed save', async () => {
    let fail!: (error: unknown) => void;
    vi.spyOn(tauri, 'writeProjectFile').mockImplementation(() => new Promise<string>((_resolve, reject) => { fail = reject; }));
    ask([a]);
    const save = screen.getByText('Zapisz');
    expect(save).toHaveFocus();

    fireEvent.click(save);
    await waitFor(() => expect(save.closest('button')).toBeDisabled());
    screen.getByText('Anuluj').focus();
    expect(screen.getByText('Anuluj')).toHaveFocus();
    await act(async () => { fail({ code: 'io', message: 'disk full' }); });

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByText('Zapisz')).toHaveFocus();
  });

  describe('files from several projects', () => {
    beforeEach(() => {
      useStore.setState({ projects: [{ id: 1, name: 'Alfa', path: '/a' }, { id: 2, name: 'Beta', path: '/b' }] as never });
    });

    it('prefixes each path with its project name', async () => {
      const c = await seedDirtyFileTab('src/c.ts', 2);
      ask([a, c]);

      expect(screen.getByText('Alfa: src/a.ts')).toBeTruthy();
      expect(screen.getByText('Beta: src/c.ts')).toBeTruthy();
      expect(screen.queryByText('src/a.ts')).toBeNull();
    });

    it('names conflicting files with their project too', async () => {
      const c = await seedDirtyFileTab('src/c.ts', 2);
      vi.spyOn(tauri, 'writeProjectFile').mockRejectedValue(conflict);
      ask([a, c]);

      fireEvent.click(screen.getByText('Zapisz'));

      expect(await screen.findByRole('alert')).toHaveTextContent(conflictText('Alfa: src/a.ts, Beta: src/c.ts'));
      await act(async () => {});
    });

    it('keeps plain paths when every listed file is in one project', async () => {
      await seedDirtyFileTab('src/c.ts', 2);
      ask([a, b]);

      expect(screen.getByText('src/a.ts')).toBeTruthy();
      expect(screen.getByText('src/b.ts')).toBeTruthy();
    });
  });

  it('disables saving and discarding but not cancelling while the save is in flight', async () => {
    let release!: (version: string) => void;
    vi.spyOn(tauri, 'writeProjectFile').mockImplementation(() => new Promise<string>(resolve => { release = resolve; }));
    ask([a]);

    fireEvent.click(screen.getByText('Zapisz'));

    await waitFor(() => expect(screen.getByText('Odrzuć zmiany').closest('button')).toBeDisabled());
    expect(screen.getByText('Zapisz').closest('button')).toBeDisabled();
    expect(screen.getByText('Anuluj').closest('button')).not.toBeDisabled();
    await act(async () => { release('v2'); });
    await expect(outcome).resolves.toBe(true);
  });

  it('cancels while saving, keeps the action stopped and ignores the late save result', async () => {
    let release!: (version: string) => void;
    vi.spyOn(tauri, 'writeProjectFile').mockImplementation(() => new Promise<string>(resolve => { release = resolve; }));
    ask([a]);
    const first = outcome;

    fireEvent.click(screen.getByText('Zapisz'));
    await waitFor(() => expect(screen.getByText('Odrzuć zmiany').closest('button')).toBeDisabled());
    fireEvent.click(screen.getByText('Anuluj'));

    await expect(first).resolves.toBe(false);
    expect(screen.queryByText('Niezapisane zmiany')).toBeNull();

    fireEvent.click(screen.getByText('ask'));
    const second = outcome;
    expect(screen.getByText('Niezapisane zmiany')).toBeTruthy();
    const settled = vi.fn();
    void second!.then(settled);
    await act(async () => { release('v2'); });

    expect(settled).not.toHaveBeenCalled();
    expect(screen.getByText('Niezapisane zmiany')).toBeTruthy();
    fireEvent.click(screen.getByText('Anuluj'));
    await expect(second).resolves.toBe(false);
  });

  it('opens again after a save that never finishes was cancelled with Escape, and discarding still proceeds', async () => {
    vi.spyOn(tauri, 'writeProjectFile').mockImplementation(() => new Promise<string>(() => undefined));
    ask([a]);
    const first = outcome;

    fireEvent.click(screen.getByText('Zapisz'));
    await waitFor(() => expect(screen.getByText('Zapisz').closest('button')).toBeDisabled());
    fireEvent.keyDown(document, { key: 'Escape' });
    await expect(first).resolves.toBe(false);

    fireEvent.click(screen.getByText('ask'));
    expect(screen.getByText('src/a.ts')).toBeTruthy();
    expect(screen.getByText('Odrzuć zmiany').closest('button')).not.toBeDisabled();
    fireEvent.click(screen.getByText('Odrzuć zmiany'));
    await expect(outcome).resolves.toBe(true);
  });

  it('refuses a second prompt while one is open', async () => {
    ask([a]);

    await act(async () => { fireEvent.click(screen.getByText('ask')); });

    await expect(outcome).resolves.toBe(false);
    expect(screen.getByText('Niezapisane zmiany')).toBeTruthy();
  });
});
