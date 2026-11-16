import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { tauri } from './tauri';
import { useExtendOnActivity, CARD_EXTEND_THROTTLE_MS } from './useExtendOnActivity';

describe('useExtendOnActivity', () => {
  let extend: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    extend = vi.spyOn(tauri, 'supervisorExtendCard').mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('extends at once on the first activity and then at most every 10 s', () => {
    renderHook(() => useExtendOnActivity('q1', true));
    act(() => { window.dispatchEvent(new MouseEvent('mousemove')); });
    expect(extend).toHaveBeenCalledTimes(1);
    expect(extend).toHaveBeenCalledWith('q1');
    act(() => {
      window.dispatchEvent(new WheelEvent('wheel'));
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    });
    expect(extend).toHaveBeenCalledTimes(1);
    act(() => { vi.advanceTimersByTime(CARD_EXTEND_THROTTLE_MS); });
    act(() => { window.dispatchEvent(new MouseEvent('mousedown')); });
    expect(extend).toHaveBeenCalledTimes(2);
  });

  it('does nothing while disabled', () => {
    renderHook(() => useExtendOnActivity('q1', false));
    act(() => { window.dispatchEvent(new MouseEvent('mousemove')); });
    expect(extend).not.toHaveBeenCalled();
  });

  it('stops listening after unmount', () => {
    const { unmount } = renderHook(() => useExtendOnActivity('q1', true));
    unmount();
    act(() => { window.dispatchEvent(new MouseEvent('mousemove')); });
    expect(extend).not.toHaveBeenCalled();
  });

  it('ignores a failed call', async () => {
    extend.mockRejectedValue('no core');
    renderHook(() => useExtendOnActivity('q1', true));
    await act(async () => { window.dispatchEvent(new MouseEvent('mousemove')); });
    expect(extend).toHaveBeenCalledTimes(1);
  });
});
