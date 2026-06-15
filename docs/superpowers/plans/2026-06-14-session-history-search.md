# Session History Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an in-session find bar to `HistoryView` that searches the conversation blocks of the currently open session, counts matches, and jumps between them.

**Architecture:** `HistoryView` owns search state. The `viewMode` filtering currently inside `HistoryStream` is lifted up to `HistoryView` so the same `filtered` array feeds both the search hook and the (virtualized) stream — match indices then align with Virtuoso's `data`. A pure helper computes searchable text per block kind; a hook computes match indices + cyclic navigation; a presentational bar renders the UI; the stream highlights matched/active blocks by index and scrolls via a `VirtuosoHandle` ref.

**Tech Stack:** React 19, TypeScript, Zustand, Tailwind 4, react-virtuoso, Vitest + @testing-library/react.

---

## File structure

| File | Responsibility |
|---|---|
| `src/lib/historySearch.ts` (new) | `blockSearchText(block)` — maps each of 7 `HistoryBlock` kinds to its searchable text. Pure, no React. |
| `src/lib/historySearch.test.ts` (new) | Unit tests for `blockSearchText`. |
| `src/components/history/useHistorySearch.ts` (new) | Hook: holds `query`, derives `matches` (indices into the passed-in blocks), `activeIndex`, `count`, cyclic `next/prev`, `reset`. |
| `src/components/history/useHistorySearch.test.ts` (new) | Unit tests for the hook. |
| `src/components/history/HistorySearchBar.tsx` (new) | Presentational find bar: input, counter, prev/next, close, "older not loaded" note. Polish UI. |
| `src/components/history/HistorySearchBar.test.tsx` (new) | Component tests for the bar. |
| `src/components/history/HistoryStream.tsx` (modify) | Stop filtering internally; accept `blocks` (already filtered), `matchedIndices`, `activeBlockIndex`, `virtuosoRef`; apply highlight classes; forward ref to `Virtuoso`. |
| `src/components/history/HistoryView.tsx` (modify) | Own search state; lift `viewMode` filtering; wire hook + bar + stream; `Ctrl/Cmd+F` (capture, guarded by `tabId === activeTabId`) and `Esc`; scroll effect. |
| `src/components/history/HistoryHeader.tsx` (modify) | Add magnifier `IconBtn` that toggles the search bar. |

---

## Task 1: `blockSearchText` helper

**Files:**
- Create: `src/lib/historySearch.ts`
- Test: `src/lib/historySearch.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest';
import { blockSearchText } from './historySearch';
import type { HistoryBlock } from '../types';

const base = { uuid: 'u', timestamp: 0 };

describe('blockSearchText', () => {
  it('returns text for userText, assistantText, assistantThinking', () => {
    expect(blockSearchText({ ...base, kind: 'userText', text: 'Hello user' })).toBe('Hello user');
    expect(blockSearchText({ ...base, kind: 'assistantText', text: 'Hi there' })).toBe('Hi there');
    expect(blockSearchText({ ...base, kind: 'assistantThinking', text: 'pondering' })).toBe('pondering');
  });

  it('combines name, input_summary and raw_input for toolUse', () => {
    const block: HistoryBlock = { ...base, kind: 'toolUse', name: 'Read', input_summary: 'file.ts', raw_input: { path: '/x/y' } };
    const text = blockSearchText(block);
    expect(text).toContain('Read');
    expect(text).toContain('file.ts');
    expect(text).toContain('/x/y');
  });

  it('handles string raw_input without double-quoting', () => {
    const block: HistoryBlock = { ...base, kind: 'toolUse', name: 'Bash', input_summary: 'ls', raw_input: 'ls -la' };
    expect(blockSearchText(block)).toContain('ls -la');
  });

  it('returns content for toolResult, name for attachment, message for system', () => {
    expect(blockSearchText({ ...base, kind: 'toolResult', content: 'output', is_error: false })).toBe('output');
    expect(blockSearchText({ ...base, kind: 'attachment', attachmentKind: 'image', name: 'pic.png' })).toBe('pic.png');
    expect(blockSearchText({ ...base, kind: 'system', subtype: 'info', message: 'system note' })).toBe('system note');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/historySearch.test.ts`
