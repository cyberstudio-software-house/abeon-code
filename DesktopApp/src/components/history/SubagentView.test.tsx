import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, fireEvent, act } from '@testing-library/react';
import { useStore } from '../../store';
import { tauri } from '../../lib/tauri';
import type { SessionHistory, SubagentInfo } from '../../types';
import { SubagentView } from './SubagentView';

vi.mock('./HistoryStream', () => ({
  HistoryStream: () => <div data-testid="stream" />,
}));

const history: SessionHistory = {
  meta: {
    id: 'agent-a1', projectId: 1, title: 'Sesja agent-a1', messageCount: 2, lastModified: 0,
    gitBranch: null, cwd: null, activity: 'idle', provider: 'claude', runningAgents: 0, totalAgents: 0,
  },
  blocks: [],
  hasMoreBefore: false,
};

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
    useStore.setState({ tabs: [sessionTab], activeTabId: 'session:s1', subagentsBySession: { s1: [agent] } });
  });

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

  it('shows the failure instead of an endless spinner when the read fails', async () => {
    vi.spyOn(tauri, 'readSubagentHistory').mockRejectedValue('brak pliku agenta');
    const { getByText } = render(
      <SubagentView projectId={1} sessionId="s1" agentId="a1" tabId="session:s1" />,
    );
    await act(async () => {});

    expect(getByText(/brak pliku agenta/)).toBeTruthy();
  });
});
