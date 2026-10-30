import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, fireEvent, waitFor, act } from '@testing-library/react';
import { SessionItem } from './SessionItem';
import { useStore } from '../../store';
import { tauri } from '../../lib/tauri';
import type { SessionMeta, SubagentInfo } from '../../types';

function meta(
  activity: SessionMeta['activity'],
  provider: SessionMeta['provider'] = 'claude',
  over: Partial<SessionMeta> = {},
): SessionMeta {
  return {
    id: 'abc12345',
    projectId: 1,
    title: 'Test session',
    messageCount: 1,
    lastModified: Date.now(),
    createdAt: null,
    gitBranch: null,
    cwd: null,
    activity,
    provider,
    runningAgents: 0,
    totalAgents: 0,
    ...over,
  };
}

function agent(over: Partial<SubagentInfo> = {}): SubagentInfo {
  return {
    agentId: 'agent-1', agentType: 'Explore', description: 'Find shortcuts',
    status: 'running', startedAt: 1000, endedAt: null, ...over,
  };
}

describe('SessionItem activity marker', () => {
  beforeEach(() => {
    useStore.setState({ attentionSessions: new Set() });
  });

  it('draws a pink dot when waiting for a tool', () => {
    const { container } = render(<SessionItem session={meta('waitingTool', 'codex')} onClick={() => {}} />);
    const dot = container.querySelector('span[title]');
    expect(dot?.getAttribute('class') ?? '').toContain('bg-pink');
    expect(dot?.getAttribute('class') ?? '').not.toContain('activity-pulse');
  });

  it('draws a pulsing accent dot when running', () => {
    const { container } = render(<SessionItem session={meta('running')} onClick={() => {}} />);
    const cls = container.querySelector('span[title]')?.getAttribute('class') ?? '';
    expect(cls).toContain('bg-accent');
    expect(cls).toContain('activity-pulse');
  });

  it('draws an info dot when waiting for the user', () => {
    const { container } = render(<SessionItem session={meta('waitingUser')} onClick={() => {}} />);
    expect(container.querySelector('span[title]')?.getAttribute('class') ?? '').toContain('bg-info');
  });

  it('replaces the dot with an info bell when the session needs attention', () => {
    useStore.setState({ attentionSessions: new Set(['abc12345']) });
    const { container } = render(<SessionItem session={meta('waitingUser')} onClick={() => {}} />);
    const svg = container.querySelector('span[title] svg');
    const cls = svg?.getAttribute('class') ?? '';
    expect(cls).toContain('text-info');
    expect(cls).not.toContain('text-accent');
  });

  it('draws a muted dot when idle', () => {
    const { container } = render(<SessionItem session={meta('idle')} onClick={() => {}} />);
    expect(container.querySelector('span[title]')?.getAttribute('class') ?? '').toContain('bg-muted');
  });

  it('claude and codex sessions render different provider svgs', () => {
    const { container: claudeContainer } = render(<SessionItem session={meta('idle', 'claude')} onClick={() => {}} />);
    const { container: codexContainer } = render(<SessionItem session={meta('idle', 'codex')} onClick={() => {}} />);
    const claudeSvgInner = claudeContainer.querySelector('li > svg')?.innerHTML;
    const codexSvgInner = codexContainer.querySelector('li > svg')?.innerHTML;
    expect(claudeSvgInner).toBeTruthy();
    expect(claudeSvgInner).not.toEqual(codexSvgInner);
  });
});

