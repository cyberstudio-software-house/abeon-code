import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useStore } from '../store';
import { tauri } from './tauri';
import { usePresenceReporter } from './usePresenceReporter';

const sessionTab = (id: string, sessionId: string, ptyId: string, linkedSessionId?: string) => ({
  kind: 'session' as const,
  id,
  projectId: 1,
  sessionId,
  ...(linkedSessionId ? { linkedSessionId } : {}),
  ptyId,
  title: sessionId,
  mode: 'terminal' as const,
});

const pressKey = () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));

describe('usePresenceReporter', () => {
  let report: ReturnType<typeof vi.spyOn>;
  let hasFocus: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-29T10:00:00Z'));
    report = vi.spyOn(tauri, 'supervisorReportActivity').mockResolvedValue(undefined);
    hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    useStore.setState({
      tabs: [sessionTab('session:s1', 's1', 'pty-1'), sessionTab('session:new-2', 'new-2', 'pty-2', 's2')],
      activeAgentPtyId: null,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('reports at most once per 20 seconds for repeated keydowns', () => {
    renderHook(() => usePresenceReporter());
    act(() => { pressKey(); });
    act(() => { vi.advanceTimersByTime(5_000); });
    act(() => { pressKey(); });
    expect(report).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith(null);
  });

  it('reports again once the throttle window has passed', () => {
    renderHook(() => usePresenceReporter());
    act(() => { pressKey(); });
    act(() => { vi.advanceTimersByTime(20_000); });
    act(() => { pressKey(); });
    expect(report).toHaveBeenCalledTimes(2);
  });

  it('reports on window focus and mousedown too', () => {
    renderHook(() => usePresenceReporter());
    act(() => { window.dispatchEvent(new Event('focus')); });
    act(() => { vi.advanceTimersByTime(20_000); });
    act(() => { window.dispatchEvent(new MouseEvent('mousedown')); });
    expect(report).toHaveBeenCalledTimes(2);
  });

  it('reports immediately with the session id when the focused session changes', () => {
    renderHook(() => usePresenceReporter());
    act(() => { pressKey(); });
    report.mockClear();
    act(() => { useStore.setState({ activeAgentPtyId: 'pty-1' }); });
    expect(report).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith('s1');
  });

  it('prefers the linked session id of a placeholder tab', () => {
    renderHook(() => usePresenceReporter());
    act(() => { useStore.setState({ activeAgentPtyId: 'pty-2' }); });
    expect(report).toHaveBeenLastCalledWith('s2');
  });

  it('sends the focused session with the throttled events as well', () => {
    useStore.setState({ activeAgentPtyId: 'pty-1' });
    renderHook(() => usePresenceReporter());
    act(() => { pressKey(); });
    expect(report).toHaveBeenCalledWith('s1');
  });

  it('reports no session while the window is not focused', () => {
    hasFocus.mockReturnValue(false);
    useStore.setState({ activeAgentPtyId: 'pty-1' });
    renderHook(() => usePresenceReporter());
    act(() => { pressKey(); });
    expect(report).toHaveBeenCalledWith(null);
  });

  it('does not report a focused-session change while the window is not focused', () => {
    hasFocus.mockReturnValue(false);
    renderHook(() => usePresenceReporter());
    act(() => { useStore.setState({ activeAgentPtyId: 'pty-1' }); });
    expect(report).not.toHaveBeenCalled();
  });

  it('stops listening after unmount', () => {
    const { unmount } = renderHook(() => usePresenceReporter());
    unmount();
    act(() => { pressKey(); });
    expect(report).not.toHaveBeenCalled();
  });
});
