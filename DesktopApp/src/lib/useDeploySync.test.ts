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

  it('attaches the listener before the first load', async () => {
    const order: string[] = [];
    vi.mocked(tauri.onDeployChanged).mockImplementation(async (cb) => {
      order.push('listen');
      emit = cb;
      return unlisten;
    });
    vi.spyOn(tauri, 'deployListTrackings').mockImplementation(async () => {
      order.push('load');
      return [];
    });
    renderHook(() => useDeploySync());
    await waitFor(() => expect(order).toEqual(['listen', 'load']));
  });

  it('stops listening on unmount', async () => {
    vi.spyOn(tauri, 'deployListTrackings').mockResolvedValue([]);
    const { unmount } = renderHook(() => useDeploySync());
    await waitFor(() => expect(tauri.deployListTrackings).toHaveBeenCalled());
    unmount();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it('unlistens when unmounted before the listener is attached and does not load', async () => {
    let resolveListen: (fn: () => void) => void = () => {};
    vi.mocked(tauri.onDeployChanged).mockImplementation(
      () => new Promise<() => void>(resolve => { resolveListen = resolve; }),
    );
    const list = vi.spyOn(tauri, 'deployListTrackings').mockResolvedValue([]);
    const { unmount } = renderHook(() => useDeploySync());
    unmount();
    expect(unlisten).not.toHaveBeenCalled();
    await act(async () => { resolveListen(unlisten); });
    expect(unlisten).toHaveBeenCalledTimes(1);
    expect(list).not.toHaveBeenCalled();
  });

  it('survives a failing load', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(tauri, 'deployListTrackings').mockRejectedValue(new Error('boom'));
    renderHook(() => useDeploySync());
    await waitFor(() => expect(error).toHaveBeenCalled());
    expect(useStore.getState().trackings).toEqual([]);
  });

  it('still loads when the listener cannot be attached', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(tauri.onDeployChanged).mockRejectedValue(new Error('no listener'));
    const loaded = [makeView({ id: 5 })];
    vi.spyOn(tauri, 'deployListTrackings').mockResolvedValue(loaded);
    renderHook(() => useDeploySync());
    await waitFor(() => expect(useStore.getState().trackings).toEqual(loaded));
    expect(error).toHaveBeenCalled();
  });
});
