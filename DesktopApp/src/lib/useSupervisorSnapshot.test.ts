import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useStore } from '../store';
import { tauri } from './tauri';
import { useSupervisorSnapshot } from './useSupervisorSnapshot';
import type { SessionRebound, SupervisorSnapshot } from '../types';
import type { Tab } from '../store/tabsSlice';

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
    vi.spyOn(tauri, 'onSupervisorSessionRebound').mockResolvedValue(() => {});
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

describe('useSupervisorSnapshot and session id changes in a terminal', () => {
  let rebound: (event: SessionRebound) => void = () => {};
  const unlistenRebound = vi.fn();
  const sessionTab = (id: string, sessionId: string, extra: Partial<Extract<Tab, { kind: 'session' }>> = {}): Tab => ({
    kind: 'session',
    id,
    projectId: 1,
    sessionId,
    title: sessionId,
    mode: 'terminal',
    ...extra,
  });
  const tabs: Tab[] = [
    sessionTab('session:a', 'a', { ptyId: 'pty-1' }),
    sessionTab('session:c', 'c', { ptyId: 'pty-2' }),
    { kind: 'terminal', id: 'terminal:t', projectId: 1, title: 'Terminal' },
    sessionTab('session:new-d', 'new-d', { linkedSessionId: 'd', ptyId: 'pty-3' }),
  ];

  beforeEach(() => {
    unlistenRebound.mockClear();
    useStore.setState({ supervisor: null, tabs });
    vi.spyOn(tauri, 'onSupervisorSnapshot').mockResolvedValue(() => {});
    vi.spyOn(tauri, 'supervisorSnapshot').mockResolvedValue(snapshot({ ptyId: 'pty-sup' }));
    vi.spyOn(tauri, 'onSupervisorSessionRebound').mockImplementation(async (cb) => {
      rebound = cb;
      return unlistenRebound;
    });
  });

  afterEach(() => vi.restoreAllMocks());

  it('links the new session id only to the tab that owns the terminal', async () => {
    renderHook(() => useSupervisorSnapshot());
    await waitFor(() => expect(tauri.onSupervisorSessionRebound).toHaveBeenCalled());
    act(() => { rebound({ ptyId: 'pty-1', sessionId: 'b' }); });
    const after = useStore.getState().tabs;
    expect(after[0]).toEqual({ ...tabs[0], linkedSessionId: 'b' });
    after.slice(1).forEach((tab, index) => expect(tab).toBe(tabs[index + 1]));
    act(() => { rebound({ ptyId: 'pty-3', sessionId: 'e' }); });
    expect(useStore.getState().tabs[3]).toEqual({ ...tabs[3], linkedSessionId: 'e' });
  });

  it('leaves every tab alone for the supervisor terminal, an unknown terminal or an unchanged id', async () => {
    renderHook(() => useSupervisorSnapshot());
    await waitFor(() => expect(tauri.onSupervisorSessionRebound).toHaveBeenCalled());
    act(() => { rebound({ ptyId: 'pty-sup', sessionId: 'x' }); });
    act(() => { rebound({ ptyId: 'pty-9', sessionId: 'x' }); });
    act(() => { rebound({ ptyId: 'pty-1', sessionId: 'a' }); });
    act(() => { rebound({ ptyId: 'pty-3', sessionId: 'd' }); });
    expect(useStore.getState().tabs).toBe(tabs);
  });

  it('stops following session id changes on unmount', async () => {
    const { unmount } = renderHook(() => useSupervisorSnapshot());
    await waitFor(() => expect(tauri.onSupervisorSessionRebound).toHaveBeenCalled());
    await act(async () => {});
    unmount();
    expect(unlistenRebound).toHaveBeenCalledTimes(1);
  });
});
