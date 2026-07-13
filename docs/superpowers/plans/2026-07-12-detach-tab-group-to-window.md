# Wydzielenie grupy zakładek do nowego okna — plan implementacji

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Przeniesienie wszystkich zakładek jednego projektu z głównego okna do osobnego okna aplikacji, z zachowaniem działających procesów akcji.

**Architecture:** Nowy webview dostaje payload zakładek w query stringu (base64 JSON), rozszerzając istniejący `windowMode`. Sesje i shelle restartują PTY (kill w starym oknie przy `tauri://created`, spawn w nowym przy mount). Akcje są adoptowane po `ptyId` (Rust rozsyła wyjście PTY broadcastem), a stare okno zwalnia je dopiero po evencie `abeon:detach-ready` z nowego okna — dzięki temu proces nie ginie i nie gubi logów.

**Tech Stack:** React 19, Zustand 5, Tauri 2 (`@tauri-apps/api/webviewWindow`, `/event`), Vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-07-12-detach-tab-group-to-window-design.md`

## Global Constraints

- Identyfikatory w kodzie wyłącznie po angielsku; teksty UI po polsku.
- Bez komentarzy w kodzie, chyba że wyjaśniają nieoczywiste „dlaczego" (istniejący kod stosuje je oszczędnie).
- Każde wywołanie IPC przechodzi przez `src/lib/tauri.ts` — komponenty nie wołają `invoke`/`listen`/`emit` bezpośrednio.
- Commity: Conventional Commits, scope `desktop`, bez trailerów co-author.
- Praca w `DesktopApp/` (tam `npm test`, `npm run lint`).
- Po każdym zadaniu: `npm test` i `npm run lint` (= `tsc -b --noEmit`) muszą przechodzić bez błędów.

---

### Task 1: Tryb okna `group` w `windowMode`

**Files:**
- Modify: `DesktopApp/src/lib/windowMode.ts`
- Test: `DesktopApp/src/lib/windowMode.test.ts`

**Interfaces:**
- Produces: `DetachedTab`, `WindowMode` (union `session` | `group`), `buildGroupWindowUrl(p)`, `groupWindowLabel(projectId)`, `parseWindowMode(search)` zwracające także tryb `group`.

- [ ] **Step 1: Write the failing tests** — dopisz do `windowMode.test.ts`:

```tsx
import { describe, it, expect } from 'vitest';
import { parseWindowMode, buildSessionWindowUrl, buildGroupWindowUrl, sessionWindowLabel, groupWindowLabel, type DetachedTab } from './windowMode';

describe('group window mode', () => {
  const tabs: DetachedTab[] = [
    { kind: 'session', id: 'session:s1', sessionId: 's1', title: 'Sesja — żółć', mode: 'history' },
    { kind: 'session', id: 'session:s2', sessionId: 's2', linkedSessionId: 's2r', title: 'Live', mode: 'terminal', fresh: true, provider: 'codex' },
    { kind: 'action', id: 'action:4', actionId: 4, title: 'dev', status: 'running', ptyId: 'pty-9' },
    { kind: 'terminal', id: 'terminal:t1', title: 'Terminal' },
    { kind: 'providerPicker', id: 'picker:p1', title: 'New session' },
  ];

  it('round-trips the payload, including non-ASCII titles', () => {
    const url = buildGroupWindowUrl({ projectId: 7, tabs, activeTabId: 'action:4' });
    const search = url.slice(url.indexOf('?'));
    expect(parseWindowMode(search)).toEqual({ view: 'group', projectId: 7, tabs, activeTabId: 'action:4' });
  });

  it('accepts a null activeTabId', () => {
    const url = buildGroupWindowUrl({ projectId: 1, tabs: [tabs[0]], activeTabId: null });
    const search = url.slice(url.indexOf('?'));
    expect(parseWindowMode(search)).toEqual({ view: 'group', projectId: 1, tabs: [tabs[0]], activeTabId: null });
  });

  it('returns null on a malformed payload', () => {
    expect(parseWindowMode('?view=group&projectId=1&tabs=not-base64!!')).toBeNull();
    expect(parseWindowMode('?view=group&projectId=1')).toBeNull();
    expect(parseWindowMode(`?view=group&projectId=1&tabs=${btoa('[]')}`)).toBeNull();
    expect(parseWindowMode(`?view=group&projectId=x&tabs=${btoa('[{"kind":"terminal","id":"t","title":"T"}]')}`)).toBeNull();
  });
});

describe('groupWindowLabel', () => {
  it('prefixes with project', () => {
    expect(groupWindowLabel(12)).toBe('project-12');
  });
});
```

Istniejące testy `parseWindowMode` dla trybu `session` zostają bez zmian — muszą dalej przechodzić.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd DesktopApp && npx vitest run src/lib/windowMode.test.ts`
Expected: FAIL — `buildGroupWindowUrl is not a function`.

- [ ] **Step 3: Implement** — `src/lib/windowMode.ts` w całości:

```ts
import type { Provider } from '../types';

export type DetachedTab =
  | { kind: 'session'; id: string; sessionId: string; linkedSessionId?: string; title: string; mode: 'history' | 'terminal'; fresh?: boolean; preview?: boolean; provider?: Provider }
  | { kind: 'action'; id: string; actionId: number; title: string; status: 'running' | 'exited'; exitCode?: number; ptyId?: string }
  | { kind: 'terminal'; id: string; title: string }
  | { kind: 'providerPicker'; id: string; title: string };

export type SessionWindowMode = {
  view: 'session';
  projectId: number;
  sessionId: string;
  linkedSessionId?: string;
  title: string;
  fresh: boolean;
  provider?: Provider;
};

export type GroupWindowMode = {
  view: 'group';
  projectId: number;
  tabs: DetachedTab[];
  activeTabId: string | null;
};

export type WindowMode = SessionWindowMode | GroupWindowMode;

function encodePayload(value: unknown): string {
  return btoa(unescape(encodeURIComponent(JSON.stringify(value))));
}

function decodePayload(raw: string): unknown {
  return JSON.parse(decodeURIComponent(escape(atob(raw))));
}

function parseProjectId(raw: string | null): number | null {
  if (!raw) return null;
  const value = Number(raw);
  return Number.isInteger(value) ? value : null;
}

function parseSessionMode(q: URLSearchParams): SessionWindowMode | null {
  const projectId = parseProjectId(q.get('projectId'));
  const sessionId = q.get('sessionId');
  if (projectId === null || !sessionId) return null;
  const linkedSessionId = q.get('linkedSessionId') ?? undefined;
  const title = q.get('title') ?? 'Sesja';
  const fresh = q.get('fresh') === 'true';
  const provider: Provider | undefined = q.get('provider') === 'codex' ? 'codex' : undefined;
  return {
    view: 'session',
    projectId,
    sessionId,
    ...(linkedSessionId ? { linkedSessionId } : {}),
    title,
    fresh,
    ...(provider ? { provider } : {}),
  };
}

function parseGroupMode(q: URLSearchParams): GroupWindowMode | null {
  const projectId = parseProjectId(q.get('projectId'));
  const raw = q.get('tabs');
  if (projectId === null || !raw) return null;
  let tabs: unknown;
  try {
    tabs = decodePayload(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(tabs) || tabs.length === 0) return null;
  return {
    view: 'group',
    projectId,
    tabs: tabs as DetachedTab[],
    activeTabId: q.get('activeTabId'),
  };
}

export function parseWindowMode(search: string): WindowMode | null {
  const q = new URLSearchParams(search);
  const view = q.get('view');
  if (view === 'session') return parseSessionMode(q);
  if (view === 'group') return parseGroupMode(q);
  return null;
}

export function buildSessionWindowUrl(p: {
  projectId: number;
  sessionId: string;
  linkedSessionId?: string;
  title: string;
  fresh: boolean;
  provider?: Provider;
}): string {
  const q = new URLSearchParams();
  q.set('view', 'session');
  q.set('projectId', String(p.projectId));
  q.set('sessionId', p.sessionId);
  if (p.linkedSessionId) q.set('linkedSessionId', p.linkedSessionId);
  q.set('title', p.title);
  q.set('fresh', p.fresh ? 'true' : 'false');
  if (p.provider) q.set('provider', p.provider);
  return `index.html?${q.toString()}`;
}

export function buildGroupWindowUrl(p: {
  projectId: number;
  tabs: DetachedTab[];
  activeTabId: string | null;
}): string {
  const q = new URLSearchParams();
  q.set('view', 'group');
  q.set('projectId', String(p.projectId));
  q.set('tabs', encodePayload(p.tabs));
  if (p.activeTabId) q.set('activeTabId', p.activeTabId);
  return `index.html?${q.toString()}`;
}

export function sessionWindowLabel(sessionId: string): string {
  return `session-${sessionId.replace(/[^a-zA-Z0-9-]/g, '_')}`;
}

export function groupWindowLabel(projectId: number): string {
  return `project-${projectId}`;
}
```

