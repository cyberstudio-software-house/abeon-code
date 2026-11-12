import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const { onCloseRequested, destroy } = vi.hoisted(() => ({
  onCloseRequested: vi.fn(),
  destroy: vi.fn(),
}));

vi.mock('@tauri-apps/api/webviewWindow', () => ({
  getCurrentWebviewWindow: () => ({ onCloseRequested, destroy, label: 'project-1' }),
}));
vi.mock('../terminal/TerminalView', () => ({ TerminalView: () => <div data-testid="terminal" /> }));
vi.mock('../history/HistoryView', () => ({ HistoryView: () => <div data-testid="history" /> }));
vi.mock('../history/SubagentView', () => ({ SubagentView: () => <div data-testid="subagent" /> }));
vi.mock('../right/RightPanel', () => ({ RightPanel: () => <div /> }));
vi.stubGlobal('ResizeObserver', class {
  observe() {}
  unobserve() {}
  disconnect() {}
});
Element.prototype.scrollIntoView = vi.fn();

import { useStore } from '../../store';
import type { Note } from '../../types';
import { tauri } from '../../lib/tauri';
import type { AttentionEvent } from '../../lib/tauri';
import type { SessionRebound } from '../../types';
import { createLeaf, findLeaf, leaves } from '../../lib/paneTree';
import { mockFileIo, seedDirtyFileTab } from '../../test-helpers/dirtyFiles';
import { ROOT_PANE_ID } from '../../store/panesSlice';
import { DetachedShell } from './DetachedShell';

const groupMode = { view: 'group' as const, projectId: 1, tabs: [], activeTabId: 'session:s1' };
const sessionMode = { view: 'session' as const, projectId: 1, sessionId: 's1', title: 'S1', fresh: false };

const DETACHED_HINT = 'Otwórz nową sesję przyciskiem + na pasku zakładek';

const savedNote: Note = { id: 5, projectId: 1, content: 'X', createdAt: 1, updatedAt: 1 };

function seedDirtyNote() {
  useStore.getState().openNoteInPanel(savedNote);
  const key = Object.keys(useStore.getState().noteDrafts)[0];
  useStore.getState().editNoteDraft(key, 'XY');
}

function seedEmptiedNote() {
  useStore.getState().openNoteInPanel(savedNote);
  const key = Object.keys(useStore.getState().noteDrafts)[0];
  useStore.getState().editNoteDraft(key, '');
}

const sessionTab = (id: string, sessionId: string) => ({
  kind: 'session' as const, id, projectId: 1, sessionId, title: sessionId, mode: 'history' as const,
});

function seedSessionWindow() {
  useStore.setState({
    tabs: [sessionTab('session:s1', 's1')],
    activeTabId: 'session:s1',
    layout: createLeaf(ROOT_PANE_ID, ['session:s1'], 'session:s1'),
    focusedPaneId: ROOT_PANE_ID,
  });
}

function splitTwoSessions() {
  useStore.setState({
    tabs: [sessionTab('session:s1', 's1'), sessionTab('session:s2', 's2')],
    activeTabId: 'session:s1',
    layout: {
      kind: 'split', id: 'outer', dir: 'row', sizes: [0.5, 0.5],
      children: [
        createLeaf('left', ['session:s1'], 'session:s1'),
        createLeaf('right', ['session:s2'], 'session:s2'),
      ],
    },
    focusedPaneId: 'left',
  });
}

