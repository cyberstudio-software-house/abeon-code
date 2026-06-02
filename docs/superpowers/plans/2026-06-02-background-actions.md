# Akcje w tle — plan implementacji

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Uruchamianie akcji odbywa się w tle (bez otwierania zakładki); output jest buforowany i oglądalny na żądanie nawet po zakończeniu procesu; na liście projektów dochodzi dropdown z akcjami.

**Architecture:** Własność PTY przenosi się z `TerminalView` do modułu-singletona `src/lib/processManager.ts` (PTY + bufory bajtów + listenery + subskrybenci live). Reaktywny status (`running|exited`) trzyma `actionsSlice` w Zustandzie. `TerminalView` dla `kind:'action'` zamiast spawnować PTY — podpina się do managera i przegrywa bufor.

**Tech Stack:** React 19, Zustand 5, xterm.js 6, Tauri 2 IPC (`src/lib/tauri.ts`), Vitest + jsdom + @testing-library/react.

**Kolejność i stany pośrednie:** Zadania 1–2 dają testowalny rdzeń. Aplikacja jest funkcjonalnie spójna end-to-end dopiero po Zadaniu 6 (gdy `TerminalView` podpina się, a wszystkie miejsca startujące akcję wołają manager). Każdy commit kompiluje się i przechodzi własne testy; smoke-test ręczny jest w Zadaniu 8.

**Uruchamianie testów:** `npm test` (wszystkie), `npm test -- <ścieżka>` (jeden plik), `npm run lint` (tsc --noEmit, zero błędów).

---

### Task 1: Model statusu w `actionsSlice`

**Files:**
- Modify: `src/store/actionsSlice.ts`
- Test: `src/store/actionsSlice.test.ts` (Create)

- [ ] **Step 1: Write the failing test**

Create `src/store/actionsSlice.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from './index';

describe('actionsSlice running status', () => {
  beforeEach(() => { useStore.setState({ runningActions: {} }); });

  it('setActionRunning adds a running entry', () => {
    useStore.getState().setActionRunning(5, 'pty-x');
    expect(useStore.getState().runningActions[5]).toEqual({ actionId: 5, ptyId: 'pty-x', status: 'running' });
  });

  it('setActionExited keeps ptyId and records exitCode', () => {
    useStore.getState().setActionRunning(5, 'pty-x');
    useStore.getState().setActionExited(5, 1);
    expect(useStore.getState().runningActions[5]).toEqual({ actionId: 5, ptyId: 'pty-x', status: 'exited', exitCode: 1 });
  });

  it('setActionExited is a no-op when action is not running', () => {
    useStore.getState().setActionExited(5, 1);
    expect(useStore.getState().runningActions[5]).toBeUndefined();
  });

  it('clearAction removes the entry', () => {
    useStore.getState().setActionRunning(5, 'pty-x');
    useStore.getState().clearAction(5);
    expect(useStore.getState().runningActions[5]).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/store/actionsSlice.test.ts`
Expected: FAIL — `setActionRunning is not a function` (metody jeszcze nie istnieją).

- [ ] **Step 3: Rewrite the slice**

Replace the entire contents of `src/store/actionsSlice.ts` with:

```ts
import type { StateCreator } from 'zustand';
import { tauri } from '../lib/tauri';
import type { Action } from '../types';

export type ActionStatus = 'running' | 'exited';
export type RunningAction = { actionId: number; ptyId: string; status: ActionStatus; exitCode?: number };

export type ActionsSlice = {
  actionsByProject: Record<number, Action[]>;
  runningActions: Record<number, RunningAction>;
  loadActions: (projectId: number) => Promise<void>;
  setActionRunning: (actionId: number, ptyId: string) => void;
  setActionExited: (actionId: number, exitCode: number) => void;
  clearAction: (actionId: number) => void;
  removeAction: (id: number) => Promise<void>;
};

export const createActionsSlice: StateCreator<ActionsSlice> = (set, get) => ({
  actionsByProject: {},
  runningActions: {},
  loadActions: async (projectId) => {
    const items = await tauri.listActions(projectId);
    set({ actionsByProject: { ...get().actionsByProject, [projectId]: items } });
  },
  setActionRunning: (actionId, ptyId) =>
    set({ runningActions: { ...get().runningActions, [actionId]: { actionId, ptyId, status: 'running' } } }),
  setActionExited: (actionId, exitCode) => {
    const cur = get().runningActions[actionId];
    if (!cur) return;
    set({ runningActions: { ...get().runningActions, [actionId]: { ...cur, status: 'exited', exitCode } } });
  },
  clearAction: (actionId) => {
    const next = { ...get().runningActions };
    delete next[actionId];
    set({ runningActions: next });
  },
  removeAction: async (id) => {
    await tauri.removeAction(id);
    const byProj = { ...get().actionsByProject };
    for (const pid of Object.keys(byProj)) {
      byProj[Number(pid)] = byProj[Number(pid)].filter(a => a.id !== id);
    }
    set({ actionsByProject: byProj });
  },
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/store/actionsSlice.test.ts`
Expected: PASS (4 testy).

