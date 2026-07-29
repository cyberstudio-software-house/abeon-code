import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, fireEvent, act } from '@testing-library/react';
import { useStore } from '../../store';
import { tauri } from '../../lib/tauri';
import type { SessionHistory, SubagentInfo } from '../../types';
import { RELOAD_DEBOUNCE_MS, SubagentView } from './SubagentView';

vi.mock('./HistoryStream', () => ({
  HistoryStream: ({ blocks }: { blocks: unknown[] }) => <div data-testid="stream">{blocks.length}</div>,
}));

const history: SessionHistory = {
  meta: {
    id: 'agent-a1', projectId: 1, title: 'Sesja agent-a1', messageCount: 2, lastModified: 0,
    gitBranch: null, cwd: null, activity: 'idle', provider: 'claude', runningAgents: 0, totalAgents: 0,
  },
  blocks: [],
  hasMoreBefore: false,
};

const historyWith = (lines: number): SessionHistory => ({
  ...history,
  blocks: Array.from({ length: lines }, (_, i) => ({
    kind: 'assistantText' as const, uuid: `b${i}`, timestamp: i, text: `linia ${i}`,
  })),
});

const agent: SubagentInfo = {
  agentId: 'a1', agentType: 'Explore', description: 'Znajdź skróty', status: 'completed',
  startedAt: 1000, endedAt: 2000,
};

const sessionTab = {
  kind: 'session' as const, id: 'session:s1', projectId: 1, sessionId: 's1', title: 'S',
  mode: 'terminal' as const, viewingSubagentId: 'a1',
};

