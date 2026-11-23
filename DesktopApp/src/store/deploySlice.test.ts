import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from './index';
import { tauri } from '../lib/tauri';
import { makeView } from '../test-helpers/deploy';
import type { TrackingView } from '../types';

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe('deploySlice loadTrackings', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useStore.setState({ trackings: [] });
  });

  it('stores the loaded trackings', async () => {
    const views = [makeView({ id: 1 })];
    vi.spyOn(tauri, 'deployListTrackings').mockResolvedValue(views);
    await useStore.getState().loadTrackings();
    expect(useStore.getState().trackings).toEqual(views);
  });

  it('does not let an older response overwrite a newer one', async () => {
    const older = deferred<TrackingView[]>();
    const newer = deferred<TrackingView[]>();
    vi.spyOn(tauri, 'deployListTrackings')
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise);
    const newerViews = [makeView({ id: 2, state: 'succeeded' })];

    const first = useStore.getState().loadTrackings();
    const second = useStore.getState().loadTrackings();
    newer.resolve(newerViews);
    await second;
    older.resolve([makeView({ id: 1, state: 'building' })]);
    await first;

    expect(useStore.getState().trackings).toEqual(newerViews);
  });
});