- [ ] **Step 5: Commit**

```bash
git add src/store/actionsSlice.ts src/store/actionsSlice.test.ts
git commit -m "feat(actions): track action process status (running/exited) in store"
```

---

### Task 2: `processManager` (rdzeń — PTY + bufor)

**Files:**
- Create: `src/lib/processManager.ts`
- Test: `src/lib/processManager.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/processManager.test.ts`:

```ts
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
    expect(received.length).toBeGreaterThan(0);
  });

  it('dismiss kills the pty and clears status', async () => {
    await processManager.start(7, action);
    processManager.dismiss(1);
    expect(tauri.ptyKill).toHaveBeenCalledWith('pty-1');
    expect(useStore.getState().runningActions[1]).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/lib/processManager.test.ts`
Expected: FAIL — `Cannot find module './processManager'`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/processManager.ts`:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/lib/processManager.test.ts`
Expected: PASS (4 testy).

- [ ] **Step 5: Commit**

```bash
git add src/lib/processManager.ts src/lib/processManager.test.ts
git commit -m "feat(actions): add processManager owning background action PTYs + output buffer"
```

---

### Task 3: `TerminalView` — podpinanie zamiast spawnowania (dla `kind:'action'`)

**Files:**
- Modify: `src/components/terminal/TerminalView.tsx`

Brak unit-testu: xterm wymaga prawdziwego DOM/canvas i nie jest sensownie testowalny w jsdom (zgodnie z istniejącym stanem repo — nie ma testów `TerminalView`). Weryfikacja: `npm run lint` + smoke ręczny (Zadanie 8).

- [ ] **Step 1: Dodaj import managera**

W `src/components/terminal/TerminalView.tsx`, po istniejącym imporcie store (`import { useStore } from '../../store';`) dodaj:

```ts
import { processManager } from '../../lib/processManager';
```

- [ ] **Step 2: Wyłącz spawnowanie i zabijanie PTY dla akcji**

W głównym efekcie montującym, owiń CAŁY blok `tauri.spawnPty(projectId, ptyKind, cols, rows).then(async (id) => { ... });` (obecnie `TerminalView.tsx:155-222`, od `let cancelled = false;` linia powyżej zostaje) warunkiem `if (kind !== 'action')`. Konkretnie zmień:

```ts
    let cancelled = false;
    tauri.spawnPty(projectId, ptyKind, cols, rows).then(async (id) => {
      // ... cała dotychczasowa zawartość ...
    });
```

na:

```ts
    let cancelled = false;
    if (kind !== 'action') {
      tauri.spawnPty(projectId, ptyKind, cols, rows).then(async (id) => {
        // ... cała dotychczasowa zawartość bez zmian ...
      });
    }
```

Cleanup efektu pozostaje bez zmian: `if (ptyRef.current) tauri.ptyKill(ptyRef.current)`. Dla `kind:'action'` `ptyRef.current` nigdy nie jest ustawiane (nie spawnujemy), więc PTY akcji NIE jest zabijane przy odmontowaniu — czego właśnie chcemy. `cancelled` i `ptyKind` dla akcji są nieużywane, ale zostają (lint przejdzie, bo `ptyKind` używany w innej gałęzi).

- [ ] **Step 3: Dodaj efekt podpinający dla akcji**

Bezpośrednio PO głównym efekcie montującym (przed efektem `useEffect(() => { if (!visible ...`), dodaj selektor ptyId i nowy efekt:

