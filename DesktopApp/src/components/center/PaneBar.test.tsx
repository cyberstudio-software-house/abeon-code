import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), info: vi.fn() } }));
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

import { toast } from 'sonner';
import { processManager } from '../../lib/processManager';
import { detachProjectGroup, focusExistingGroupWindow } from '../../lib/detachGroup';
import { detachSessionTab } from '../../lib/detachSession';
import { useStore } from '../../store';
import { PaneBar } from './PaneBar';
import { createLeaf, insertBeside } from '../../lib/paneTree';
import { ROOT_PANE_ID } from '../../store/panesSlice';
import type { Tab } from '../../store/tabsSlice';
import { tauri } from '../../lib/tauri';
import { mockFileIo, seedCleanFileTab, seedDirtyFileTab } from '../../test-helpers/dirtyFiles';

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

const sessionTabIds = (container: HTMLElement) =>
  [...container.querySelectorAll('[data-tab-id]')].map(el => el.getAttribute('data-tab-id'));

describe('PaneBar session row', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('shows only the session tabs of the selected project with the + and $ buttons', () => {
    seed('session:a1', ['session:a1']);
    const { container } = render(<PaneBar />);
    expect(sessionTabIds(container)).toEqual(['session:a1', 'session:a2']);
    expect(screen.getByTitle('Nowa sesja')).toBeInTheDocument();
    expect(screen.getByTitle('Nowy terminal')).toBeInTheDocument();
  });

  it('follows the active tab when it moves to another project', () => {
    seed('session:b1', ['session:b1']);
    const { container } = render(<PaneBar />);
    expect(sessionTabIds(container)).toEqual(['session:b1']);
  });

  it('renders no project row inside the bar', () => {
    seed('session:a1', ['session:a1']);
    const { container } = render(<PaneBar />);
    expect(container.querySelector('[data-project-tab-id]')).toBeNull();
    expect(screen.queryByText('Alfa')).toBeNull();
    expect(screen.queryByText('Beta')).toBeNull();
  });

  it('lists the tabs in pane order, appending a replaced preview tab at the end', () => {
    useStore.setState({
      tabs: [
        { kind: 'session', id: 'session:a', projectId: 1, sessionId: 'a', title: 'A', mode: 'history' },
        { kind: 'session', id: 'session:p', projectId: 1, sessionId: 'p', title: 'P', mode: 'history', preview: true },
        { kind: 'session', id: 'session:c', projectId: 1, sessionId: 'c', title: 'C', mode: 'history' },
      ],
      activeTabId: 'session:p',
      mruOrder: ['session:p'],
      navHistory: ['session:p'],
      navIndex: 0,
      runningActions: {},
      projects: [{ id: 1, name: 'P', path: '/p' }] as never,
      layout: createLeaf(ROOT_PANE_ID, ['session:a', 'session:p', 'session:c'], 'session:p'),
      focusedPaneId: ROOT_PANE_ID,
    });
    const { container } = render(<PaneBar />);
    act(() => { useStore.getState().openSessionTab(1, 'n', 'N'); });
    expect(useStore.getState().tabs.map(t => t.id)).toEqual(['session:a', 'session:n', 'session:c']);
    expect(sessionTabIds(container)).toEqual(['session:a', 'session:c', 'session:n']);
  });
});

describe('PaneBar status', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useStore.setState({ sessionsByProject: {}, attentionSessions: new Set<string>() });
  });

  const seedSingle = (tab: Tab) => {
    useStore.setState({
      tabs: [tab],
      activeTabId: tab.id,
      mruOrder: [tab.id],
      navHistory: [tab.id],
      navIndex: 0,
      runningActions: {},
      projects: projects as never,
      layout: createLeaf(ROOT_PANE_ID, [tab.id], tab.id),
      focusedPaneId: ROOT_PANE_ID,
    });
  };

  const runningSession = (sessionId: string) => ({
    id: sessionId, projectId: 1, title: sessionId, messageCount: 1, lastModified: 0, createdAt: null,
    gitBranch: null, cwd: null, activity: 'running' as const, provider: 'claude' as const,
    runningAgents: 0, totalAgents: 0,
  });

  it('shows Tylko odczyt for a history tab', () => {
    seedSingle({ kind: 'session', id: 'session:a1', projectId: 1, sessionId: 'a1', title: 'A1', mode: 'history' });
    const { container } = render(<PaneBar />);
    expect(screen.getByText('Tylko odczyt').querySelector('svg')).not.toBeNull();
    const tab = container.querySelector('[data-tab-id="session:a1"]') as HTMLElement;
    expect(tab.querySelector('svg')).not.toBeNull();
    expect(tab.querySelector('[title="Bezczynna"]')).toBeNull();
  });

  it('shows the short activity label for a live session', () => {
    seedSingle({ kind: 'session', id: 'session:a1', projectId: 1, sessionId: 'a1', title: 'A1', mode: 'terminal' });
    useStore.setState({ sessionsByProject: { 1: { items: [runningSession('a1')], hasMore: false } } });
    const { container } = render(<PaneBar />);
    const label = screen.getByText('Pracuje');
    expect(label.className).toContain('text-accent');
    expect(screen.queryByText('Tylko odczyt')).toBeNull();
    const dot = container.querySelector('[data-tab-id="session:a1"] [title="Aktywna — agent pracuje"]') as HTMLElement;
    expect(dot.classList.contains('activity-pulse')).toBe(true);
  });

  it('shows no status for a shell tab', () => {
    seedSingle({ kind: 'terminal', id: 'terminal:t1', projectId: 1, title: 'Terminal' });
    render(<PaneBar />);
    expect(screen.queryByText('Tylko odczyt')).toBeNull();
    expect(screen.queryByText('Bezczynna')).toBeNull();
    expect(screen.queryByText('Pracuje')).toBeNull();
  });
});

