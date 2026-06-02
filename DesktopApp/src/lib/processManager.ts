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

export const processManager = {
  isActive(actionId: number): boolean {
    return procs.has(actionId);
  },

  async start(projectId: number, action: Action): Promise<void> {
    if (procs.has(action.id)) return;
    const ptyId = await tauri.spawnPty(projectId, { kind: 'action', action_id: action.id }, 80, 24);
    const entry: ProcEntry = { ptyId, buffer: [], subscribers: new Set(), unlisten: [] };
    procs.set(action.id, entry);
    useStore.getState().setActionRunning(action.id, ptyId);

    const offOut = await tauri.onPtyOutput(ptyId, (bytes) => {
      entry.buffer.push(bytes);
      entry.subscribers.forEach((s) => s.write(bytes));
    });
    const offExit = await tauri.onPtyExit(ptyId, (code) => {
      const marker = exitMarker(code);
      entry.buffer.push(marker);
      entry.subscribers.forEach((s) => s.write(marker));
      useStore.getState().setActionExited(action.id, code);
    });
    entry.unlisten.push(offOut, offExit);
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
