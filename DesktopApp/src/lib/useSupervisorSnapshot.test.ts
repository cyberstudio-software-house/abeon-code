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

  it('registers the listener before it asks for the initial snapshot', async () => {
    const order: string[] = [];
    vi.spyOn(tauri, 'onSupervisorSnapshot').mockImplementation(async (cb) => {
      order.push('listen');
      emit = cb;
      return unlisten;
    });
    vi.spyOn(tauri, 'supervisorSnapshot').mockImplementation(async () => {
      order.push('snapshot');
      return snapshot();
    });
    renderHook(() => useSupervisorSnapshot());
    await waitFor(() => expect(order).toEqual(['listen', 'snapshot']));
  });

  it('releases a listener that registers after unmount', async () => {
    let finishRegistration: (fn: () => void) => void = () => {};
    vi.spyOn(tauri, 'onSupervisorSnapshot').mockImplementation(
      () => new Promise<() => void>(resolve => { finishRegistration = resolve; }),
    );
    const initial = vi.spyOn(tauri, 'supervisorSnapshot').mockResolvedValue(snapshot());
    const { unmount } = renderHook(() => useSupervisorSnapshot());
    unmount();
    await act(async () => { finishRegistration(unlisten); });
    expect(unlisten).toHaveBeenCalledTimes(1);
    expect(initial).not.toHaveBeenCalled();
  });

  it('logs a failing backend instead of swallowing it', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(tauri, 'supervisorSnapshot').mockRejectedValue(new Error('no backend'));
    renderHook(() => useSupervisorSnapshot());
    await waitFor(() => expect(logged).toHaveBeenCalled());
    expect(useStore.getState().supervisor).toBeNull();
  });

  it('logs a failing listener registration', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(tauri, 'onSupervisorSnapshot').mockRejectedValue(new Error('no events'));
    vi.spyOn(tauri, 'supervisorSnapshot').mockResolvedValue(snapshot());
    renderHook(() => useSupervisorSnapshot());
    await waitFor(() => expect(logged).toHaveBeenCalled());
  });
});
