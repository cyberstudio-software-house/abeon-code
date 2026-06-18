# Mouse Back/Forward Tab Navigation — Design

## Goal

Let the mouse back/forward buttons switch between tabs the way a browser's
back/forward buttons move through page history — back returns to the
previously-viewed tab, forward steps toward the most recently viewed one.
Switching is instant (no overlay). This complements the existing Ctrl+Tab
switcher rather than replacing it.

## Interaction model

Browser-style navigation history with a moving cursor — distinct from the
Ctrl+Tab switcher's pure MRU cycling.

- **Mouse button 3 (back)** — move the cursor one step back in the navigation
  history and activate that tab.
- **Mouse button 4 (forward)** — move the cursor one step forward and activate
  that tab.
- Switching is **instant**: no overlay, no commit step. The tab bar highlights
  the active tab as usual.

The history behaves exactly like a browser's:

```
History: A → B → C → D   (cursor on D)
  back    → C
  back    → B
  forward → C
  forward → D

Activating a new tab E while on B:
History becomes A → B → E   (the C/D forward branch is discarded)
```

## Two kinds of tab change

This distinction is the core of correctness:

- **User navigation** — clicking a tab in the TabBar, picking a session in the
  Sidebar, Ctrl+Tab commit, opening a session/action/terminal. This *pushes*
  onto the history: any forward branch past the cursor is truncated, the new id
  is appended, and the cursor moves to the end. If the activated tab already is
  the one at the cursor, it is a no-op (no duplicate entry).
- **History traversal** — the mouse back/forward buttons. This only moves
  `navIndex`; it never mutates `navHistory`. That is what makes smooth back/then/
  forward possible.

In both cases the landed tab is moved to the front of `mruOrder` (it becomes the
active tab, so Ctrl+Tab also sees it as current). `navHistory` and `mruOrder`
are independent structures that never interfere.

## Edge cases

- **Closing a tab** → its entries are removed from `navHistory` and `navIndex`
  is clamped so the cursor stays valid (`pruneNav`). The existing `closeTab`
  fallback for choosing the next active tab is preserved; that fallback
  activation is treated as a normal user navigation only if it changes the
  active tab.
- **At a history boundary** (cursor at the first or last entry) → the
  corresponding button is a no-op, like a greyed-out browser back/forward.
- **0 or 1 tabs** → both buttons are no-ops.
- **Duplicate consecutive activation** → pushing the id already at the cursor is
  a no-op, so rapid re-activation of the same tab does not bloat the history.

## Architecture

### 1. `src/lib/navHistory.ts` — pure history logic (new)

Mirrors the existing `src/lib/tabSwitcher.ts` pattern (pure, unit-tested
functions; the store and components stay thin). All functions are pure and
return new values — no mutation.

```ts
type NavState = { history: string[]; index: number };

// User navigation: truncate forward branch, append, move cursor to end.
// No-op (returns input) when id already sits at the cursor.
pushNav(state: NavState, id: string): NavState

// Traversal: returns the new cursor + target id, or null at the boundary.
stepBack(state: NavState): { index: number; targetId: string } | null
stepForward(state: NavState): { index: number; targetId: string } | null

// Remove all occurrences of a closed tab id, clamping the cursor.
pruneNav(state: NavState, removedId: string): NavState
```

### 2. `src/store/tabsSlice.ts` — navigation history state

Add to `TabsSlice`:

```ts
navHistory: string[];   // navigation path (tab ids)
navIndex: number;       // cursor position within navHistory
```

Wiring (a helper applies `pushNav` to the current slice state):

- `setActive(id)` — push (user navigation), then set `activeTabId` +
  `moveToFront(mruOrder, id)` as today.
- `openSessionTab` (both the focus-existing and the new-tab branches),
  `upsertActionTab`, and any other open path — push the activated id.
- `closeTab(id)` — apply `pruneNav` alongside the existing `tabs` / `mruOrder` /
  `activeTabId` updates.
- `goBack()` / `goForward()` (new actions) — call `stepBack` / `stepForward`;
  on a non-null result set `navIndex`, `activeTabId`, and
  `moveToFront(mruOrder, targetId)`. **They do not push.**

Like `mruOrder`, `navHistory` / `navIndex` are ephemeral session state and are
**not** added to `PERSISTED_KEYS`.

### 3. `src/hooks/useMouseNavigation.ts` — global listener (new)

A null-rendering hook called once from `AppShell` (app-global, independent of
which tab/terminal holds focus), mirroring how `TabSwitcher` attaches global
listeners.

```ts
const onMouseDown = (e: MouseEvent) => {
  if (e.button === 3) { e.preventDefault(); e.stopPropagation(); useStore.getState().goBack(); }
  else if (e.button === 4) { e.preventDefault(); e.stopPropagation(); useStore.getState().goForward(); }
};
document.addEventListener('mousedown', onMouseDown, { capture: true });
```

`mousedown` on the capture phase, matching the CLAUDE.md pattern for
global handlers that must win over xterm's textarea. `preventDefault` suppresses
any default WebView back/forward navigation. Button 3 = back, 4 = forward is the
standard WebView mapping.

### 4. `src/lib/shortcuts.ts` — discoverability

Add an entry to `FIXED_SHORTCUTS` (the non-rebindable documentation list shown
in Settings), Polish UI text per project convention:

```ts
{ label: 'Nawigacja zakładek', description: 'Przyciski myszy wstecz/następny — po historii oglądania', binding: 'mouse:back/forward' }
```

If `formatBinding` cannot render the `mouse:` token, fall back to a plain label
so the row still displays; no rebindable `SHORTCUTS` entry (mouse buttons do not
fit the keyboard `matchesShortcut` model).

## Data flow

```
mouse button 3/4 (mousedown, capture)
  └─> useMouseNavigation → goBack() / goForward()
        └─> tabsSlice: stepBack/stepForward(navHistory, navIndex)
              → set navIndex + activeTabId + moveToFront(mruOrder, targetId)
              (navHistory unchanged)

click tab / open session / Ctrl+Tab commit
  └─> setActive(id) / openSessionTab / upsertActionTab
        └─> pushNav(navHistory, navIndex, id)  → truncate forward branch + append
            + activeTabId + moveToFront(mruOrder, id)
```

## Testing

- **`navHistory.ts` unit tests** (Vitest): `pushNav` appends and truncates the
  forward branch; `pushNav` of the current id is a no-op; `stepBack`/`stepForward`
  return null at boundaries and the right target otherwise; `pruneNav` removes
  closed ids and clamps the cursor (including removing the cursor entry itself).
- **`tabsSlice` unit tests**: `goBack`/`goForward` move the cursor and set
  `activeTabId` without mutating `navHistory`; `setActive` and the open paths
  push; `closeTab` prunes.
- **Manual verification:** 0/1/2/many tabs across projects; back then forward
  walks the same path; activating a new tab mid-history discards the forward
  branch; closing the current/other tabs keeps navigation consistent; back/
  forward work while a terminal (xterm) is focused.

## Out of scope (YAGNI)

- An overlay/preview for mouse navigation (instant switch by design).
- Rebindable mouse buttons.
- Persisting navigation history across app restarts.
- Per-project history scoping (history is global, matching the Ctrl+Tab
  switcher).
- A timed MRU step-through model (rejected in favor of browser-style history).