- [ ] **Step 4: Run tests**

Run: `cd DesktopApp && npx vitest run src/lib/windowMode.test.ts && npm run lint`
Expected: PASS, zero błędów TS.

- [ ] **Step 5: Commit**

```bash
git add DesktopApp/src/lib/windowMode.ts DesktopApp/src/lib/windowMode.test.ts
git commit -m "feat(desktop): dodaj tryb okna group do windowMode"
```

---

### Task 2: `processManager.adopt` / `release`

**Files:**
- Modify: `DesktopApp/src/lib/processManager.ts`
- Test: `DesktopApp/src/lib/processManager.test.ts`

**Interfaces:**
- Consumes: nic.
- Produces: `processManager.adopt(actionId: number, ptyId: string): Promise<void>`, `processManager.release(actionId: number): void`.

`adopt` rejestruje nasłuch na istniejącym PTY (bez `spawnPty`) i ustawia `runningActions`. `release` odsubskrybowuje i czyści stan **bez** `ptyKill` — proces żyje dalej w innym oknie.

- [ ] **Step 1: Write the failing tests** — dopisz do `processManager.test.ts` (wewnątrz `describe('processManager', …)`):

```ts
  it('adopt listens on an existing pty without spawning', async () => {
    await processManager.adopt(1, 'pty-live');
    expect(tauri.spawnPty).not.toHaveBeenCalled();
    expect(tauri.onPtyOutput).toHaveBeenCalledWith('pty-live', expect.any(Function));
    expect(useStore.getState().runningActions[1]).toMatchObject({ actionId: 1, ptyId: 'pty-live', status: 'running' });

    const received: number[] = [];
    processManager.attach(1, { write: (b) => received.push(...b) });
    outCb(new Uint8Array([65]));
    expect(received).toEqual([65]);
  });

  it('release clears state without killing the pty', async () => {
    await processManager.start(7, action);
    processManager.release(1);
    expect(tauri.ptyKill).not.toHaveBeenCalled();
    expect(processManager.isActive(1)).toBe(false);
    expect(useStore.getState().runningActions[1]).toBeUndefined();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd DesktopApp && npx vitest run src/lib/processManager.test.ts`
Expected: FAIL — `processManager.adopt is not a function`.

- [ ] **Step 3: Implement** — w `processManager.ts` wydziel wspólną rejestrację nasłuchu (używa jej `start` i `adopt`), a potem dodaj obie metody.

Zamień ciało `start` i dodaj `register`, `adopt`, `release`:

```ts
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

  // …attach / write / resize / stop / dismiss bez zmian
};
```

Reszta metod (`attach`, `write`, `resize`, `stop`, `dismiss`) zostaje dokładnie taka, jaka jest.

- [ ] **Step 4: Run tests**