describe('PaneBar session row actions', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('opens a new session for the project of the active tab', () => {
    seed('session:b1', ['session:b1']);
    const openNewSessionTab = vi.fn();
    useStore.setState({ openNewSessionTab });
    render(<PaneBar />);
    fireEvent.click(screen.getByTitle('Nowa sesja'));
    expect(openNewSessionTab).toHaveBeenCalledWith(2);
  });

  it('toggles the terminal drawer of the active session', () => {
    seed('session:a1', ['session:a1']);
    useStore.setState({ drawers: {}, drawerTerminals: {} });
    render(<PaneBar />);
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
    render(<PaneBar />);
    fireEvent.click(screen.getByTitle('Nowy terminal'));
    expect(openNewTerminalTab).toHaveBeenCalledWith(1);
  });

  it('ignores the close shortcut while settings are open', () => {
    useStore.setState({
      tabs: [{ kind: 'terminal', id: 'terminal:t1', projectId: 1, title: 'Terminal' }],
      activeTabId: 'terminal:t1',
      mruOrder: ['terminal:t1'],
      navHistory: ['terminal:t1'],
      navIndex: 0,
      runningActions: {},
      projects: projects as never,
      settingsOpen: true,
    });
    render(<PaneBar />);

    fireEvent.keyDown(document, { key: 'w', ctrlKey: true });

    expect(useStore.getState().tabs).toHaveLength(1);
    expect(screen.queryByText('Zamknąć aktywny tab?')).toBeNull();

    act(() => { useStore.getState().closeSettings(); });
    fireEvent.keyDown(document, { key: 'w', ctrlKey: true });

    expect(screen.getByText('Zamknąć aktywny tab?')).toBeInTheDocument();
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
    render(<PaneBar />);
    fireEvent.click(screen.getByTitle('Zamknij tab'));
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

describe('PaneBar action close', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('closes an exited action tab immediately and dismisses the process', () => {
    seedActionTab('exited', 0);
    render(<PaneBar />);
    fireEvent.click(screen.getByTitle('Zamknij tab'));
    expect(screen.queryByText('Zamknąć aktywny tab?')).toBeNull();
    expect(processManager.dismiss).toHaveBeenCalledWith(1);
    expect(useStore.getState().tabs).toHaveLength(0);
  });

  it('asks for confirmation when the action process is still running', () => {
    seedActionTab('running');
    render(<PaneBar />);
    fireEvent.click(screen.getByTitle('Zamknij tab'));
    expect(screen.getByText('Zamknąć aktywny tab?')).toBeInTheDocument();
    expect(processManager.dismiss).not.toHaveBeenCalled();
    expect(useStore.getState().tabs).toHaveLength(1);
  });

  it('colors the action tab status dot from runningActions (error exit to danger)', () => {
    seedActionTab('exited', 2);
    const { container } = render(<PaneBar />);
    const danger = container.querySelector('[data-tab-id="action:1"] .text-danger');
    expect(danger?.classList.contains('rounded-full')).toBe(true);
  });
});

describe('PaneBar group detach', () => {
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

  it('detaches the project group from the tab context menu', async () => {
    useStore.setState({ activeTabId: 'session:s2', mruOrder: ['session:s2'], navHistory: ['session:s2'] });
    render(<PaneBar />);
    fireEvent.contextMenu(screen.getByText('S2'));
    fireEvent.click(screen.getByText('Wydziel projekt do nowego okna'));
    await waitFor(() => expect(detachProjectGroup).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 2, projectName: 'Beta' }),
    ));
    expect(vi.mocked(detachProjectGroup).mock.calls[0][0].tabs.map(t => t.id)).toEqual(['session:s2']);
  });

  it('asks for confirmation when the group holds a live process', async () => {
    seedLiveTerminal();
    render(<PaneBar />);
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
    render(<PaneBar />);
    fireEvent.contextMenu(screen.getByText('Terminal'));
    fireEvent.click(screen.getByText('Wydziel projekt do nowego okna'));
    await waitFor(() => expect(focusExistingGroupWindow).toHaveBeenCalledWith(1));
    expect(screen.queryByText('Wydzielić grupę do nowego okna?')).toBeNull();
    expect(detachProjectGroup).not.toHaveBeenCalled();
  });

  it('hides the detach items in a detached window', () => {
    render(<PaneBar detachedProjectId={1} />);
    fireEvent.contextMenu(screen.getByText('S1'));
    expect(screen.queryByText('Wydziel projekt do nowego okna')).toBeNull();
  });

  it('keeps the tab strip alive in a detached window with no tabs', () => {
    useStore.setState({ tabs: [], activeTabId: null });
    render(<PaneBar detachedProjectId={1} />);
    expect(screen.getByTitle('Nowa sesja')).toBeInTheDocument();
    expect(screen.getByTitle('Nowy terminal')).toBeInTheDocument();
  });
});

