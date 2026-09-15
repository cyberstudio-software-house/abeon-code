import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, fireEvent, act } from '@testing-library/react';
import { useStore } from '../../store';
import { tauri } from '../../lib/tauri';
import type { SessionHistory } from '../../types';
import { HistoryView } from './HistoryView';

vi.mock('./HistoryStream', () => ({
  HistoryStream: ({ blocks }: { blocks: Array<{ text?: string }> }) => (
    <div data-testid="stream">{blocks.map(block => block.text ?? '').join('|')}</div>
  ),
}));
vi.mock('./HistorySearchBar', () => ({
  HistorySearchBar: () => <div data-testid="search-bar" />,
}));
vi.mock('./SessionFooter', () => ({
  SessionFooter: () => <div data-testid="footer" />,
}));

const history: SessionHistory = {
  meta: {
    id: 's1', projectId: 1, title: 'Sesja', messageCount: 1, lastModified: 0,
    gitBranch: null, cwd: null, activity: 'idle', provider: 'claude', runningAgents: 0, totalAgents: 0,
  },
  blocks: [{ kind: 'assistantText', uuid: 'b0', timestamp: 0, text: 'hej' }],
  hasMoreBefore: false,
};

const sessionTab = {
  kind: 'session' as const, id: 'session:s1', projectId: 1, sessionId: 's1', title: 'Sesja',
  mode: 'history' as const,
};

describe('HistoryView search shortcut', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(tauri, 'readSessionHistory').mockResolvedValue(history);
    vi.spyOn(tauri, 'openSessionWatch').mockResolvedValue(undefined);
    vi.spyOn(tauri, 'closeSessionWatch').mockResolvedValue(undefined);
    vi.spyOn(tauri, 'onSessionAppend').mockResolvedValue(() => {});
    vi.spyOn(tauri, 'onSessionActivity').mockResolvedValue(() => {});
    vi.spyOn(tauri, 'onSessionTitle').mockResolvedValue(() => {});
    useStore.setState({ tabs: [sessionTab], activeTabId: 'session:s1', sessionsByProject: {} });
  });

  it('registers listeners before opening the watcher and reading the snapshot', async () => {
    const order: string[] = [];
    vi.spyOn(tauri, 'onSessionAppend').mockImplementation(async () => {
      order.push('listener');
      return () => {};
    });
    vi.spyOn(tauri, 'openSessionWatch').mockImplementation(async () => {
      order.push('watch');
    });
    vi.spyOn(tauri, 'readSessionHistory').mockImplementation(async () => {
      order.push('read');
      return history;
    });

    render(<HistoryView projectId={1} sessionId="s1" tabId="session:s1" />);
    await act(async () => {});

    expect(order.indexOf('listener')).toBeLessThan(order.indexOf('watch'));
    expect(order.indexOf('watch')).toBeLessThan(order.indexOf('read'));
  });

  it('debounces a burst of OpenCode synchronization events', async () => {
    vi.useFakeTimers();
    const opencodeHistory: SessionHistory = {
      ...history,
      meta: { ...history.meta, provider: 'opencode' },
    };
    const updatedHistory: SessionHistory = {
      ...opencodeHistory,
      blocks: [
        { kind: 'assistantText', uuid: 'b0', timestamp: 0, text: 'updated' },
        { kind: 'assistantText', uuid: 'b1', timestamp: 1, text: 'new' },
      ],
    };
    const read = vi.spyOn(tauri, 'readSessionHistory')
      .mockResolvedValueOnce(opencodeHistory)
      .mockResolvedValue(updatedHistory);
    let sync: (() => void) | undefined;
    vi.spyOn(tauri, 'onSessionSync').mockImplementation(async (_sessionId, callback) => {
      sync = callback;
      return () => {};
    });

    render(<HistoryView projectId={1} sessionId="s1" tabId="session:s1" provider="opencode" />);
    await act(async () => {});
    act(() => {
      sync?.();
      sync?.();
      vi.advanceTimersByTime(150);
    });
    await act(async () => {});

    expect(read).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('ignores an older OpenCode snapshot that resolves after a newer one', async () => {
    vi.useFakeTimers();
    const opencodeHistory: SessionHistory = {
      ...history,
      meta: { ...history.meta, provider: 'opencode' },
    };
    let resolveOlder!: (value: SessionHistory) => void;
    let resolveNewer!: (value: SessionHistory) => void;
    const older = new Promise<SessionHistory>(resolve => { resolveOlder = resolve; });
    const newer = new Promise<SessionHistory>(resolve => { resolveNewer = resolve; });
    vi.spyOn(tauri, 'readSessionHistory')
      .mockResolvedValueOnce(opencodeHistory)
      .mockReturnValueOnce(older)
      .mockReturnValueOnce(newer);
    let sync: (() => void) | undefined;
    vi.spyOn(tauri, 'onSessionSync').mockImplementation(async (_sessionId, callback) => {
      sync = callback;
      return () => {};
    });

    const { getByTestId } = render(
      <HistoryView projectId={1} sessionId="s1" tabId="session:s1" provider="opencode" />,
    );
    await act(async () => {});
    act(() => {
      sync?.();
      vi.advanceTimersByTime(150);
    });
    await act(async () => {});
    act(() => {
      sync?.();
      vi.advanceTimersByTime(150);
    });
    await act(async () => {});

    await act(async () => {
      resolveNewer({
        ...opencodeHistory,
        blocks: [{ kind: 'assistantText', uuid: 'b0', timestamp: 0, text: 'newer' }],
      });
    });
    await act(async () => {
      resolveOlder({
        ...opencodeHistory,
        blocks: [{ kind: 'assistantText', uuid: 'b0', timestamp: 0, text: 'older' }],
      });
    });

    expect(getByTestId('stream').textContent).toBe('newer');
    vi.useRealTimers();
  });

  it('opens the search bar on Ctrl+F for the active tab', async () => {
    const { queryByTestId } = render(<HistoryView projectId={1} sessionId="s1" tabId="session:s1" />);
    await act(async () => {});

    fireEvent.keyDown(document, { key: 'f', ctrlKey: true });

    expect(queryByTestId('search-bar')).toBeTruthy();
  });

  it('ignores Ctrl+F while the subagent transcript covers the tab', async () => {
    useStore.setState({ tabs: [{ ...sessionTab, viewingSubagentId: 'a1' }] });
    const { queryByTestId } = render(<HistoryView projectId={1} sessionId="s1" tabId="session:s1" />);
    await act(async () => {});

    fireEvent.keyDown(document, { key: 'f', ctrlKey: true });

    expect(queryByTestId('search-bar')).toBeNull();
  });

  it('ignores Ctrl+F for a tab that is not the active one', async () => {
    useStore.setState({
      tabs: [sessionTab, { ...sessionTab, id: 'session:other', sessionId: 'other' }],
      activeTabId: 'session:other',
    });
    const { queryByTestId } = render(<HistoryView projectId={1} sessionId="s1" tabId="session:s1" />);
    await act(async () => {});

    fireEvent.keyDown(document, { key: 'f', ctrlKey: true });

    expect(queryByTestId('search-bar')).toBeNull();
  });
});