Expected: FAIL — cannot find module `./historySearch`.

- [ ] **Step 3: Write minimal implementation**

```typescript
import type { HistoryBlock } from '../types';

export function blockSearchText(block: HistoryBlock): string {
  switch (block.kind) {
    case 'userText':
    case 'assistantText':
    case 'assistantThinking':
      return block.text;
    case 'toolUse': {
      const raw = typeof block.raw_input === 'string'
        ? block.raw_input
        : JSON.stringify(block.raw_input ?? '');
      return `${block.name} ${block.input_summary} ${raw}`;
    }
    case 'toolResult':
      return block.content;
    case 'attachment':
      return block.name;
    case 'system':
      return block.message;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/historySearch.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/historySearch.ts src/lib/historySearch.test.ts
git commit -m "feat(desktop): add blockSearchText helper for session history search"
```

---

## Task 2: `useHistorySearch` hook

**Files:**
- Create: `src/components/history/useHistorySearch.ts`
- Test: `src/components/history/useHistorySearch.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useHistorySearch } from './useHistorySearch';
import type { HistoryBlock } from '../../types';

const base = { uuid: 'u', timestamp: 0 };
const blocks: HistoryBlock[] = [
  { ...base, uuid: '0', kind: 'userText', text: 'alpha beta' },
  { ...base, uuid: '1', kind: 'assistantText', text: 'gamma' },
  { ...base, uuid: '2', kind: 'assistantText', text: 'BETA again' },
];

describe('useHistorySearch', () => {
  it('starts empty', () => {
    const { result } = renderHook(() => useHistorySearch(blocks));
    expect(result.current.matches).toEqual([]);
    expect(result.current.count).toBe(0);
    expect(result.current.activeBlockIndex).toBe(-1);
  });

  it('matches case-insensitively and reports indices into the blocks array', () => {
    const { result } = renderHook(() => useHistorySearch(blocks));
    act(() => result.current.setQuery('beta'));
    expect(result.current.matches).toEqual([0, 2]);
    expect(result.current.count).toBe(2);
    expect(result.current.activeBlockIndex).toBe(0);
  });

  it('cycles forward and backward', () => {
    const { result } = renderHook(() => useHistorySearch(blocks));
    act(() => result.current.setQuery('beta'));
    act(() => result.current.next());
    expect(result.current.activeBlockIndex).toBe(2);
    act(() => result.current.next());
    expect(result.current.activeBlockIndex).toBe(0);
    act(() => result.current.prev());
    expect(result.current.activeBlockIndex).toBe(2);
  });

  it('resets active position when the query changes', () => {
    const { result } = renderHook(() => useHistorySearch(blocks));
    act(() => result.current.setQuery('beta'));
    act(() => result.current.next());
    expect(result.current.activeBlockIndex).toBe(2);
    act(() => result.current.setQuery('alpha'));
    expect(result.current.matches).toEqual([0]);
    expect(result.current.activeBlockIndex).toBe(0);
  });

  it('reset() clears the query and matches', () => {
    const { result } = renderHook(() => useHistorySearch(blocks));
    act(() => result.current.setQuery('beta'));
    act(() => result.current.reset());
    expect(result.current.query).toBe('');
    expect(result.current.matches).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/history/useHistorySearch.test.ts`
Expected: FAIL — cannot find module `./useHistorySearch`.

- [ ] **Step 3: Write minimal implementation**