describe('PaneBar per pane', () => {
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

  it('paints the active tab of the focused pane as the raised chip', () => {
    seedTwoPanes();
    const { container } = render(<PaneBar paneId={ROOT_PANE_ID} />);
    const el = container.querySelector('[data-tab-id="t1"]') as HTMLElement;
    expect(el.classList.contains('bg-raised-strong')).toBe(true);
    expect(el.classList.contains('text-fg-strong')).toBe(true);
  });

  it('renders only the tabs of its own pane', () => {
    seedTwoPanes();
    render(<PaneBar paneId="p2" />);
    expect(screen.queryByText('Lewy')).toBeNull();
    expect(screen.getByText('Prawy')).toBeTruthy();
  });

  it('dims the active tab of a pane that does not hold the focus', () => {
    seedTwoPanes();
    const { container } = render(<PaneBar paneId="p2" />);
    const el = container.querySelector('[data-tab-id="t2"]') as HTMLElement;
    expect(el.classList.contains('bg-field')).toBe(true);
    expect(el.classList.contains('text-fg-secondary')).toBe(true);
    expect(el.classList.contains('bg-raised-strong')).toBe(false);
    expect(el.classList.contains('text-fg-strong')).toBe(false);
  });

  it('activates a tab through its own pane', () => {
    seedTwoPanes();
    render(<PaneBar paneId="p2" />);
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
    render(<><PaneBar paneId={ROOT_PANE_ID} /><PaneBar paneId="p2" /></>);

    fireEvent.keyDown(document, { key: 'w', ctrlKey: true });

    expect(screen.getAllByText('Zamknąć aktywny tab?')).toHaveLength(1);
    expect(useStore.getState().tabs).toHaveLength(2);
    expect(processManager.dismiss).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('Zamknij'));
    expect(processManager.dismiss).toHaveBeenCalledExactlyOnceWith(1);
    expect(useStore.getState().tabs.map(t => t.id)).toEqual(['t2']);
  });
});

