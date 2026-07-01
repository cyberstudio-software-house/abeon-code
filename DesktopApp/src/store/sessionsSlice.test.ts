import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useStore } from './index';
import { tauri } from '../lib/tauri';
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
    provider: 'claude',
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

describe('refreshActivity', () => {
  beforeEach(() => {
    useStore.setState({ sessionsByProject: {} });
    vi.restoreAllMocks();
  });

  it('patches activity but preserves title', async () => {
    useStore.setState({
      sessionsByProject: {
        1: { items: [{ ...fakeMeta('a', 1, 'idle'), title: 'My Rename' }], hasMore: false },
      },
    });
    vi.spyOn(tauri, 'listSessions').mockResolvedValue([
      { ...fakeMeta('a', 1, 'running'), title: 'WHATEVER-FROM-BACKEND' },
    ]);
    await useStore.getState().refreshActivity(1);
    const item = useStore.getState().sessionsByProject[1].items[0];
    expect(item.activity).toBe('running');
    expect(item.title).toBe('My Rename');
  });

  it('does nothing when project bucket is missing', async () => {
    const spy = vi.spyOn(tauri, 'listSessions');
    await useStore.getState().refreshActivity(42);
    expect(spy).not.toHaveBeenCalled();
  });

  it('links new- tabs to sessions by provider, not position', async () => {
    useStore.setState({
      sessionsByProject: {
        1: { items: [], hasMore: false },
      },
      tabs: [
        {
          kind: 'session',
          id: 'session:new-codex',
          projectId: 1,
          sessionId: 'new-codex',
          title: 'New session',
          mode: 'terminal',
          fresh: true,
          provider: 'codex',
        },
        {
          kind: 'session',
          id: 'session:new-claude',
          projectId: 1,
          sessionId: 'new-claude',
          title: 'New session',
          mode: 'terminal',
          fresh: true,
        },
      ],
    });

    vi.spyOn(tauri, 'listSessions').mockResolvedValue([
      { ...fakeMeta('real-claude-id', 1, 'idle'), provider: 'claude', title: 'Claude session' },
      { ...fakeMeta('real-codex-id', 1, 'idle'), provider: 'codex', title: 'Codex session' },
    ]);

    await useStore.getState().refreshActivity(1);

    const tabs = useStore.getState().tabs;
    const codexTab = tabs.find(t => t.id === 'session:new-codex');
    const claudeTab = tabs.find(t => t.id === 'session:new-claude');

    expect(codexTab?.kind === 'session' && codexTab.linkedSessionId).toBe('real-codex-id');
    expect(claudeTab?.kind === 'session' && claudeTab.linkedSessionId).toBe('real-claude-id');
  });
});

describe('scheduleNewSessionRefresh', () => {
  beforeEach(() => {
    useStore.setState({ sessionsByProject: {}, tabs: [] });
    vi.restoreAllMocks();
  });

  it('updates a fresh tab title for a project whose sessions were never loaded', async () => {
    vi.useFakeTimers();
    useStore.setState({
      sessionsByProject: {},
      tabs: [{
        kind: 'session',
        id: 'session:fresh-x',
        projectId: 7,
        sessionId: 'fresh-x',
        title: 'New session',
        mode: 'terminal',
        fresh: true,
        provider: 'claude',
      }],
      loadActivity: vi.fn().mockResolvedValue(undefined),
    });
    vi.spyOn(tauri, 'listSessions')
      .mockResolvedValueOnce([])
      .mockResolvedValue([{ ...fakeMeta('fresh-x', 7), title: 'Generated Title' }]);

    useStore.getState().scheduleNewSessionRefresh(7);
    await vi.advanceTimersByTimeAsync(2100);

    const tab = useStore.getState().tabs[0];
    expect(tab.title).toBe('Generated Title');

    vi.clearAllTimers();
    vi.useRealTimers();
  });
});

describe('sessionsSlice activeSessions', () => {
  beforeEach(() => { useStore.setState({ activeSessions: [], showActiveSessions: true }); });

  it('refreshActiveSessions stores the fetched rows', async () => {
    const rows = [{
      sessionId: 'a', projectId: 1, projectName: 'P', title: 'T',
      activity: 'running' as const, lastModified: 5, provider: 'claude' as const,
    }];
    const spy = vi.spyOn(tauri, 'listActiveSessions').mockResolvedValue(rows);
    await useStore.getState().refreshActiveSessions();
    expect(useStore.getState().activeSessions).toEqual(rows);
    spy.mockRestore();
  });

  it('refreshActiveSessions does not fetch when showActiveSessions is off', async () => {
    useStore.setState({ showActiveSessions: false, activeSessions: [] });
    const rows = [{
      sessionId: 'a', projectId: 1, projectName: 'P', title: 'T',
      activity: 'running' as const, lastModified: 5, provider: 'claude' as const,
    }];
    const spy = vi.spyOn(tauri, 'listActiveSessions').mockResolvedValue(rows);
    await useStore.getState().refreshActiveSessions();
    expect(spy).not.toHaveBeenCalled();
    expect(useStore.getState().activeSessions).toEqual([]);
    spy.mockRestore();
  });
});