describe('SubagentView', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    vi.spyOn(tauri, 'onSubagentsChanged').mockResolvedValue(() => {});
    useStore.setState({ tabs: [sessionTab], activeTabId: 'session:s1', subagentsBySession: { s1: [agent] } });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const settleDebounce = async () => {
    await act(async () => { await vi.advanceTimersByTimeAsync(RELOAD_DEBOUNCE_MS); });
  };

  it('heads the transcript with the agent type and description, not the history meta title', async () => {
    vi.spyOn(tauri, 'readSubagentHistory').mockResolvedValue(history);
    const { getByText, queryByText } = render(
      <SubagentView projectId={1} sessionId="s1" agentId="a1" tabId="session:s1" />,
    );
    await act(async () => {});

    expect(getByText('Explore')).toBeTruthy();
    expect(getByText('Znajdź skróty')).toBeTruthy();
    expect(queryByText('Sesja agent-a1')).toBeNull();
  });

  it('falls back to a generic label when the store knows nothing about the agent', async () => {
    useStore.setState({ subagentsBySession: {} });
    vi.spyOn(tauri, 'readSubagentHistory').mockResolvedValue(history);
    const { getByText } = render(
      <SubagentView projectId={1} sessionId="s1" agentId="a1" tabId="session:s1" />,
    );
    await act(async () => {});

    expect(getByText('Agent')).toBeTruthy();
  });

  it('clears the tab subagent view when the back button is pressed', async () => {
    vi.spyOn(tauri, 'readSubagentHistory').mockResolvedValue(history);
    const { getByRole } = render(
      <SubagentView projectId={1} sessionId="s1" agentId="a1" tabId="session:s1" />,
    );
    await act(async () => {});

    fireEvent.click(getByRole('button', { name: /Wróć do sesji/ }));

    const tab = useStore.getState().tabs[0];
    expect('viewingSubagentId' in tab).toBe(false);
  });

  it('re-reads the transcript when the watcher reports agent activity', async () => {
    const read = vi.spyOn(tauri, 'readSubagentHistory').mockResolvedValue(history);
    let fire: (() => void) | undefined;
    vi.spyOn(tauri, 'onSubagentsChanged').mockImplementation(async (_sessionId, cb) => {
      fire = cb;
      return () => {};
    });
    render(<SubagentView projectId={1} sessionId="s1" agentId="a1" tabId="session:s1" />);
    await act(async () => {});
    expect(read).toHaveBeenCalledTimes(1);

    await act(async () => { fire?.(); });
    expect(read).toHaveBeenCalledTimes(1);
    await settleDebounce();

    expect(read).toHaveBeenCalledTimes(2);
    expect(read).toHaveBeenLastCalledWith(1, 's1', 'a1');
  });

  const stagedReads = () => {
    const queue: Array<() => void> = [];
    const file = { lines: 1 };
    const read = vi.spyOn(tauri, 'readSubagentHistory').mockImplementation(
      () => new Promise<SessionHistory>(resolve => {
        const snapshot = historyWith(file.lines);
        queue.push(() => resolve(snapshot));
      }),
    );
    let fire: (() => void) | undefined;
    vi.spyOn(tauri, 'onSubagentsChanged').mockImplementation(async (_sessionId, cb) => {
      fire = cb;
      return () => {};
    });
    const settleNewestFirst = async () => {
      await act(async () => {
        for (let round = 0; round < 10; round++) {
          while (queue.length > 0) queue.pop()!();
          await vi.advanceTimersByTimeAsync(RELOAD_DEBOUNCE_MS);
          if (queue.length === 0) break;
        }
      });
    };
    return { read, file, settleNewestFirst, emit: () => act(() => { fire?.(); }) };
  };

  it('never rolls the transcript back when re-reads resolve out of order', async () => {
    const staged = stagedReads();
    const { getByTestId } = render(
      <SubagentView projectId={1} sessionId="s1" agentId="a1" tabId="session:s1" />,
    );
    await staged.settleNewestFirst();
    expect(getByTestId('stream').textContent).toBe('1');

    staged.file.lines = 2;
    staged.emit();
    staged.file.lines = 3;
    staged.emit();
    await staged.settleNewestFirst();

    expect(getByTestId('stream').textContent).toBe('3');
  });

  it('coalesces a burst of agent events into one trailing re-read', async () => {
    const staged = stagedReads();
    render(<SubagentView projectId={1} sessionId="s1" agentId="a1" tabId="session:s1" />);
    await staged.settleNewestFirst();
    expect(staged.read).toHaveBeenCalledTimes(1);

    staged.emit();
    staged.emit();
    staged.emit();
    staged.emit();
    expect(staged.read).toHaveBeenCalledTimes(1);
    await staged.settleNewestFirst();

    expect(staged.read).toHaveBeenCalledTimes(2);
  });

  it('keeps the last transcript when a live re-read fails', async () => {
    const read = vi.spyOn(tauri, 'readSubagentHistory').mockResolvedValue(history);
    let fire: (() => void) | undefined;
    vi.spyOn(tauri, 'onSubagentsChanged').mockImplementation(async (_sessionId, cb) => {
      fire = cb;
      return () => {};
    });
    const { queryByText, getByTestId } = render(
      <SubagentView projectId={1} sessionId="s1" agentId="a1" tabId="session:s1" />,
    );
    await act(async () => {});
    read.mockRejectedValue('plik zniknął');

    await act(async () => { fire?.(); });
    await settleDebounce();

    expect(queryByText(/plik zniknął/)).toBeNull();
    expect(getByTestId('stream')).toBeTruthy();
  });

  it('drops the error banner once a live re-read succeeds', async () => {
    const read = vi.spyOn(tauri, 'readSubagentHistory').mockRejectedValue('brak pliku agenta');
    let fire: (() => void) | undefined;
    vi.spyOn(tauri, 'onSubagentsChanged').mockImplementation(async (_sessionId, cb) => {
      fire = cb;
      return () => {};
    });
    const { queryByText } = render(
      <SubagentView projectId={1} sessionId="s1" agentId="a1" tabId="session:s1" />,
    );
    await act(async () => {});
    expect(queryByText(/brak pliku agenta/)).toBeTruthy();
    read.mockResolvedValue(history);

    await act(async () => { fire?.(); });
    await settleDebounce();

    expect(queryByText(/brak pliku agenta/)).toBeNull();
  });

  it('stops listening for agent changes when the view unmounts', async () => {
    vi.spyOn(tauri, 'readSubagentHistory').mockResolvedValue(history);
    const unlisten = vi.fn();
    vi.spyOn(tauri, 'onSubagentsChanged').mockResolvedValue(unlisten);
    const { unmount } = render(
      <SubagentView projectId={1} sessionId="s1" agentId="a1" tabId="session:s1" />,
    );
    await act(async () => {});

    unmount();

    expect(unlisten).toHaveBeenCalled();
  });

  it('shows the failure instead of an endless spinner when the read fails', async () => {
    vi.spyOn(tauri, 'readSubagentHistory').mockRejectedValue('brak pliku agenta');
    const { getByText } = render(
      <SubagentView projectId={1} sessionId="s1" agentId="a1" tabId="session:s1" />,
    );
    await act(async () => {});

    expect(getByText(/brak pliku agenta/)).toBeTruthy();
  });
});
