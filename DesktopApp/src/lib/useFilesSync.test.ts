import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { FilesDirChangedEvent } from '../types';

import { useStore } from '../store';
import { tauri } from './tauri';
import { useFilesSync } from './useFilesSync';

describe('useFilesSync', () => {
  let emit: (event: FilesDirChangedEvent) => void;
  const unlisten = vi.fn();
  const reloadFileDir = vi.fn().mockResolvedValue(undefined);
  const checkFilesOnDisk = vi.fn().mockResolvedValue(undefined);
  const refreshGit = vi.fn().mockResolvedValue(undefined);

  const listing = { status: 'ready' as const, entries: [] };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    useStore.setState({
      reloadFileDir, checkFilesOnDisk, refreshGit,
      filesPanelOpen: true,
      fileTrees: { 1: { expanded: [], listings: { '': listing, src: listing } } },
    });
    vi.spyOn(tauri, 'onFilesDirChanged').mockImplementation(async (cb) => {
      emit = cb;
      return unlisten;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const mount = async () => {
    const hook = renderHook(() => useFilesSync());
    await vi.waitFor(() => expect(emit).toBeDefined());
    return hook;
  };

  it('reloads a loaded directory and checks open files in it', async () => {
    await mount();
    emit({ projectId: 1, relDir: 'src' });
    expect(reloadFileDir).toHaveBeenCalledWith(1, 'src');
    expect(checkFilesOnDisk).toHaveBeenCalledWith(1, 'src');
  });

  it('does not reload a directory that was never loaded', async () => {
    await mount();
    emit({ projectId: 1, relDir: 'lib' });
    emit({ projectId: 9, relDir: '' });
    expect(reloadFileDir).not.toHaveBeenCalled();
    expect(checkFilesOnDisk).toHaveBeenCalledTimes(2);
  });

  it('refreshes git once, 500 ms after the last event, while the panel is open', async () => {
    await mount();
    emit({ projectId: 1, relDir: 'src' });
    await vi.advanceTimersByTimeAsync(300);
    emit({ projectId: 1, relDir: '' });
    await vi.advanceTimersByTimeAsync(499);
    expect(refreshGit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(refreshGit).toHaveBeenCalledTimes(1);
    expect(refreshGit).toHaveBeenCalledWith(1);
  });

  it('skips the git refresh while the panel is closed', async () => {
    useStore.setState({ filesPanelOpen: false });
    await mount();
    emit({ projectId: 1, relDir: 'src' });
    await vi.advanceTimersByTimeAsync(600);
    expect(refreshGit).not.toHaveBeenCalled();
  });

  it('survives a failing git refresh', async () => {
    refreshGit.mockRejectedValueOnce(new Error('git'));
    await mount();
    emit({ projectId: 1, relDir: 'src' });
    await vi.advanceTimersByTimeAsync(600);
    expect(refreshGit).toHaveBeenCalledTimes(1);
  });

  it('unsubscribes and cancels a pending refresh on unmount', async () => {
    const hook = await mount();
    emit({ projectId: 1, relDir: 'src' });
    hook.unmount();
    expect(unlisten).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(600);
    expect(refreshGit).not.toHaveBeenCalled();
  });
});
