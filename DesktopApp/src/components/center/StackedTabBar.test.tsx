import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

vi.mock('../../lib/processManager', () => ({ processManager: { dismiss: vi.fn(), release: vi.fn() } }));
vi.mock('../../lib/detachGroup', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/detachGroup')>();
  return {
    ...actual,
    detachProjectGroup: vi.fn(),
    focusExistingGroupWindow: vi.fn().mockResolvedValue(false),
  };
});

vi.mock('../../lib/detachSession', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/detachSession')>();
  return { ...actual, detachSessionTab: vi.fn() };
});

vi.stubGlobal('ResizeObserver', class {
  observe() {}
  unobserve() {}
  disconnect() {}
});

Element.prototype.scrollIntoView = vi.fn();

import { processManager } from '../../lib/processManager';
import { detachProjectGroup, focusExistingGroupWindow } from '../../lib/detachGroup';
import { detachSessionTab } from '../../lib/detachSession';
import { useStore } from '../../store';
import { StackedTabBar } from './StackedTabBar';
import { createLeaf, insertBeside } from '../../lib/paneTree';
import { ROOT_PANE_ID } from '../../store/panesSlice';

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

  it('toggles the terminal drawer of the active session', () => {
    seed('session:a1', ['session:a1']);
    useStore.setState({ drawers: {}, drawerTerminals: {} });
    render(<StackedTabBar />);
    fireEvent.click(screen.getByTitle('Nowy terminal'));
    expect(useStore.getState().drawers['session:a1']?.open).toBe(true);
  });

  it('opens a terminal tab when the active tab is not a session', () => {
    seed('session:a1', ['session:a1']);
    const openNewTerminalTab = vi.fn();
    useStore.setState({
      tabs: [...useStore.getState().tabs, { kind: 'terminal', id: 'terminal:x', projectId: 1, title: 'T' }],
      activeTabId: 'terminal:x',
      openNewTerminalTab,
    });
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

function seedActionTab(status: 'running' | 'exited', exitCode?: number) {
  useStore.setState({
    tabs: [{ kind: 'action', id: 'action:1', projectId: 1, actionId: 1, title: 'build', status, ...(exitCode != null ? { exitCode } : {}) }],
    activeTabId: 'action:1',
    mruOrder: ['action:1'],
    runningActions: { 1: { actionId: 1, ptyId: 'p', status, exitCode } },
    projects: [{ id: 1, name: 'P', path: '/p' }] as never,
  });
}

describe('StackedTabBar action close', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('closes an exited action tab immediately and dismisses the process', () => {
    seedActionTab('exited', 0);
    render(<StackedTabBar />);
    fireEvent.click(screen.getByText('×'));
    expect(screen.queryByText('Zamknąć aktywny tab?')).toBeNull();
    expect(processManager.dismiss).toHaveBeenCalledWith(1);
    expect(useStore.getState().tabs).toHaveLength(0);
  });

  it('asks for confirmation when the action process is still running', () => {
    seedActionTab('running');
    render(<StackedTabBar />);
    fireEvent.click(screen.getByText('×'));
    expect(screen.getByText('Zamknąć aktywny tab?')).toBeInTheDocument();
    expect(processManager.dismiss).not.toHaveBeenCalled();
    expect(useStore.getState().tabs).toHaveLength(1);
  });

  it('colors the action tab icon from runningActions (error exit to danger)', () => {
    seedActionTab('exited', 2);
    const { container } = render(<StackedTabBar />);
    const danger = container.querySelector('.text-danger');
    expect(danger?.textContent).toBe('▶');
  });
});

describe('StackedTabBar group detach', () => {
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
      projects: projects as never,
    });
  });

  const seedLiveTerminal = () => {
    useStore.setState({
      tabs: [{ kind: 'terminal', id: 'terminal:t1', projectId: 1, title: 'Terminal' }],
      activeTabId: 'terminal:t1',
    });
  };

  it('detaches the project group from the project row context menu', async () => {
    useStore.setState({
      tabs: [
        { kind: 'session', id: 'session:s1', projectId: 1, sessionId: 's1', title: 'S1', mode: 'history' },
        { kind: 'session', id: 'session:s1b', projectId: 1, sessionId: 's1b', title: 'S1b', mode: 'history' },
        { kind: 'session', id: 'session:s2', projectId: 2, sessionId: 's2', title: 'S2', mode: 'history' },
      ],
    });
    const { container } = render(<StackedTabBar />);
    fireEvent.contextMenu(container.querySelector('[data-project-tab-id="1"]') as HTMLElement);
    fireEvent.click(screen.getByText('Wydziel do nowego okna'));
    await waitFor(() => expect(detachProjectGroup).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 1, projectName: 'Alfa' }),
    ));
    expect(vi.mocked(detachProjectGroup).mock.calls[0][0].tabs.map(t => t.id)).toEqual(['session:s1', 'session:s1b']);
  });

  it('detaches the project group from the tab context menu', async () => {
    useStore.setState({ activeTabId: 'session:s2', mruOrder: ['session:s2'], navHistory: ['session:s2'] });
    render(<StackedTabBar />);
    fireEvent.contextMenu(screen.getByText('S2'));
    fireEvent.click(screen.getByText('Wydziel projekt do nowego okna'));
    await waitFor(() => expect(detachProjectGroup).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 2, projectName: 'Beta' }),
    ));
    expect(vi.mocked(detachProjectGroup).mock.calls[0][0].tabs.map(t => t.id)).toEqual(['session:s2']);
  });

  it('asks for confirmation when the group holds a live process', async () => {
    seedLiveTerminal();
    render(<StackedTabBar />);
    fireEvent.contextMenu(screen.getByText('Terminal'));
    fireEvent.click(screen.getByText('Wydziel projekt do nowego okna'));
    expect(await screen.findByText('Wydzielić grupę do nowego okna?')).toBeInTheDocument();
    expect(detachProjectGroup).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Wydziel'));
    expect(detachProjectGroup).toHaveBeenCalledOnce();
  });

  it('focuses the existing project window instead of asking to detach again', async () => {
    vi.mocked(focusExistingGroupWindow).mockResolvedValue(true);
    seedLiveTerminal();
    render(<StackedTabBar />);
    fireEvent.contextMenu(screen.getByText('Terminal'));
    fireEvent.click(screen.getByText('Wydziel projekt do nowego okna'));
    await waitFor(() => expect(focusExistingGroupWindow).toHaveBeenCalledWith(1));
    expect(screen.queryByText('Wydzielić grupę do nowego okna?')).toBeNull();
    expect(detachProjectGroup).not.toHaveBeenCalled();
  });

  it('hides the detach items in a detached window', () => {
    render(<StackedTabBar detachedProjectId={1} />);
    fireEvent.contextMenu(screen.getByText('S1'));
    expect(screen.queryByText('Wydziel projekt do nowego okna')).toBeNull();
  });

  it('keeps the tab strip alive in a detached window with no tabs', () => {
    useStore.setState({ tabs: [], activeTabId: null });
    render(<StackedTabBar detachedProjectId={1} />);
    expect(screen.getByTitle('Nowa sesja')).toBeInTheDocument();
    expect(screen.getByTitle('Nowy terminal')).toBeInTheDocument();
  });
});