Run: `cd DesktopApp && npx vitest run src/lib/processManager.test.ts && npm run lint`
Expected: PASS (w tym istniejący test „tears down listeners if dismissed during start" — `register` zachowuje sprawdzenie `procs.get(actionId) !== entry`).

- [ ] **Step 5: Commit**

```bash
git add DesktopApp/src/lib/processManager.ts DesktopApp/src/lib/processManager.test.ts
git commit -m "feat(desktop): adopt/release w processManager dla przenoszenia akcji między oknami"
```

---

### Task 3: `tabsSlice` — seed grupy i usuwanie zakładek bez zabijania

**Files:**
- Modify: `DesktopApp/src/store/tabsSlice.ts`
- Test: `DesktopApp/src/store/tabsSlice.test.ts` (nowy plik)

**Interfaces:**
- Consumes: `GroupWindowMode`, `DetachedTab` z Task 1.
- Produces: `tabsFromGroupMode(mode: GroupWindowMode): Tab[]`, `TabsSlice.detachTabs(ids: string[]): void`.

`detachTabs` usuwa zakładki ze stanu **bez** zabijania procesów akcji (to robi `processManager`), przelicza `activeTabId`, `mruOrder` i `navHistory`.

- [ ] **Step 1: Write the failing test** — nowy plik `src/store/tabsSlice.test.ts`:

```tsx
import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from './index';
import { tabsFromGroupMode } from './tabsSlice';
import type { GroupWindowMode } from '../lib/windowMode';

describe('tabsFromGroupMode', () => {
  it('maps the payload back to tabs and stamps the projectId', () => {
    const mode: GroupWindowMode = {
      view: 'group',
      projectId: 5,
      activeTabId: 'terminal:t1',
      tabs: [
        { kind: 'session', id: 'session:s1', sessionId: 's1', title: 'S', mode: 'history' },
        { kind: 'action', id: 'action:4', actionId: 4, title: 'dev', status: 'running', ptyId: 'pty-9' },
        { kind: 'terminal', id: 'terminal:t1', title: 'Terminal' },
      ],
    };
    expect(tabsFromGroupMode(mode)).toEqual([
      { kind: 'session', id: 'session:s1', projectId: 5, sessionId: 's1', title: 'S', mode: 'history' },
      { kind: 'action', id: 'action:4', projectId: 5, actionId: 4, title: 'dev', status: 'running' },
      { kind: 'terminal', id: 'terminal:t1', projectId: 5, title: 'Terminal' },
    ]);
  });
});

describe('detachTabs', () => {
  beforeEach(() => {
    useStore.setState({
      tabs: [
        { kind: 'terminal', id: 'a', projectId: 1, title: 'A' },
        { kind: 'terminal', id: 'b', projectId: 2, title: 'B' },
        { kind: 'terminal', id: 'c', projectId: 1, title: 'C' },
      ],
      activeTabId: 'c',
      mruOrder: ['c', 'b', 'a'],
      navHistory: ['a', 'b', 'c'],
      navIndex: 2,
    });
  });

  it('removes the given tabs and moves the active one to a survivor', () => {
    useStore.getState().detachTabs(['a', 'c']);
    const s = useStore.getState();
    expect(s.tabs.map(t => t.id)).toEqual(['b']);
    expect(s.activeTabId).toBe('b');
    expect(s.mruOrder).toEqual(['b']);
    expect(s.navHistory).toEqual(['b']);
    expect(s.navIndex).toBe(0);
  });

  it('keeps the active tab when it is not detached', () => {
    useStore.getState().detachTabs(['a']);
    const s = useStore.getState();
    expect(s.tabs.map(t => t.id)).toEqual(['b', 'c']);
    expect(s.activeTabId).toBe('c');
  });

  it('nulls the active tab when everything is detached', () => {
    useStore.getState().detachTabs(['a', 'b', 'c']);
    const s = useStore.getState();
    expect(s.tabs).toEqual([]);
    expect(s.activeTabId).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd DesktopApp && npx vitest run src/store/tabsSlice.test.ts`
Expected: FAIL — `tabsFromGroupMode is not exported` / `detachTabs is not a function`.

- [ ] **Step 3: Implement** — w `src/store/tabsSlice.ts`:

Zmień import typu na `import type { GroupWindowMode, SessionWindowMode } from '../lib/windowMode';` i zamień sygnaturę `sessionTabFromMode` na `SessionWindowMode` (`WindowMode` jest teraz unią, więc `mode.sessionId` przestałoby się typować):

```ts
export function sessionTabFromMode(mode: SessionWindowMode): Extract<Tab, { kind: 'session' }> {
```

Dodaj poniżej:

```ts
export function tabsFromGroupMode(mode: GroupWindowMode): Tab[] {
  return mode.tabs.map((t): Tab => {
    if (t.kind === 'session') {
      return {
        kind: 'session',
        id: t.id,
        projectId: mode.projectId,
        sessionId: t.sessionId,
        ...(t.linkedSessionId ? { linkedSessionId: t.linkedSessionId } : {}),
        title: t.title,
        mode: t.mode,
        ...(t.fresh ? { fresh: true } : {}),
        ...(t.preview ? { preview: true } : {}),
        ...(t.provider ? { provider: t.provider } : {}),
      };
    }
    if (t.kind === 'action') {
      return {
        kind: 'action',
        id: t.id,
        projectId: mode.projectId,
        actionId: t.actionId,
        title: t.title,
        status: t.status,
        ...(t.exitCode != null ? { exitCode: t.exitCode } : {}),
      };
    }
    if (t.kind === 'terminal') {
      return { kind: 'terminal', id: t.id, projectId: mode.projectId, title: t.title };
    }
    return { kind: 'providerPicker', id: t.id, projectId: mode.projectId, title: t.title };
  });
}
```

Dodaj `detachTabs: (ids: string[]) => void;` do typu `TabsSlice` (obok `closeTab`) i implementację w `createTabsSlice`:

```ts
  detachTabs: (ids) => {
    const removed = new Set(ids);
    const tabs = get().tabs.filter(t => !removed.has(t.id));
    const mruOrder = get().mruOrder.filter(x => !removed.has(x));
    const wasActive = !!get().activeTabId && removed.has(get().activeTabId!);
    const activeTabId = wasActive ? (tabs[tabs.length - 1]?.id ?? null) : get().activeTabId;
    let nav = { history: get().navHistory, index: get().navIndex };
    for (const id of ids) nav = pruneNav(nav, id);
    if (wasActive && activeTabId) {
      const idx = nav.history.lastIndexOf(activeTabId);
      if (idx !== -1) nav = { history: nav.history, index: idx };
    }
    set({ tabs, activeTabId, mruOrder, navHistory: nav.history, navIndex: nav.index });
  },
```

- [ ] **Step 4: Run tests**

Run: `cd DesktopApp && npx vitest run src/store/tabsSlice.test.ts && npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add DesktopApp/src/store/tabsSlice.ts DesktopApp/src/store/tabsSlice.test.ts
git commit -m "feat(desktop): tabsFromGroupMode i detachTabs w tabsSlice"
```

---

### Task 4: Event `abeon:detach-ready` w warstwie IPC

**Files:**
- Modify: `DesktopApp/src/lib/tauri.ts:1-2` (import `emit`), `DesktopApp/src/lib/tauri.ts:119` (obok `setWindowTitle`)

**Interfaces:**
- Produces: `tauri.emitDetachReady(label: string): Promise<void>`, `tauri.onDetachReady(cb: (label: string) => void): Promise<UnlistenFn>`.

Główne okno musi wiedzieć, że wydzielone okno przejęło już PTY akcji. Używamy globalnego `listen` (nie `WebviewWindow.listen`), bo `emit` z okna wydzielonego jest broadcastem — payload niesie label, po którym filtrujemy.

- [ ] **Step 1: Implement** (ten task nie ma własnego testu — kontrakt jest weryfikowany w Task 5 przez mock `tauri`)

W `src/lib/tauri.ts` zmień import zdarzeń:

```ts
import { listen, emit, type UnlistenFn } from '@tauri-apps/api/event';
```

i dopisz w obiekcie `tauri` (zaraz po `setWindowTitle`):

```ts
  emitDetachReady: (label: string) => emit('abeon:detach-ready', { label }),
  onDetachReady: (cb: (label: string) => void): Promise<UnlistenFn> =>
    listen<{ label: string }>('abeon:detach-ready', e => cb(e.payload.label)),
```

- [ ] **Step 2: Verify it type-checks**

Run: `cd DesktopApp && npm run lint`
Expected: zero błędów.

- [ ] **Step 3: Commit**

```bash
git add DesktopApp/src/lib/tauri.ts
git commit -m "feat(desktop): event abeon:detach-ready w wrapperze IPC"
```

---

### Task 5: `detachGroup.ts` — payload, podsumowanie, orkiestracja

**Files:**
- Create: `DesktopApp/src/lib/detachGroup.ts`
- Test: `DesktopApp/src/lib/detachGroup.test.ts`

**Interfaces:**
- Consumes: `buildGroupWindowUrl`, `groupWindowLabel`, `DetachedTab` (Task 1); `processManager.release` (Task 2); `tauri.onDetachReady` (Task 4).
- Produces:
  - `type DetachSummary = { sessions: number; terminals: number; runningActions: number }`
  - `summarizeDetach(tabs: Tab[], runningActions: Record<number, RunningAction | undefined>): DetachSummary`
  - `detachSummaryMessage(s: DetachSummary): string | null` — `null` gdy nic żywego (dialog pomijamy)
  - `buildDetachPayload(tabs: Tab[], runningActions: Record<number, RunningAction | undefined>): DetachedTab[]`
  - `detachProjectGroup(args: { projectId: number; projectName: string; tabs: Tab[]; activeTabId: string | null; runningActions: Record<number, RunningAction | undefined>; detachTabs: (ids: string[]) => void }): Promise<void>`

`summarizeDetach` liczy tylko to, co **realnie coś traci**: sesje w trybie `terminal` (restart CLI), zakładki `terminal` (utrata scrollbacku shella), akcje ze statusem `running` (przejęcie bez logów). Sesje w trybie `history` i akcje zakończone nie generują ostrzeżenia.

- [ ] **Step 1: Write the failing test** — nowy plik `src/lib/detachGroup.test.ts`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';

const setFocus = vi.fn();
const getByLabel = vi.fn();
const windowCtor = vi.fn();

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd DesktopApp && npx vitest run src/lib/detachGroup.test.ts`
Expected: FAIL — brak modułu `./detachGroup`.

- [ ] **Step 3: Implement** — nowy plik `src/lib/detachGroup.ts`:

```ts
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { toast } from 'sonner';
import type { Tab } from '../store/tabsSlice';
import type { RunningAction } from '../store/actionsSlice';
import { buildGroupWindowUrl, groupWindowLabel, type DetachedTab } from './windowMode';
import { processManager } from './processManager';
import { tauri } from './tauri';

export type DetachSummary = { sessions: number; terminals: number; runningActions: number };

type ActionMap = Record<number, RunningAction | undefined>;

export function summarizeDetach(tabs: Tab[], runningActions: ActionMap): DetachSummary {
  let sessions = 0;
  let terminals = 0;
  let running = 0;
  for (const tab of tabs) {
    if (tab.kind === 'session' && tab.mode === 'terminal') sessions++;
    else if (tab.kind === 'terminal') terminals++;
    else if (tab.kind === 'action' && runningActions[tab.actionId]?.status === 'running') running++;
  }
  return { sessions, terminals, runningActions: running };
}

const plural = (n: number, one: string, few: string, many: string) => {
  if (n === 1) return `${n} ${one}`;
  const rest = n % 10;
  const teens = n % 100;
  if (rest >= 2 && rest <= 4 && (teens < 12 || teens > 14)) return `${n} ${few}`;
  return `${n} ${many}`;
};

export function detachSummaryMessage(s: DetachSummary): string | null {
  const parts: string[] = [];
  if (s.sessions > 0) parts.push(`${plural(s.sessions, 'sesja zostanie', 'sesje zostaną', 'sesji zostanie')} uruchomiona od nowa z wznowieniem kontekstu`);
  if (s.terminals > 0) parts.push(`${plural(s.terminals, 'terminal straci', 'terminale stracą', 'terminali straci')} historię powłoki`);
  if (s.runningActions > 0) parts.push(`${plural(s.runningActions, 'akcja zostanie przejęta', 'akcje zostaną przejęte', 'akcji zostanie przejętych')} bez wcześniejszych logów`);
  if (parts.length === 0) return null;
  return `${parts.join(', ')}.`;
}

export function buildDetachPayload(tabs: Tab[], runningActions: ActionMap): DetachedTab[] {
  return tabs.map((tab): DetachedTab => {
    if (tab.kind === 'session') {
      return {
        kind: 'session',
        id: tab.id,
        sessionId: tab.sessionId,
        ...(tab.linkedSessionId ? { linkedSessionId: tab.linkedSessionId } : {}),
        title: tab.title,
        mode: tab.mode,
        ...(tab.fresh ? { fresh: true } : {}),
        ...(tab.preview ? { preview: true } : {}),
        ...(tab.provider ? { provider: tab.provider } : {}),
      };
    }
    if (tab.kind === 'action') {
      const ptyId = runningActions[tab.actionId]?.status === 'running'
        ? runningActions[tab.actionId]?.ptyId
        : undefined;
      return {
        kind: 'action',
        id: tab.id,
        actionId: tab.actionId,
        title: tab.title,
        status: tab.status,
        ...(tab.exitCode != null ? { exitCode: tab.exitCode } : {}),
        ...(ptyId ? { ptyId } : {}),
      };
    }
    if (tab.kind === 'terminal') {
      return { kind: 'terminal', id: tab.id, title: tab.title };
    }
    return { kind: 'providerPicker', id: tab.id, title: tab.title };
  });
}

export async function detachProjectGroup(args: {
  projectId: number;
  projectName: string;
  tabs: Tab[];
  activeTabId: string | null;
  runningActions: ActionMap;
  detachTabs: (ids: string[]) => void;
}): Promise<void> {
  const { projectId, projectName, tabs, activeTabId, runningActions, detachTabs } = args;
  if (tabs.length === 0) return;

  const label = groupWindowLabel(projectId);
  const existing = await WebviewWindow.getByLabel(label);
  if (existing) {
    await existing.setFocus();
    return;
  }

  const actionTabs = tabs.filter(t => t.kind === 'action');
  const plainTabs = tabs.filter(t => t.kind !== 'action');
  const active = tabs.some(t => t.id === activeTabId) ? activeTabId : null;

  const url = buildGroupWindowUrl({
    projectId,
    tabs: buildDetachPayload(tabs, runningActions),
    activeTabId: active,
  });

  // The action PTYs outlive the move: the new window adopts them by ptyId, so we
  // only release them here once it reports back — releasing earlier would drop
  // output emitted in the gap.
  const unlistenReady = await tauri.onDetachReady((readyLabel) => {
    if (readyLabel !== label) return;
    for (const tab of actionTabs) {
      if (tab.kind === 'action') processManager.release(tab.actionId);
    }
    if (actionTabs.length > 0) detachTabs(actionTabs.map(t => t.id));
    unlistenReady();
  });

  const win = new WebviewWindow(label, {
    url,
    title: projectName,
    width: 1100,
    height: 760,
    minWidth: 720,
    minHeight: 500,
    titleBarStyle: 'overlay',
    hiddenTitle: true,
  });

  let unlistenCreated: (() => void) | undefined;
  let unlistenError: (() => void) | undefined;

  unlistenCreated = await win.once('tauri://created', () => {
    if (plainTabs.length > 0) detachTabs(plainTabs.map(t => t.id));
    unlistenError?.();
  });
  unlistenError = await win.once('tauri://error', (e) => {
    console.error('[detach] group window create failed', e);
    toast.error('Nie udało się otworzyć okna projektu');
    unlistenReady();
    unlistenCreated?.();
  });
}
```

- [ ] **Step 4: Run tests**

Run: `cd DesktopApp && npx vitest run src/lib/detachGroup.test.ts && npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add DesktopApp/src/lib/detachGroup.ts DesktopApp/src/lib/detachGroup.test.ts
git commit -m "feat(desktop): logika wydzielania grupy projektowej do nowego okna"
```

---

### Task 6: Boot store'a w trybie `group`

**Files:**
- Modify: `DesktopApp/src/store/index.ts:9-14` (importy, `windowMode`), `DesktopApp/src/store/index.ts:311-325` (seed)

**Interfaces:**
- Consumes: `tabsFromGroupMode` (Task 3), `processManager.adopt` (Task 2).

Adopcja PTY akcji dzieje się już przy inicjalizacji modułu store'a — czyli **przed** mountem `DetachedShell`, który dopiero potem emituje `abeon:detach-ready`. To gwarantuje, że główne okno zwolni akcję dopiero wtedy, gdy nowe okno faktycznie na niej wisi.

- [ ] **Step 1: Implement**

W `src/store/index.ts` dopisz import (obok istniejącego `sessionTabFromMode`):

```ts
import { sessionTabFromMode, tabsFromGroupMode } from './tabsSlice';
import { processManager } from '../lib/processManager';
```

Zamień blok seedujący (`if (windowMode) { … } else { … }`) na:

```ts
if (windowMode?.view === 'session') {
  const tab = sessionTabFromMode(windowMode);
  useStore.setState({ tabs: [tab], activeTabId: tab.id, navHistory: [tab.id], navIndex: 0 });
} else if (windowMode?.view === 'group') {
  const tabs = tabsFromGroupMode(windowMode);
  const activeTabId = tabs.some(t => t.id === windowMode.activeTabId)
    ? windowMode.activeTabId
    : (tabs[0]?.id ?? null);
  useStore.setState({
    tabs,
    activeTabId,
    mruOrder: activeTabId ? [activeTabId] : [],
    navHistory: activeTabId ? [activeTabId] : [],
    navIndex: 0,
  });
  for (const tab of windowMode.tabs) {
    if (tab.kind === 'action' && tab.ptyId) void processManager.adopt(tab.actionId, tab.ptyId);
  }
} else {
  const savedTabs = loadTabsFromLocalStorage();
  if (savedTabs && savedTabs.tabs.length > 0) {
    useStore.setState({
      tabs: savedTabs.tabs.map(t => ({ ...t, mode: 'history' as const })),
      activeTabId: savedTabs.activeTabId,
      navHistory: savedTabs.activeTabId ? [savedTabs.activeTabId] : [],
      navIndex: 0,
    });
  }
}
```

Reszta pliku (w tym `if (windowMode) return;` w `subscribe`, które nadal wyłącza persystencję w obu trybach okna) zostaje bez zmian.

- [ ] **Step 2: Verify nothing regressed**

Run: `cd DesktopApp && npm test && npm run lint`
Expected: wszystkie testy PASS (`store/index.ts` jest importowany przez testy TabBar/processManager, więc nowy kod jest wykonywany przy `windowMode === null`).

- [ ] **Step 3: Commit**

```bash
git add DesktopApp/src/store/index.ts
git commit -m "feat(desktop): seedowanie store w oknie grupy i adopcja PTY akcji"
```

---

### Task 7: Menu kontekstowe grupy + wywołanie z `TabBar`

**Files:**
- Create: `DesktopApp/src/components/center/GroupContextMenu.tsx`
- Create: `DesktopApp/src/components/center/GroupContextMenu.test.tsx`
- Modify: `DesktopApp/src/components/center/TabContextMenu.tsx`
- Modify: `DesktopApp/src/components/center/TabContextMenu.test.tsx`
- Modify: `DesktopApp/src/components/center/TabBar.tsx`
- Modify: `DesktopApp/src/components/center/TabBar.test.tsx`

**Interfaces:**
- Consumes: `detachProjectGroup`, `summarizeDetach`, `detachSummaryMessage` (Task 5); `detachTabs` (Task 3).
- Produces: `GroupContextMenu` (props: `onDetach`, `onCloseMenu`); `TabContextMenu` z dodatkowymi propsami `canDetachGroup: boolean`, `onDetachGroup: () => void`; `TabBar` z opcjonalnym propsem `detachedProjectId?: number`.

`detachedProjectId` jest ustawiane **tylko** w oknie wydzielonym (Task 8): włącza przycisk „+" i wyłącza pozycje detach w menu kontekstowym (w oknie wydzielonym nie ma czego wydzielać).

- [ ] **Step 1: Write the failing tests**

Nowy plik `src/components/center/GroupContextMenu.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { GroupContextMenu } from './GroupContextMenu';

describe('GroupContextMenu', () => {
  it('fires onDetach then onCloseMenu', () => {
    const onDetach = vi.fn();
    const onCloseMenu = vi.fn();
    render(<GroupContextMenu onDetach={onDetach} onCloseMenu={onCloseMenu} />);
    fireEvent.click(screen.getByText('Wydziel do nowego okna'));
    expect(onDetach).toHaveBeenCalledOnce();
    expect(onCloseMenu).toHaveBeenCalledOnce();
  });
});
```

W `src/components/center/TabContextMenu.test.tsx` — każde istniejące `render(<TabContextMenu … />)` dostaje dwa nowe propsy; dopisz też nowy test:

```tsx
  it('fires onDetachGroup then onCloseMenu', () => {
    const onDetachGroup = vi.fn(); const onCloseMenu = vi.fn();
    render(<TabContextMenu canDetach canDetachGroup onDetach={noop} onDetachGroup={onDetachGroup} onRename={noop} onClose={noop} onCloseMenu={onCloseMenu} />);
    fireEvent.click(screen.getByText('Wydziel projekt do nowego okna'));
    expect(onDetachGroup).toHaveBeenCalledOnce();
    expect(onCloseMenu).toHaveBeenCalledOnce();
  });

  it('hides both detach items when detaching is not allowed', () => {
    render(<TabContextMenu canDetach={false} canDetachGroup={false} onDetach={noop} onDetachGroup={noop} onRename={noop} onClose={noop} onCloseMenu={noop} />);
    expect(screen.queryByText('Wydziel projekt do nowego okna')).toBeNull();
    expect(screen.getByText('Otwórz w nowym oknie')).toBeDisabled();
  });
```

(Pozostałe testy `TabContextMenu` uzupełnij o `canDetachGroup` i `onDetachGroup={noop}` — inaczej nie skompilują się w TS.)

W `src/components/center/TabBar.test.tsx` dopisz mock i nowy blok `describe`. Uwaga: górny `vi.mock('../../lib/processManager', …)` musi dostać też `release`, bo `detachGroup` go importuje:

```tsx
vi.mock('../../lib/processManager', () => ({ processManager: { dismiss: vi.fn(), release: vi.fn() } }));
vi.mock('../../lib/detachGroup', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/detachGroup')>();
  return { ...actual, detachProjectGroup: vi.fn() };
});