```ts
  const actionPtyId = useStore(s =>
    kind === 'action' && actionId != null ? s.runningActions[actionId]?.ptyId : undefined
  );

  useEffect(() => {
    if (kind !== 'action' || actionId == null) return;
    const term = termRef.current;
    if (!term || !actionPtyId) return;

    term.reset();
    const sink = {
      write: (bytes: Uint8Array) => {
        if (visibleRef.current) term.write(bytes);
        else pendingWrites.current.push(bytes);
      },
    };
    const detach = processManager.attach(actionId, sink);
    const offData = term.onData((d) => {
      const enc = btoa(unescape(encodeURIComponent(d)));
      processManager.write(actionId, enc);
    });
    const offResize = term.onResize(({ cols, rows }) => processManager.resize(actionId, cols, rows));
    processManager.resize(actionId, term.cols, term.rows);

    return () => { detach(); offData.dispose(); offResize.dispose(); };
  }, [kind, actionId, actionPtyId]);
```

Uwaga: efekt montujący tworzy `term` synchronicznie (ustawia `termRef.current`) zanim ten efekt się uruchomi, więc `termRef.current` jest dostępny. Zmiana `actionPtyId` (re-run akcji: `dismiss`+`start`) powoduje cleanup (`detach`) i ponowne podpięcie z `term.reset()` (czysty ekran dla nowego procesu).

- [ ] **Step 4: Verify lint**

Run: `npm run lint`
Expected: brak błędów.

- [ ] **Step 5: Commit**

```bash
git add src/components/terminal/TerminalView.tsx
git commit -m "feat(actions): attach TerminalView to managed action PTY instead of spawning"
```

---

### Task 4: `ActionRow` — start w tle + przyciski podglądu/stop/re-run

**Files:**
- Modify: `src/components/right/ActionRow.tsx`
- Test: `src/components/right/ActionRow.test.tsx` (Create)

- [ ] **Step 1: Write the failing test**

Create `src/components/right/ActionRow.test.tsx`:

```tsx
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { Action } from '../../types';

const h = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
  start: vi.fn(), stop: vi.fn(), dismiss: vi.fn(),
  upsert: vi.fn(), closeTab: vi.fn(), removeAction: vi.fn(),
}));

vi.mock('../../lib/processManager', () => ({
  processManager: { start: h.start, stop: h.stop, dismiss: h.dismiss },
}));
vi.mock('../../store', () => ({ useStore: (sel: (s: unknown) => unknown) => sel(h.state) }));

import { ActionRow } from './ActionRow';

const action: Action = {
  id: 1, projectId: 7, label: 'build', command: 'echo hi',
  workingDir: null, source: null, preCommand: null, sortOrder: 0,
};

function seed(runningActions: Record<number, unknown>) {
  h.state = {
    runningActions,
    upsertActionTab: h.upsert,
    closeTab: h.closeTab,
    removeAction: h.removeAction,
  };
}

describe('ActionRow', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('runs the action in background when not running', () => {
    seed({});
    render(<ActionRow action={action} index={0} onChanged={() => {}} />);
    fireEvent.click(screen.getByTitle('Uruchom'));
    expect(h.start).toHaveBeenCalledWith(7, action);
    expect(h.upsert).not.toHaveBeenCalled();
  });

  it('shows output tab and offers stop while running', () => {
    seed({ 1: { actionId: 1, ptyId: 'p', status: 'running' } });
    render(<ActionRow action={action} index={0} onChanged={() => {}} />);
    fireEvent.click(screen.getByTitle('Pokaż output'));
    expect(h.upsert).toHaveBeenCalled();
    fireEvent.click(screen.getByTitle('Zatrzymaj'));
    expect(h.stop).toHaveBeenCalledWith(1);
  });

  it('re-runs an exited action', () => {
    seed({ 1: { actionId: 1, ptyId: 'p', status: 'exited', exitCode: 0 } });
    render(<ActionRow action={action} index={0} onChanged={() => {}} />);
    fireEvent.click(screen.getByTitle('Uruchom ponownie'));
    expect(h.dismiss).toHaveBeenCalledWith(1);
    expect(h.start).toHaveBeenCalledWith(7, action);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/components/right/ActionRow.test.tsx`
Expected: FAIL — `Unable to find ... title="Uruchom"` (stary `ActionRow` ma inne przyciski).

- [ ] **Step 3: Rewrite `ActionRow`**

Replace the entire contents of `src/components/right/ActionRow.tsx` with:

