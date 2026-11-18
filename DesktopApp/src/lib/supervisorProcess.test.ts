import { describe, it, expect, beforeEach, vi } from 'vitest';
import { tauri } from './tauri';
import { supervisorProcess } from './supervisorProcess';

describe('supervisorProcess', () => {
  let outCb: (b: Uint8Array) => void = () => {};
  let exitCb: (c: number) => void = () => {};
  const unlistenOut = vi.fn();
  const unlistenExit = vi.fn();

  beforeEach(() => {
    supervisorProcess.reset();
    vi.restoreAllMocks();
    unlistenOut.mockClear();
    unlistenExit.mockClear();
    vi.spyOn(tauri, 'onPtyOutput').mockImplementation(async (_id, cb) => { outCb = cb; return unlistenOut; });
    vi.spyOn(tauri, 'onPtyExit').mockImplementation(async (_id, cb) => { exitCb = cb; return unlistenExit; });
    vi.spyOn(tauri, 'ptyWrite').mockResolvedValue(undefined);
    vi.spyOn(tauri, 'ptyResize').mockResolvedValue(undefined);
    vi.spyOn(tauri, 'ptyAttach').mockResolvedValue(undefined);
  });

  it('replays buffered bytes to a late sink and then delivers live output', async () => {
    supervisorProcess.track('p1');
    await Promise.resolve();
    outCb(new Uint8Array([1, 2]));
    const received: number[] = [];
    supervisorProcess.attach('p1', { write: (b) => received.push(...b) });
    expect(received).toEqual([1, 2]);
    outCb(new Uint8Array([3]));
    expect(received).toEqual([1, 2, 3]);
  });

  it('stops delivering after detach and replays everything on reattach', async () => {
    const first: number[] = [];
    const detach = supervisorProcess.attach('p1', { write: (b) => first.push(...b) });
    await Promise.resolve();
    outCb(new Uint8Array([7]));
    detach();
    outCb(new Uint8Array([8]));
    expect(first).toEqual([7]);
    const second: number[] = [];
    supervisorProcess.attach('p1', { write: (b) => second.push(...b) });
    expect(second).toEqual([7, 8]);
  });

  it('appends an exit marker for the sinks', async () => {
    const chunks: string[] = [];
    supervisorProcess.attach('p1', { write: (b) => chunks.push(new TextDecoder().decode(b)) });
    await Promise.resolve();
    exitCb(3);
    expect(chunks.join('')).toContain('process exited with code 3');
  });

  it('forwards write and resize to the pty', () => {
    supervisorProcess.write('p1', 'YQ==');
    supervisorProcess.resize('p1', 100, 30);
    expect(tauri.ptyWrite).toHaveBeenCalledWith('p1', 'YQ==');
    expect(tauri.ptyResize).toHaveBeenCalledWith('p1', 100, 30);
  });

  it('attaches the pty once its output and exit listeners are registered', async () => {
    let resolveExit!: (off: () => void) => void;
    vi.spyOn(tauri, 'onPtyExit').mockImplementation((_id, cb) => {
      exitCb = cb;
      return new Promise(resolve => { resolveExit = resolve; });
    });

    supervisorProcess.track('p1');
    await vi.waitFor(() => expect(tauri.onPtyExit).toHaveBeenCalled());
    await Promise.resolve();
    expect(tauri.ptyAttach).not.toHaveBeenCalled();

    resolveExit(unlistenExit);
    await vi.waitFor(() => expect(tauri.ptyAttach).toHaveBeenCalledWith('p1'));
    expect(tauri.ptyAttach).toHaveBeenCalledTimes(1);
  });

  it('attaches a pty once even when it is tracked again', async () => {
    supervisorProcess.track('p1');
    supervisorProcess.track('p1');
    await vi.waitFor(() => expect(tauri.ptyAttach).toHaveBeenCalledWith('p1'));
    await Promise.resolve();
    expect(tauri.ptyAttach).toHaveBeenCalledTimes(1);
  });

  it('never attaches a pty that was replaced before its listeners registered', async () => {
    let resolveOutput!: (off: () => void) => void;
    vi.spyOn(tauri, 'onPtyOutput').mockImplementationOnce((_id, cb) => {
      outCb = cb;
      return new Promise(resolve => { resolveOutput = resolve; });
    });

    supervisorProcess.track('p1');
    supervisorProcess.track('p2');
    resolveOutput(unlistenOut);
    await vi.waitFor(() => expect(tauri.ptyAttach).toHaveBeenCalledWith('p2'));

    expect(tauri.ptyAttach).not.toHaveBeenCalledWith('p1');
  });

  it('drops the listeners of a previous pty when a new one is tracked', async () => {
    supervisorProcess.track('p1');
    await Promise.resolve();
    await Promise.resolve();
    supervisorProcess.track('p2');
    expect(unlistenOut).toHaveBeenCalledTimes(1);
    expect(unlistenExit).toHaveBeenCalledTimes(1);
  });
});
