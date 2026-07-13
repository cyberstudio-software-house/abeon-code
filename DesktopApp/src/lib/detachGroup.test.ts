import { describe, it, expect, vi, beforeEach } from 'vitest';

const { setFocus, getByLabel, windowCtor } = vi.hoisted(() => ({
  setFocus: vi.fn(),
  getByLabel: vi.fn(),
  windowCtor: vi.fn(),
}));

vi.mock('@tauri-apps/api/webviewWindow', () => ({
  WebviewWindow: Object.assign(
    class {
      once: (event: string, cb: (e: unknown) => void) => Promise<() => void>;
      constructor(label: string, options: unknown) {
        windowCtor(label, options);
        this.once = vi.fn(async (event: string, cb: (e: unknown) => void) => {
          if (event === 'tauri://created') queueMicrotask(() => cb({}));
          return () => {};
        });
      }
    },
    { getByLabel },
  ),
}));

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));

import { summarizeDetach, detachSummaryMessage, buildDetachPayload, detachProjectGroup } from './detachGroup';
import { processManager } from './processManager';
import { tauri } from './tauri';
import type { Tab } from '../store/tabsSlice';
import type { RunningAction } from '../store/actionsSlice';

const tabs: Tab[] = [
  { kind: 'session', id: 'session:s1', projectId: 5, sessionId: 's1', title: 'Historia', mode: 'history' },
  { kind: 'session', id: 'session:s2', projectId: 5, sessionId: 's2', title: 'Live', mode: 'terminal', provider: 'codex' },
  { kind: 'action', id: 'action:4', projectId: 5, actionId: 4, title: 'dev', status: 'running' },
  { kind: 'action', id: 'action:5', projectId: 5, actionId: 5, title: 'build', status: 'exited', exitCode: 0 },
  { kind: 'terminal', id: 'terminal:t1', projectId: 5, title: 'Terminal' },
];

const runningActions: Record<number, RunningAction> = {
  4: { actionId: 4, ptyId: 'pty-live', status: 'running' },
  5: { actionId: 5, ptyId: 'pty-dead', status: 'exited', exitCode: 0 },
};

describe('summarizeDetach', () => {
  it('counts only what loses state', () => {
    expect(summarizeDetach(tabs, runningActions)).toEqual({ sessions: 1, terminals: 1, runningActions: 1 });
  });

  it('returns no message when nothing is live', () => {
    expect(detachSummaryMessage({ sessions: 0, terminals: 0, runningActions: 0 })).toBeNull();
  });

  it('builds a message listing the consequences', () => {
    const msg = detachSummaryMessage({ sessions: 1, terminals: 1, runningActions: 1 });
    expect(msg).toContain('1 sesja');
    expect(msg).toContain('1 terminal');
    expect(msg).toContain('1 akcja');
  });
});

describe('buildDetachPayload', () => {
  it('drops projectId and carries the live pty id', () => {
    const payload = buildDetachPayload(tabs, runningActions);
    expect(payload).toEqual([
      { kind: 'session', id: 'session:s1', sessionId: 's1', title: 'Historia', mode: 'history' },
      { kind: 'session', id: 'session:s2', sessionId: 's2', title: 'Live', mode: 'terminal', provider: 'codex' },
      { kind: 'action', id: 'action:4', actionId: 4, title: 'dev', status: 'running', ptyId: 'pty-live' },
      { kind: 'action', id: 'action:5', actionId: 5, title: 'build', status: 'exited', exitCode: 0 },
      { kind: 'terminal', id: 'terminal:t1', title: 'Terminal' },
    ]);
  });
});

describe('detachProjectGroup', () => {
  let readyCb: (label: string) => void = () => {};

  beforeEach(() => {
    vi.clearAllMocks();
    getByLabel.mockResolvedValue(null);
    vi.spyOn(tauri, 'onDetachReady').mockImplementation(async (cb) => { readyCb = cb; return () => {}; });
    vi.spyOn(processManager, 'release').mockImplementation(() => {});
  });

  it('focuses an existing window instead of opening a second one', async () => {
    getByLabel.mockResolvedValue({ setFocus });
    const detachTabs = vi.fn();
    await detachProjectGroup({ projectId: 5, projectName: 'P', tabs, activeTabId: 'action:4', runningActions, detachTabs });
    expect(setFocus).toHaveBeenCalled();
    expect(windowCtor).not.toHaveBeenCalled();
    expect(detachTabs).not.toHaveBeenCalled();
  });

  it('removes non-action tabs on created, and action tabs only after the new window is ready', async () => {
    const detachTabs = vi.fn();
    await detachProjectGroup({ projectId: 5, projectName: 'P', tabs, activeTabId: 'action:4', runningActions, detachTabs });
    expect(windowCtor).toHaveBeenCalledWith('project-5', expect.objectContaining({ title: 'P' }));

    await new Promise(r => queueMicrotask(() => r(null)));
    expect(detachTabs).toHaveBeenCalledWith(['session:s1', 'session:s2', 'terminal:t1']);
    expect(processManager.release).not.toHaveBeenCalled();

    readyCb('project-5');
    expect(processManager.release).toHaveBeenCalledWith(4);
    expect(processManager.release).toHaveBeenCalledWith(5);
    expect(detachTabs).toHaveBeenCalledWith(['action:4', 'action:5']);
  });

  it('ignores a ready event from another window', async () => {
    const detachTabs = vi.fn();
    await detachProjectGroup({ projectId: 5, projectName: 'P', tabs, activeTabId: null, runningActions, detachTabs });
    readyCb('project-99');
    expect(processManager.release).not.toHaveBeenCalled();
  });
});
