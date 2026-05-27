# Tab Switcher (Ctrl+Tab) — Design

## Goal

Add a Ctrl+Tab tab switcher with a visual overlay listing all open tabs, so the
user can see where they are switching to. Tabs in the overlay are visually
grouped by project (section header + color), reusing the existing grouping
used by the TabBar.

## Interaction model

Most-recently-used (MRU) cycling with hold-release commit, plus mouse support
that works *while Ctrl is held* (so the fast keyboard flick is preserved).

**Open / cycle (while Ctrl held):**
- `Ctrl+Tab` — open the overlay if closed; otherwise advance the selection to
  the next tab in MRU order.
- `Ctrl+Shift+Tab` — move the selection backwards in MRU order.
- `ArrowDown` / `ArrowUp` (while open) — same as Tab / Shift+Tab.
- **Hover** a row — moves the highlight to that row.
- **Click** a row — switch to it and close immediately.
- `Escape` — cancel; close without switching.

**Commit:**
- **Release Ctrl** — switch to the highlighted tab and close (fast path).

**Selection start:** When the overlay opens, selection starts at MRU index `1`
(the previously-active tab), so a single `Ctrl+Tab` + release jumps to the
last-used tab — classic Alt+Tab behavior.

**Cycling uses a frozen snapshot:** The overlay snapshots the MRU-ordered tab
list when it opens and only writes back (`setActive`) on commit. This prevents
the cycle order from shifting mid-cycle.

**Ordering vs grouping:** Cycle order is pure MRU. Grouping by project is
purely visual (section headers + colors). The highlight may jump between
project sections as it follows recency order — this is expected.

## Edge cases

- `0` or `1` tabs → the overlay is a no-op (renders nothing, Ctrl+Tab ignored).
- Ctrl is the literal modifier on **both** platforms (macOS included), unlike
  the registry's `mod` shortcuts which map to Cmd on macOS. Cmd+Tab is reserved
  by macOS for OS app switching; browsers/editors use Ctrl+Tab on macOS too.
- Closing the active tab is unrelated to this feature and keeps the existing
  `closeTab` fallback logic.

## Architecture

### 1. `src/store/tabsSlice.ts` — MRU order (Approach A)

Add `mruOrder: string[]` to `TabsSlice` (index `0` = most recent).

- Maintained as the single source of truth for recency.
- `setActive(id)` — move `id` to the front of `mruOrder`.
- `openSessionTab` / `openNewSessionTab` / `openNewTerminalTab` /
  `upsertActionTab` — newly-opened/activated tab goes to the front.
  - `openSessionTab` on an existing tab (focus) also moves it to the front.
- `closeTab(id)` — remove `id` from `mruOrder`.

A small helper keeps the array clean:

```ts
const moveToFront = (order: string[], id: string) =>
  [id, ...order.filter(x => x !== id)];
```

`mruOrder` is **not** persisted (not added to `PERSISTED_KEYS`) — it is
ephemeral session state, like `tabs` and `activeTabId` themselves.

### 2. `src/components/center/TabSwitcher.tsx` — overlay (new)

Mounted once in `AppShell` (app-global, works regardless of which tab/terminal
has focus).

State (local):
- `open: boolean`
- `snapshot: Tab[]` — MRU-ordered tabs captured on open
- `index: number` — current selection within `snapshot`

Document listeners registered in `useEffect` on **capture phase**
(`{ capture: true }`) so they win over xterm's textarea — the pattern mandated
in CLAUDE.md for global shortcuts that may conflict with xterm:

- `keydown`:
  - `e.ctrlKey && e.key === 'Tab'`: `preventDefault()` + `stopPropagation()`.
    - If `tabs.length <= 1`: ignore.
    - If not open: snapshot `tabs` ordered by `mruOrder`, set `index` to `1`
      (clamped), `open = true`.
    - If open: advance `index` (`+1`, or `-1` when `e.shiftKey`), wrapping
      modulo `snapshot.length`.
  - While open: `ArrowDown` → advance `+1`; `ArrowUp` → `-1`; `Escape` →
    cancel (close, no switch). `preventDefault` for these.
- `keyup`:
  - `e.key === 'Control'` while open → commit: `setActive(snapshot[index].id)`,
    close.

Rendering (when `open`):
- A centered overlay (fixed, dim backdrop) above the app.
- The snapshot grouped via `groupTabsByProject(snapshot, projects)`; section
  header colored with `getGroupColor(groupIndex)` — identical to TabBar.
- Each row shows the tab icon (same `TabIcon` logic), title, and is highlighted
  when it is the currently-selected tab (matched by tab `id`, not position).
- Row `onMouseEnter` → set `index` to that row's position in `snapshot`.
- Row `onMouseDown` → `setActive(tab.id)`, close immediately.
- Returns `null` when not open or `tabs.length <= 1`.

UI text in Polish per project convention (e.g. header label "Przełącz
zakładkę").

### 3. `src/lib/shortcuts.ts` — discoverability

Add an entry to `FIXED_SHORTCUTS` (non-rebindable documentation list, shown in
Settings) — the hold-release interaction does not fit the single-keydown
`matchesShortcut` model, so it is not added to the rebindable `SHORTCUTS`:

```ts
{ label: 'Przełącz zakładki', description: 'Cyklicznie po ostatnio używanych (Shift = wstecz)', binding: 'Ctrl+Tab' }
```

`formatBinding` already renders a literal `Ctrl` token as-is, so no parser
changes are required for display.

## Data flow

```
Ctrl+Tab (keydown, capture)
  └─> TabSwitcher: snapshot mruOrder→tabs, index=1, open
        repeated Ctrl+Tab / Shift+Tab / arrows / hover → move index (local only)
        click row → setActive(id) + close
  release Ctrl (keyup)
  └─> setActive(snapshot[index].id) + close
        └─> tabsSlice.setActive → moveToFront(mruOrder, id) → store updated
```

The store's `mruOrder` only changes on real activation (`setActive` / open /
close). Cycling never touches it — it operates on the local snapshot.

## Testing

- **`tabsSlice` unit tests** (Vitest): `mruOrder` is updated correctly by
  `setActive`, the four open paths, and `closeTab`; `moveToFront` dedupes; an
  existing-session focus moves the tab to the front.
- **`TabSwitcher` behavior** is interaction-heavy (document key events); cover
  the pure selection math (snapshot ordering, index wrapping with/without
  shift, start-at-1 clamp for 2 tabs) via a small extracted helper if it keeps
  the component testable. Full DOM-event coverage is optional given the manual
  verification path.
- **Manual verification:** 0/1/2/many tabs across multiple projects; fast flick
  (Ctrl+Tab, release); multi-step cycle; reverse; hover; click; Escape; that
  xterm does not swallow Tab while a terminal is focused.

## Out of scope (YAGNI)

- Rebindable modifier for the switcher (hold-release is tied to Ctrl).
- Type-to-filter / search within the overlay.
- Persisting MRU order across app restarts.
- Cross-project cycle restriction (cycle is global MRU by design).
