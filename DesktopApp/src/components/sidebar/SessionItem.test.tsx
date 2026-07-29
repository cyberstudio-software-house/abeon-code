import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
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

describe('SessionItem provider icon', () => {
  it('renders provider icon tinted by activity (waitingTool → text-warn)', () => {
    const session = meta('waitingTool', 'codex');
    const { container } = render(<SessionItem session={session} onClick={() => {}} />);
    const iconSpan = container.querySelector('span[title]');
    expect(iconSpan).toBeTruthy();
    const svg = iconSpan?.querySelector('svg');
    expect(svg).toBeTruthy();
    expect(svg?.getAttribute('class') ?? '').toContain('text-warn');
  });

  it('renders text-success when running', () => {
    const { container } = render(<SessionItem session={meta('running')} onClick={() => {}} />);
    const svg = container.querySelector('span[title] svg');
    expect(svg?.getAttribute('class') ?? '').toContain('text-success');
  });

  it('renders text-accent when waitingUser', () => {
    const { container } = render(<SessionItem session={meta('waitingUser')} onClick={() => {}} />);
    const svg = container.querySelector('span[title] svg');
    expect(svg?.getAttribute('class') ?? '').toContain('text-accent');
  });

  it('renders text-muted when idle', () => {
    const { container } = render(<SessionItem session={meta('idle')} onClick={() => {}} />);
    const svg = container.querySelector('span[title] svg');
    expect(svg?.getAttribute('class') ?? '').toContain('text-muted');
  });

  it('claude and codex sessions render different svgs (different polygon vs path content)', () => {
    const { container: claudeContainer } = render(<SessionItem session={meta('idle', 'claude')} onClick={() => {}} />);
    const { container: codexContainer } = render(<SessionItem session={meta('idle', 'codex')} onClick={() => {}} />);
    const claudeSvgInner = claudeContainer.querySelector('span[title] svg')?.innerHTML;
    const codexSvgInner = codexContainer.querySelector('span[title] svg')?.innerHTML;
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
