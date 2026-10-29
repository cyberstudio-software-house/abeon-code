import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import type { SessionRebound, SupervisorSnapshot } from '../../types';

const probe = vi.hoisted(() => ({
  spawned: 0,
  openedContainers: [] as HTMLElement[],
  rebound: (_event: SessionRebound) => {},
  snapshot: (_snapshot: SupervisorSnapshot) => {},
}));

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    options: Record<string, unknown> = {};
    buffer = { active: { getLine: () => null } };
    loadAddon() {}
    open(container: HTMLElement) { probe.openedContainers.push(container); }
    attachCustomKeyEventHandler() {}
    registerLinkProvider() {}
    getSelection() { return ''; }
    onSelectionChange() { return { dispose() {} }; }
    reset() {}
    focus() {}
    write() {}
    onData() { return { dispose() {} }; }
    onResize() { return { dispose() {} }; }
  },
}));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }));
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }));
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn() }));
vi.mock('../history/HistoryView', () => ({ HistoryView: () => <div data-testid="history" /> }));
vi.mock('../history/SubagentView', () => ({ SubagentView: () => <div data-testid="subagent" /> }));
vi.mock('../../lib/tauri', () => ({
  tauri: {
    spawnPty: vi.fn(async () => `pty-${++probe.spawned}`),
    onPtyOutput: vi.fn(async () => () => {}),
    onPtyExit: vi.fn(async () => () => {}),
    ptyKill: vi.fn(async () => {}),
    ptyWrite: vi.fn(async () => {}),
    ptyResize: vi.fn(async () => {}),
    writeClipboardText: vi.fn(async () => {}),
    readClipboardText: vi.fn(async () => null),
    readClipboardImage: vi.fn(async () => null),
    getAllSettings: vi.fn(async () => ({})),
    setSetting: vi.fn(async () => {}),
    detectDefaultShell: vi.fn(async () => ''),
    takePendingOpenPaths: vi.fn(async () => []),
    supervisorSnapshot: vi.fn(async () => ({
      level: 'assistant', running: true, ready: true, ptyId: 'pty-sup', present: true, away: false,
      escalations: [], approvals: [], cards: [],
    })),
    onSupervisorSnapshot: vi.fn(async (cb: (snapshot: SupervisorSnapshot) => void) => {
      probe.snapshot = cb;
      return () => {};
    }),
    onSupervisorSessionRebound: vi.fn(async (cb: (event: SessionRebound) => void) => {
      probe.rebound = cb;
      return () => {};
    }),
    supervisorReportActivity: vi.fn(async () => {}),
  },
}));

Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 600 });
Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => 400 });
vi.stubGlobal('ResizeObserver', class {
  observe() {}
  unobserve() {}
  disconnect() {}
});

import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../../store';
import { tauri } from '../../lib/tauri';
import { useSupervisorSnapshot } from '../../lib/useSupervisorSnapshot';
import { usePresenceReporter } from '../../lib/usePresenceReporter';
import type { Tab } from '../../store/tabsSlice';
import { TabPanel } from './TabContent';

function Shell() {
  useSupervisorSnapshot();
  usePresenceReporter();
  const tabs = useStore(useShallow(s => s.tabs));
  const active = useStore(s => s.activeTabId);
  return (
    <div className="relative">
      {tabs.map(t => <TabPanel key={t.id} tab={t} visible={t.id === active} focused />)}
    </div>
  );
}

const snapshotWithCard = (sessionId: string): SupervisorSnapshot => ({
  level: 'assistant', running: true, ready: true, ptyId: 'pty-sup', present: true, away: false,
  escalations: [], approvals: [],
  cards: [{
    questionId: 'q1',
    sessionId,
    questions: [{ question: 'Który kolor?', header: null, options: ['Czerwony'], multiSelect: false }],
    phase: 'paused',
    deadlineMs: null,
  }],
});

const liveTab = (extra: Partial<Extract<Tab, { kind: 'session' }>> = {}): Tab => ({
  kind: 'session',
  id: 'session:a',
  projectId: 1,
  sessionId: 'a',
  title: 'A',
  mode: 'terminal',
  ...extra,
});

const sessionTabs = () => useStore.getState().tabs.filter(
  (t): t is Extract<Tab, { kind: 'session' }> => t.kind === 'session',
);

describe('a live session tab after /clear or an in-terminal /resume', () => {
  beforeEach(() => {
    probe.spawned = 0;
    probe.openedContainers = [];
    vi.mocked(tauri.spawnPty).mockClear();
    vi.mocked(tauri.ptyKill).mockClear();
    vi.mocked(tauri.supervisorReportActivity).mockClear();
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    useStore.setState({
      projects: [{ id: 1, name: 'P', path: '/p' }] as never,
      tabs: [],
      activeTabId: null,
      activeAgentPtyId: null,
      supervisor: null,
    });
  });

  it('follows the new session id without remounting, respawning or killing the terminal', async () => {
    useStore.setState({ tabs: [liveTab()], activeTabId: 'session:a' });
    await act(async () => { render(<Shell />); });
    expect(sessionTabs()[0].ptyId).toBe('pty-1');
    expect(tauri.supervisorReportActivity).toHaveBeenLastCalledWith('a');
    const container = probe.openedContainers[0];

    await act(async () => { probe.rebound({ ptyId: 'pty-1', sessionId: 'b' }); });

    expect(sessionTabs()[0]).toMatchObject({ id: 'session:a', sessionId: 'a', linkedSessionId: 'b', ptyId: 'pty-1' });
    expect(tauri.spawnPty).toHaveBeenCalledTimes(1);
    expect(tauri.ptyKill).not.toHaveBeenCalled();
    expect(probe.openedContainers).toEqual([container]);
    expect(container.isConnected).toBe(true);
    expect(tauri.supervisorReportActivity).toHaveBeenLastCalledWith('b');

    await act(async () => { probe.snapshot(snapshotWithCard('b')); });
    expect(screen.getByText('Który kolor?')).toBeInTheDocument();
    expect(tauri.spawnPty).toHaveBeenCalledTimes(1);
  });

  it('keeps a fresh session terminal alive when its id changes', async () => {
    useStore.setState({ tabs: [liveTab({ fresh: true })], activeTabId: 'session:a' });
    await act(async () => { render(<Shell />); });
    const container = probe.openedContainers[0];

    await act(async () => { probe.rebound({ ptyId: 'pty-1', sessionId: 'b' }); });

    expect(sessionTabs()[0].linkedSessionId).toBe('b');
    expect(tauri.spawnPty).toHaveBeenCalledTimes(1);
    expect(tauri.ptyKill).not.toHaveBeenCalled();
    expect(probe.openedContainers).toEqual([container]);
  });

  it('resumes the newest session when the tab goes back to the terminal later', async () => {
    useStore.setState({ tabs: [liveTab()], activeTabId: 'session:a' });
    await act(async () => { render(<Shell />); });
    await act(async () => { probe.rebound({ ptyId: 'pty-1', sessionId: 'b' }); });

    await act(async () => { useStore.getState().setSessionMode('session:a', 'history'); });
    await act(async () => { useStore.getState().setSessionMode('session:a', 'terminal'); });

    expect(tauri.spawnPty).toHaveBeenCalledTimes(2);
    expect(vi.mocked(tauri.spawnPty).mock.calls[1][1]).toMatchObject({ kind: 'agent', session_id: 'b' });
  });
});
