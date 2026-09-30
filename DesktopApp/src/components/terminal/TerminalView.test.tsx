import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, render } from '@testing-library/react';

const probe = vi.hoisted(() => ({
  exits: [] as Array<(code: number) => void>,
  focusCalls: 0,
  writes: [] as Uint8Array[],
  sinks: [] as Array<(bytes: Uint8Array) => void>,
  spawned: 0,
  selection: '',
  selectionCbs: [] as Array<() => void>,
  keyHandlers: [] as Array<(e: KeyboardEvent) => boolean>,
  openedContainers: [] as HTMLElement[],
}));

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    options: Record<string, unknown> = {};
    buffer = { active: { getLine: () => null } };
    loadAddon() {}
    open(container: HTMLElement) { probe.openedContainers.push(container); }
    attachCustomKeyEventHandler(cb: (e: KeyboardEvent) => boolean) { probe.keyHandlers.push(cb); }
    registerLinkProvider() {}
    getSelection() { return probe.selection; }
    onSelectionChange(cb: () => void) { probe.selectionCbs.push(cb); return { dispose() {} }; }
    reset() {}
    focus() { probe.focusCalls += 1; }
    write(bytes: Uint8Array) { probe.writes.push(bytes); }
    onData() { return { dispose() {} }; }
    onResize() { return { dispose() {} }; }
  },
}));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }));
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }));
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn() }));
vi.mock('../../lib/tauri', () => ({
  tauri: {
    spawnPty: vi.fn(async () => `pty-${++probe.spawned}`),
    onPtyOutput: vi.fn(async (_id: string, cb: (bytes: Uint8Array) => void) => {
      probe.sinks.push(cb);
      return () => {};
    }),
    onPtyExit: vi.fn(async (_id: string, cb: (code: number) => void) => {
      probe.exits.push(cb);
      return () => {};
    }),
    ptyKill: vi.fn(async () => {}),
    ptyWrite: vi.fn(async () => {}),
    ptyResize: vi.fn(async () => {}),
    writeClipboardText: vi.fn(async () => {}),
    readClipboardText: vi.fn(async () => null),
    readClipboardImage: vi.fn(async () => null),
    getAllSettings: vi.fn(async () => ({})),
    setSetting: vi.fn(async () => {}),
    detectDefaultShell: vi.fn(async () => ''),
    takePendingOpenPaths: vi.fn(async () => []),
  },
}));

// jsdom reports every element as 0x0; the visible-change effect bails out on that.
Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 600 });
Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => 400 });
vi.stubGlobal('ResizeObserver', class {
  observe() {}
  unobserve() {}
  disconnect() {}
});

import { useStore } from '../../store';
import { TerminalView } from './TerminalView';
import { tauri } from '../../lib/tauri';
import { toast } from 'sonner';

function Panes({ focused }: { focused: 'left' | 'right' }) {
  return (
    <>
      <TerminalView projectId={1} kind="agent" sessionId="left" visible focused={focused === 'left'} />
      <TerminalView projectId={1} kind="agent" sessionId="right" visible focused={focused === 'right'} />
    </>
  );
}

