import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../../lib/processManager', () => ({ processManager: { dismiss: vi.fn(), release: vi.fn() } }));
vi.mock('../../lib/detachGroup', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/detachGroup')>();
  return {
    ...actual,
    detachProjectGroup: vi.fn(),
    focusExistingGroupWindow: vi.fn().mockResolvedValue(false),
  };
});

vi.stubGlobal('ResizeObserver', class {
  observe() {}
  unobserve() {}
  disconnect() {}
});

Element.prototype.scrollIntoView = vi.fn();

import { processManager } from '../../lib/processManager';
import { detachProjectGroup, focusExistingGroupWindow } from '../../lib/detachGroup';
import { useStore } from '../../store';
import { TabBar } from './TabBar';

function seedActionTab(status: 'running' | 'exited', exitCode?: number) {
  useStore.setState({
    tabs: [{ kind: 'action', id: 'action:1', projectId: 1, actionId: 1, title: 'build', status, ...(exitCode != null ? { exitCode } : {}) }],
    activeTabId: 'action:1',
    mruOrder: ['action:1'],
    runningActions: { 1: { actionId: 1, ptyId: 'p', status, exitCode } },
    projects: [{ id: 1, name: 'P', path: '/p' }] as never,
  });
}

describe('TabBar action close', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('closes an exited action tab immediately and dismisses the process', () => {
    seedActionTab('exited', 0);
    render(<TabBar />);
    fireEvent.click(screen.getByText('×'));
    expect(screen.queryByText('Zamknąć aktywny tab?')).toBeNull();
    expect(processManager.dismiss).toHaveBeenCalledWith(1);
    expect(useStore.getState().tabs).toHaveLength(0);
  });

  it('asks for confirmation when the action process is still running', () => {
    seedActionTab('running');
    render(<TabBar />);
    fireEvent.click(screen.getByText('×'));
    expect(screen.getByText('Zamknąć aktywny tab?')).toBeInTheDocument();
    expect(useStore.getState().tabs).toHaveLength(1);
  });

  it('colors the action tab icon from runningActions (error exit → danger)', () => {
    seedActionTab('exited', 2);
    const { container } = render(<TabBar />);
    const danger = container.querySelector('.text-danger');
    expect(danger?.textContent).toBe('▶');
  });
});