```tsx
import { useState } from 'react';
import { useStore } from '../../store';
import { processManager } from '../../lib/processManager';
import type { Action } from '../../types';
import type { RunningAction } from '../../store/actionsSlice';
import { Icon } from '../shared/Icon';
import { Kbd } from '../shared/Kbd';
import { EditActionDialog } from '../dialogs/EditActionDialog';
import { ConfirmDialog } from '../dialogs/ConfirmDialog';

type Props = { action: Action; index: number; onChanged: () => void };

const STOP_SIGNAL_CODES = new Set([130, 143]);

function statusColor(r: RunningAction | undefined): string {
  if (!r) return 'text-fg-secondary';
  if (r.status === 'running') return 'text-success';
  if (r.exitCode != null && !STOP_SIGNAL_CODES.has(r.exitCode)) return 'text-danger';
  return 'text-muted';
}

export function ActionRow({ action, index, onChanged }: Props) {
  const tabId = `action:${action.id}`;
  const running = useStore(s => s.runningActions[action.id]) as RunningAction | undefined;
  const upsertActionTab = useStore(s => s.upsertActionTab);
  const closeTab = useStore(s => s.closeTab);
  const removeAction = useStore(s => s.removeAction);
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const start = () => { processManager.start(action.projectId, action); };
  const showOutput = () => {
    upsertActionTab({
      kind: 'action', id: tabId, projectId: action.projectId,
      actionId: action.id, title: action.label, status: running?.status ?? 'running',
      ...(running?.exitCode != null ? { exitCode: running.exitCode } : {}),
    });
  };
  const stop = () => { processManager.stop(action.id); };
  const rerun = () => { processManager.dismiss(action.id); processManager.start(action.projectId, action); };
  const clear = () => { processManager.dismiss(action.id); closeTab(tabId); };

  const handleDelete = async () => {
    await removeAction(action.id);
    setConfirming(false);
  };

  return (
    <>
      <div className="group flex items-center gap-3 px-2 py-2 hover:bg-bg-elev text-[12px]">
        {running ? (
          <button onClick={showOutput} title="Pokaż output"
            className={`shrink-0 ${statusColor(running)} hover:text-fg`}>
            <Icon name="eye" className="w-3.5 h-3.5" />
          </button>
        ) : (
          <button onClick={start} title="Uruchom"
            className="shrink-0 text-fg-secondary hover:text-fg">
            <Icon name="play" className="w-3.5 h-3.5" />
          </button>
        )}
        <div className="flex-1 min-w-0">
          <div className="text-fg truncate">{action.label}</div>
          {(action.source || action.workingDir) && (
            <div className="text-[10px] text-muted">
              {action.source}{action.workingDir ? ` · ${action.workingDir}/` : ''}
              {running?.status === 'running' ? ' · w tle' : running?.status === 'exited' ? ' · zakończone' : ''}
            </div>
          )}
        </div>
        <div className="flex items-center gap-1">
          {running?.status === 'running' && (
            <button onClick={stop} title="Zatrzymaj" className="text-muted hover:text-warn p-0.5">
              <Icon name="stop" className="w-3.5 h-3.5" />
            </button>
          )}
          {running?.status === 'exited' && (
            <>
              <button onClick={rerun} title="Uruchom ponownie" className="text-muted hover:text-fg p-0.5">
                <Icon name="refresh" className="w-3.5 h-3.5" />
              </button>
              <button onClick={clear} title="Wyczyść" className="text-muted hover:text-fg p-0.5">
                <Icon name="close" className="w-3.5 h-3.5" />
              </button>
            </>
          )}
        </div>
        <div className="hidden group-hover:flex items-center gap-1">
          <button onClick={() => setEditing(true)}
            className="text-muted hover:text-fg p-0.5" title="Edytuj">
            <Icon name="pencil" className="w-3 h-3" />
          </button>
          <button onClick={() => setConfirming(true)}
            className="text-muted hover:text-danger p-0.5" title="Usuń">
            <Icon name="trash" className="w-3 h-3" />
          </button>
        </div>
        {index < 9 && <Kbd>⌘{index + 1}</Kbd>}
      </div>
      {editing && (
        <EditActionDialog
          action={action}
          onClose={() => setEditing(false)}
          onUpdated={onChanged}
        />
      )}
      {confirming && (
        <ConfirmDialog
          title="Usuń akcję"
          message={`Usunąć akcję "${action.label}"?`}
          onConfirm={handleDelete}
          onCancel={() => setConfirming(false)}
        />
      )}
    </>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/components/right/ActionRow.test.tsx`
Expected: PASS (3 testy).

- [ ] **Step 5: Commit**

