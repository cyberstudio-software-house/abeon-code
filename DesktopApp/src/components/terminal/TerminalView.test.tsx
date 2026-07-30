import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, render } from '@testing-library/react';

const probe = vi.hoisted(() => ({
  focusCalls: 0,
  writes: [] as Uint8Array[],
  sinks: [] as Array<(bytes: Uint8Array) => void>,
  spawned: 0,
}));

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    options: Record<string, unknown> = {};
    buffer = { active: { getLine: () => null } };
    loadAddon() {}
    open() {}
    attachCustomKeyEventHandler() {}
    registerLinkProvider() {}
    getSelection() { return ''; }
    reset() {}
    focus() { probe.focusCalls += 1; }
    write(bytes: Uint8Array) { probe.writes.push(bytes); }
    onData() { return { dispose() {} }; }
    onResize() { return { dispose() {} }; }
  },
}));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }));
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }));
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn() }));
vi.mock('../../lib/tauri', () => ({
  tauri: {
    spawnPty: vi.fn(async () => `pty-${++probe.spawned}`),
    onPtyOutput: vi.fn(async (_id: string, cb: (bytes: Uint8Array) => void) => {
      probe.sinks.push(cb);
      return () => {};
    }),
    onPtyExit: vi.fn(async () => () => {}),
    ptyKill: vi.fn(async () => {}),
    ptyWrite: vi.fn(async () => {}),
    ptyResize: vi.fn(async () => {}),
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
    probe.focusCalls = 0;
    probe.writes = [];
    probe.sinks = [];
    probe.spawned = 0;
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
});