```typescript
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { HistoryBlock } from '../../types';
import { blockSearchText } from '../../lib/historySearch';

export type HistorySearch = {
  query: string;
  setQuery: (q: string) => void;
  matches: number[];
  activeIndex: number;
  activeBlockIndex: number;
  count: number;
  next: () => void;
  prev: () => void;
  reset: () => void;
};

export function useHistorySearch(blocks: HistoryBlock[]): HistorySearch {
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const out: number[] = [];
    for (let i = 0; i < blocks.length; i++) {
      if (blockSearchText(blocks[i]).toLowerCase().includes(q)) out.push(i);
    }
    return out;
  }, [blocks, query]);

  useEffect(() => { setActiveIndex(0); }, [query]);

  const next = useCallback(() => {
    setActiveIndex(i => (matches.length === 0 ? 0 : (i + 1) % matches.length));
  }, [matches.length]);

  const prev = useCallback(() => {
    setActiveIndex(i => (matches.length === 0 ? 0 : (i - 1 + matches.length) % matches.length));
  }, [matches.length]);

  const reset = useCallback(() => { setQuery(''); setActiveIndex(0); }, []);

  const safeActive = matches.length === 0 ? -1 : Math.min(activeIndex, matches.length - 1);
  const activeBlockIndex = safeActive === -1 ? -1 : matches[safeActive];

  return {
    query, setQuery,
    matches,
    activeIndex: safeActive,
    activeBlockIndex,
    count: matches.length,
    next, prev, reset,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/history/useHistorySearch.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/components/history/useHistorySearch.ts src/components/history/useHistorySearch.test.ts
git commit -m "feat(desktop): add useHistorySearch hook for in-session matching"
```

---

## Task 3: `HistorySearchBar` component

**Files:**
- Create: `src/components/history/HistorySearchBar.tsx`
- Test: `src/components/history/HistorySearchBar.test.tsx`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { HistorySearchBar } from './HistorySearchBar';

function setup(overrides = {}) {
  const props = {
    query: '',
    onQueryChange: vi.fn(),
    count: 0,
    activeIndex: -1,
    onNext: vi.fn(),
    onPrev: vi.fn(),
    onClose: vi.fn(),
    hasOlderUnloaded: false,
    ...overrides,
  };
  render(<HistorySearchBar {...props} />);
  return props;
}

