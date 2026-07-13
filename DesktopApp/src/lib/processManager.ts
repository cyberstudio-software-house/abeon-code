import { tauri } from './tauri';
import { useStore } from '../store';
import type { Action } from '../types';

export type ProcessSink = { write: (bytes: Uint8Array) => void };

type ProcEntry = {
  ptyId: string;
  buffer: Uint8Array[];
  subscribers: Set<ProcessSink>;
  unlisten: Array<() => void>;
};

const procs = new Map<number, ProcEntry>();

const exitMarker = (code: number) =>
  new TextEncoder().encode(`\r\n\x1b[33m[process exited with code ${code}]\x1b[0m\r\n`);

async function register(actionId: number, ptyId: string): Promise<void> {
  const entry: ProcEntry = { ptyId, buffer: [], subscribers: new Set(), unlisten: [] };
  procs.set(actionId, entry);
  useStore.getState().setActionRunning(actionId, ptyId);

  const offOut = await tauri.onPtyOutput(ptyId, (bytes) => {
    entry.buffer.push(bytes);
    entry.subscribers.forEach((s) => s.write(bytes));
  });
  const offExit = await tauri.onPtyExit(ptyId, (code) => {
    const marker = exitMarker(code);
    entry.buffer.push(marker);
    entry.subscribers.forEach((s) => s.write(marker));
    useStore.getState().setActionExited(actionId, code);
  });
  if (procs.get(actionId) !== entry) {
    offOut();
    offExit();
    return;
  }
  entry.unlisten.push(offOut, offExit);
}

export const processManager = {
  isActive(actionId: number): boolean {
    return procs.has(actionId);
  },

  async start(projectId: number, action: Action): Promise<void> {
    if (procs.has(action.id)) return;
    const ptyId = await tauri.spawnPty(projectId, { kind: 'action', action_id: action.id }, 80, 24);
    await register(action.id, ptyId);
  },

  async adopt(actionId: number, ptyId: string): Promise<void> {
    if (procs.has(actionId)) return;
    await register(actionId, ptyId);
  },

  release(actionId: number): void {
    const entry = procs.get(actionId);
    if (entry) {
      entry.unlisten.forEach((fn) => fn());
      procs.delete(actionId);
    }
    useStore.getState().clearAction(actionId);
  },

  attach(actionId: number, sink: ProcessSink): () => void {
    const entry = procs.get(actionId);
    if (!entry) return () => {};
    for (const bytes of entry.buffer) sink.write(bytes);
    entry.subscribers.add(sink);
    return () => { entry.subscribers.delete(sink); };
  },

  write(actionId: number, dataBase64: string): void {
    const entry = procs.get(actionId);
    if (entry) tauri.ptyWrite(entry.ptyId, dataBase64).catch(() => {});
  },

  resize(actionId: number, cols: number, rows: number): void {
    const entry = procs.get(actionId);
    if (entry) tauri.ptyResize(entry.ptyId, cols, rows).catch(() => {});
  },

  stop(actionId: number): void {
    const entry = procs.get(actionId);
    if (entry) tauri.ptyKill(entry.ptyId).catch(() => {});
  },

  dismiss(actionId: number): void {
    const entry = procs.get(actionId);
    if (entry) {
      tauri.ptyKill(entry.ptyId).catch(() => {});
      entry.unlisten.forEach((fn) => fn());
      procs.delete(actionId);
    }
    useStore.getState().clearAction(actionId);
  },
};
