import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';

const { onCloseRequested, destroy } = vi.hoisted(() => ({
  onCloseRequested: vi.fn(),
  destroy: vi.fn(),
}));

vi.mock('@tauri-apps/api/webviewWindow', () => ({
  getCurrentWebviewWindow: () => ({ onCloseRequested, destroy, label: 'project-1' }),
}));
vi.mock('../center/TabContent', () => ({ TabContent: () => <div /> }));
vi.mock('../center/TabBar', () => ({ TabBar: () => <div data-testid="tabbar" /> }));
vi.mock('../right/RightPanel', () => ({ RightPanel: () => <div /> }));
vi.mock('./TitleBar', () => ({ TitleBar: () => <div /> }));
vi.stubGlobal('ResizeObserver', class {
  observe() {}
  unobserve() {}
  disconnect() {}
});

import { useStore } from '../../store';
import { tauri } from '../../lib/tauri';
import { DetachedShell } from './DetachedShell';

const groupMode = { view: 'group' as const, projectId: 1, tabs: [], activeTabId: 'session:s1' };

describe('DetachedShell', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    onCloseRequested.mockResolvedValue(() => {});
    vi.spyOn(tauri, 'emitDetachReady').mockResolvedValue(undefined);
    vi.spyOn(tauri, 'setWindowTitle').mockResolvedValue(undefined);
    vi.spyOn(tauri, 'listProjects').mockResolvedValue([]);
    useStore.setState({
      tabs: [
        { kind: 'session', id: 'session:s1', projectId: 1, sessionId: 's1', title: 'S1', mode: 'history' },
        { kind: 'terminal', id: 'terminal:t1', projectId: 1, title: 'Terminal' },
      ],
      activeTabId: 'session:s1',
      runningActions: {},
      projects: [{ id: 1, name: 'Alfa', path: '/a' }] as never,
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
      tabs: [{ kind: 'session', id: 'session:s1', projectId: 1, sessionId: 's1', title: 'S1', mode: 'history' }],
    });
    render(<DetachedShell mode={groupMode} />);
    const handler = onCloseRequested.mock.calls[0][0];
    const event = { preventDefault: vi.fn() };
    handler(event);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it('reports readiness so the source window can release its actions', () => {
    render(<DetachedShell mode={groupMode} />);
    expect(tauri.emitDetachReady).toHaveBeenCalledWith('project-1');
  });

  it('does not report readiness in session mode', () => {
    render(<DetachedShell mode={{ view: 'session', projectId: 1, sessionId: 's1', title: 'S1', fresh: false }} />);
    expect(tauri.emitDetachReady).not.toHaveBeenCalled();
  });
});
