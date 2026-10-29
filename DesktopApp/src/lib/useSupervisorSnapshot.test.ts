import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useStore } from '../store';
import { tauri } from './tauri';
import { useSupervisorSnapshot } from './useSupervisorSnapshot';
import type { SupervisorSnapshot } from '../types';

const snapshot = (overrides: Partial<SupervisorSnapshot> = {}): SupervisorSnapshot => ({
  level: 'assistant',
  running: true,
  ready: true,
  ptyId: null,
  present: true,
  away: false,
  escalations: [],
  approvals: [],
  cards: [],
  ...overrides,
});

describe('useSupervisorSnapshot', () => {
  let emit: (s: SupervisorSnapshot) => void;
  const unlisten = vi.fn();

  beforeEach(() => {
    useStore.setState({ supervisor: null });
    unlisten.mockClear();
    vi.spyOn(tauri, 'onSupervisorSnapshot').mockImplementation(async (cb) => {
      emit = cb;
      return unlisten;
    });
  });

  afterEach(() => vi.restoreAllMocks());

  it('loads the initial snapshot and then follows events', async () => {
    vi.spyOn(tauri, 'supervisorSnapshot').mockResolvedValue(snapshot({ running: false }));
    renderHook(() => useSupervisorSnapshot());
    await waitFor(() => expect(useStore.getState().supervisor?.running).toBe(false));
    act(() => { emit(snapshot({ running: true })); });
    expect(useStore.getState().supervisor?.running).toBe(true);
  });

  it('does not let a late initial snapshot overwrite a newer event', async () => {
    let resolveInitial: (s: SupervisorSnapshot) => void = () => {};
    vi.spyOn(tauri, 'supervisorSnapshot').mockImplementation(
      () => new Promise<SupervisorSnapshot>(resolve => { resolveInitial = resolve; }),
    );
    renderHook(() => useSupervisorSnapshot());
    await waitFor(() => expect(tauri.onSupervisorSnapshot).toHaveBeenCalled());
    await act(async () => { emit(snapshot({ away: true })); });
    await act(async () => { resolveInitial(snapshot({ away: false })); });
    expect(useStore.getState().supervisor?.away).toBe(true);
  });

  it('stops listening on unmount', async () => {
    vi.spyOn(tauri, 'supervisorSnapshot').mockResolvedValue(snapshot());
    const { unmount } = renderHook(() => useSupervisorSnapshot());
    await waitFor(() => expect(tauri.onSupervisorSnapshot).toHaveBeenCalled());
    await act(async () => {});
    unmount();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it('survives a failing backend', async () => {
    vi.spyOn(tauri, 'supervisorSnapshot').mockRejectedValue(new Error('no backend'));
    renderHook(() => useSupervisorSnapshot());
    await act(async () => {});
    expect(useStore.getState().supervisor).toBeNull();
  });
});