describe('PaneBar note tabs', () => {
  const seedNote = () => {
    useStore.setState({
      tabs: [{ kind: 'note', id: 'note:5', projectId: 1, noteId: 5, title: 'Klient' }],
      activeTabId: 'note:5',
      mruOrder: ['note:5'],
      navHistory: ['note:5'],
      navIndex: 0,
      runningActions: {},
      projects: [{ id: 1, name: 'P', path: '/p' }] as never,
      layout: createLeaf(ROOT_PANE_ID, ['note:5'], 'note:5'),
      focusedPaneId: ROOT_PANE_ID,
      noteDrafts: { k1: { key: 'k1', noteId: 5, projectId: 1, content: 'Klient', savedContent: 'Klient', status: 'idle' } },
    });
  };

  const originalRelease = useStore.getState().releaseNoteDraft;

  beforeEach(() => { vi.clearAllMocks(); });
  afterEach(() => { useStore.setState({ releaseNoteDraft: originalRelease, noteDrafts: {} }); });

  it('closes a note tab without a confirmation once the draft is released', async () => {
    seedNote();
    const releaseNoteDraft = vi.fn().mockResolvedValue(true);
    useStore.setState({ releaseNoteDraft });
    render(<PaneBar />);
    fireEvent.click(screen.getByLabelText('Zamknij tab'));
    await waitFor(() => expect(useStore.getState().tabs).toHaveLength(0));
    expect(releaseNoteDraft).toHaveBeenCalledWith('k1', { tabId: 'note:5' });
    expect(screen.queryByText('Zamknąć aktywny tab?')).not.toBeInTheDocument();
  });

  it('keeps the note tab and warns when the draft cannot be saved', async () => {
    seedNote();
    useStore.setState({ releaseNoteDraft: vi.fn().mockResolvedValue(false) });
    render(<PaneBar />);
    fireEvent.click(screen.getByLabelText('Zamknij tab'));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Nie udało się zapisać notatki'));
    expect(useStore.getState().tabs).toHaveLength(1);
  });

  it('does not start renaming a note tab', () => {
    seedNote();
    const { container } = render(<PaneBar />);
    fireEvent.doubleClick(screen.getByText('Klient'));
    expect(container.querySelector('input')).toBeNull();
  });
});