describe('StackedTabBar per pane', () => {
  const seedTwoPanes = () => {
    useStore.setState({
      tabs: [
        { kind: 'terminal', id: 't1', projectId: 1, title: 'Lewy' },
        { kind: 'terminal', id: 't2', projectId: 1, title: 'Prawy' },
      ],
      activeTabId: 't1',
      projects: [{ id: 1, name: 'P', path: '/p' }] as never,
      layout: insertBeside(createLeaf(ROOT_PANE_ID, ['t1'], 't1'), ROOT_PANE_ID, 'row', false, createLeaf('p2', ['t2'], 't2'), 's1'),
      focusedPaneId: ROOT_PANE_ID,
    });
  };

  beforeEach(() => { vi.clearAllMocks(); });

  it('renders only the tabs of its own pane', () => {
    seedTwoPanes();
    render(<StackedTabBar paneId="p2" />);
    expect(screen.queryByText('Lewy')).toBeNull();
    expect(screen.getByText('Prawy')).toBeTruthy();
  });

  it('dims the active tab of a pane that does not hold the focus', () => {
    seedTwoPanes();
    const { container } = render(<StackedTabBar paneId="p2" />);
    const el = container.querySelector('[data-tab-id="t2"]') as HTMLElement;
    expect(el.className).toContain('bg-bg-elev');
    expect(el.className).toContain('text-muted');
    expect(el.className).not.toContain('text-fg');
  });

  it('activates a tab through its own pane', () => {
    seedTwoPanes();
    render(<StackedTabBar paneId="p2" />);
    fireEvent.click(screen.getByText('Prawy'));
    expect(useStore.getState().focusedPaneId).toBe('p2');
    expect(useStore.getState().activeTabId).toBe('t2');
  });

  it('lets only the pane owning the active tab react to the close shortcut', () => {
    useStore.setState({
      tabs: [
        { kind: 'action', id: 'action:1', projectId: 1, actionId: 1, title: 'build', status: 'running' },
        { kind: 'terminal', id: 't2', projectId: 1, title: 'Prawy' },
      ],
      activeTabId: 'action:1',
      mruOrder: ['action:1'],
      navHistory: ['action:1'],
      navIndex: 0,
      runningActions: { 1: { actionId: 1, ptyId: 'p', status: 'running' } },
      projects: [{ id: 1, name: 'P', path: '/p' }] as never,
      layout: insertBeside(createLeaf(ROOT_PANE_ID, ['action:1'], 'action:1'), ROOT_PANE_ID, 'row', false, createLeaf('p2', ['t2'], 't2'), 's1'),
      focusedPaneId: ROOT_PANE_ID,
    });
    render(<><StackedTabBar paneId={ROOT_PANE_ID} /><StackedTabBar paneId="p2" /></>);

    fireEvent.keyDown(document, { key: 'w', ctrlKey: true });

    expect(screen.getAllByText('Zamknąć aktywny tab?')).toHaveLength(1);
    expect(useStore.getState().tabs).toHaveLength(2);
    expect(processManager.dismiss).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('Zamknij'));
    expect(processManager.dismiss).toHaveBeenCalledExactlyOnceWith(1);
    expect(useStore.getState().tabs.map(t => t.id)).toEqual(['t2']);
  });
});