describe('TabBar group detach', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(focusExistingGroupWindow).mockResolvedValue(false);
    useStore.setState({
      tabs: [
        { kind: 'session', id: 'session:s1', projectId: 1, sessionId: 's1', title: 'S1', mode: 'history' },
        { kind: 'session', id: 'session:s2', projectId: 2, sessionId: 's2', title: 'S2', mode: 'history' },
      ],
      activeTabId: 'session:s1',
      mruOrder: ['session:s1'],
      navHistory: ['session:s1'],
      navIndex: 0,
      runningActions: {},
      projects: [{ id: 1, name: 'Alfa', path: '/a' }, { id: 2, name: 'Beta', path: '/b' }] as never,
    });
  });

  it('detaches the project group from the group header context menu', async () => {
    useStore.setState({
      tabs: [
        { kind: 'session', id: 'session:s1', projectId: 1, sessionId: 's1', title: 'S1', mode: 'history' },
        { kind: 'session', id: 'session:s1b', projectId: 1, sessionId: 's1b', title: 'S1b', mode: 'history' },
        { kind: 'session', id: 'session:s2', projectId: 2, sessionId: 's2', title: 'S2', mode: 'history' },
      ],
    });
    render(<TabBar />);
    fireEvent.contextMenu(screen.getByText('Alfa'));
    fireEvent.click(screen.getByText('Wydziel do nowego okna'));
    await waitFor(() => expect(detachProjectGroup).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 1, projectName: 'Alfa' }),
    ));
    expect(vi.mocked(detachProjectGroup).mock.calls[0][0].tabs.map(t => t.id)).toEqual(['session:s1', 'session:s1b']);
  });

  it('detaches the project group from the tab context menu', async () => {
    render(<TabBar />);
    fireEvent.contextMenu(screen.getByText('S2'));
    fireEvent.click(screen.getByText('Wydziel projekt do nowego okna'));
    await waitFor(() => expect(detachProjectGroup).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 2, projectName: 'Beta' }),
    ));
  });

  it('asks for confirmation when the group holds a live process', async () => {
    useStore.setState({
      tabs: [{ kind: 'terminal', id: 'terminal:t1', projectId: 1, title: 'Terminal' }],
      activeTabId: 'terminal:t1',
    });
    render(<TabBar />);
    fireEvent.contextMenu(screen.getByText('Terminal'));
    fireEvent.click(screen.getByText('Wydziel projekt do nowego okna'));
    expect(await screen.findByText('Wydzielić grupę do nowego okna?')).toBeInTheDocument();
    expect(detachProjectGroup).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Wydziel'));
    expect(detachProjectGroup).toHaveBeenCalledOnce();
  });

  it('focuses the existing project window instead of asking to detach again', async () => {
    vi.mocked(focusExistingGroupWindow).mockResolvedValue(true);
    useStore.setState({
      tabs: [{ kind: 'terminal', id: 'terminal:t1', projectId: 1, title: 'Terminal' }],
      activeTabId: 'terminal:t1',
    });
    render(<TabBar />);
    fireEvent.contextMenu(screen.getByText('Terminal'));
    fireEvent.click(screen.getByText('Wydziel projekt do nowego okna'));
    await waitFor(() => expect(focusExistingGroupWindow).toHaveBeenCalledWith(1));
    expect(screen.queryByText('Wydzielić grupę do nowego okna?')).toBeNull();
    expect(detachProjectGroup).not.toHaveBeenCalled();
  });

  it('hides the detach items in a detached window', () => {
    render(<TabBar detachedProjectId={1} />);
    fireEvent.contextMenu(screen.getByText('S1'));
    expect(screen.queryByText('Wydziel projekt do nowego okna')).toBeNull();
  });

  it('keeps the tab strip alive in a detached window with no tabs', () => {
    useStore.setState({ tabs: [], activeTabId: null });
    render(<TabBar detachedProjectId={1} />);
    expect(screen.getByTitle('Nowa sesja')).toBeInTheDocument();
    expect(screen.getByTitle('Nowy terminal')).toBeInTheDocument();
  });
});

describe('TabBar grouping rule', () => {
  beforeEach(() => {
    useStore.setState({
      tabs: [
        { kind: 'session', id: 'session:s2a', projectId: 2, sessionId: 's2a', title: 'S2a', mode: 'history' },
        { kind: 'session', id: 'session:s1', projectId: 1, sessionId: 's1', title: 'S1', mode: 'history' },
        { kind: 'session', id: 'session:s2b', projectId: 2, sessionId: 's2b', title: 'S2b', mode: 'history' },
      ],
      activeTabId: 'session:s1',
      mruOrder: ['session:s1'],
      navHistory: ['session:s1'],
      navIndex: 0,
      runningActions: {},
      projects: [{ id: 1, name: 'Alfa', path: '/a' }, { id: 2, name: 'Beta', path: '/b' }] as never,
    });
  });

  it('renders the single-tab project first and without a group header', () => {
    const { container } = render(<TabBar />);
    expect([...container.querySelectorAll('[data-tab-id]')].map(el => el.getAttribute('data-tab-id')))
      .toEqual(['session:s1', 'session:s2a', 'session:s2b']);
    expect(screen.getByText('Beta')).toBeInTheDocument();
    expect(screen.queryByText('Alfa')).toBeNull();
  });

  it('collapses only the real group, leaving the hoisted tab visible', () => {
    render(<TabBar />);
    fireEvent.click(screen.getByText('Beta'));
    expect(screen.queryByText('S2a')).toBeNull();
    expect(screen.queryByText('S2b')).toBeNull();
    expect(screen.getByText('S1')).toBeInTheDocument();
  });
});
