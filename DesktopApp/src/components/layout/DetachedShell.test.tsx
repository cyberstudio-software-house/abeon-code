import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, waitFor } from '@testing-library/react';

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
vi.mock('./TitleBar', () => ({ TitleBar: () => <div /> }));
vi.stubGlobal('ResizeObserver', class {
  observe() {}
  unobserve() {}
  disconnect() {}
});
Element.prototype.scrollIntoView = vi.fn();

import { useStore } from '../../store';
import { tauri } from '../../lib/tauri';
import type { AttentionEvent } from '../../lib/tauri';
import { createLeaf, findLeaf, leaves } from '../../lib/paneTree';
import { ROOT_PANE_ID } from '../../store/panesSlice';
import { DetachedShell } from './DetachedShell';

const groupMode = { view: 'group' as const, projectId: 1, tabs: [], activeTabId: 'session:s1' };

const sessionTab = (id: string, sessionId: string) => ({
  kind: 'session' as const, id, projectId: 1, sessionId, title: sessionId, mode: 'history' as const,
});

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
    onCloseRequested.mockResolvedValue(() => {});
    vi.spyOn(tauri, 'emitDetachReady').mockResolvedValue(undefined);
    vi.spyOn(tauri, 'setWindowTitle').mockResolvedValue(undefined);
    vi.spyOn(tauri, 'listProjects').mockResolvedValue([]);
    vi.spyOn(tauri, 'listSessions').mockResolvedValue([]);
    vi.spyOn(tauri, 'onSessionAttention').mockResolvedValue(() => {});
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    useStore.setState({
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
