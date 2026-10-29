import { tauri } from './tauri';

export type SupervisorSink = { write: (bytes: Uint8Array) => void };

type Entry = {
  buffer: Uint8Array[];
  size: number;
  subscribers: Set<SupervisorSink>;
  unlisten: Array<() => void>;
  released: boolean;
};

const MAX_BUFFER_BYTES = 1024 * 1024;

const entries = new Map<string, Entry>();

const exitMarker = (code: number) =>
  new TextEncoder().encode(`\r\n\x1b[33m[process exited with code ${code}]\x1b[0m\r\n`);

function push(entry: Entry, bytes: Uint8Array) {
  entry.buffer.push(bytes);
  entry.size += bytes.length;
  while (entry.size > MAX_BUFFER_BYTES && entry.buffer.length > 1) {
    entry.size -= entry.buffer.shift()!.length;
  }
  entry.subscribers.forEach((s) => s.write(bytes));
}

function release(ptyId: string) {
  const entry = entries.get(ptyId);
  if (!entry) return;
  entry.released = true;
  entry.unlisten.forEach((fn) => fn());
  entry.unlisten = [];
  entries.delete(ptyId);
}

function track(ptyId: string): Entry {
  const existing = entries.get(ptyId);
  if (existing) return existing;
  for (const other of [...entries.keys()]) release(other);

  const entry: Entry = { buffer: [], size: 0, subscribers: new Set(), unlisten: [], released: false };
  entries.set(ptyId, entry);

  const adopt = (off: () => void) => {
    if (entry.released) off();
    else entry.unlisten.push(off);
  };
  tauri.onPtyOutput(ptyId, (bytes) => push(entry, bytes)).then(adopt).catch(() => {});
  tauri.onPtyExit(ptyId, (code) => push(entry, exitMarker(code))).then(adopt).catch(() => {});
  return entry;
}

export const supervisorProcess = {
  track(ptyId: string): void {
    track(ptyId);
  },

  attach(ptyId: string, sink: SupervisorSink): () => void {
    const entry = track(ptyId);
    for (const bytes of entry.buffer) sink.write(bytes);
    entry.subscribers.add(sink);
    return () => { entry.subscribers.delete(sink); };
  },

  write(ptyId: string, dataBase64: string): void {
    tauri.ptyWrite(ptyId, dataBase64).catch(() => {});
  },

  resize(ptyId: string, cols: number, rows: number): void {
    tauri.ptyResize(ptyId, cols, rows).catch(() => {});
  },

  reset(): void {
    for (const key of [...entries.keys()]) release(key);
  },
};