describe('StackedTabBar session detach to a window', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('hands the drawer shells over as tabs before the session tab closes', () => {
    useStore.setState({
      tabs: [{ kind: 'session', id: 'session:s1', projectId: 1, sessionId: 's1', title: 'S1', mode: 'history' }],
      activeTabId: 'session:s1',
      mruOrder: ['session:s1'],
      navHistory: ['session:s1'],
      navIndex: 0,
      runningActions: {},
      projects: [{ id: 1, name: 'Alfa', path: '/a' }] as never,
      layout: createLeaf(ROOT_PANE_ID, ['session:s1'], 'session:s1'),
      focusedPaneId: ROOT_PANE_ID,
      drawers: {},
      drawerTerminals: {},
    });
    act(() => { useStore.getState().toggleTerminalDrawer('session:s1'); });
    const drawerTerminalId = Object.keys(useStore.getState().drawerTerminals)[0];

    render(<StackedTabBar />);
    fireEvent.contextMenu(screen.getByText('S1'));
    fireEvent.click(screen.getByText('Otwórz w nowym oknie'));

    expect(detachSessionTab).toHaveBeenCalledOnce();
    const closeTab = vi.mocked(detachSessionTab).mock.calls[0][1];
    act(() => { closeTab('session:s1'); });

    const state = useStore.getState();
    expect(state.tabs.map(t => t.id)).toEqual([drawerTerminalId]);
    expect(state.tabs[0].kind).toBe('terminal');
    expect(state.drawers).toEqual({});
    expect(state.drawerTerminals).toEqual({});
  });
});
