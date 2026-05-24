import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from './index';
import type { SessionMeta } from '../types';

function fakeMeta(id: string, projectId: number, activity: SessionMeta['activity'] = 'idle'): SessionMeta {
  return {
    id,
    projectId,
    title: `Session ${id}`,
    messageCount: 1,
    lastModified: 0,
    gitBranch: null,
    cwd: null,
    activity,
  };
}

describe('sessionsSlice activity', () => {
  beforeEach(() => {
    useStore.setState({ sessionsByProject: {} });
  });

  it('patchActivity updates a session in its project bucket', () => {
    useStore.setState({
      sessionsByProject: {
        1: { items: [fakeMeta('a', 1, 'idle'), fakeMeta('b', 1, 'idle')], hasMore: false },
      },
    });
    useStore.getState().patchActivity('b', 'waitingUser');
    const items = useStore.getState().sessionsByProject[1].items;
    expect(items.find(i => i.id === 'a')?.activity).toBe('idle');
    expect(items.find(i => i.id === 'b')?.activity).toBe('waitingUser');
  });

  it('patchActivity finds session across multiple project buckets', () => {
    useStore.setState({
      sessionsByProject: {
        1: { items: [fakeMeta('a', 1, 'idle')], hasMore: false },
        2: { items: [fakeMeta('b', 2, 'idle')], hasMore: false },
      },
    });
    useStore.getState().patchActivity('b', 'running');
    expect(useStore.getState().sessionsByProject[2].items[0].activity).toBe('running');
    expect(useStore.getState().sessionsByProject[1].items[0].activity).toBe('idle');
  });

  it('patchActivity is a no-op for unknown sid', () => {
    useStore.setState({
      sessionsByProject: {
        1: { items: [fakeMeta('a', 1, 'idle')], hasMore: false },
      },
    });
    useStore.getState().patchActivity('zzz', 'running');
    expect(useStore.getState().sessionsByProject[1].items[0].activity).toBe('idle');
  });
});