describe('DetachedShell', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFileIo();
    onCloseRequested.mockResolvedValue(() => {});
    vi.spyOn(tauri, 'emitDetachReady').mockResolvedValue(undefined);
    vi.spyOn(tauri, 'setWindowTitle').mockResolvedValue(undefined);
    vi.spyOn(tauri, 'listProjects').mockResolvedValue([]);
    vi.spyOn(tauri, 'listSessions').mockResolvedValue([]);
    vi.spyOn(tauri, 'onSessionAttention').mockResolvedValue(() => {});
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    useStore.setState({
      noteDrafts: {},
      tabs: [
        sessionTab('session:s1', 's1'),
        { kind: 'terminal', id: 'terminal:t1', projectId: 1, title: 'Terminal' },
      ],
      activeTabId: 'session:s1',
      runningActions: {},
      attentionSessions: new Set<string>(),
      projects: [{ id: 1, name: 'Alfa', path: '/a' }] as never,
      layout: createLeaf(ROOT_PANE_ID, ['session:s1', 'terminal:t1'], 'session:s1'),
      focusedPaneId: ROOT_PANE_ID,
    });
  });

  it('shows the project header in a project window', () => {
    const { container, getByText } = render(<DetachedShell mode={groupMode} />);
    const header = container.querySelector('header[data-tauri-drag-region]') as HTMLElement;
    expect(header).not.toBeNull();
    expect(getByText('Okno projektu')).toBeTruthy();
    expect(header.textContent).toContain('Alfa');
    expect(header.querySelector('[data-project-tab-id]')).toBeNull();
  });

  it('shows the project row in the header of a session window', () => {
    seedSessionWindow();
    const { container, queryByText } = render(<DetachedShell mode={sessionMode} />);
    const header = container.querySelector('header[data-tauri-drag-region]') as HTMLElement;
    expect(header.querySelector('[data-project-tab-id="1"]')).not.toBeNull();
    expect(queryByText('Okno projektu')).toBeNull();
  });

  it('blocks the close when a non-active tab still holds a live process', () => {
    render(<DetachedShell mode={groupMode} />);
    const handler = onCloseRequested.mock.calls[0][0];
    const event = { preventDefault: vi.fn() };
    handler(event);
    expect(event.preventDefault).toHaveBeenCalled();
  });

  it('lets the close through when no tab holds a live process', () => {
    useStore.setState({
      tabs: [sessionTab('session:s1', 's1')],
    });
    render(<DetachedShell mode={groupMode} />);
    const handler = onCloseRequested.mock.calls[0][0];
    const event = { preventDefault: vi.fn() };
    handler(event);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it('saves pending notes before closing', async () => {
    useStore.setState({ tabs: [sessionTab('session:s1', 's1')] });
    vi.spyOn(tauri, 'updateNote').mockResolvedValue({ ...savedNote, content: 'XY', updatedAt: 2 });
    seedDirtyNote();
    render(<DetachedShell mode={groupMode} />);
    const handler = onCloseRequested.mock.calls[0][0];
    const event = { preventDefault: vi.fn() };

    act(() => { handler(event); });

    expect(event.preventDefault).toHaveBeenCalled();
    await waitFor(() => expect(destroy).toHaveBeenCalledTimes(1));
    expect(tauri.updateNote).toHaveBeenCalledWith(5, 'XY');
  });

  it('deletes an emptied note instead of saving it when closing', async () => {
    useStore.setState({ tabs: [sessionTab('session:s1', 's1')] });
    vi.spyOn(tauri, 'updateNote').mockResolvedValue({ ...savedNote, content: '', updatedAt: 2 });
    vi.spyOn(tauri, 'deleteNote').mockResolvedValue(undefined);
    seedEmptiedNote();
    render(<DetachedShell mode={groupMode} />);
    const handler = onCloseRequested.mock.calls[0][0];

    act(() => { handler({ preventDefault: vi.fn() }); });

    await waitFor(() => expect(destroy).toHaveBeenCalledTimes(1));
    expect(tauri.deleteNote).toHaveBeenCalledWith(5);
    expect(tauri.updateNote).not.toHaveBeenCalled();
  });

  it('asks before closing when a note cannot be saved', async () => {
    useStore.setState({ tabs: [sessionTab('session:s1', 's1')] });
    vi.spyOn(tauri, 'updateNote').mockRejectedValue(new Error('disk'));
    seedDirtyNote();
    render(<DetachedShell mode={groupMode} />);
    const handler = onCloseRequested.mock.calls[0][0];

    act(() => { handler({ preventDefault: vi.fn() }); });

    expect(await screen.findByText('Nie udało się zapisać notatki')).toBeTruthy();
    expect(screen.getByText('Zamknięcie okna spowoduje utratę niezapisanej treści notatki.')).toBeTruthy();
    expect(destroy).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('Anuluj'));
    expect(screen.queryByText('Nie udało się zapisać notatki')).toBeNull();
    expect(destroy).not.toHaveBeenCalled();

    act(() => { handler({ preventDefault: vi.fn() }); });
    fireEvent.click(await screen.findByText('Zamknij mimo to'));
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('saves notes and then asks about running sessions', async () => {
    vi.spyOn(tauri, 'updateNote').mockResolvedValue({ ...savedNote, content: 'XY', updatedAt: 2 });
    seedDirtyNote();
    render(<DetachedShell mode={groupMode} />);
    const handler = onCloseRequested.mock.calls[0][0];

    act(() => { handler({ preventDefault: vi.fn() }); });

    expect(await screen.findByText('Zamknąć okno projektu?')).toBeTruthy();
    expect(tauri.updateNote).toHaveBeenCalledWith(5, 'XY');
    expect(destroy).not.toHaveBeenCalled();
  });

  describe('unsaved files', () => {
    const dialogTitle = () => screen.queryByText('Niezapisane zmiany', { selector: 'h2' });
    const closeRequest = () => {
      const event = { preventDefault: vi.fn() };
      act(() => { onCloseRequested.mock.calls[0][0](event); });
      return event;
    };

    beforeEach(async () => {
      useStore.setState({ tabs: [sessionTab('session:s1', 's1')], fileBuffers: {} });
      await seedDirtyFileTab('src/a.ts');
    });

    afterEach(() => {
      useStore.setState({ fileBuffers: {} });
    });

    it('holds the close and lists the dirty file', () => {
      render(<DetachedShell mode={groupMode} />);

      const event = closeRequest();

      expect(event.preventDefault).toHaveBeenCalled();
      expect(dialogTitle()).toBeTruthy();
      expect(within(screen.getByRole('dialog')).getByText('src/a.ts')).toBeTruthy();
      expect(destroy).not.toHaveBeenCalled();
    });

    it('keeps the window open when cancelled', () => {
      render(<DetachedShell mode={groupMode} />);
      closeRequest();

      fireEvent.click(within(screen.getByRole('dialog')).getByText('Anuluj'));

      expect(dialogTitle()).toBeNull();
      expect(destroy).not.toHaveBeenCalled();
    });

    it('closes the window after saving', async () => {
      render(<DetachedShell mode={groupMode} />);
      closeRequest();

      fireEvent.click(within(screen.getByRole('dialog')).getByText('Zapisz'));

      await waitFor(() => expect(destroy).toHaveBeenCalledTimes(1));
      expect(tauri.writeProjectFile).toHaveBeenCalledWith(1, 'src/a.ts', 'edited', 'v1', false);
    });

    it('closes the window after discarding, without writing', async () => {
      render(<DetachedShell mode={groupMode} />);
      closeRequest();

      fireEvent.click(within(screen.getByRole('dialog')).getByText('Odrzuć zmiany'));

      await waitFor(() => expect(destroy).toHaveBeenCalledTimes(1));
      expect(tauri.writeProjectFile).not.toHaveBeenCalled();
    });

    it('keeps the window and the dialog when saving fails', async () => {
      vi.spyOn(tauri, 'writeProjectFile').mockRejectedValue({ code: 'conflict', message: 'conflict: src/a.ts' });
      render(<DetachedShell mode={groupMode} />);
      closeRequest();

      fireEvent.click(within(screen.getByRole('dialog')).getByText('Zapisz'));

      expect(await screen.findByText('Nie udało się zapisać wszystkich plików.')).toBeTruthy();
      expect(destroy).not.toHaveBeenCalled();
    });

    it('asks about running sessions after the files are resolved', async () => {
      useStore.setState({ tabs: [sessionTab('session:s1', 's1'), { kind: 'terminal', id: 'terminal:t1', projectId: 1, title: 'Terminal' }] });
      await seedDirtyFileTab('src/a.ts');
      render(<DetachedShell mode={groupMode} />);
      closeRequest();
      expect(screen.queryByText('Zamknąć okno projektu?')).toBeNull();

      fireEvent.click(within(screen.getByRole('dialog')).getByText('Odrzuć zmiany'));

      expect(await screen.findByText('Zamknąć okno projektu?')).toBeTruthy();
      expect(destroy).not.toHaveBeenCalled();
    });

    it('settles notes only after the files are resolved', async () => {
      const updateNote = vi.spyOn(tauri, 'updateNote').mockResolvedValue({ ...savedNote, content: 'XY', updatedAt: 2 });
      seedDirtyNote();
      render(<DetachedShell mode={groupMode} />);
      closeRequest();

      expect(updateNote).not.toHaveBeenCalled();
      fireEvent.click(within(screen.getByRole('dialog')).getByText('Odrzuć zmiany'));

      await waitFor(() => expect(destroy).toHaveBeenCalledTimes(1));
      expect(updateNote).toHaveBeenCalledWith(5, 'XY');
    });

    it('does not touch the notes when the close is cancelled', () => {
      const updateNote = vi.spyOn(tauri, 'updateNote').mockResolvedValue({ ...savedNote, content: 'XY', updatedAt: 2 });
      seedDirtyNote();
      render(<DetachedShell mode={groupMode} />);
      closeRequest();

      fireEvent.click(within(screen.getByRole('dialog')).getByText('Anuluj'));

      expect(updateNote).not.toHaveBeenCalled();
      expect(destroy).not.toHaveBeenCalled();
    });
  });

  it('links a terminal\'s new session id to the tab that owns it', async () => {
    let rebound: ((event: SessionRebound) => void) | null = null;
    vi.spyOn(tauri, 'onSupervisorSessionRebound').mockImplementation(async (cb) => {
      rebound = cb;
      return () => {};
    });
    useStore.setState({ tabs: [{ ...sessionTab('session:s1', 's1'), ptyId: 'pty-1' }] });
    render(<DetachedShell mode={groupMode} />);
    await waitFor(() => expect(rebound).not.toBeNull());
    act(() => { rebound!({ ptyId: 'pty-1', sessionId: 's9' }); });
    const tab = useStore.getState().tabs.find(t => t.id === 'session:s1');
    expect(tab?.kind === 'session' && tab.linkedSessionId).toBe('s9');
  });

  it('reports readiness so the source window can release its actions', async () => {
    render(<DetachedShell mode={groupMode} />);
    await waitFor(() => expect(tauri.emitDetachReady).toHaveBeenCalledWith('project-1'));
  });

  it('does not report readiness in session mode', async () => {
    render(<DetachedShell mode={{ view: 'session', projectId: 1, sessionId: 's1', title: 'S1', fresh: false }} />);
    await Promise.resolve();
    expect(tauri.emitDetachReady).not.toHaveBeenCalled();
  });

  it('tracks session activity so the tab dots are not stuck on idle', async () => {
    render(<DetachedShell mode={groupMode} />);
    await waitFor(() => expect(tauri.listSessions).toHaveBeenCalledWith(1, expect.any(Number), 0));
  });

  it('renders the tabs of every pane at once', () => {
    splitTwoSessions();
    const { container } = render(<DetachedShell mode={groupMode} />);
    expect(container.querySelectorAll('[data-pane-id="left"] [data-tab-id]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-pane-id="right"] [data-tab-id]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-tab-layer]')).toHaveLength(2);
  });

  it('closes exactly one tab on the close-tab shortcut, even with two panes open', () => {
    splitTwoSessions();
    const { queryByText } = render(<DetachedShell mode={groupMode} />);

    fireEvent.keyDown(document, { key: 'w', ctrlKey: true });

    expect(useStore.getState().tabs.map(t => t.id)).toEqual(['session:s2']);
    expect(leaves(useStore.getState().layout)).toHaveLength(1);
    expect(queryByText('Zamknąć aktywny tab?')).toBeNull();
  });

  // The neighbouring pane must not resolve the shortcut against its own tab list:
  // it holds no live process and would close the terminal without asking.
  it('routes a live process through the confirm dialog on the close-tab shortcut', () => {
    useStore.setState({
      tabs: [{ kind: 'terminal', id: 'terminal:t1', projectId: 1, title: 'Terminal' }, sessionTab('session:s1', 's1')],
      activeTabId: 'terminal:t1',
      layout: {
        kind: 'split', id: 'outer', dir: 'row', sizes: [0.5, 0.5],
        children: [
          createLeaf('left', ['terminal:t1'], 'terminal:t1'),
          createLeaf('right', ['session:s1'], 'session:s1'),
        ],
      },
      focusedPaneId: 'left',
    });
    const { getByText } = render(<DetachedShell mode={groupMode} />);

    fireEvent.keyDown(document, { key: 'w', ctrlKey: true });

    expect(getByText('Zamknąć aktywny tab?')).toBeTruthy();
    expect(useStore.getState().tabs).toHaveLength(2);

    fireEvent.click(getByText('Zamknij'));

    expect(useStore.getState().tabs.map(t => t.id)).toEqual(['session:s1']);
  });

  it('opens a new terminal into the pane whose new-tab strip was clicked', () => {
    splitTwoSessions();
    const { container } = render(<DetachedShell mode={groupMode} />);
    const right = container.querySelector('[data-pane-id="right"]') as HTMLElement;
    const plus = right.querySelector('button[title="Nowy terminal"]') as HTMLElement;

    fireEvent.mouseDown(plus);
    fireEvent.click(plus);

    const opened = useStore.getState().activeTabId!;
    expect(findLeaf(useStore.getState().layout, 'right')?.tabIds).toContain(opened);
  });

  it('offers the new-tab strip in a single-session window', () => {
    seedSessionWindow();
    const { container } = render(<DetachedShell mode={sessionMode} />);

    expect(container.querySelector('button[title="Nowa sesja"]')).toBeTruthy();
    expect(container.querySelector('button[title="Nowy terminal"]')).toBeTruthy();
  });

  it('stays recoverable when the close shortcut empties a single-session window', () => {
    seedSessionWindow();
    const { container, getByText, queryByText } = render(<DetachedShell mode={sessionMode} />);

    fireEvent.keyDown(document, { key: 'w', ctrlKey: true });

    expect(useStore.getState().tabs).toHaveLength(0);
    expect(container.querySelector('button[title="Nowa sesja"]')).toBeTruthy();
    expect(getByText(DETACHED_HINT)).toBeTruthy();
    expect(queryByText('Wybierz sesję z lewej')).toBeNull();
  });

  it('hides the detach entries from the tab menu of a detached window', () => {
    seedSessionWindow();
    const { container, getByText, queryByText } = render(<DetachedShell mode={sessionMode} />);

    fireEvent.contextMenu(container.querySelector('[data-tab-id="session:s1"]') as HTMLElement);

    expect(queryByText('Wydziel projekt do nowego okna')).toBeNull();
    expect(getByText('Otwórz w nowym oknie').closest('button')).toBeDisabled();
  });

  it('tracks activity in a single-session window so its dot is not stuck on idle', async () => {
    vi.spyOn(tauri, 'listSessions').mockResolvedValue([{
      id: 's1', projectId: 1, title: 'S1', messageCount: 3, lastModified: 0, createdAt: null,
      gitBranch: null, cwd: null, activity: 'running', provider: 'claude',
      runningAgents: 0, totalAgents: 0,
    }]);
    seedSessionWindow();
    useStore.setState({ tabs: [{ ...sessionTab('session:s1', 's1'), mode: 'terminal' }] });
    const { container } = render(<DetachedShell mode={sessionMode} />);

    await waitFor(() => expect(tauri.listSessions).toHaveBeenCalledWith(1, expect.any(Number), 0));
    await waitFor(() =>
      expect(container.querySelector('[title="Aktywna — agent pracuje"]')).toBeTruthy(),
    );
  });

  it('keeps attention off a session visible in another pane but marks a hidden one', async () => {
    let handler: ((e: AttentionEvent) => void) | null = null;
    vi.spyOn(tauri, 'onSessionAttention').mockImplementation(async (cb) => {
      handler = cb;
      return () => {};
    });
    useStore.setState({
      tabs: [sessionTab('session:s1', 's1'), sessionTab('session:s2', 's2'), sessionTab('session:s3', 's3')],
      activeTabId: 'session:s1',
      layout: {
        kind: 'split', id: 'outer', dir: 'row', sizes: [0.5, 0.5],
        children: [
          createLeaf('left', ['session:s1', 'session:s3'], 'session:s1'),
          createLeaf('right', ['session:s2'], 'session:s2'),
        ],
      },
      focusedPaneId: 'left',
    });
    render(<DetachedShell mode={groupMode} />);
    await waitFor(() => expect(handler).not.toBeNull());

    handler!({ sessionId: 's2', reason: 'hook', message: null });
    handler!({ sessionId: 's3', reason: 'hook', message: null });

    expect(useStore.getState().attentionSessions.has('s2')).toBe(false);
    expect(useStore.getState().attentionSessions.has('s3')).toBe(true);
  });
});
