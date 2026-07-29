import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, fireEvent, act } from '@testing-library/react';
import { useStore } from '../../store';
import { tauri } from '../../lib/tauri';
import type { SessionHistory } from '../../types';
import { HistoryView } from './HistoryView';

vi.mock('./HistoryStream', () => ({
  HistoryStream: () => <div data-testid="stream" />,
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
    useStore.setState({ activeTabId: 'session:other' });
    const { queryByTestId } = render(<HistoryView projectId={1} sessionId="s1" tabId="session:s1" />);
    await act(async () => {});

    fireEvent.keyDown(document, { key: 'f', ctrlKey: true });

    expect(queryByTestId('search-bar')).toBeNull();
  });
});