describe('TerminalView focus', () => {
  beforeEach(() => {
    probe.exits = [];
    probe.focusCalls = 0;
    probe.writes = [];
    probe.sinks = [];
    probe.spawned = 0;
    probe.openedContainers = [];
    useStore.setState({
      projects: [{ id: 1, name: 'P', path: '/p' }] as never,
      activeAgentPtyId: null,
    });
  });

  it('claims the active agent PTY when it is visible and focused', async () => {
    await act(async () => { render(<TerminalView projectId={1} kind="agent" sessionId="s1" visible focused />); });

    expect(useStore.getState().activeAgentPtyId).toBe('pty-1');
    expect(probe.focusCalls).toBeGreaterThan(0);
  });

  it('never claims the active agent PTY while its pane is unfocused', async () => {
    await act(async () => {
      render(<TerminalView projectId={1} kind="agent" sessionId="s1" visible focused={false} />);
    });

    expect(useStore.getState().activeAgentPtyId).toBeNull();
    expect(probe.focusCalls).toBe(0);
  });

  it('hands the active agent PTY over when focus moves to another visible terminal', async () => {
    let view!: ReturnType<typeof render>;
    await act(async () => { view = render(<Panes focused="left" />); });
    expect(useStore.getState().activeAgentPtyId).toBe('pty-1');

    await act(async () => { view.rerender(<Panes focused="right" />); });

    expect(useStore.getState().activeAgentPtyId).toBe('pty-2');
  });

  it('flushes output buffered while hidden even when the pane stays unfocused', async () => {
    let view!: ReturnType<typeof render>;
    await act(async () => {
      view = render(<TerminalView projectId={1} kind="agent" sessionId="s1" visible={false} focused={false} />);
    });
    act(() => { probe.sinks[0](new Uint8Array([104, 105])); });
    expect(probe.writes).toHaveLength(0);

    await act(async () => {
      view.rerender(<TerminalView projectId={1} kind="agent" sessionId="s1" visible focused={false} />);
    });

    expect(probe.writes).toEqual([new Uint8Array([104, 105])]);
    expect(probe.focusCalls).toBe(0);
  });

  it('keeps terminal padding outside the element measured by FitAddon', async () => {
    await act(async () => { render(<TerminalView projectId={1} kind="agent" sessionId="s1" visible focused />); });

    const container = probe.openedContainers[0];
    expect(container).toHaveClass('h-full', 'w-full');
    expect(container).not.toHaveClass('p-4', 'pb-6');
    expect(container.parentElement).toHaveClass('h-full', 'w-full', 'p-4', 'pb-6');
  });

  it('passes the selected model to a fresh OpenCode process', async () => {
    const { tauri } = await import('../../lib/tauri');
    useStore.setState({ opencodeModelId: 'openai/gpt-5.6-sol' });

    await act(async () => {
      render(
        <TerminalView
          projectId={1}
          kind="agent"
          provider="opencode"
          sessionId="new-opencode"
          fresh
          visible
          focused
        />,
      );
    });

    expect(tauri.spawnPty).toHaveBeenCalledWith(
      1,
      expect.objectContaining({
        kind: 'agent',
        provider: 'opencode',
        model: 'openai/gpt-5.6-sol',
        fresh: true,
      }),
      80,
      24,
    );
  });

  it('keeps the active agent PTY while another element holds the keyboard', async () => {
    await act(async () => {
      render(<TerminalView projectId={1} kind="agent" sessionId="s1" visible focused takeFocus={false} />);
    });
    expect(useStore.getState().activeAgentPtyId).toBe('pty-1');
    expect(probe.focusCalls).toBe(0);
  });

  it('takes the keyboard back when takeFocus turns on', async () => {
    let view!: ReturnType<typeof render>;
    await act(async () => {
      view = render(<TerminalView projectId={1} kind="agent" sessionId="s1" visible focused takeFocus={false} />);
    });
    await act(async () => {
      view.rerender(<TerminalView projectId={1} kind="agent" sessionId="s1" visible focused takeFocus />);
    });
    expect(probe.focusCalls).toBeGreaterThan(0);
  });

  it('reports the PTY exit to the latest onExit without respawning', async () => {
    const first = vi.fn();
    const second = vi.fn();
    let view!: ReturnType<typeof render>;
    await act(async () => { view = render(<TerminalView projectId={1} kind="shell" visible onExit={first} />); });
    await act(async () => { view.rerender(<TerminalView projectId={1} kind="shell" visible onExit={second} />); });
    act(() => { probe.exits[0](0); });
    expect(probe.spawned).toBe(1);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith(0);
  });
});

