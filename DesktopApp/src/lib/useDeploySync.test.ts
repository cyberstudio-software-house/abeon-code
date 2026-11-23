import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { DeployChangedEvent } from '../types';
import { useStore } from '../store';
import { tauri } from './tauri';
import { makeView } from '../test-helpers/deploy';
import { useDeploySync } from './useDeploySync';

describe('useDeploySync', () => {
  let emit: (event: DeployChangedEvent) => void;
  const unlisten = vi.fn();

  beforeEach(() => {
    vi.restoreAllMocks();
    unlisten.mockClear();
    useStore.setState({ trackings: [] });
    vi.spyOn(tauri, 'onDeployChanged').mockImplementation(async (cb) => {
      emit = cb;
      return unlisten;
    });
  });

  it('loads the trackings on mount and again on every change event', async () => {
    const first = [makeView({ id: 1 })];
    const second = [makeView({ id: 1 }), makeView({ id: 2, repoPath: '/b' })];
    const list = vi.spyOn(tauri, 'deployListTrackings').mockResolvedValueOnce(first).mockResolvedValueOnce(second);

    renderHook(() => useDeploySync());
    await waitFor(() => expect(useStore.getState().trackings).toEqual(first));

    act(() => { emit({ repoPath: '/repos/api' } as DeployChangedEvent); });
    await waitFor(() => expect(useStore.getState().trackings).toEqual(second));
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('stops listening on unmount', async () => {
    vi.spyOn(tauri, 'deployListTrackings').mockResolvedValue([]);
    const { unmount } = renderHook(() => useDeploySync());
    await waitFor(() => expect(tauri.onDeployChanged).toHaveBeenCalled());
    await act(async () => { await Promise.resolve(); });
    unmount();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it('survives a failing load', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(tauri, 'deployListTrackings').mockRejectedValue(new Error('boom'));
    renderHook(() => useDeploySync());
    await waitFor(() => expect(error).toHaveBeenCalled());
    expect(useStore.getState().trackings).toEqual([]);
  });
});
