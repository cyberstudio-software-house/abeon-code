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

describe('useUnsavedFilesPrompt', () => {
  let a: string;
  let b: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    outcome = null;
    useStore.setState({ tabs: [], fileBuffers: {} });
    mockFileIo();
    a = await seedDirtyFileTab('src/a.ts');
    b = await seedDirtyFileTab('src/b.ts');
  });

  afterEach(() => {
    useStore.setState({ tabs: [], fileBuffers: {} });
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

  it('stays open with the error and no longer lists the files that did save', async () => {
    vi.spyOn(tauri, 'writeProjectFile').mockImplementation(async (_project, path) => {
      if (path === 'src/b.ts') throw conflict;
      return 'v2';
    });
    ask([a, b]);

    fireEvent.click(screen.getByText('Zapisz'));

    expect(await screen.findByText('Nie udało się zapisać wszystkich plików.')).toBeTruthy();
    expect(screen.queryByText('src/a.ts')).toBeNull();
    expect(screen.getByText('src/b.ts')).toBeTruthy();
    expect(screen.getByText('Zapisz').closest('button')).not.toBeDisabled();
    await act(async () => {});
  });

  it('keeps the buttons disabled while the save is in flight', async () => {
    let release!: (version: string) => void;
    vi.spyOn(tauri, 'writeProjectFile').mockImplementation(() => new Promise<string>(resolve => { release = resolve; }));
    ask([a]);

    fireEvent.click(screen.getByText('Zapisz'));

    await waitFor(() => expect(screen.getByText('Anuluj').closest('button')).toBeDisabled());
    expect(screen.getByText('Odrzuć zmiany').closest('button')).toBeDisabled();
    await act(async () => { release('v2'); });
    await expect(outcome).resolves.toBe(true);
  });

  it('refuses a second prompt while one is open', async () => {
    ask([a]);

    await act(async () => { fireEvent.click(screen.getByText('ask')); });

    await expect(outcome).resolves.toBe(false);
    expect(screen.getByText('Niezapisane zmiany')).toBeTruthy();
  });
});
