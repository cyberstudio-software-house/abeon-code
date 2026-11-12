import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { FilesDirChangedEvent } from '../types';

import { useStore } from '../store';
import { tauri } from './tauri';
import { FILES_RECHECK_INTERVAL_MS, useFilesSync } from './useFilesSync';

describe('useFilesSync', () => {
  let emit: (event: FilesDirChangedEvent) => void;
  const unlisten = vi.fn();
  const reloadFileDir = vi.fn().mockResolvedValue(undefined);
  const checkFilesOnDisk = vi.fn().mockResolvedValue(undefined);
  const refreshGit = vi.fn().mockResolvedValue(undefined);
  const recheckFiles = vi.fn().mockResolvedValue(undefined);

  const listing = { status: 'ready' as const, entries: [] };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    useStore.setState({
      reloadFileDir, checkFilesOnDisk, refreshGit, recheckFiles,
      filesPanelOpen: true,
      tabs: [], activeTabId: null,
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

  it('re-checks the files when the window regains focus, at most once per interval plus one trailing run', async () => {
    await mount();
    window.dispatchEvent(new Event('focus'));
    expect(recheckFiles).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100);
    window.dispatchEvent(new Event('focus'));
    window.dispatchEvent(new Event('focus'));
    expect(recheckFiles).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(FILES_RECHECK_INTERVAL_MS - 100);
    expect(recheckFiles).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(FILES_RECHECK_INTERVAL_MS * 3);
    expect(recheckFiles).toHaveBeenCalledTimes(2);
    window.dispatchEvent(new Event('focus'));
    expect(recheckFiles).toHaveBeenCalledTimes(3);
  });

  it('re-checks the files when a file tab becomes active, not for other tabs', async () => {
    const terminal = { kind: 'terminal' as const, id: 'term', projectId: 1, title: 't' };
    const file = { kind: 'file' as const, id: 'file:1:a.ts', projectId: 1, path: 'a.ts', title: 'a.ts' };
    useStore.setState({ tabs: [terminal, file], activeTabId: null });
    await mount();
    act(() => { useStore.setState({ activeTabId: 'term' }); });
    expect(recheckFiles).not.toHaveBeenCalled();
    act(() => { useStore.setState({ activeTabId: 'file:1:a.ts' }); });
    expect(recheckFiles).toHaveBeenCalledTimes(1);
    act(() => { useStore.setState({ filesPanelOpen: false }); });
    expect(recheckFiles).toHaveBeenCalledTimes(1);
  });

  it('stops the re-check triggers on unmount', async () => {
    const hook = await mount();
    window.dispatchEvent(new Event('focus'));
    window.dispatchEvent(new Event('focus'));
    hook.unmount();
    await vi.advanceTimersByTimeAsync(FILES_RECHECK_INTERVAL_MS * 2);
    window.dispatchEvent(new Event('focus'));
    expect(recheckFiles).toHaveBeenCalledTimes(1);
  });
});