describe('TerminalView clipboard copy', () => {
  beforeEach(() => {
    probe.selection = '';
    probe.selectionCbs = [];
    probe.keyHandlers = [];
    probe.spawned = 0;
    vi.clearAllMocks();
    useStore.setState({ projects: [{ id: 1, name: 'P', path: '/p' }] as never });
  });

  it('copies the selection to the clipboard on Ctrl+Shift+C', async () => {
    const { tauri } = await import('../../lib/tauri');
    await act(async () => { render(<TerminalView projectId={1} kind="shell" visible focused />); });

    probe.selection = 'copied via shortcut';
    const handled = probe.keyHandlers.map(h =>
      h({ type: 'keydown', ctrlKey: true, shiftKey: true, key: 'C' } as KeyboardEvent)
    );

    expect(tauri.writeClipboardText).toHaveBeenCalledWith('copied via shortcut');
    expect(handled).toContain(false);
  });

  it('copies to the clipboard shortly after a selection settles', async () => {
    const { tauri } = await import('../../lib/tauri');
    await act(async () => { render(<TerminalView projectId={1} kind="shell" visible focused />); });

    probe.selection = 'hello world';
    await act(async () => {
      probe.selectionCbs.forEach(cb => cb());
      await new Promise(r => setTimeout(r, 160));
    });

    expect(tauri.writeClipboardText).toHaveBeenCalledWith('hello world');
  });

  it('coalesces rapid selection changes into a single clipboard write', async () => {
    const { tauri } = await import('../../lib/tauri');
    await act(async () => { render(<TerminalView projectId={1} kind="shell" visible focused />); });

    await act(async () => {
      probe.selection = 'partial';
      probe.selectionCbs.forEach(cb => cb());
      probe.selection = 'partial selection final';
      probe.selectionCbs.forEach(cb => cb());
      await new Promise(r => setTimeout(r, 160));
    });

    expect(tauri.writeClipboardText).toHaveBeenCalledTimes(1);
    expect(tauri.writeClipboardText).toHaveBeenCalledWith('partial selection final');
  });

  it('does not write to the clipboard when the selection is cleared', async () => {
    const { tauri } = await import('../../lib/tauri');
    await act(async () => { render(<TerminalView projectId={1} kind="shell" visible focused />); });

    probe.selection = '';
    await act(async () => {
      probe.selectionCbs.forEach(cb => cb());
      await new Promise(r => setTimeout(r, 160));
    });

    expect(tauri.writeClipboardText).not.toHaveBeenCalled();
  });
});

describe('TerminalView initial prompt', () => {
  beforeEach(() => {
    vi.mocked(tauri.spawnPty).mockClear();
    useStore.setState({
      tabs: [{
        kind: 'session', id: 'session:s1', projectId: 1, sessionId: 's1', title: 'T',
        mode: 'terminal', fresh: true, provider: 'claude', initialPrompt: 'Do X',
      }],
    });
  });

  const view = () => (
    <TerminalView projectId={1} kind="agent" provider="claude" sessionId="s1" fresh tabId="session:s1" visible focused />
  );

  it('passes initial_prompt on the first spawn and consumes it', async () => {
    await act(async () => { render(view()); });
    const kind = vi.mocked(tauri.spawnPty).mock.calls[0][1];
    expect(kind).toMatchObject({ kind: 'agent', provider: 'claude', fresh: true, initial_prompt: 'Do X' });
    const tab = useStore.getState().tabs[0];
    expect(tab.kind === 'session' && tab.initialPrompt).toBeFalsy();
  });

  it('does not resend after remount', async () => {
    let r!: ReturnType<typeof render>;
    await act(async () => { r = render(view()); });
    await act(async () => { r.unmount(); });
    await act(async () => { render(view()); });
    const calls = vi.mocked(tauri.spawnPty).mock.calls;
    expect(calls.length).toBe(2);
    expect(calls[1][1]).not.toHaveProperty('initial_prompt');
  });

  it('omits initial_prompt when the tab has none', async () => {
    useStore.setState({
      tabs: [{ kind: 'session', id: 'session:s1', projectId: 1, sessionId: 's1', title: 'T', mode: 'terminal', fresh: true, provider: 'claude' }],
    });
    await act(async () => { render(view()); });
    expect(vi.mocked(tauri.spawnPty).mock.calls[0][1]).not.toHaveProperty('initial_prompt');
  });

  it('names the project path in the toast when a prompted spawn fails', async () => {
    vi.mocked(toast.error).mockClear();
    useStore.setState({ projects: [{ id: 1, name: 'P', path: '/home/x/proj' }] as never });
    vi.mocked(tauri.spawnPty).mockRejectedValueOnce(new Error('boom'));
    await act(async () => { render(view()); });
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(vi.mocked(toast.error).mock.calls[0][0]).toContain('/home/x/proj');
  });

  it('does not toast when an unprompted spawn fails', async () => {
    vi.mocked(toast.error).mockClear();
    useStore.setState({
      projects: [{ id: 1, name: 'P', path: '/home/x/proj' }] as never,
      tabs: [{ kind: 'session', id: 'session:s1', projectId: 1, sessionId: 's1', title: 'T', mode: 'terminal', fresh: true, provider: 'claude' }],
    });
    vi.mocked(tauri.spawnPty).mockRejectedValueOnce(new Error('boom'));
    await act(async () => { render(view()); });
    expect(toast.error).not.toHaveBeenCalled();
  });
});
