import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, waitFor } from '@testing-library/react';

vi.mock('../sidebar/Sidebar', () => ({ Sidebar: () => <div /> }));
vi.mock('../center/CenterPanel', () => ({ CenterPanel: () => <div /> }));
vi.mock('../right/RightPanel', () => ({ RightPanel: () => <div /> }));
vi.mock('./TitleBar', () => ({ TitleBar: () => <div /> }));
vi.mock('../center/TabSwitcher', () => ({ TabSwitcher: () => <div /> }));
vi.mock('../center/ProjectLauncher', () => ({ ProjectLauncher: () => <div /> }));
vi.mock('../../lib/updater', () => ({ checkForUpdate: async () => null }));

import { useStore } from '../../store';
import { tauri } from '../../lib/tauri';
import type { AttentionEvent } from '../../lib/tauri';
import { createLeaf } from '../../lib/paneTree';
import { AppShell } from './AppShell';

const sessionTab = (id: string, sessionId: string) => ({
  kind: 'session' as const, id, projectId: 1, sessionId, title: sessionId, mode: 'terminal' as const,
});

// Left pane shows s1 with s3 hidden behind it, right pane shows s2.
const twoPaneLayout = {
  kind: 'split' as const,
  id: 'outer',
  dir: 'row' as const,
  sizes: [0.5, 0.5],
  children: [
    createLeaf('left', ['session:s1', 'session:s3'], 'session:s1'),
    createLeaf('right', ['session:s2'], 'session:s2'),
  ],
};

describe('AppShell attention across panes', () => {
  let handler: (e: AttentionEvent) => void;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    vi.spyOn(tauri, 'setWindowTitle').mockResolvedValue(undefined);
    vi.spyOn(tauri, 'showAttentionNotification').mockResolvedValue(undefined);
    vi.spyOn(tauri, 'onCliOpenPath').mockResolvedValue(() => {});
    vi.spyOn(tauri, 'onNotificationActivate').mockResolvedValue(() => {});
    vi.spyOn(tauri, 'listSessions').mockResolvedValue([]);
    let captured: ((e: AttentionEvent) => void) | null = null;
    vi.spyOn(tauri, 'onSessionAttention').mockImplementation(async (cb) => {
      captured = cb;
      return () => {};
    });
    useStore.setState({
      tabs: [sessionTab('session:s1', 's1'), sessionTab('session:s2', 's2'), sessionTab('session:s3', 's3')],
      activeTabId: 'session:s1',
      layout: twoPaneLayout,
      focusedPaneId: 'left',
      attentionSessions: new Set<string>(),
      notificationsEnabled: true,
      notificationTrigger: 'both',
      sessionsByProject: {},
    });
    render(<AppShell />);
    await waitFor(() => expect(captured).not.toBeNull());
    handler = captured!;
  });

  it('leaves a session shown in another pane alone but flags a hidden one', () => {
    act(() => { handler({ sessionId: 's2', reason: 'hook', message: null }); });
    act(() => { handler({ sessionId: 's3', reason: 'hook', message: null }); });

    expect(useStore.getState().attentionSessions.has('s2')).toBe(false);
    expect(useStore.getState().attentionSessions.has('s3')).toBe(true);
    expect(tauri.showAttentionNotification).toHaveBeenCalledTimes(1);
    expect(tauri.showAttentionNotification).toHaveBeenCalledWith('s3', expect.any(String), expect.any(String));
  });

  it('clears attention for every visible pane when the active tab changes', () => {
    act(() => { useStore.setState({ attentionSessions: new Set(['s1', 's2', 's3']) }); });

    act(() => { useStore.getState().setActive('session:s3'); });

    const attention = useStore.getState().attentionSessions;
    expect(attention.has('s3')).toBe(false);
    expect(attention.has('s2')).toBe(false);
    expect(attention.has('s1')).toBe(true);
  });
});
