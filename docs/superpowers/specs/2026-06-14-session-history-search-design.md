# Session history search — design

Date: 2026-06-14
Scope: DesktopApp
Status: Approved

## Goal

Add in-session content search to the open session history view (`HistoryView`):
a find bar that searches the conversation blocks of the currently open session,
counts matches, and lets the user jump between them — the equivalent of "Ctrl+F
inside this conversation".

This is distinct from the existing sidebar search (`Sidebar.tsx`, `Ctrl/Cmd+K`),
which filters projects and session *titles*. The new search operates on session
*content*.

## Constraints that drive the design

1. **Virtualization** — `HistoryStream` renders blocks through `react-virtuoso`,
   so off-screen blocks are not in the DOM. Native browser find cannot reach
   them. Matches must be computed from the in-memory block array, and navigation
   must go through a Virtuoso ref (`scrollToIndex`).
2. **Markdown rendering** — user and assistant text render through `Markdown.tsx`.
   Exact in-place substring highlighting would require a rehype plugin and is
   invasive/fragile. Therefore highlighting is at **block granularity**.
3. **Tabs stay mounted** — `TabContent` keeps every tab mounted and toggles
   visibility. The global `Ctrl/Cmd+F` listener must guard on
   `tabId === activeTabId` so only the visible session tab responds.

## Architecture

`HistoryView` becomes the owner of search state. Today the `viewMode` filtering
lives inside `HistoryStream`; it is **lifted up to `HistoryView`** so the same
`filtered` array feeds both the search hook and the stream. This guarantees match
indices align with the `data` array passed to Virtuoso.

```
HistoryView  (state: searchOpen, query, filtered[])
 ├─ useHistorySearch(filtered, query) → { matches: number[], activeIndex, next(), prev(), count }
 ├─ HistorySearchBar   (input + counter "3/12" + prev/next + close)   ← conditional, above the stream
 └─ HistoryStream      (receives virtuosoRef, matchedIndices, activeMatchIndex; renders given blocks)
```

## Components / files

| File | Change |
|---|---|
| `components/history/HistorySearchBar.tsx` | **new** — bar: text input, result counter, prev/next buttons, close (✕). UI text in Polish. |
| `lib/historySearch.ts` | **new** — `blockSearchText(block)`: returns searchable text for each of the 7 block kinds (`text` / `input_summary` / `raw_input` / `content` / `name` / `message`). |
| `components/history/useHistorySearch.ts` | **new** — hook: computes `matches` (indices into `filtered`), holds `activeIndex`, exposes cyclic `next/prev` and `count`. Resets when query or `filtered` changes. |
| `components/history/HistoryView.tsx` | search state; lifted `viewMode` filtering; `Ctrl/Cmd+F` listener (capture phase, guard `tabId === activeTabId`); `Esc` closes. |
| `components/history/HistoryStream.tsx` | accepts `virtuosoRef`, `matchedIndices: Set<number>`, `activeMatchIndex`; data = `filtered` from props (no longer filters itself); ring/background on a matched block, stronger ring on the active one. |
| `components/history/HistoryHeader.tsx` | magnifier icon (`IconBtn icon="search"`) toggling `searchOpen`. |

## Behavior (UX)

- **Open**: `Ctrl/Cmd+F` (active tab only) or the header magnifier → bar appears
  above the stream, input autofocused.
- **Search**: case-insensitive substring match. Typing updates the counter live;
  no results → "0 wyników".
- **Navigate**: `Enter` = next, `Shift+Enter` = previous, plus prev/next buttons.
  `scrollToIndex({ index, align: 'center', behavior: 'smooth' })`. The active
  match gets a stronger ring (`ring-accent`); other matches get a subtle
  background.
- **Close**: `Esc` or ✕ → clears the query and removes highlights.
- **Scope**: blocks already loaded into memory, within the current view mode.
  When `hasMoreBefore === true`, the bar shows a discreet note that older
  messages are not loaded (surface the limitation rather than silently skip).

## Match computation

`blockSearchText(block)` maps each `HistoryBlock` kind to its searchable text:

- `userText`, `assistantText`, `assistantThinking` → `text`
- `toolUse` → `name` + `input_summary` + `raw_input`
- `toolResult` → `content`
- `attachment` → `name`
- `system` → `message`

A block matches when its lowercased search text contains the lowercased query.
`matches` is the list of indices in `filtered` whose block matches. `activeIndex`
cycles within `matches`.

## Keyboard handling

Register on `document` in a `useEffect` with `{ capture: true }`, matching the
existing pattern for `Ctrl/Cmd+K` and `Ctrl/Cmd+W`, so it wins over xterm's
textarea. Guard the handler with `tabId === activeTabId`. `preventDefault()` +
`stopPropagation()` on match.

## Tests

- `lib/historySearch.test.ts` — `blockSearchText` for every block kind, plus
  case-insensitive matching.
- `components/history/useHistorySearch.test.ts` — match counting, cyclic
  next/prev, reset on query change.

## Out of scope (YAGNI)

- Regex search, whole-word matching.
- Exact substring highlight inside rendered markdown.
- Loading older (`hasMoreBefore`) blocks for search.
- Global cross-session search.