```bash
git add src/components/right/ActionRow.tsx src/components/right/ActionRow.test.tsx
git commit -m "feat(actions): run from right panel in background with output/stop/rerun controls"
```

---

### Task 5: `AppShell` — skróty `Ctrl/Cmd+1..9` startują w tle

**Files:**
- Modify: `src/components/layout/AppShell.tsx`

Weryfikacja: `npm run lint` + smoke (Zadanie 8). Brak unit-testu (globalny listener klawiatury w dużym komponencie; logika to jedna linia podmiany wywołania).

- [ ] **Step 1: Dodaj import managera**

W `src/components/layout/AppShell.tsx`, po `import { tauri } from '../../lib/tauri';` dodaj:

```ts
import { processManager } from '../../lib/processManager';
```

- [ ] **Step 2: Zamień otwieranie zakładki na start w tle**

W bloku obsługi cyfr (`AppShell.tsx:116-125`) zamień wywołanie `state.upsertActionTab({...})`:

```ts
      if (!e.shiftKey && !e.altKey && e.key >= '1' && e.key <= '9' && projectId != null) {
        const action = (state.actionsByProject[projectId] ?? [])[Number(e.key) - 1];
        if (!action) return;
        e.preventDefault();
        e.stopPropagation();
        processManager.start(projectId, action);
      }
```

- [ ] **Step 3: Verify lint**

Run: `npm run lint`
Expected: brak błędów.

- [ ] **Step 4: Commit**

```bash
git add src/components/layout/AppShell.tsx
git commit -m "feat(actions): Ctrl/Cmd+1..9 starts action in background"
```

---

### Task 6: `TabBar` — `dismiss` przy zamknięciu, `ConfirmDialog` tylko dla `running`

**Files:**
- Modify: `src/components/center/TabBar.tsx`
- Test: `src/components/center/TabBar.test.tsx` (Create)

- [ ] **Step 1: Write the failing test**

Create `src/components/center/TabBar.test.tsx`:

```tsx
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('../../lib/processManager', () => ({ processManager: { dismiss: vi.fn() } }));

import { processManager } from '../../lib/processManager';
import { useStore } from '../../store';
import { TabBar } from './TabBar';

function seedActionTab(status: 'running' | 'exited', exitCode?: number) {
  useStore.setState({
    tabs: [{ kind: 'action', id: 'action:1', projectId: 1, actionId: 1, title: 'build', status, ...(exitCode != null ? { exitCode } : {}) }],
    activeTabId: 'action:1',
    mruOrder: ['action:1'],
    runningActions: { 1: { actionId: 1, ptyId: 'p', status, exitCode } },
    projects: [{ id: 1, name: 'P', path: '/p' }] as never,
  });
}

describe('TabBar action close', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('closes an exited action tab immediately and dismisses the process', () => {
    seedActionTab('exited', 0);
    render(<TabBar />);
    fireEvent.click(screen.getByText('×'));
    expect(screen.queryByText('Zamknąć aktywny tab?')).toBeNull();
    expect(processManager.dismiss).toHaveBeenCalledWith(1);
    expect(useStore.getState().tabs).toHaveLength(0);
  });

  it('asks for confirmation when the action process is still running', () => {
    seedActionTab('running');
    render(<TabBar />);
    fireEvent.click(screen.getByText('×'));
    expect(screen.getByText('Zamknąć aktywny tab?')).toBeInTheDocument();
    expect(useStore.getState().tabs).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/components/center/TabBar.test.tsx`