describe('HistorySearchBar', () => {
  it('shows "0 wyników" when there is a query but no matches', () => {
    setup({ query: 'zzz', count: 0 });
    expect(screen.getByText('0 wyników')).toBeTruthy();
  });

  it('shows the active position out of total', () => {
    setup({ query: 'beta', count: 3, activeIndex: 1 });
    expect(screen.getByText('2/3')).toBeTruthy();
  });

  it('calls onQueryChange when typing', () => {
    const props = setup();
    fireEvent.change(screen.getByPlaceholderText('Szukaj w sesji…'), { target: { value: 'x' } });
    expect(props.onQueryChange).toHaveBeenCalledWith('x');
  });

  it('Enter triggers next, Shift+Enter triggers prev, Escape closes', () => {
    const props = setup({ query: 'beta', count: 2 });
    const input = screen.getByPlaceholderText('Szukaj w sesji…');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(props.onNext).toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(props.onPrev).toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(props.onClose).toHaveBeenCalled();
  });

  it('shows a note when older messages are not loaded', () => {
    setup({ hasOlderUnloaded: true });
    expect(screen.getByText(/starsze wiadomości nie są wczytane/i)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/history/HistorySearchBar.test.tsx`
Expected: FAIL — cannot find module `./HistorySearchBar`.

- [ ] **Step 3: Write minimal implementation**

```tsx
import { useEffect, useRef } from 'react';
import { IconBtn } from '../shared/IconBtn';
import { Icon } from '../shared/Icon';

type Props = {
  query: string;
  onQueryChange: (q: string) => void;
  count: number;
  activeIndex: number;
  onNext: () => void;
  onPrev: () => void;
  onClose: () => void;
  hasOlderUnloaded: boolean;
};

export function HistorySearchBar({
  query, onQueryChange, count, activeIndex, onNext, onPrev, onClose, hasOlderUnloaded,
}: Props) {
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const counter = query.trim() === ''
    ? ''
    : count === 0
      ? '0 wyników'
      : `${activeIndex + 1}/${count}`;

  return (
    <div className="shrink-0 border-b border-border bg-bg-elev px-8 py-2 flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <div className="flex items-center gap-2 flex-1 bg-bg border border-border rounded-md px-2.5 py-[6px]">
          <Icon name="search" className="w-[13px] h-[13px] text-muted" />
          <input
            ref={inputRef}
            value={query}
            onChange={e => onQueryChange(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') { e.preventDefault(); e.shiftKey ? onPrev() : onNext(); }
              if (e.key === 'Escape') { e.preventDefault(); onClose(); }
            }}
            placeholder="Szukaj w sesji…"
            className="bg-transparent outline-none text-[12px] text-fg flex-1 placeholder:text-muted"
          />
          <span className="text-[11px] text-muted font-mono tabular-nums min-w-[3ch] text-right">{counter}</span>
        </div>
        <IconBtn icon="chevU" label="Poprzednie" tone="ghost" size="sm" onClick={onPrev} />
        <IconBtn icon="chevron" label="Następne" tone="ghost" size="sm" onClick={onNext} />
        <IconBtn icon="close" label="Zamknij" tone="ghost" size="sm" onClick={onClose} />
      </div>
      {hasOlderUnloaded && (
        <div className="text-[10px] text-muted font-mono">
          Uwaga: starsze wiadomości nie są wczytane i nie są przeszukiwane.
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/history/HistorySearchBar.test.tsx`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/components/history/HistorySearchBar.tsx src/components/history/HistorySearchBar.test.tsx
git commit -m "feat(desktop): add HistorySearchBar find UI"
```

---

## Task 4: Refactor `HistoryStream` to render given blocks with highlights

**Files:**
- Modify: `src/components/history/HistoryStream.tsx`

Note: this task removes internal `viewMode` filtering from `HistoryStream` — the
caller (Task 5) now passes already-filtered `blocks`. The `viewMode` prop and the
`COMMUNICATION_KINDS` constant move out of this file in Task 5.

- [ ] **Step 1: Replace the file contents**

```tsx
import { type ReactNode } from 'react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import type { RefObject } from 'react';
import type { HistoryBlock } from '../../types';
import { UserBubble } from './blocks/UserBubble';
import { AssistantBubble } from './blocks/AssistantBubble';
import { ThinkingBlock } from './blocks/ThinkingBlock';
import { ToolUseBlock } from './blocks/ToolUseBlock';
import { ToolResultBlock } from './blocks/ToolResultBlock';
import { AttachmentBlock } from './blocks/AttachmentBlock';
import { SystemBlock } from './blocks/SystemBlock';

type Props = {
  blocks: HistoryBlock[];
  onLoadMore?: () => void;
  hasMore: boolean;
  header?: ReactNode;
  matchedIndices?: Set<number>;
  activeBlockIndex?: number;
  virtuosoRef?: RefObject<VirtuosoHandle | null>;
};

function render(b: HistoryBlock) {
  switch (b.kind) {
    case 'userText':          return <UserBubble text={b.text} />;
    case 'assistantText':     return <AssistantBubble text={b.text} />;
    case 'assistantThinking': return <ThinkingBlock text={b.text} />;
    case 'toolUse':           return <ToolUseBlock name={b.name} inputSummary={b.input_summary} rawInput={b.raw_input} />;
    case 'toolResult':        return <ToolResultBlock content={b.content} isError={b.is_error} />;
    case 'attachment':        return <AttachmentBlock kind={b.attachmentKind} name={b.name} />;
    case 'system':            return <SystemBlock subtype={b.subtype} message={b.message} />;
  }
}

export function HistoryStream({
  blocks, onLoadMore, hasMore, header, matchedIndices, activeBlockIndex = -1, virtuosoRef,
}: Props) {
  return (
    <Virtuoso
      ref={virtuosoRef}
      data={blocks}
      initialTopMostItemIndex={blocks.length > 0 ? blocks.length - 1 : 0}
      itemContent={(index, b) => {
        const isActive = index === activeBlockIndex;
        const isMatch = matchedIndices?.has(index) ?? false;
        const highlight = isActive
          ? 'ring-2 ring-accent rounded-md'
          : isMatch
            ? 'bg-accent/10 rounded-md'
            : '';
        return <div className={`px-8 ${highlight}`}>{render(b)}</div>;
      }}
      startReached={() => { if (hasMore && onLoadMore) onLoadMore(); }}
      followOutput="auto"
      className="flex-1"
      components={header ? { Header: () => <>{header}</> } : undefined}
    />
  );
}
```

- [ ] **Step 2: Type-check (the consumer still passes the old `viewMode` prop until Task 5)**

Run: `npm run lint`
Expected: ERROR in `HistoryView.tsx` — `viewMode` no longer exists on `HistoryStream` props. This is expected and is fixed in Task 5. Do NOT commit yet.

- [ ] **Step 3: Proceed directly to Task 5 (no commit — the tree does not type-check between Task 4 and Task 5).**

---

## Task 5: Wire search into `HistoryView`

**Files:**
- Modify: `src/components/history/HistoryView.tsx`

- [ ] **Step 1: Replace the file contents**

```tsx
import { useEffect, useMemo, useRef, useState } from 'react';
import type { VirtuosoHandle } from 'react-virtuoso';
import { tauri } from '../../lib/tauri';
import { formatTauriError } from '../../lib/errors';
import { useStore } from '../../store';
import type { HistoryViewMode } from '../../store/settingsSlice';
import type { SessionHistory, HistoryBlock, Provider } from '../../types';
import { HistoryHeader } from './HistoryHeader';
import { HistoryStream } from './HistoryStream';
import { HistorySearchBar } from './HistorySearchBar';
import { useHistorySearch } from './useHistorySearch';
import { ReadOnlyPill } from './ReadOnlyPill';
import { SessionFooter } from './SessionFooter';

type Props = { projectId: number; sessionId: string; tabId: string; provider?: Provider };

const COMMUNICATION_KINDS = new Set<HistoryBlock['kind']>(['userText', 'assistantText']);

function blockUuid(b: HistoryBlock): string {
  return b.uuid;
}

export function HistoryView({ projectId, sessionId, tabId, provider = 'claude' }: Props) {
  const [data, setData] = useState<SessionHistory | null>(null);
  const [error, setError] = useState<string | null>(null);
  const patchActivity = useStore(s => s.patchActivity);
  const defaultViewMode = useStore(s => s.historyViewMode);
  const [viewMode, setViewMode] = useState<HistoryViewMode>(defaultViewMode);
  const activeTabId = useStore(s => s.activeTabId);

  const [searchOpen, setSearchOpen] = useState(false);
  const virtuosoRef = useRef<VirtuosoHandle | null>(null);

  useEffect(() => {
    tauri.readSessionHistory(projectId, sessionId, provider)
      .then(setData)
      .catch(e => setError(formatTauriError(e)));
  }, [projectId, sessionId, provider]);

  const renameTab = useStore(s => s.renameTab);

  useEffect(() => {
    let unlistenAppend: (() => void) | null = null;
    let unlistenActivity: (() => void) | null = null;
    let unlistenTitle: (() => void) | null = null;
    tauri.openSessionWatch(projectId, sessionId, provider).catch(() => {});
    tauri.onSessionAppend(sessionId, (blocks) => {
      setData(prev => prev ? ({ ...prev, blocks: [...prev.blocks, ...blocks] }) : prev);
    }).then(fn => { unlistenAppend = fn; });
    tauri.onSessionActivity(sessionId, (activity) => {
      patchActivity(sessionId, activity);
    }).then(fn => { unlistenActivity = fn; });
    tauri.onSessionTitle(sessionId, (title) => {
      renameTab(`session:${sessionId}`, title);
      setData(prev => prev ? ({ ...prev, meta: { ...prev.meta, title } }) : prev);
    }).then(fn => { unlistenTitle = fn; });
    return () => {
      if (unlistenAppend) unlistenAppend();
      if (unlistenActivity) unlistenActivity();
      if (unlistenTitle) unlistenTitle();
      tauri.closeSessionWatch(sessionId).catch(() => {});
    };
  }, [projectId, sessionId, provider, patchActivity, renameTab]);

  const loadMore = async () => {
    if (!data || !data.hasMoreBefore || data.blocks.length === 0) return;
    const firstUuid = blockUuid(data.blocks[0]);
    const more = await tauri.readSessionHistory(projectId, sessionId, provider, 200, firstUuid);
    setData({
      meta: more.meta,
      blocks: [...more.blocks, ...data.blocks],
      hasMoreBefore: more.hasMoreBefore,
    });
  };

  const storeTitle = useStore(s => {
    const items = s.sessionsByProject[projectId]?.items;
    return items?.find(i => i.id === sessionId)?.title;
  });

  const storeActivity = useStore(s => {
    const items = s.sessionsByProject[projectId]?.items;
    return items?.find(i => i.id === sessionId)?.activity;
  });

  const meta = useMemo(() => {
    if (!data) return null;
    const patched = { ...data.meta };
    if (storeTitle && storeTitle !== data.meta.title) patched.title = storeTitle;
    if (storeActivity && storeActivity !== data.meta.activity) patched.activity = storeActivity;
    return patched;
  }, [data, storeTitle, storeActivity]);

  const filtered = useMemo(() => {
    const blocks = data?.blocks ?? [];
    return viewMode === 'communication'
      ? blocks.filter(b => COMMUNICATION_KINDS.has(b.kind))
      : blocks;
  }, [data, viewMode]);

  const search = useHistorySearch(filtered);
  const matchedSet = useMemo(() => new Set(search.matches), [search.matches]);

  useEffect(() => {
    if (search.activeBlockIndex >= 0) {
      virtuosoRef.current?.scrollToIndex({ index: search.activeBlockIndex, align: 'center', behavior: 'smooth' });
    }
  }, [search.activeBlockIndex]);

  const closeSearch = () => { setSearchOpen(false); search.reset(); };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (tabId !== activeTabId) return;
      if ((e.metaKey || e.ctrlKey) && (e.key === 'f' || e.key === 'F')) {
        e.preventDefault();
        e.stopPropagation();
        setSearchOpen(true);
      }
    };
    document.addEventListener('keydown', onKey, { capture: true });
    return () => document.removeEventListener('keydown', onKey, { capture: true });
  }, [tabId, activeTabId]);

  if (error) return <div className="p-6 text-danger text-[13px]">Błąd: {error}</div>;
  if (!data || !meta) return <div className="p-6 text-muted text-[13px]">Wczytywanie historii…</div>;
  return (
    <div className="h-full flex flex-col">
      <HistoryHeader
        meta={meta}
        viewMode={viewMode}
        onViewModeChange={setViewMode}
        provider={provider}
        onToggleSearch={() => setSearchOpen(o => !o)}
      />
      {searchOpen && (
        <HistorySearchBar
          query={search.query}
          onQueryChange={search.setQuery}
          count={search.count}
          activeIndex={search.activeIndex}
          onNext={search.next}
          onPrev={search.prev}
          onClose={closeSearch}
          hasOlderUnloaded={data.hasMoreBefore}
        />
      )}
      <HistoryStream
        blocks={filtered}
        onLoadMore={loadMore}
        hasMore={data.hasMoreBefore}
        header={<div className="px-8 py-5"><ReadOnlyPill /></div>}
        matchedIndices={matchedSet}
        activeBlockIndex={search.activeBlockIndex}
        virtuosoRef={virtuosoRef}
      />
      <SessionFooter sessionId={sessionId} tabId={tabId} />
    </div>
  );
}
```

- [ ] **Step 2: Type-check (will still fail until `HistoryHeader` accepts `onToggleSearch` — fixed in Task 6)**

Run: `npm run lint`
Expected: ERROR in `HistoryView.tsx` — `onToggleSearch` not assignable to `HistoryHeader` props. Expected; fixed in Task 6. Do NOT commit yet.

- [ ] **Step 3: Proceed directly to Task 6.**

---

## Task 6: Add magnifier toggle to `HistoryHeader`

**Files:**
- Modify: `src/components/history/HistoryHeader.tsx`

- [ ] **Step 1: Add the prop to the `Props` type**

Find:

```tsx
type Props = {
  meta: SessionMeta;
  viewMode: HistoryViewMode;
  onViewModeChange: (mode: HistoryViewMode) => void;
  provider?: Provider;
};
```

Replace with:

```tsx
type Props = {
  meta: SessionMeta;
  viewMode: HistoryViewMode;
  onViewModeChange: (mode: HistoryViewMode) => void;
  provider?: Provider;
  onToggleSearch: () => void;
};
```

- [ ] **Step 2: Destructure the new prop**

Find:

```tsx
export function HistoryHeader({ meta, viewMode, onViewModeChange, provider = 'claude' }: Props) {
```

Replace with:

```tsx
export function HistoryHeader({ meta, viewMode, onViewModeChange, provider = 'claude', onToggleSearch }: Props) {
```

- [ ] **Step 3: Add the magnifier button into the action button group**

Find:

```tsx
          <div className="flex gap-1.5">
            <IconBtn
              icon="sparkles"
              label={generating ? 'Generuję tytuł…' : 'Generuj tytuł sesji'}
              onClick={handleGenerateTitle}
              loading={generating}
            />
```

Replace with:

```tsx
          <div className="flex gap-1.5">
            <IconBtn
              icon="search"
              label="Szukaj w sesji"
              onClick={onToggleSearch}
            />
            <IconBtn
              icon="sparkles"
              label={generating ? 'Generuję tytuł…' : 'Generuj tytuł sesji'}
              onClick={handleGenerateTitle}
              loading={generating}
            />
```

- [ ] **Step 4: Type-check the whole tree**

Run: `npm run lint`
Expected: PASS — zero errors.

- [ ] **Step 5: Run the full frontend test suite**

Run: `npm test`
Expected: PASS — all tests green, including the three new test files.

- [ ] **Step 6: Commit**

```bash
git add src/components/history/HistoryStream.tsx src/components/history/HistoryView.tsx src/components/history/HistoryHeader.tsx
git commit -m "feat(desktop): wire in-session history search into HistoryView"
```

---

## Manual verification

- [ ] `npm run tauri dev`, open a session with history.
- [ ] Press `Ctrl/Cmd+F` → bar appears, input focused. Type a term present in the conversation → counter shows `1/N`, view scrolls to the first match, the matched block shows an accent ring.
- [ ] `Enter` / `Shift+Enter` (and the chevron buttons) cycle through matches, scrolling each into view.
- [ ] A term with no matches shows `0 wyników`; a long session shows the "starsze wiadomości nie są wczytane" note when older blocks remain unloaded.
- [ ] `Esc` (and the ✕ button, and the header magnifier) close the bar and clear highlights.
- [ ] Open a second session tab; confirm `Ctrl/Cmd+F` only affects the visible tab.
- [ ] Toggle Komunikacja/Pełny while searching → matches recompute against the visible block set.
```