describe('PaneBar session detach to a window', () => {
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

    render(<PaneBar />);
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

describe('PaneBar unsaved file guard', () => {
  const seedFileWindow = async (kind: 'dirty' | 'clean') => {
    useStore.setState({
      tabs: [], fileBuffers: {}, activeTabId: null, mruOrder: [], navHistory: [], navIndex: 0, runningActions: {},
      projects: [{ id: 1, name: 'P', path: '/p' }] as never,
    });
    const id = kind === 'dirty' ? await seedDirtyFileTab('src/a.ts') : await seedCleanFileTab('src/a.ts');
    useStore.setState({
      activeTabId: id,
      mruOrder: [id],
      navHistory: [id],
      layout: createLeaf(ROOT_PANE_ID, [id], id),
      focusedPaneId: ROOT_PANE_ID,
    });
    return id;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockFileIo();
    vi.mocked(focusExistingGroupWindow).mockResolvedValue(false);
  });

  afterEach(() => { useStore.setState({ tabs: [], fileBuffers: {} }); });

  it('closes a clean file tab at once', async () => {
    await seedFileWindow('clean');
    render(<PaneBar />);

    fireEvent.click(screen.getByTitle('Zamknij tab'));

    expect(screen.queryByText('Niezapisane zmiany', { selector: 'h2' })).toBeNull();
    expect(useStore.getState().tabs).toHaveLength(0);
  });

  it('asks before closing a dirty file tab and keeps it while asking', async () => {
    await seedFileWindow('dirty');
    render(<PaneBar />);

    fireEvent.click(screen.getByTitle('Zamknij tab'));

    expect(screen.getByText('Niezapisane zmiany', { selector: 'h2' })).toBeInTheDocument();
    expect(screen.getAllByText('src/a.ts').length).toBeGreaterThan(0);
    expect(useStore.getState().tabs).toHaveLength(1);
  });

  it('saves and closes the tab, dropping its buffer', async () => {
    const id = await seedFileWindow('dirty');
    render(<PaneBar />);
    fireEvent.click(screen.getByTitle('Zamknij tab'));

    fireEvent.click(screen.getByText('Zapisz'));

    await waitFor(() => expect(useStore.getState().tabs).toHaveLength(0));
    expect(tauri.writeProjectFile).toHaveBeenCalledWith(1, 'src/a.ts', 'edited', 'v1', false);
    expect(useStore.getState().fileBuffers[id]).toBeUndefined();
  });

  it('keeps the tab and shows the error when saving fails', async () => {
    await seedFileWindow('dirty');
    vi.spyOn(tauri, 'writeProjectFile').mockRejectedValue({ code: 'conflict', message: 'conflict: src/a.ts' });
    render(<PaneBar />);
    fireEvent.click(screen.getByTitle('Zamknij tab'));

    fireEvent.click(screen.getByText('Zapisz'));

    expect(await screen.findByText('Nie udało się zapisać: src/a.ts. Plik zmienił się na dysku — otwórz zakładkę i wybierz „Nadpisz” albo „Wczytaj ponownie”.')).toBeInTheDocument();
    expect(useStore.getState().tabs).toHaveLength(1);
  });

  it('closes without writing on discard', async () => {
    await seedFileWindow('dirty');
    render(<PaneBar />);
    fireEvent.click(screen.getByTitle('Zamknij tab'));

    fireEvent.click(screen.getByText('Odrzuć zmiany'));

    await waitFor(() => expect(useStore.getState().tabs).toHaveLength(0));
    expect(tauri.writeProjectFile).not.toHaveBeenCalled();
  });

  it('keeps the tab and its edits on cancel', async () => {
    const id = await seedFileWindow('dirty');
    render(<PaneBar />);
    fireEvent.click(screen.getByTitle('Zamknij tab'));

    fireEvent.click(screen.getByText('Anuluj'));

    expect(screen.queryByText('Niezapisane zmiany', { selector: 'h2' })).toBeNull();
    expect(useStore.getState().tabs).toHaveLength(1);
    expect(useStore.getState().fileBuffers[id].content).toBe('edited');
  });

  it('asks on the close shortcut', async () => {
    await seedFileWindow('dirty');
    render(<PaneBar />);

    fireEvent.keyDown(document, { key: 'w', ctrlKey: true });

    expect(screen.getByText('Niezapisane zmiany', { selector: 'h2' })).toBeInTheDocument();
    expect(useStore.getState().tabs).toHaveLength(1);
  });

  it('ignores the close shortcut while settings are open', async () => {
    await seedFileWindow('dirty');
    useStore.setState({ settingsOpen: true });
    render(<PaneBar />);

    fireEvent.keyDown(document, { key: 'w', ctrlKey: true });

    expect(screen.queryByText('Niezapisane zmiany', { selector: 'h2' })).toBeNull();
    act(() => { useStore.getState().closeSettings(); });
  });

  it('asks on middle click', async () => {
    await seedFileWindow('dirty');
    const { container } = render(<PaneBar />);

    fireEvent.mouseDown(container.querySelector('[data-tab-id]') as HTMLElement, { button: 1 });

    expect(screen.getByText('Niezapisane zmiany', { selector: 'h2' })).toBeInTheDocument();
  });

  it('asks from the context menu', async () => {
    await seedFileWindow('dirty');
    render(<PaneBar />);

    fireEvent.contextMenu(screen.getByText('a.ts'));
    fireEvent.click(screen.getByText('Zamknij'));

    expect(screen.getByText('Niezapisane zmiany', { selector: 'h2' })).toBeInTheDocument();
  });

  describe('group detach', () => {
    const detachFromMenu = () => {
      fireEvent.contextMenu(screen.getByText('a.ts'));
      fireEvent.click(screen.getByText('Wydziel projekt do nowego okna'));
    };

    it('asks about the dirty file tabs of the group before detaching', async () => {
      await seedFileWindow('dirty');
      render(<PaneBar />);

      detachFromMenu();

      expect(await screen.findByText('Niezapisane zmiany', { selector: 'h2' })).toBeInTheDocument();
      expect(detachProjectGroup).not.toHaveBeenCalled();
    });

    it('detaches after the files are saved', async () => {
      await seedFileWindow('dirty');
      render(<PaneBar />);
      detachFromMenu();

      fireEvent.click(await screen.findByText('Zapisz'));

      await waitFor(() => expect(detachProjectGroup).toHaveBeenCalledOnce());
      expect(tauri.writeProjectFile).toHaveBeenCalledOnce();
    });

    it('detaches after the changes are discarded', async () => {
      await seedFileWindow('dirty');
      render(<PaneBar />);
      detachFromMenu();

      fireEvent.click(await screen.findByText('Odrzuć zmiany'));

      await waitFor(() => expect(detachProjectGroup).toHaveBeenCalledOnce());
      expect(tauri.writeProjectFile).not.toHaveBeenCalled();
    });

    it('does not detach when cancelled', async () => {
      await seedFileWindow('dirty');
      render(<PaneBar />);
      detachFromMenu();

      fireEvent.click(await screen.findByText('Anuluj'));

      expect(detachProjectGroup).not.toHaveBeenCalled();
    });

    it('detaches a group with only clean file tabs without asking', async () => {
      await seedFileWindow('clean');
      render(<PaneBar />);

      detachFromMenu();

      await waitFor(() => expect(detachProjectGroup).toHaveBeenCalledOnce());
      expect(screen.queryByText('Niezapisane zmiany', { selector: 'h2' })).toBeNull();
    });

    it('does not ask about dirty files of another project', async () => {
      await seedFileWindow('clean');
      const other = await seedDirtyFileTab('src/b.ts', 2);
      expect(other).toBeTruthy();
      render(<PaneBar />);

      detachFromMenu();

      await waitFor(() => expect(detachProjectGroup).toHaveBeenCalledOnce());
      expect(screen.queryByText('Niezapisane zmiany', { selector: 'h2' })).toBeNull();
    });
  });
});