Expected: FAIL — pierwszy test: pokaże dialog (bo dziś każda akcja jest „active process"), `dismiss` nie wołane.

- [ ] **Step 3: Implement the changes**

W `src/components/center/TabBar.tsx`:

(a) Po istniejących importach dodaj:

```ts
import { processManager } from '../../lib/processManager';
```

(b) W komponencie `TabBar`, obok pozostałych selektorów dodaj selektor `runningActions`:

```ts
  const runningActions = useStore(s => s.runningActions);
```

(c) Zamień `isActiveProcess` tak, by akcja liczyła się jako aktywny proces tylko gdy działa:

```ts
  const isActiveProcess = (id: string) => {
    const t = tabs.find(x => x.id === id);
    if (!t) return false;
    if (t.kind === 'action') return runningActions[t.actionId]?.status === 'running';
    return (t.kind === 'session' && t.mode === 'terminal') || t.kind === 'terminal';
  };
```

(d) Dodaj helper `doClose` (zabija proces akcji przed zamknięciem zakładki) i użyj go wszędzie zamiast bezpośredniego `closeTab` w ścieżkach zamykania:

```ts
  const doClose = (id: string) => {
    const t = tabs.find(x => x.id === id);
    if (t?.kind === 'action') processManager.dismiss(t.actionId);
    closeTab(id);
  };

  const closeWithGuard = (id: string) => {
    if (isActiveProcess(id)) setPendingClose(id);
    else doClose(id);
  };
```

(e) W `ConfirmDialog` na dole zamień `onConfirm`:

```tsx
          onConfirm={() => { doClose(pendingClose); setPendingClose(null); }}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/components/center/TabBar.test.tsx`
Expected: PASS (2 testy).

- [ ] **Step 5: Commit**

```bash
git add src/components/center/TabBar.tsx src/components/center/TabBar.test.tsx
git commit -m "feat(actions): dismiss managed process on action tab close; confirm only while running"
```

---

### Task 7: Dropdown akcji na liście projektów

**Files:**
- Create: `src/components/sidebar/ProjectActionsMenu.tsx`
- Create: `src/components/sidebar/ProjectActionsMenu.test.tsx`
- Modify: `src/components/sidebar/ProjectItem.tsx`

- [ ] **Step 1: Write the failing test**

Create `src/components/sidebar/ProjectActionsMenu.test.tsx`:

```tsx
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { Action } from '../../types';

const h = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
  start: vi.fn(), stop: vi.fn(), dismiss: vi.fn(),
  upsert: vi.fn(), closeTab: vi.fn(), load: vi.fn(),
}));

vi.mock('../../lib/processManager', () => ({
  processManager: { start: h.start, stop: h.stop, dismiss: h.dismiss },
}));
vi.mock('../../store', () => ({ useStore: (sel: (s: unknown) => unknown) => sel(h.state) }));

import { ProjectActionsMenu } from './ProjectActionsMenu';

const actions: Action[] = [
  { id: 1, projectId: 7, label: 'build', command: 'b', workingDir: null, source: null, preCommand: null, sortOrder: 0 },
  { id: 2, projectId: 7, label: 'test', command: 't', workingDir: null, source: null, preCommand: null, sortOrder: 1 },
];

function seed(runningActions: Record<number, unknown>) {
  h.state = {
    actionsByProject: { 7: actions },
    runningActions,
    loadActions: h.load,
    upsertActionTab: h.upsert,
    closeTab: h.closeTab,
  };
}

describe('ProjectActionsMenu', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('starts a not-running action on click', () => {
    seed({});
    render(<ProjectActionsMenu projectId={7} onClose={() => {}} />);
    fireEvent.click(screen.getByText('build'));
    expect(h.start).toHaveBeenCalledWith(7, actions[0]);
    expect(h.upsert).not.toHaveBeenCalled();
  });

  it('opens the tab for an already-running action on click', () => {
    seed({ 1: { actionId: 1, ptyId: 'p', status: 'running' } });
    render(<ProjectActionsMenu projectId={7} onClose={() => {}} />);
    fireEvent.click(screen.getByText('build'));
    expect(h.upsert).toHaveBeenCalled();
    expect(h.start).not.toHaveBeenCalled();
  });

  it('re-runs an exited action via its restart button', () => {
    seed({ 1: { actionId: 1, ptyId: 'p', status: 'exited', exitCode: 0 } });
    render(<ProjectActionsMenu projectId={7} onClose={() => {}} />);
    fireEvent.click(screen.getByTitle('Uruchom ponownie'));
    expect(h.dismiss).toHaveBeenCalledWith(1);
    expect(h.start).toHaveBeenCalledWith(7, actions[0]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/components/sidebar/ProjectActionsMenu.test.tsx`
Expected: FAIL — `Cannot find module './ProjectActionsMenu'`.

- [ ] **Step 3: Write the component**

Create `src/components/sidebar/ProjectActionsMenu.tsx`:

```tsx
import { useEffect } from 'react';
import { useStore } from '../../store';
import { processManager } from '../../lib/processManager';
import type { Action } from '../../types';
import type { RunningAction } from '../../store/actionsSlice';
import { Icon } from '../shared/Icon';

const STOP_SIGNAL_CODES = new Set([130, 143]);

function dotClass(r: RunningAction | undefined): string {
  if (!r) return 'bg-transparent border border-border';
  if (r.status === 'running') return 'bg-success';
  if (r.exitCode != null && !STOP_SIGNAL_CODES.has(r.exitCode)) return 'bg-danger';
  return 'bg-muted';
}

type Props = { projectId: number; onClose: () => void };

export function ProjectActionsMenu({ projectId, onClose }: Props) {
  const actions = useStore(s => s.actionsByProject[projectId]) as Action[] | undefined;
  const running = useStore(s => s.runningActions) as Record<number, RunningAction>;
  const loadActions = useStore(s => s.loadActions);
  const upsertActionTab = useStore(s => s.upsertActionTab);
  const closeTab = useStore(s => s.closeTab);

  useEffect(() => { if (!actions) void loadActions(projectId); }, [projectId, actions, loadActions]);

  const showTab = (a: Action) => {
    const r = running[a.id];
    upsertActionTab({
      kind: 'action', id: `action:${a.id}`, projectId, actionId: a.id,
      title: a.label, status: r?.status ?? 'running',
      ...(r?.exitCode != null ? { exitCode: r.exitCode } : {}),
    });
    onClose();
  };
  const start = (a: Action) => { processManager.start(projectId, a); };
  const rerun = (a: Action) => { processManager.dismiss(a.id); processManager.start(projectId, a); };
  const clear = (a: Action) => { processManager.dismiss(a.id); closeTab(`action:${a.id}`); };

  if (!actions || actions.length === 0) {
    return <div className="px-3 py-2 text-[11.5px] text-muted">Brak akcji</div>;
  }

  return (
    <div role="menu" className="py-1">
      {actions.map(a => {
        const r = running[a.id];
        return (
          <div key={a.id} className="group flex items-center gap-2 px-3 py-1.5 text-[11.5px] hover:bg-bg-elev">
            <span className={`shrink-0 w-1.5 h-1.5 rounded-full ${dotClass(r)}`} />
            <button
              onClick={() => (r ? showTab(a) : start(a))}
              title={r ? 'Pokaż output' : 'Uruchom'}
              className="flex-1 text-left truncate text-fg hover:text-accent"
            >
              {a.label}
            </button>
            {r?.status === 'running' && (
              <button onClick={() => processManager.stop(a.id)} title="Zatrzymaj" className="text-muted hover:text-warn p-0.5">
                <Icon name="stop" className="w-3 h-3" />
              </button>
            )}
            {r?.status === 'exited' && (
              <>
                <button onClick={() => rerun(a)} title="Uruchom ponownie" className="text-muted hover:text-fg p-0.5">
                  <Icon name="refresh" className="w-3 h-3" />
                </button>
                <button onClick={() => clear(a)} title="Wyczyść" className="text-muted hover:text-fg p-0.5">
                  <Icon name="close" className="w-3 h-3" />
                </button>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/components/sidebar/ProjectActionsMenu.test.tsx`
Expected: PASS (3 testy).

- [ ] **Step 5: Osadź dropdown + badge w `ProjectItem`**

W `src/components/sidebar/ProjectItem.tsx`:

(a) Zmień import Reacta na `import { useEffect, useRef, useState } from 'react';` i dodaj importy:

```ts
import { ProjectActionsMenu } from './ProjectActionsMenu';
```

(b) W komponencie dodaj stan menu, ref do zamykania po kliknięciu poza, oraz selektory akcji/statusu:

```ts
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const actions = useStore(s => s.actionsByProject[project.id]);
  const runningActions = useStore(s => s.runningActions);
  const hasActive = (actions ?? []).some(a => runningActions[a.id]);

  useEffect(() => {
    if (!menuOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [menuOpen]);
```

(c) W rzędzie przycisków (po przycisku „Open in editor", przed zamknięciem `</div>` rzędu) dodaj trzeci przycisk z dropdownem:

```tsx
            <div className="relative" ref={menuRef}>
              <button
                onClick={(e) => { e.stopPropagation(); setMenuOpen(o => !o); }}
                className="relative flex items-center gap-1 px-1.5 py-1.5 text-[11.5px] text-muted hover:text-fg transition-colors rounded"
                title="Akcje"
              >
                <Icon name="layers" className="w-3 h-3" strokeWidth={2} />
                {hasActive && (
                  <span className="absolute top-0.5 right-0.5 w-1.5 h-1.5 rounded-full bg-success" />
                )}
              </button>
              {menuOpen && (
                <div className="absolute right-0 z-20 mt-1 w-56 max-h-72 overflow-y-auto rounded-md border border-border bg-bg shadow-lg">
                  <ProjectActionsMenu projectId={project.id} onClose={() => setMenuOpen(false)} />
                </div>
              )}
            </div>
```

- [ ] **Step 6: Verify lint + run touched tests**

Run: `npm run lint && npm test -- src/components/sidebar/ProjectActionsMenu.test.tsx`
Expected: lint bez błędów; testy PASS.

- [ ] **Step 7: Commit**

```bash
git add src/components/sidebar/ProjectActionsMenu.tsx src/components/sidebar/ProjectActionsMenu.test.tsx src/components/sidebar/ProjectItem.tsx
git commit -m "feat(actions): add actions dropdown with background-run/show-tab to project list"
```

---

### Task 8: Pełna weryfikacja + smoke ręczny

**Files:** brak (weryfikacja).

- [ ] **Step 1: Lint + cały zestaw testów**

Run: `npm run lint && npm test`
Expected: lint bez błędów; wszystkie testy PASS (w tym istniejące `tabsSlice`, `restoreTabs`, `sessionsSlice`).

- [ ] **Step 2: Smoke ręczny**

Run: `npm run tauri dev`

Sprawdź:
1. Prawy panel: klik ▶ na akcji → NIE otwiera się zakładka; pojawia się ikona oka + „· w tle". Klik oka → otwiera zakładkę z dotychczasowym outputem, output leci dalej live.
2. Poczekaj aż proces się zakończy → status „· zakończone", przyciski `↻`/`×`. Zamknięcie zakładki zakończonego procesu NIE pyta o potwierdzenie.
3. Akcja `running` → zamknięcie zakładki pyta o potwierdzenie („Zamknąć aktywny tab?").
4. `Ctrl/Cmd+1` → uruchamia 1. akcję w tle (bez zakładki).
5. Lista projektów (rozwinięty projekt): trzecia ikona (warstwy) → dropdown z akcjami. Klik nieuruchomionej → start w tle; klik uruchomionej → otwiera zakładkę. Kropka/badge przy ikonie pojawia się gdy ≥1 akcja aktywna.
6. Re-run (`↻`) gdy zakładka otwarta → ekran czyści się i leci nowy proces.

- [ ] **Step 3: Commit (jeśli smoke wymusił poprawki)**

```bash
git add -A
git commit -m "fix(actions): smoke-test follow-ups for background action execution"
```

---

## Self-review (autor planu)

**Pokrycie specu:**
- Uruchamianie w tle bez zakładki → Task 4 (prawy panel), Task 5 (skróty), Task 7 (dropdown), oparte o Task 2 (`processManager.start`). ✔
- Przycisk otwierający zakładkę ze stanem procesu → Task 4 (ikona oka), Task 7 (klik w dropdownie), Task 3 (attach + replay bufora). ✔
- Output oglądalny po `exit` → Task 2 (bufor + marker, status `exited`, brak czyszczenia do `dismiss`), Task 3 (replay). ✔
- Dropdown na liście projektów (klik startuje nieuruchomione / pokazuje tab dla uruchomionych) → Task 7. ✔
- Semantyka zamknięcia (confirm tylko `running`, `exited` bez pytania, `dismiss` zabija/czyści) → Task 6. ✔
- Wskaźnik „niewidzialnego tła" (badge) → Task 7 krok 5. ✔
- `TerminalView` przestaje zabijać PTY akcji na unmount → Task 3 krok 2. ✔

**Skan placeholderów:** brak TBD/TODO; każdy krok zmieniający kod zawiera pełny kod.

**Spójność typów/nazw:** `RunningAction = { actionId, ptyId, status: 'running'|'exited', exitCode? }` zdefiniowane w Task 1 i używane identycznie w Task 2/4/6/7. Metody `setActionRunning`/`setActionExited`/`clearAction` (Task 1) wołane spójnie w Task 2. API managera `start/attach/write/resize/stop/dismiss` (Task 2) używane spójnie w Task 3/4/5/6/7. `Tab` (`kind:'action'`, `status:'running'|'exited'`, `exitCode?`) zgodne z istniejącym `tabsSlice` — `upsertActionTab` nie wymaga zmian.

**Poza zakresem (zgodnie ze specem):** persystencja buforów między restartami, limit rozmiaru bufora, globalny widok procesów ponad projektem.
```
