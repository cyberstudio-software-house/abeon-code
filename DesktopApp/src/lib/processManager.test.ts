import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { tauri } from './tauri';
import { processManager } from './processManager';
import { useStore } from '../store';
import type { Action } from '../types';

const action: Action = {
  id: 1, projectId: 7, label: 'build', command: 'echo hi',
  workingDir: null, source: null, preCommand: null, sortOrder: 0,
};

describe('processManager', () => {
  let outCb: (b: Uint8Array) => void = () => {};
  let exitCb: (c: number) => void = () => {};

  beforeEach(() => {
    useStore.setState({ runningActions: {} });
    vi.restoreAllMocks();
    vi.spyOn(tauri, 'spawnPty').mockResolvedValue('pty-1');
    vi.spyOn(tauri, 'onPtyOutput').mockImplementation(async (_id, cb) => { outCb = cb; return () => {}; });
    vi.spyOn(tauri, 'onPtyExit').mockImplementation(async (_id, cb) => { exitCb = cb; return () => {}; });
    vi.spyOn(tauri, 'ptyWrite').mockResolvedValue(undefined);
    vi.spyOn(tauri, 'ptyResize').mockResolvedValue(undefined);
    vi.spyOn(tauri, 'ptyKill').mockResolvedValue(undefined);
  });
  afterEach(() => { processManager.dismiss(1); });

  it('start spawns pty and sets running status', async () => {
    await processManager.start(7, action);
    expect(tauri.spawnPty).toHaveBeenCalledWith(7, { kind: 'action', action_id: 1 }, 80, 24);
    expect(useStore.getState().runningActions[1]).toMatchObject({ actionId: 1, ptyId: 'pty-1', status: 'running' });
  });

  it('attach replays the buffer then receives live output, detach stops it', async () => {
    await processManager.start(7, action);
    outCb(new Uint8Array([65]));
    const received: number[] = [];
    const detach = processManager.attach(1, { write: (b) => received.push(...b) });
    expect(received).toEqual([65]);
    outCb(new Uint8Array([66]));
    expect(received).toEqual([65, 66]);
    detach();
    outCb(new Uint8Array([67]));
    expect(received).toEqual([65, 66]);
  });

  it('exit sets exited status and keeps the buffer (exit marker replayed on attach)', async () => {
    await processManager.start(7, action);
    exitCb(0);
    expect(useStore.getState().runningActions[1]).toMatchObject({ status: 'exited', exitCode: 0 });
    const received: number[] = [];
    processManager.attach(1, { write: (b) => received.push(...b) });
    const text = new TextDecoder().decode(new Uint8Array(received));
    expect(text).toContain('[process exited with code 0]');
  });

  it('dismiss kills the pty and clears status', async () => {
    await processManager.start(7, action);
    processManager.dismiss(1);
    expect(tauri.ptyKill).toHaveBeenCalledWith('pty-1');
    expect(useStore.getState().runningActions[1]).toBeUndefined();
  });

  it('tears down listeners if dismissed during start', async () => {
    const offOut = vi.fn();
    const offExit = vi.fn();
    let resolveOut: (fn: () => void) => void = () => {};
    (tauri.onPtyOutput as ReturnType<typeof vi.fn>).mockImplementation(
      (_id: string, cb: (b: Uint8Array) => void) => { outCb = cb; return new Promise((r) => { resolveOut = r; }); }
    );
    (tauri.onPtyExit as ReturnType<typeof vi.fn>).mockResolvedValue(offExit);

    const startPromise = processManager.start(7, action);
    // flush microtasks so start() reaches the onPtyOutput await
    await Promise.resolve();
    await Promise.resolve();
    processManager.dismiss(1);
    resolveOut(offOut);
    await startPromise;

    expect(offOut).toHaveBeenCalled();
    expect(useStore.getState().runningActions[1]).toBeUndefined();
  });
});
