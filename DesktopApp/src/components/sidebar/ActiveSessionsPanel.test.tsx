import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { ActiveSessionsPanel } from './ActiveSessionsPanel';
import { useStore } from '../../store';
import { tauri } from '../../lib/tauri';
import type { ActiveSession, Project, SessionMeta, SubagentInfo } from '../../types';

function active(id: string, over: Partial<ActiveSession> = {}): ActiveSession {
  return {
    sessionId: id, projectId: 1, projectName: 'Proj', title: `T-${id}`, activity: 'running',
    lastModified: 1, provider: 'claude', runningAgents: 0, totalAgents: 0, ...over,
  };
}
function project(): Project {
  return { id: 1, name: 'Proj', path: '/p', claudeDir: 'd', color: null, sortOrder: 0, createdAt: 0 };
}
function meta(id: string, over: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id, projectId: 1, title: `T-${id}`, messageCount: 1, lastModified: 1,
    gitBranch: null, cwd: null, activity: 'running', provider: 'claude',
    runningAgents: 0, totalAgents: 0, ...over,
  };
}
function agent(over: Partial<SubagentInfo> = {}): SubagentInfo {
  return {
    agentId: 'agent-1', agentType: 'Explore', description: 'Find shortcuts',
    status: 'running', startedAt: 1000, endedAt: null, ...over,
  };
}
// Minimal session tab — the panel only reads kind/sessionId/linkedSessionId.
function sessionTab(sessionId: string) {
  return { kind: 'session', id: `session:${sessionId}`, sessionId, projectId: 1, title: `T-${sessionId}` } as never;
}

describe('ActiveSessionsPanel visibility', () => {
  beforeEach(() => {
    useStore.setState({
      showActiveSessions: true, activeSessions: [], attentionSessions: new Set(),
      sessionsByProject: {}, projects: [project()], tabs: [],
    });
  });

  it('renders nothing when there are no active sessions', () => {
    const { container } = render(<ActiveSessionsPanel />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when the active session has no open tab', () => {
    useStore.setState({ activeSessions: [active('a')], tabs: [] });
    const { container } = render(<ActiveSessionsPanel />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when showActiveSessions is false', () => {
    useStore.setState({ showActiveSessions: false, activeSessions: [active('a')], tabs: [sessionTab('a')] });
    const { container } = render(<ActiveSessionsPanel />);
    expect(container.firstChild).toBeNull();
  });

  it('renders the header with a count for an active session that has an open tab', () => {
    useStore.setState({ activeSessions: [active('a')], tabs: [sessionTab('a')] });
    const { getByText } = render(<ActiveSessionsPanel />);
    expect(getByText('Aktywne')).toBeTruthy();
    expect(getByText('1')).toBeTruthy();
  });
});

describe('ActiveSessionsPanel subagents', () => {
  const badgeLabel = 'Pracuje 1 z 2 agentów';

  beforeEach(() => {
    useStore.setState({
      showActiveSessions: true,
      activeSessions: [active('a', { runningAgents: 1, totalAgents: 2 })],
      attentionSessions: new Set(),
      sessionsByProject: { 1: { items: [meta('a')], hasMore: false } },
      subagentsBySession: {},
      projects: [project()],
      tabs: [sessionTab('a')],
      activeTabId: null,
      mruOrder: [],
    });
    vi.restoreAllMocks();
  });

  it('renders the badge from the counters carried by the active session row', () => {
    const { getByRole } = render(<ActiveSessionsPanel />);
    expect(getByRole('button', { name: badgeLabel }).textContent).toContain('1');
  });

  it('renders the badge for a project whose sessions were never expanded in the sidebar', () => {
    useStore.setState({ sessionsByProject: {} });
    const { getByRole } = render(<ActiveSessionsPanel />);
    expect(getByRole('button', { name: badgeLabel }).textContent).toContain('1');
  });

  it('loads the agents once on expand and not again on collapse', async () => {
    const listSubagents = vi.spyOn(tauri, 'listSubagents').mockResolvedValue([agent()]);
    const { getByRole, findByTitle } = render(<ActiveSessionsPanel />);

    fireEvent.click(getByRole('button', { name: badgeLabel }));
    await findByTitle('Pracuje · Find shortcuts');
    expect(listSubagents).toHaveBeenCalledOnce();
    expect(listSubagents).toHaveBeenCalledWith(1, 'a');

    fireEvent.click(getByRole('button', { name: badgeLabel }));
    expect(listSubagents).toHaveBeenCalledOnce();
  });

  it('points viewSubagent at the tab that openSessionTab focused', async () => {
    vi.spyOn(tauri, 'listSubagents').mockResolvedValue([agent({ agentId: 'agent-7' })]);
    const { getByRole, findByTitle } = render(<ActiveSessionsPanel />);

    fireEvent.click(getByRole('button', { name: badgeLabel }));
    fireEvent.click(await findByTitle('Pracuje · Find shortcuts'));

    const { tabs, activeTabId } = useStore.getState();
    const focused = tabs.find(t => t.id === activeTabId);
    expect(focused?.kind).toBe('session');
    expect(focused?.kind === 'session' && focused.sessionId).toBe('a');
    expect(focused?.kind === 'session' && focused.viewingSubagentId).toBe('agent-7');
  });
});