describe('SessionItem subagents', () => {
  beforeEach(() => {
    useStore.setState({ subagentsBySession: {}, tabs: [], activeTabId: null, mruOrder: [] });
    vi.restoreAllMocks();
  });

  it('renders the badge from the session agent counters', () => {
    const session = meta('running', 'claude', { runningAgents: 2, totalAgents: 3 });
    const { getByRole } = render(<ul><SessionItem session={session} onClick={() => {}} /></ul>);
    const badge = getByRole('button');
    expect(badge.textContent).toContain('2');
    expect(badge.getAttribute('aria-expanded')).toBe('false');
  });

  it('loads the agents once on expand and not again on collapse', async () => {
    const listSubagents = vi.spyOn(tauri, 'listSubagents').mockResolvedValue([agent()]);
    const session = meta('running', 'claude', { runningAgents: 1, totalAgents: 1 });
    const { getByRole, findByTitle } = render(<ul><SessionItem session={session} onClick={() => {}} /></ul>);

    fireEvent.click(getByRole('button'));
    await findByTitle('Pracuje · Find shortcuts');
    expect(listSubagents).toHaveBeenCalledOnce();
    expect(listSubagents).toHaveBeenCalledWith(1, 'abc12345');

    fireEvent.click(getByRole('button'));
    expect(listSubagents).toHaveBeenCalledOnce();
  });

  it('reloads the expanded list when the session agent counters change', async () => {
    const listSubagents = vi.spyOn(tauri, 'listSubagents').mockResolvedValue([agent()]);
    const { getByRole, findByTitle, rerender } = render(
      <ul><SessionItem session={meta('running', 'claude', { runningAgents: 2, totalAgents: 2 })} onClick={() => {}} /></ul>,
    );

    fireEvent.click(getByRole('button'));
    await findByTitle('Pracuje · Find shortcuts');
    expect(listSubagents).toHaveBeenCalledOnce();

    rerender(
      <ul><SessionItem session={meta('running', 'claude', { runningAgents: 1, totalAgents: 3 })} onClick={() => {}} /></ul>,
    );

    await waitFor(() => expect(listSubagents).toHaveBeenCalledTimes(2));
  });

  it('does not reload a collapsed list when the session agent counters change', async () => {
    const listSubagents = vi.spyOn(tauri, 'listSubagents').mockResolvedValue([agent()]);
    const { rerender } = render(
      <ul><SessionItem session={meta('running', 'claude', { runningAgents: 2, totalAgents: 2 })} onClick={() => {}} /></ul>,
    );

    rerender(
      <ul><SessionItem session={meta('running', 'claude', { runningAgents: 1, totalAgents: 3 })} onClick={() => {}} /></ul>,
    );
    await act(async () => {});

    expect(listSubagents).not.toHaveBeenCalled();
  });

  it('surfaces a failed agent load instead of claiming the session has no agents', async () => {
    vi.spyOn(tauri, 'listSubagents').mockRejectedValue('nie ma katalogu subagents');
    const { getByRole, findByText, queryByText } = render(
      <ul><SessionItem session={meta('running', 'claude', { runningAgents: 1, totalAgents: 1 })} onClick={() => {}} /></ul>,
    );

    fireEvent.click(getByRole('button'));

    expect(await findByText(/nie ma katalogu subagents/)).toBeTruthy();
    expect(queryByText('Brak agentów')).toBeNull();
  });

  it('does not open the session when the badge is clicked', () => {
    const onClick = vi.fn();
    vi.spyOn(tauri, 'listSubagents').mockResolvedValue([]);
    const session = meta('running', 'claude', { runningAgents: 1, totalAgents: 1 });
    const { getByRole } = render(<ul><SessionItem session={session} onClick={onClick} /></ul>);

    fireEvent.click(getByRole('button'));

    expect(onClick).not.toHaveBeenCalled();
  });

  it('points viewSubagent at the tab that openSessionTab focused', async () => {
    vi.spyOn(tauri, 'listSubagents').mockResolvedValue([agent({ agentId: 'agent-7' })]);
    const session = meta('running', 'claude', { runningAgents: 1, totalAgents: 1 });
    const { getByRole, findByTitle } = render(<ul><SessionItem session={session} onClick={() => {}} /></ul>);

    fireEvent.click(getByRole('button'));
    fireEvent.click(await findByTitle('Pracuje · Find shortcuts'));

    const { tabs, activeTabId } = useStore.getState();
    const focused = tabs.find(t => t.id === activeTabId);
    expect(focused?.kind).toBe('session');
    expect(focused?.kind === 'session' && focused.sessionId).toBe('abc12345');
    expect(focused?.kind === 'session' && focused.viewingSubagentId).toBe('agent-7');
  });
});
