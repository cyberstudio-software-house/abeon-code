import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useHistorySearch } from './useHistorySearch';
import type { HistoryBlock } from '../../types';

const base = { uuid: 'u', timestamp: 0 };
const blocks: HistoryBlock[] = [
  { ...base, uuid: '0', kind: 'userText', text: 'alpha beta' },
  { ...base, uuid: '1', kind: 'assistantText', text: 'gamma' },
  { ...base, uuid: '2', kind: 'assistantText', text: 'BETA again' },
];

describe('useHistorySearch', () => {
  it('starts empty', () => {
    const { result } = renderHook(() => useHistorySearch(blocks));
    expect(result.current.matches).toEqual([]);
    expect(result.current.count).toBe(0);
    expect(result.current.activeBlockIndex).toBe(-1);
  });

  it('matches case-insensitively and reports indices into the blocks array', () => {
    const { result } = renderHook(() => useHistorySearch(blocks));
    act(() => result.current.setQuery('beta'));
    expect(result.current.matches).toEqual([0, 2]);
    expect(result.current.count).toBe(2);
    expect(result.current.activeBlockIndex).toBe(0);
  });

  it('cycles forward and backward', () => {
    const { result } = renderHook(() => useHistorySearch(blocks));
    act(() => result.current.setQuery('beta'));
    act(() => result.current.next());
    expect(result.current.activeBlockIndex).toBe(2);
    act(() => result.current.next());
    expect(result.current.activeBlockIndex).toBe(0);
    act(() => result.current.prev());
    expect(result.current.activeBlockIndex).toBe(2);
  });

  it('resets active position when the query changes', () => {
    const { result } = renderHook(() => useHistorySearch(blocks));
    act(() => result.current.setQuery('beta'));
    act(() => result.current.next());
    expect(result.current.activeBlockIndex).toBe(2);
    act(() => result.current.setQuery('alpha'));
    expect(result.current.matches).toEqual([0]);
    expect(result.current.activeBlockIndex).toBe(0);
  });

  it('reset() clears the query and matches', () => {
    const { result } = renderHook(() => useHistorySearch(blocks));
    act(() => result.current.setQuery('beta'));
    act(() => result.current.reset());
    expect(result.current.query).toBe('');
    expect(result.current.matches).toEqual([]);
  });
});