import { detachProjectGroup } from '../../lib/detachGroup';
```

```tsx
describe('TabBar group detach', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useStore.setState({
      tabs: [
        { kind: 'session', id: 'session:s1', projectId: 1, sessionId: 's1', title: 'S1', mode: 'history' },
        { kind: 'session', id: 'session:s2', projectId: 2, sessionId: 's2', title: 'S2', mode: 'history' },
      ],
      activeTabId: 'session:s1',
      mruOrder: ['session:s1'],
      runningActions: {},
      projects: [{ id: 1, name: 'Alfa', path: '/a' }, { id: 2, name: 'Beta', path: '/b' }] as never,
    });
  });

  it('detaches the project group from the group header context menu', async () => {
    render(<TabBar />);
    fireEvent.contextMenu(screen.getByText('Alfa'));
    fireEvent.click(screen.getByText('Wydziel do nowego okna'));
    expect(detachProjectGroup).toHaveBeenCalledWith(expect.objectContaining({ projectId: 1, projectName: 'Alfa' }));
    expect(vi.mocked(detachProjectGroup).mock.calls[0][0].tabs.map(t => t.id)).toEqual(['session:s1']);
  });

  it('detaches the project group from the tab context menu', () => {
    render(<TabBar />);
    fireEvent.contextMenu(screen.getByText('S2'));
    fireEvent.click(screen.getByText('Wydziel projekt do nowego okna'));
    expect(detachProjectGroup).toHaveBeenCalledWith(expect.objectContaining({ projectId: 2, projectName: 'Beta' }));
  });

  it('asks for confirmation when the group holds a live process', () => {
    useStore.setState({
      tabs: [{ kind: 'terminal', id: 'terminal:t1', projectId: 1, title: 'Terminal' }],
      activeTabId: 'terminal:t1',
    });
    render(<TabBar />);
    fireEvent.contextMenu(screen.getByText('Terminal'));
    fireEvent.click(screen.getByText('Wydziel projekt do nowego okna'));
    expect(detachProjectGroup).not.toHaveBeenCalled();
    expect(screen.getByText('Wydzielić grupę do nowego okna?')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Wydziel'));
    expect(detachProjectGroup).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd DesktopApp && npx vitest run src/components/center`
Expected: FAIL — brak `GroupContextMenu`, brak tekstu „Wydziel projekt do nowego okna".

- [ ] **Step 3: Implement `GroupContextMenu.tsx`**

```tsx
import { Icon } from '../shared/Icon';

type Props = {
  onDetach: () => void;
  onCloseMenu: () => void;
};

export function GroupContextMenu({ onDetach, onCloseMenu }: Props) {
  return (
    <div role="menu" className="py-1">
      <button
        role="menuitem"
        onClick={() => { onDetach(); onCloseMenu(); }}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-[11.5px] text-fg hover:bg-bg-elev"
      >
        <Icon name="external-link" className="w-3 h-3" strokeWidth={2} />
        <span>Wydziel do nowego okna</span>
      </button>
    </div>
  );
}
```

- [ ] **Step 4: Implement `TabContextMenu.tsx`** — dodaj pozycję grupy między „Otwórz w nowym oknie" a „Zmień nazwę":

```tsx
import { Icon } from '../shared/Icon';

type Props = {
  canDetach: boolean;
  canDetachGroup: boolean;
  onDetach: () => void;
  onDetachGroup: () => void;
  onRename: () => void;
  onClose: () => void;
  onCloseMenu: () => void;
};

export function TabContextMenu({ canDetach, canDetachGroup, onDetach, onDetachGroup, onRename, onClose, onCloseMenu }: Props) {
  return (
    <div role="menu" className="py-1">
      <button
        role="menuitem"
        disabled={!canDetach}
        onClick={() => { if (!canDetach) return; onDetach(); onCloseMenu(); }}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-[11.5px] text-fg hover:bg-bg-elev disabled:opacity-40 disabled:hover:bg-transparent disabled:cursor-default"
      >
        <Icon name="external-link" className="w-3 h-3" strokeWidth={2} />
        <span>Otwórz w nowym oknie</span>
      </button>
      {canDetachGroup && (
        <button
          role="menuitem"
          onClick={() => { onDetachGroup(); onCloseMenu(); }}
          className="w-full flex items-center gap-2 px-3 py-1.5 text-[11.5px] text-fg hover:bg-bg-elev"
        >
          <Icon name="external-link" className="w-3 h-3" strokeWidth={2} />
          <span>Wydziel projekt do nowego okna</span>
        </button>
      )}
      <button
        role="menuitem"
        onClick={() => { onRename(); onCloseMenu(); }}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-[11.5px] text-fg hover:bg-bg-elev"
      >
        <Icon name="pencil" className="w-3 h-3" strokeWidth={2} />
        <span>Zmień nazwę</span>
      </button>
      <button
        role="menuitem"
        onClick={() => { onClose(); onCloseMenu(); }}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-[11.5px] text-danger hover:bg-danger/10"
      >
        <Icon name="close" className="w-3 h-3" strokeWidth={2} />
        <span>Zamknij</span>
      </button>
    </div>
  );
}
```

- [ ] **Step 5: Implement `TabBar.tsx`**

Nowe importy:

```tsx
import { GroupContextMenu } from './GroupContextMenu';
import { detachProjectGroup, summarizeDetach, detachSummaryMessage } from '../../lib/detachGroup';
```

Sygnatura i nowy stan (obok istniejących `useState`):

```tsx
export function TabBar({ detachedProjectId }: { detachedProjectId?: number } = {}) {
  const detachTabs = useStore(s => s.detachTabs);
  const openNewSessionTab = useStore(s => s.openNewSessionTab);
  const openNewTerminalTab = useStore(s => s.openNewTerminalTab);
  const [groupMenu, setGroupMenu] = useState<{ projectId: number; x: number; y: number } | null>(null);
  const [pendingDetach, setPendingDetach] = useState<{ projectId: number; message: string } | null>(null);
```

Zamknięcie menu grupy dopisz do istniejącego efektu `onDocClick` (ten sam `ctxMenuRef` obsłuży oba menu — renderujemy je w tym samym kontenerze):

```tsx
  useEffect(() => {
    if (!ctxMenu && !groupMenu) return;
    const onDocClick = (e: MouseEvent) => {
      if (!ctxMenuRef.current?.contains(e.target as Node)) { setCtxMenu(null); setGroupMenu(null); }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [ctxMenu, groupMenu]);
```

Handlery (obok `closeWithGuard`):

```tsx
  const runDetach = (projectId: number) => {
    const state = useStore.getState();
    const groupTabs = state.tabs.filter(t => t.projectId === projectId);
    void detachProjectGroup({
      projectId,
      projectName: state.projects.find(p => p.id === projectId)?.name ?? 'Projekt',
      tabs: groupTabs,
      activeTabId: state.activeTabId,
      runningActions: state.runningActions,
      detachTabs,
    });
  };

  const detachWithGuard = (projectId: number) => {
    const state = useStore.getState();
    const groupTabs = state.tabs.filter(t => t.projectId === projectId);
    const message = detachSummaryMessage(summarizeDetach(groupTabs, state.runningActions));
    if (message) setPendingDetach({ projectId, message });
    else runDetach(projectId);
  };
```

Nagłówek grupy — dodaj `onContextMenu` do `div`-a z `onClick={() => toggleCollapse(group.projectId)}`:

```tsx
                  <div
                    onClick={() => toggleCollapse(group.projectId)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setCtxMenu(null);
                      setGroupMenu({ projectId: group.projectId, x: e.clientX, y: e.clientY });
                    }}
                    className="flex items-center px-2 py-1 cursor-pointer text-[10px] shrink-0 select-none"
                  >
```

Przycisk „+" (tylko w oknie wydzielonym) — wstaw wewnątrz `scrollRef`-owego `div`-a, na końcu, po bloku `{showGroups ? … : …}`:

```tsx
          {detachedProjectId != null && (
            <div className="flex items-end shrink-0 ml-1 gap-0.5">
              <button
                onClick={() => openNewSessionTab(detachedProjectId)}
                title="Nowa sesja"
                className="px-2 py-1 text-[11px] text-muted hover:text-fg"
              >+</button>
              <button
                onClick={() => openNewTerminalTab(detachedProjectId)}
                title="Nowy terminal"
                className="px-2 py-1 text-[11px] text-muted hover:text-fg"
              >$</button>
            </div>
          )}
```

Menu kontekstowe zakładki — dodaj nowe propsy (`canDetachGroup` wyłączone w oknie wydzielonym):

```tsx
            <TabContextMenu
              canDetach={ctxMenu.tab.kind === 'session' && detachedProjectId == null}
              canDetachGroup={detachedProjectId == null}
              onDetach={() => {
                if (ctxMenu.tab.kind === 'session') void detachSessionTab(ctxMenu.tab, closeTab);
              }}
              onDetachGroup={() => detachWithGuard(ctxMenu.tab.projectId)}
              onRename={() => setEditingId(ctxMenu.tab.id)}
              onClose={() => closeWithGuard(ctxMenu.tab.id)}
              onCloseMenu={() => setCtxMenu(null)}
            />
```

Menu grupy i dialog — dopisz obok istniejącego `{pendingClose && …}`:

```tsx
      {groupMenu && (
        <div ref={ctxMenuRef} className="fixed z-50" style={{ left: groupMenu.x, top: groupMenu.y }}>
          <div className="w-52 rounded-md border border-border bg-bg shadow-lg">
            <GroupContextMenu
              onDetach={() => detachWithGuard(groupMenu.projectId)}
              onCloseMenu={() => setGroupMenu(null)}
            />
          </div>
        </div>
      )}
      {pendingDetach && (
        <ConfirmDialog
          title="Wydzielić grupę do nowego okna?"
          message={pendingDetach.message}
          confirmLabel="Wydziel"
          onCancel={() => setPendingDetach(null)}
          onConfirm={() => { runDetach(pendingDetach.projectId); setPendingDetach(null); }}
        />
      )}
```

- [ ] **Step 6: Run tests**

Run: `cd DesktopApp && npx vitest run src/components/center && npm run lint`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add DesktopApp/src/components/center
git commit -m "feat(desktop): menu kontekstowe grupy zakładek z wydzieleniem do okna"
```

---

### Task 8: `DetachedShell` — okno grupy

**Files:**
- Create: `DesktopApp/src/components/layout/DetachedShell.tsx` (z `git mv` po `DetachedSessionShell.tsx`)
- Delete: `DesktopApp/src/components/layout/DetachedSessionShell.tsx`
- Create: `DesktopApp/src/components/layout/DetachedShell.test.tsx`
- Modify: `DesktopApp/src/App.tsx`

**Interfaces:**
- Consumes: `parseWindowMode` (Task 1), `TabBar` z `detachedProjectId` (Task 7), `tauri.emitDetachReady` (Task 4), `processManager.dismiss`.
- Produces: `DetachedShell` — komponent renderowany w obu trybach okna odczepionego.

Trzy zmiany merytoryczne względem `DetachedSessionShell`:
1. w trybie `group` renderuje `TabBar` (z `detachedProjectId`),
2. strażnik zamknięcia sprawdza **wszystkie** zakładki, nie tylko aktywną, i zamyka je wszystkie (obecny kod sprawdza tylko aktywną — przy wielu zakładkach zostawia żywe PTY),
3. po mountcie emituje `abeon:detach-ready` (tryb `group`), co zwalnia akcje w oknie źródłowym.

- [ ] **Step 1: Write the failing test** — nowy plik `src/components/layout/DetachedShell.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';

const onCloseRequested = vi.fn();
const destroy = vi.fn();
vi.mock('@tauri-apps/api/webviewWindow', () => ({
  getCurrentWebviewWindow: () => ({ onCloseRequested, destroy, label: 'project-1' }),
}));
vi.mock('../center/TabContent', () => ({ TabContent: () => <div /> }));
vi.mock('../center/TabBar', () => ({ TabBar: () => <div data-testid="tabbar" /> }));
vi.mock('../right/RightPanel', () => ({ RightPanel: () => <div /> }));
vi.mock('./TitleBar', () => ({ TitleBar: () => <div /> }));
vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });

import { useStore } from '../../store';
import { tauri } from '../../lib/tauri';
import { DetachedShell } from './DetachedShell';

describe('DetachedShell close guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    onCloseRequested.mockResolvedValue(() => {});
    vi.spyOn(tauri, 'emitDetachReady').mockResolvedValue(undefined);
    vi.spyOn(tauri, 'setWindowTitle').mockResolvedValue(undefined);
    useStore.setState({
      tabs: [
        { kind: 'session', id: 'session:s1', projectId: 1, sessionId: 's1', title: 'S1', mode: 'history' },
        { kind: 'terminal', id: 'terminal:t1', projectId: 1, title: 'Terminal' },
      ],
      activeTabId: 'session:s1',
      runningActions: {},
      projects: [{ id: 1, name: 'Alfa', path: '/a' }] as never,
    });
  });

  it('blocks the close when a non-active tab still holds a live process', () => {
    render(<DetachedShell mode={{ view: 'group', projectId: 1, tabs: [], activeTabId: 'session:s1' }} />);
    const handler = onCloseRequested.mock.calls[0][0];
    const event = { preventDefault: vi.fn() };
    handler(event);
    expect(event.preventDefault).toHaveBeenCalled();
  });

  it('reports readiness so the source window can release its actions', () => {
    render(<DetachedShell mode={{ view: 'group', projectId: 1, tabs: [], activeTabId: null }} />);
    expect(tauri.emitDetachReady).toHaveBeenCalledWith('project-1');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd DesktopApp && npx vitest run src/components/layout/DetachedShell.test.tsx`
Expected: FAIL — brak modułu `./DetachedShell`.

- [ ] **Step 3: Przenieś plik i zaimplementuj**

```bash
cd DesktopApp && git mv src/components/layout/DetachedSessionShell.tsx src/components/layout/DetachedShell.tsx
```

Treść `src/components/layout/DetachedShell.tsx`:

```tsx
import { useCallback, useEffect, useState } from 'react';
import { flushSync } from 'react-dom';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { TitleBar } from './TitleBar';
import { TabBar } from '../center/TabBar';
import { TabContent } from '../center/TabContent';
import { RightPanel } from '../right/RightPanel';
import { DragHandle, clamp } from './DragHandle';
import { ConfirmDialog } from '../dialogs/ConfirmDialog';
import { useStore } from '../../store';
import { tauri } from '../../lib/tauri';
import { processManager } from '../../lib/processManager';
import { formatWindowTitle } from '../../lib/windowTitle';
import { isTabLiveProcess } from '../../lib/tabProcess';
import type { WindowMode } from '../../lib/windowMode';

const RIGHT_MIN = 220;
const RIGHT_MAX = 480;

export function DetachedShell({ mode }: { mode: WindowMode }) {
  const isGroup = mode.view === 'group';
  const rightWidth = useStore(s => s.rightWidth);
  const setRightWidth = useStore(s => s.setRightWidth);
  const loadProjects = useStore(s => s.loadProjects);

  const activeTabTitle = useStore(s => s.tabs.find(t => t.id === s.activeTabId)?.title ?? null);
  const activeProjectName = useStore(s => {
    const tab = s.tabs.find(t => t.id === s.activeTabId);
    return tab ? (s.projects.find(p => p.id === tab.projectId)?.name ?? null) : null;
  });

  const [confirming, setConfirming] = useState(false);

  useEffect(() => { void loadProjects(); }, [loadProjects]);

  useEffect(() => {
    void tauri.setWindowTitle(formatWindowTitle(activeTabTitle, activeProjectName));
  }, [activeTabTitle, activeProjectName]);

  // The source window keeps the action tabs until we confirm the PTYs were
  // adopted here (store boot subscribes to them), so nothing is lost in between.
  useEffect(() => {
    if (!isGroup) return;
    void tauri.emitDetachReady(getCurrentWebviewWindow().label);
  }, [isGroup]);

  // Closing the window ends every session in it. Prompt when any PTY is live; the
  // confirm path unmounts TabContent (flushSync) so TerminalView's cleanup
  // kills the PTYs before the window closes — otherwise the processes orphan.
  useEffect(() => {
    const win = getCurrentWebviewWindow();
    let unlisten: (() => void) | null = null;
    win.onCloseRequested((event) => {
      const state = useStore.getState();
      if (state.tabs.some(t => isTabLiveProcess(t, state.runningActions))) {
        event.preventDefault();
        setConfirming(true);
      }
    }).then(fn => { unlisten = fn; });
    return () => { if (unlisten) unlisten(); };
  }, []);

  const onRightDrag = useCallback(
    (delta: number) => setRightWidth(clamp(rightWidth - delta, RIGHT_MIN, RIGHT_MAX)),
    [rightWidth, setRightWidth],
  );

  const confirmClose = () => {
    const state = useStore.getState();
    for (const tab of state.tabs) {
      if (tab.kind === 'action') processManager.dismiss(tab.actionId);
    }
    flushSync(() => state.detachTabs(state.tabs.map(t => t.id)));
    // destroy(), not close(): the user already confirmed. close() re-emits
    // close-requested into this same guard, which can leave the window stuck
    // open on Linux/wry. destroy() force-closes after the PTYs are killed above.
    void getCurrentWebviewWindow().destroy();
  };

  return (
    <div className="flex flex-col h-full w-full overflow-hidden bg-bg">
      <TitleBar />
      <div className="flex flex-1 min-h-0">
        <main className="flex-1 h-full min-w-0 bg-bg flex flex-col">
          {mode.view === 'group' && <TabBar detachedProjectId={mode.projectId} />}
          <TabContent />
        </main>
        <DragHandle onDrag={onRightDrag} ariaLabel="Resize right panel" />
        <div style={{ width: rightWidth }} className="h-full flex-shrink-0">
          <RightPanel />
        </div>
      </div>
      {confirming && (
        <ConfirmDialog
          title={isGroup ? 'Zamknąć okno projektu?' : 'Zamknąć sesję?'}
          message="Zamknięcie okna zakończy działające w nim procesy."
          onCancel={() => setConfirming(false)}
          onConfirm={confirmClose}
        />
      )}
    </div>
  );
}
```

`detachTabs` (a nie `closeTab`) w `confirmClose`: akcje zabija tu jawnie `processManager.dismiss`, a `detachTabs` usuwa wszystkie zakładki jednym `set`, co odmontowuje `TabContent` i zabija PTY sesji/shella.

- [ ] **Step 4: Podłącz w `App.tsx`**

```tsx
import { useEffect } from 'react';
import { Toaster } from 'sonner';
import { ThemeProvider } from './components/layout/ThemeProvider';
import { AppShell } from './components/layout/AppShell';
import { DetachedShell } from './components/layout/DetachedShell';
import { ErrorBoundary } from './components/layout/ErrorBoundary';
import { SettingsDialog } from './components/dialogs/SettingsDialog';
import { useStore } from './store';
import { installMiddleClickPasteGuard } from './lib/middleClickPasteGuard';
import { parseWindowMode } from './lib/windowMode';

const windowMode = parseWindowMode(window.location.search);

export default function App() {
  const settingsOpen = useStore(s => s.settingsOpen);

  useEffect(() => installMiddleClickPasteGuard(), []);

  return (
    <ThemeProvider>
      <ErrorBoundary>
        {windowMode ? <DetachedShell mode={windowMode} /> : <AppShell />}
      </ErrorBoundary>
      {!windowMode && settingsOpen && <SettingsDialog />}
      <ErrorBoundary>
        <Toaster
          richColors
          position="bottom-right"
          toastOptions={{
            style: { borderRadius: 0, fontFamily: "'Geist', sans-serif" },
          }}
        />
      </ErrorBoundary>
    </ThemeProvider>
  );
}
```

- [ ] **Step 5: Run the full suite**

Run: `cd DesktopApp && npm test && npm run lint`
Expected: wszystko PASS, zero błędów TS.

- [ ] **Step 6: Commit**

```bash
git add DesktopApp/src/components/layout DesktopApp/src/App.tsx
git commit -m "feat(desktop): okno wydzielonej grupy z paskiem zakładek i strażnikiem zamknięcia"
```

---

### Task 9: Dokumentacja

**Files:**
- Modify: `DesktopApp/CLAUDE.md` (sekcja „Tabs system")

- [ ] **Step 1: Dopisz do `DesktopApp/CLAUDE.md`** poniżej sekcji „Tabs system":

```markdown
## Detached windows

Two window modes beyond the main shell, both routed by `lib/windowMode.ts` (`?view=…`
in the webview URL) and rendered by `layout/DetachedShell.tsx`:

- `session` — one session tab (`lib/detachSession.ts`, label `session-<id>`).
- `group` — every tab of one project (`lib/detachGroup.ts`, label `project-<id>`), payload
  is base64 JSON in the query string.

Detached windows never persist settings or tabs (`store/index.ts` bails out of `subscribe`
when `windowMode` is set), so they do not come back after an app restart.

Handoff of a project group is two-phase, because session PTYs must die before the new window
respawns them, while action PTYs must survive:
1. main window removes session/terminal/picker tabs on `tauri://created` → `TerminalView`
   cleanup kills their PTYs;
2. the new window adopts running action PTYs by id (`processManager.adopt`, Rust broadcasts
   `pty:*` events to every webview) and emits `abeon:detach-ready`;
3. main window then calls `processManager.release` (unsubscribe, **no** `ptyKill`) and drops
   the action tabs.
```

- [ ] **Step 2: Commit**

```bash
git add DesktopApp/CLAUDE.md
git commit -m "docs(desktop): opis okien wydzielonych i przekazania grupy"
```

---

## Weryfikacja końcowa

- [ ] `cd DesktopApp && npm test && npm run lint` — zielone.
- [ ] `npm run tauri dev` — QA na żywo:
  - prawy klik na nagłówku grupy → „Wydziel do nowego okna" (przy ≥2 projektach),
  - prawy klik na zakładce → „Wydziel projekt do nowego okna" (działa też przy 1 projekcie),
  - w grupie z działającym `npm run dev`: proces **nie ginie**, nowe logi lecą w nowym oknie,
  - sesja w trybie historii nie odpala CLI po przeniesieniu,
  - ponowne wydzielenie tego samego projektu → focus istniejącego okna, nie drugie okno,
  - zamknięcie okna grupy z żywym procesem → dialog potwierdzenia, po potwierdzeniu brak sierot
    (`ps aux | grep claude`).
