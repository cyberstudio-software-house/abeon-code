import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useMouseNavigation } from './useMouseNavigation';
import { useStore } from '../store';

const term = (id: string) => ({ kind: 'terminal' as const, id, projectId: 1, title: id });

describe('useMouseNavigation', () => {
  beforeEach(() => {
    useStore.setState({
      tabs: [term('t1'), term('t2')],
      activeTabId: 't2',
      mruOrder: ['t2', 't1'],
      navHistory: ['t1', 't2'],
      navIndex: 1,
    });
  });

  it('mouse button 3 navigates back', () => {
    renderHook(() => useMouseNavigation());
    act(() => { document.dispatchEvent(new MouseEvent('mousedown', { button: 3, bubbles: true })); });
    expect(useStore.getState().activeTabId).toBe('t1');
  });

  it('mouse button 4 navigates forward', () => {
    useStore.setState({ activeTabId: 't1', navIndex: 0 });
    renderHook(() => useMouseNavigation());
    act(() => { document.dispatchEvent(new MouseEvent('mousedown', { button: 4, bubbles: true })); });
    expect(useStore.getState().activeTabId).toBe('t2');
  });

  it('ignores other mouse buttons', () => {
    renderHook(() => useMouseNavigation());
    act(() => { document.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true })); });
    expect(useStore.getState().activeTabId).toBe('t2');
  });
});
