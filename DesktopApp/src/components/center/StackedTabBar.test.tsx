import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

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

import { useStore } from '../../store';
import { StackedTabBar } from './StackedTabBar';

const projects = [
  { id: 1, name: 'Alfa', path: '/a' },
  { id: 2, name: 'Beta', path: '/b' },
];

function seed(activeTabId: string, mruOrder: string[]) {
  useStore.setState({
    tabs: [
      { kind: 'session', id: 'session:a1', projectId: 1, sessionId: 'a1', title: 'A1', mode: 'history' },
      { kind: 'session', id: 'session:a2', projectId: 1, sessionId: 'a2', title: 'A2', mode: 'history' },
      { kind: 'session', id: 'session:b1', projectId: 2, sessionId: 'b1', title: 'B1', mode: 'history' },
    ],
    activeTabId,
    mruOrder,
    navHistory: [activeTabId],
    navIndex: 0,
    runningActions: {},
    projects: projects as never,
  });
}

const projectTabIds = (container: HTMLElement) =>
  [...container.querySelectorAll('[data-project-tab-id]')].map(el => el.getAttribute('data-project-tab-id'));

const sessionTabIds = (container: HTMLElement) =>
  [...container.querySelectorAll('[data-tab-id]')].map(el => el.getAttribute('data-tab-id'));

describe('StackedTabBar rows', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('lists every project of the pane on top and only the active project sessions below', () => {
    seed('session:a1', ['session:a1']);
    const { container } = render(<StackedTabBar />);
    expect(projectTabIds(container)).toEqual(['1', '2']);
    expect(sessionTabIds(container)).toEqual(['session:a1', 'session:a2']);
  });

  it('follows the active tab when it moves to another project', () => {
    seed('session:b1', ['session:b1']);
    const { container } = render(<StackedTabBar />);
    expect(sessionTabIds(container)).toEqual(['session:b1']);
  });

  it('shows one project and one session when a single session is open', () => {
    useStore.setState({
      tabs: [{ kind: 'session', id: 'session:a1', projectId: 1, sessionId: 'a1', title: 'A1', mode: 'history' }],
      activeTabId: 'session:a1',
      mruOrder: ['session:a1'],
      navHistory: ['session:a1'],
      navIndex: 0,
      runningActions: {},
      projects: projects as never,
    });
    const { container } = render(<StackedTabBar />);
    expect(projectTabIds(container)).toEqual(['1']);
    expect(sessionTabIds(container)).toEqual(['session:a1']);
  });
});

describe('StackedTabBar project selection', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('activates the most recently used tab of the clicked project', () => {
    seed('session:b1', ['session:b1', 'session:a2', 'session:a1']);
    render(<StackedTabBar />);
    fireEvent.click(screen.getByText('Alfa'));
    expect(useStore.getState().activeTabId).toBe('session:a2');
  });

  it('falls back to the first tab of the project when none was ever active', () => {
    seed('session:b1', ['session:b1']);
    render(<StackedTabBar />);
    fireEvent.click(screen.getByText('Alfa'));
    expect(useStore.getState().activeTabId).toBe('session:a1');
  });
});

describe('StackedTabBar session row actions', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('opens a new session for the project of the active tab', () => {
    seed('session:b1', ['session:b1']);
    const openNewSessionTab = vi.fn();
    useStore.setState({ openNewSessionTab });
    render(<StackedTabBar />);
    fireEvent.click(screen.getByTitle('Nowa sesja'));
    expect(openNewSessionTab).toHaveBeenCalledWith(2);
  });

  it('opens a new terminal for the project of the active tab', () => {
    seed('session:a1', ['session:a1']);
    const openNewTerminalTab = vi.fn();
    useStore.setState({ openNewTerminalTab });
    render(<StackedTabBar />);
    fireEvent.click(screen.getByTitle('Nowy terminal'));
    expect(openNewTerminalTab).toHaveBeenCalledWith(1);
  });

  it('guards closing a tab that still runs a process', () => {
    useStore.setState({
      tabs: [{ kind: 'terminal', id: 'terminal:t1', projectId: 1, title: 'Terminal' }],
      activeTabId: 'terminal:t1',
      mruOrder: ['terminal:t1'],
      navHistory: ['terminal:t1'],
      navIndex: 0,
      runningActions: {},
      projects: projects as never,
    });
    render(<StackedTabBar />);
    fireEvent.click(screen.getByText('×'));
    expect(screen.getByText('Zamknąć aktywny tab?')).toBeInTheDocument();
    expect(useStore.getState().tabs).toHaveLength(1);
  });
});
