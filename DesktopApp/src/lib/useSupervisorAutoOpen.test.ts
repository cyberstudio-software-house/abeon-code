import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useStore } from '../store';
import { useSupervisorAutoOpen } from './useSupervisorAutoOpen';

describe('useSupervisorAutoOpen', () => {
  beforeEach(() => {
    useStore.setState({ supervisorLevel: 'off', supervisorPanelOpen: false });
  });

  it('opens the panel on the first off to on transition only', () => {
    renderHook(() => useSupervisorAutoOpen());
    act(() => useStore.setState({ supervisorLevel: 'assistant' }));
    expect(useStore.getState().supervisorPanelOpen).toBe(true);
    act(() => useStore.setState({ supervisorPanelOpen: false, supervisorLevel: 'off' }));
    act(() => useStore.setState({ supervisorLevel: 'relay' }));
    expect(useStore.getState().supervisorPanelOpen).toBe(false);
  });

  it('does not open when the level starts enabled', () => {
    useStore.setState({ supervisorLevel: 'assistant' });
    renderHook(() => useSupervisorAutoOpen());
    act(() => useStore.setState({ supervisorLevel: 'autonomous' }));
    expect(useStore.getState().supervisorPanelOpen).toBe(false);
  });
});
