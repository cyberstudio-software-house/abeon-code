import { describe, it, expect } from 'vitest';
import { pushNav, stepBack, stepForward, pruneNav } from './navHistory';

describe('pushNav', () => {
  it('appends a new id and moves the cursor to the end', () => {
    expect(pushNav({ history: ['a', 'b'], index: 1 }, 'c')).toEqual({ history: ['a', 'b', 'c'], index: 2 });
  });

  it('truncates the forward branch when pushing from the middle', () => {
    expect(pushNav({ history: ['a', 'b', 'c', 'd'], index: 1 }, 'e')).toEqual({ history: ['a', 'b', 'e'], index: 2 });
  });

  it('is a no-op when the id already sits at the cursor', () => {
    const state = { history: ['a', 'b'], index: 1 };
    expect(pushNav(state, 'b')).toBe(state);
  });

  it('pushes onto an empty history', () => {
    expect(pushNav({ history: [], index: 0 }, 'a')).toEqual({ history: ['a'], index: 0 });
  });
});

describe('stepBack', () => {
  it('moves the cursor back and returns the target', () => {
    expect(stepBack({ history: ['a', 'b', 'c'], index: 2 })).toEqual({ index: 1, targetId: 'b' });
  });

  it('returns null at the start boundary', () => {
    expect(stepBack({ history: ['a', 'b'], index: 0 })).toBeNull();
  });
});

describe('stepForward', () => {
  it('moves the cursor forward and returns the target', () => {
    expect(stepForward({ history: ['a', 'b', 'c'], index: 0 })).toEqual({ index: 1, targetId: 'b' });
  });

  it('returns null at the end boundary', () => {
    expect(stepForward({ history: ['a', 'b'], index: 1 })).toBeNull();
  });
});

describe('pruneNav', () => {
  it('removes a non-current id and keeps the cursor on the same entry', () => {
    expect(pruneNav({ history: ['a', 'b', 'c', 'd'], index: 3 }, 'b')).toEqual({ history: ['a', 'c', 'd'], index: 2 });
  });

  it('falls back toward the previous entry when the current id is removed', () => {
    expect(pruneNav({ history: ['a', 'b', 'c'], index: 2 }, 'c')).toEqual({ history: ['a', 'b'], index: 1 });
  });

  it('removes every occurrence of a repeated id', () => {
    expect(pruneNav({ history: ['a', 'b', 'a'], index: 2 }, 'a')).toEqual({ history: ['b'], index: 0 });
  });

  it('clamps to a valid state when the history becomes empty', () => {
    expect(pruneNav({ history: ['a'], index: 0 }, 'a')).toEqual({ history: [], index: 0 });
  });
});
