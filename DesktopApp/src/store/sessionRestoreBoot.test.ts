import { beforeEach, describe, it, expect, vi } from 'vitest';

vi.mock('../lib/tauri', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/tauri')>();
  return {
    ...actual,
    tauri: {
      ...actual.tauri,
      getAllSettings: async () => ({}),
      setSetting: async () => {},
      detectDefaultShell: async () => '',
      takePendingOpenPaths: async () => [],
    },
  };
});

type PersistedTabs = { tabs: { id: string; live?: boolean }[] };

const readPersisted = () => JSON.parse(localStorage.getItem('abeoncode.tabs')!) as PersistedTabs;

const liveIds = () => readPersisted().tabs.filter(t => t.live).map(t => t.id);

function seedTabs(live: string[], settings: Record<string, unknown> = {}) {
  localStorage.setItem('abeoncode.settings', JSON.stringify(settings));
  localStorage.setItem('abeoncode.tabs', JSON.stringify({
    tabs: ['a', 'b', 'c'].map(sessionId => ({
      kind: 'session',
      id: `session:${sessionId}`,
      projectId: 1,
      sessionId,
      title: sessionId.toUpperCase(),
      ...(live.includes(sessionId) ? { live: true } : {}),
    })),
    activeTabId: 'session:c',
  }));
}

const modeOf = (state: { tabs: { id: string; kind: string; mode?: string }[] }, id: string) =>
  state.tabs.find(t => t.id === id)?.mode;

describe('session restore across restarts', () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    window.history.replaceState({}, '', '/');
  });

  it('marks a session running in a terminal as live in the persisted tabs', async () => {
    seedTabs([]);
    const { useStore } = await import('./index');

    useStore.getState().setSessionMode('session:a', 'terminal');

    expect(liveIds()).toEqual(['session:a']);
  });

  it('brings live sessions back as history tabs queued for resume', async () => {
    seedTabs(['a', 'b']);
    const { useStore } = await import('./index');
    const state = useStore.getState();

    expect(state.tabs.map(t => modeOf(state, t.id))).toEqual(['history', 'history', 'history']);
    expect(state.pendingResumeTabIds).toEqual(['session:a', 'session:b']);
  });

  it('keeps queued sessions marked live while the question is unanswered', async () => {
    seedTabs(['a']);
    const { useStore } = await import('./index');

    useStore.getState().setActive('session:b');

    expect(liveIds()).toEqual(['session:a']);
  });

  it('resumes every queued session and empties the queue', async () => {
    seedTabs(['a', 'b']);
    const { useStore } = await import('./index');

    useStore.getState().resumePendingSessions();
    const state = useStore.getState();

    expect(modeOf(state, 'session:a')).toBe('terminal');
    expect(modeOf(state, 'session:b')).toBe('terminal');
    expect(modeOf(state, 'session:c')).toBe('history');
    expect(state.pendingResumeTabIds).toEqual([]);
    expect(liveIds()).toEqual(['session:a', 'session:b']);
  });

  it('forgets the live marks once the question is declined', async () => {
    seedTabs(['a', 'b']);
    const { useStore } = await import('./index');

    useStore.getState().dismissPendingResume();

    expect(useStore.getState().pendingResumeTabIds).toEqual([]);
    expect(modeOf(useStore.getState(), 'session:a')).toBe('history');
    expect(liveIds()).toEqual([]);
  });

  it('drops a session from the queue when it is resumed by hand', async () => {
    seedTabs(['a', 'b']);
    const { useStore } = await import('./index');

    useStore.getState().setSessionMode('session:a', 'terminal');

    expect(useStore.getState().pendingResumeTabIds).toEqual(['session:b']);
  });

  it('drops a session from the queue when its tab is closed', async () => {
    seedTabs(['a', 'b']);
    const { useStore } = await import('./index');

    useStore.getState().closeTab('session:a');
    useStore.getState().detachTabs(['session:b']);

    expect(useStore.getState().pendingResumeTabIds).toEqual([]);
  });

  it('resumes live sessions without asking when the restore mode is always', async () => {
    seedTabs(['a'], { sessionRestoreMode: 'always' });
    const { useStore } = await import('./index');
    const state = useStore.getState();

    expect(modeOf(state, 'session:a')).toBe('terminal');
    expect(modeOf(state, 'session:b')).toBe('history');
    expect(state.pendingResumeTabIds).toEqual([]);
  });

  it('leaves live sessions in history when the restore mode is never', async () => {
    seedTabs(['a'], { sessionRestoreMode: 'never' });
    const { useStore } = await import('./index');
    const state = useStore.getState();

    expect(modeOf(state, 'session:a')).toBe('history');
    expect(state.pendingResumeTabIds).toEqual([]);
  });

  it('falls back to asking when the stored restore mode is not a known value', async () => {
    seedTabs(['a'], { sessionRestoreMode: 'sometimes' });
    const { useStore } = await import('./index');

    expect(useStore.getState().sessionRestoreMode).toBe('ask');
    expect(useStore.getState().pendingResumeTabIds).toEqual(['session:a']);
  });

  it('writes a changed restore mode back to the settings cache', async () => {
    seedTabs([]);
    const { useStore } = await import('./index');

    useStore.getState().setSessionRestoreMode('never');

    const cached = JSON.parse(localStorage.getItem('abeoncode.settings')!) as { sessionRestoreMode?: string };
    expect(cached.sessionRestoreMode).toBe('never');
  });

  it('stops overwriting the saved tabs once persistence is frozen', async () => {
    seedTabs([]);
    const { useStore, freezeTabPersistence } = await import('./index');
    useStore.getState().setSessionMode('session:a', 'terminal');

    freezeTabPersistence();
    useStore.getState().detachTabs(useStore.getState().tabs.map(t => t.id));

    expect(useStore.getState().tabs).toEqual([]);
    expect(readPersisted().tabs.map(t => t.id)).toEqual(['session:a', 'session:b', 'session:c']);
    expect(liveIds()).toEqual(['session:a']);
  });
});
