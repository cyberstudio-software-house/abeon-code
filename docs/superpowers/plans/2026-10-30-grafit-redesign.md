# Grafit Redesign (version A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The whole desktop app adopts the Grafit look of version A: graphite tokens and bundled Geist fonts, an app header with the project row, pane cards with sessions-only bars, settings as a full in-window view with a new Terminal category, and restyled sidebar, right panel, drawer, history view, dialogs and detached windows.

**Architecture:** Colors move to an extended set of CSS custom properties (`globals.css` → `tailwind.config.ts`), so most components restyle by token. Layout changes stay inside the existing computed geometry (`lib/drawerGeometry.ts`, `lib/paneGeometry.ts`, `lib/paneLayers.ts`): pane cards are absolutely positioned frames drawn *over* the content layers, never wrappers of them. Settings become `components/settings/*` rendered over the still-mounted shell (`inert`), and terminal appearance becomes persisted settings that `TerminalView` applies live through `term.options`.

**Tech Stack:** React 19, Zustand 5, TypeScript 5.8, Tailwind 4, xterm.js 6, shiki 4, Vitest 4 + jsdom + Testing Library, `@fontsource/*` fonts. Frontend only, no Rust changes.

**Spec:** `docs/superpowers/specs/2026-10-30-grafit-redesign-design.md` (mockups: `docs/superpowers/specs/2026-10-30-grafit-redesign/*.dc.html`, `{{accent}}` = `#F0B44C`)

## Global Constraints

- Run everything from `DesktopApp/`: single file `npx vitest run <path>`, full suite `npx vitest run --maxWorkers=3` (plain `npm test` flakes under load), `npm run lint` (must stay at zero errors).
- Baseline before Task 1: 103 test files / 958 tests passing, lint clean.
- Identifiers in English; every user-facing string in Polish, copied exactly where this plan or the spec quotes it.
- No new code comments (the user's global rule). Existing comments you move stay as they are.
- Commits straight to the local `main` (no branch, no worktree), Conventional Commits with scope `desktop` (`feat(desktop): …`, `refactor(desktop): …`, `style(desktop): …`, `test(desktop): …`). No `Co-Authored-By` trailer, no `Claude-Session` line. No push.
- Never call `term.dispose()` in `TerminalView`.
- Content layers in `PaneLayout` never change DOM parent and keep their id-sorted order. New chrome (frames, bars) is a sibling element, never a wrapper.
- Zustand selectors that build arrays/objects use `useShallow`.
- The COSMIC title bar stays: do not touch `decorations`, add no window-control buttons. macOS keeps a 78 px left inset and a `data-tauri-drag-region` on the app header.
- The light theme must keep working (every new token gets a light value); nobody polishes it.
- Rule for mockup controls: a control drawn in a mockup with no feature behind it today is dropped; a control that exists today but is missing from a mockup is kept and restyled (spec, Non-goals).
- Visual values not restated in a task come from the spec's "Visual system" section and the mockup files; match them, do not invent new ones.
- No new Tauri commands, no `src-tauri/` changes, no new windows.

## Review Focus

- Keyboard focus is inside a live Claude terminal when the user opens settings: keystrokes must not reach the hidden terminal, and closing settings returns focus to it (Task 10 test `blocks the shell while open and restores focus on close`).
- A settings store from v0.1.34 or older holds `tabLayoutMode: 'classic'` in localStorage and SQLite: the app must boot, ignore the key and keep every other setting (Task 3 tests `ignores a stored tabLayoutMode …`).
- Two panes are open and the header project row is mounted: `Ctrl/Cmd+W` must close exactly one tab, or show exactly one confirm dialog (Task 5 test `closes exactly one tab on mod+w with the header row mounted`).
- A pasted custom palette is malformed (an array, `"red": "blue"`, `"#12"`, missing keys, invalid JSON): an inline Polish error appears, the stored palette and every terminal stay unchanged (Task 7 parser tests, Task 13 test `rejects malformed palette JSON without touching the store`).
- The font size is pushed past 20 px or the family is changed while a drawer has two splits: the value clamps to 10–20 and every open terminal refits and resizes its PTY (Task 7 test `clamps the font size`, Task 8 test `applies appearance changes to an open terminal and refits`).

---

### Task 1: Grafit tokens, pulse utility and bundled fonts

**Files:**
- Modify: `src/styles/globals.css`, `tailwind.config.ts`, `index.html`, `src/main.tsx`, `src/App.tsx` (Toaster font), `package.json`, `package-lock.json`
- Test: `src/styles/tokens.test.ts` (create)

**Interfaces:**
- Produces: Tailwind color names used by every later task: existing `bg`, `bg-elev`, `bg-elev-2`, `fg`, `fg-secondary`, `muted`, `border`, `accent`, `accent-fg`, `danger`, `success`, `warn`, plus new `fg-strong`, `icon`, `label`, `faint`, `console`, `sunken`, `field`, `raised-strong`, `pressed`, `button`, `track`, `border-subtle`, `border-strong`, `border-raised`, `border-focus`, `rule`, `info`, `pink`, `teal`, `accent-hover`. CSS class `.activity-pulse`. Tailwind `font-sans` = Geist, `font-mono` = Geist Mono. Constants for later tasks: the exact font-family names declared by the installed packages (record them in this task's commit message body for Task 7).

Token values (`--color-<name>`):

| name | dark (`:root[data-theme="dark"]`) | light (`:root`) |
|------|------|------|
| bg | `#0b0c0e` | `#faf8f5` (unchanged) |
| bg-elev | `#111215` | `#ffffff` |
| bg-elev-2 | `#17181b` | `#f2f0ed` |
| fg | `#e6e7e9` | `#1a1a1a` |
| fg-secondary | `#c4c6cb` | `#52504a` |
| muted | `#8e939b` | `#94918a` |
| border | `#1d1f23` | `#e8e6e1` |
| accent | `#f0b44c` | `#b78640` |
| accent-fg | `#1b1405` | `#ffffff` |
| danger | `#e5737a` | `#c14a3d` |
| success | `#7fcb9b` | `#4a9d5b` |
| warn | `#f6cb7d` | `#f4be4f` |
| fg-strong | `#f2f3f4` | `#111111` |
| icon | `#9da1a9` | `#6b6860` |
| label | `#858a93` | `#94918a` |
| faint | `#4a4d53` | `#c9c6bf` |
| console | `#0f1012` | `#ffffff` |
| sunken | `#0d0e10` | `#f5f3f0` |
| field | `#16171a` | `#ffffff` |
| raised-strong | `#1a1b1f` | `#ebe8e3` |
| pressed | `#26282d` | `#e2dfd9` |
| button | `#1c1d21` | `#f2f0ed` |
| track | `#1e2024` | `#e8e6e1` |
| border-subtle | `#1b1d20` | `#efede8` |
| border-strong | `#2a2c31` | `#d6d3cc` |
| border-raised | `#26282c` | `#e0ddd6` |
| border-focus | `#2e3136` | `#c9c6bf` |
| rule | `#34373c` | `#d6d3cc` |
| info | `#8fb3f9` | `#4a7dc2` |
| pink | `#e58fb4` | `#b75fa0` |
| teal | `#5fd3b4` | `#3fa882` |
| accent-hover | `#f6cb7d` | `#a0742f` |

- [ ] **Step 1: Write the failing test** `src/styles/tokens.test.ts`

```ts
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import css from './globals.css?raw';

const darkBlock = css.slice(css.indexOf(':root[data-theme="dark"]'));

it.each([
  ['bg', '#0b0c0e'], ['bg-elev', '#111215'], ['console', '#0f1012'], ['accent', '#f0b44c'],
  ['accent-fg', '#1b1405'], ['info', '#8fb3f9'], ['pink', '#e58fb4'], ['border-focus', '#2e3136'],
])('defines the dark %s token', (name, value) => {
  expect(darkBlock).toContain(`--color-${name}: ${value};`);
});

it('loads no fonts from the network', () => {
  const html = readFileSync(resolve(__dirname, '../../index.html'), 'utf8');
  expect(html).not.toContain('fonts.googleapis.com');
});

it('defines the 1.6 s activity pulse', () => {
  expect(css).toMatch(/\.activity-pulse\s*\{[^}]*1\.6s/);
});
```

- [ ] **Step 2: Run** `npx vitest run src/styles/tokens.test.ts` — Expected: FAIL (old values, Google Fonts link present).

- [ ] **Step 3: Implement.** Write both token blocks from the table; register every new token in `tailwind.config.ts` `theme.extend.colors` as `'<name>': 'var(--color-<name>)'`. Add `@keyframes activity-pulse` (opacity 1 → .35 → 1) and `.activity-pulse { animation: activity-pulse 1.6s ease-in-out infinite; }` in `@layer utilities`; add a global `:focus-visible { outline: 2px solid var(--color-accent); outline-offset: 2px; }`; body `font-size: 13px; line-height: 1.45`; scrollbar thumb uses `--color-border-strong`. `npm i @fontsource/geist-sans @fontsource/geist-mono @fontsource/jetbrains-mono @fontsource/ibm-plex-mono`; import in `src/main.tsx`: geist-sans 400/500/600, geist-mono 400/500, jetbrains-mono 400/500, ibm-plex-mono 400/500. Read the declared `font-family` names from the package CSS (`grep -h font-family node_modules/@fontsource/{geist-sans,geist-mono,jetbrains-mono,ibm-plex-mono}/400.css`) and use them exactly in `fontFamily.sans` / `fontFamily.mono` (fallbacks `ui-sans-serif, system-ui, sans-serif` / `ui-monospace, monospace`) and in the Toaster style in `App.tsx`. Remove the Google Fonts `<link>`s and the `display`/`serif` families.

- [ ] **Step 4: Run** `npx vitest run src/styles/tokens.test.ts` and `npm run lint` — Expected: PASS, 0 errors. Then `npm run build` — Expected: success, `ls dist/assets | grep woff2` lists the font files.

- [ ] **Step 5: Commit** `style(desktop): add Grafit design tokens and bundle Geist fonts` (body: the four font-family names found in Step 3).

---

### Task 2: Activity colors follow the design

**Files:**
- Modify: `src/lib/activity.ts`, `src/components/center/TabItem.tsx`, `src/components/sidebar/SessionItem.tsx`, `src/components/sidebar/ActiveSessionsPanel.tsx`, `src/components/history/HistoryHeader.tsx`
- Test: `src/lib/activity.test.ts` (create), `src/components/sidebar/SessionItem.test.tsx`

**Interfaces:**
- Consumes: Task 1 tokens `info`, `pink`, `.activity-pulse`.
- Produces: `ACTIVITY_DOT`, `ACTIVITY_TEXT` (new values), `ACTIVITY_SHORT_LABEL: Record<SessionActivity, string>`, `activityPulses(activity: SessionActivity): boolean`.

- [ ] **Step 1: Write the failing tests**

```ts
// src/lib/activity.test.ts
expect(ACTIVITY_DOT).toEqual({ running: 'bg-accent', waitingUser: 'bg-info', waitingTool: 'bg-pink', idle: 'bg-muted' });
expect(ACTIVITY_TEXT).toEqual({ running: 'text-accent', waitingUser: 'text-info', waitingTool: 'text-pink', idle: 'text-muted' });
expect(ACTIVITY_SHORT_LABEL).toEqual({ running: 'Pracuje', waitingUser: 'Czeka na Ciebie', waitingTool: 'Czeka na zgodę', idle: 'Bezczynna' });
expect(activityPulses('running')).toBe(true);
expect(activityPulses('waitingUser')).toBe(false);
```

In `SessionItem.test.tsx` add `marks a session waiting for the user in info blue`: render a session with attention / `waitingUser`, expect its marker element to have class `bg-info` and no `bg-accent`.

- [ ] **Step 2: Run** both files — Expected: FAIL.
- [ ] **Step 3: Implement** the new maps in `lib/activity.ts` (long `ACTIVITY_LABEL` texts unchanged, used as tooltips). In the four components replace every attention marker that uses `accent` (badges, bell icons, attention tiles) with `info`, and use `.activity-pulse` on running dots instead of any other running animation on dots.
- [ ] **Step 4: Run** both files and `npx vitest run src/components/center src/components/sidebar src/components/history` — Expected: PASS (update assertions in existing tests only where they pinned the old classes).
- [ ] **Step 5: Commit** `feat(desktop): use amber for running sessions and blue for waiting ones`

---

### Task 3: Remove the classic tab layout and the layout-mode setting

**Files:**
- Modify: `src/store/settingsSlice.ts`, `src/store/index.ts`, `src/lib/paneGeometry.ts`, `src/lib/tabGrouping.ts`, `src/components/center/PaneLayout.tsx`, `src/components/center/PaneResizers.tsx`, `src/components/center/usePaneDrag.ts`, `src/components/layout/AppShell.tsx`, `src/components/layout/DetachedShell.tsx`, `src/components/dialogs/SettingsDialog.tsx`
- Delete: `src/components/center/TabBar.tsx`, `src/components/center/TabBar.test.tsx`
- Test: `src/store/migratePersisted.test.ts`, `src/lib/paneGeometry.test.ts`, `src/lib/tabGrouping.test.ts`, `src/store/settingsSlice.test.ts`, `src/components/dialogs/SettingsDialogGeneral.test.tsx`, `src/components/layout/AppShell.test.tsx`, `src/components/center/PaneLayout.test.tsx`

**Interfaces:**
- Produces: `PANE_BAR_HEIGHT` (= 60 in this task; Task 5 sets 48) exported from `lib/paneGeometry.ts`; `canSplit(zone, size, barHeight = PANE_BAR_HEIGHT)`. Removed: `TabLayoutMode`, `tabLayoutMode`, `setTabLayoutMode`, `TAB_BAR_HEIGHT`, `STACKED_TAB_BAR_HEIGHT`, `tabBarHeight`, `layoutTabBar`, `TabBarItem`, `TAB_LAYOUT_OPTIONS`.

- [ ] **Step 1: Write the failing tests** in `migratePersisted.test.ts` (same module-reset pattern as the existing localStorage/SQLite tests):

```ts
it('ignores a stored tabLayoutMode in localStorage and keeps the other keys', async () => {
  localStorage.setItem('abeoncode.settings', JSON.stringify({ tabLayoutMode: 'classic', theme: 'light', leftWidth: 300 }));
  const { useStore } = await import('./index');
  const s = useStore.getState() as Record<string, unknown>;
  expect(s.theme).toBe('light');
  expect(s.leftWidth).toBe(300);
  expect('tabLayoutMode' in s).toBe(false);
});

it('ignores a stored tabLayoutMode in SQLite and never writes it back', async () => {
  getAllSettings.mockResolvedValue({ migrated_v2: '1', tabLayoutMode: 'classic', displayName: 'Ala' });
  const { useStore } = await import('./index');
  await vi.waitFor(() => expect(useStore.getState().displayName).toBe('Ala'));
  expect(setSetting).not.toHaveBeenCalledWith('tabLayoutMode', expect.anything());
});
```

In `paneGeometry.test.ts` replace the `tabBarHeight` block with `canSplit` vertical tests using `PANE_BAR_HEIGHT` (half = `MIN_PANE_HEIGHT + PANE_BAR_HEIGHT`). Delete the `tabLayoutMode` tests in `settingsSlice.test.ts`, `SettingsDialogGeneral.test.tsx` (`switches between the classic and the stacked tab bar`), `AppShell.test.tsx` and `PaneLayout.test.tsx`, and the `layoutTabBar` tests in `tabGrouping.test.ts`.

- [ ] **Step 2: Run** `npx vitest run src/store/migratePersisted.test.ts` — Expected: FAIL (`tabLayoutMode` present in state).
- [ ] **Step 3: Implement.** Remove the type, state, setter and every persistence entry (`Persisted`, `PERSISTED_KEYS`, `pickPersistedFields`, `applyPersistedToState`). `PaneLayout` always mounts `StackedTabBar` with `PANE_BAR_HEIGHT`; `PaneResizers` and `usePaneDrag` use the constant. `AppShell`/`DetachedShell` keep only the macOS 28 px drag strip branch (TitleBar stays unmounted until Task 5 deletes it). Remove the "Układ zakładek" row from `GeneralTab`. Delete `TabBar.tsx`, its test, `layoutTabBar` and `TabBarItem`; fix the `usePaneDrag` comment that names `layoutTabBar` only if it no longer reads true (keep it otherwise).
- [ ] **Step 4: Run** `npx vitest run --maxWorkers=3` and `npm run lint` — Expected: all PASS, 0 errors.
- [ ] **Step 5: Commit** `refactor(desktop): drop the classic tab bar and the tab layout setting`

---

### Task 4: Pane cards and shell spacing

**Files:**
- Modify: `src/lib/drawerGeometry.ts`, `src/components/center/PaneLayout.tsx`, `src/components/center/CenterPanel.tsx`, `src/components/layout/AppShell.tsx`, `src/components/layout/DetachedShell.tsx`, `src/components/layout/DragHandle.tsx`, `src/components/sidebar/Sidebar.tsx` (background only), `src/components/right/RightPanel.tsx` (background only)
- Test: `src/lib/drawerGeometry.test.ts`, `src/lib/paneLayers.test.ts`, `src/components/center/PaneLayout.test.tsx`

**Interfaces:**
- Consumes: `PANE_BAR_HEIGHT` (Task 3), tokens (Task 1).
- Produces in `lib/drawerGeometry.ts`: `PANE_GAP = 8`, `PANE_BORDER = 1`, `paneFrameRect(pane: PaneRect): LenRect`, `paneBarRect(pane: PaneRect, barHeight: number): LenRect`, and a changed `paneContentRect(pane, barHeight)` (every caller, incl. `computeDrawerLayout`, inherits it). DOM: one `[data-pane-frame="<paneId>"]` element per pane, `data-focused="true"` on the focused one when there are two or more panes.

The frame is the pane rect inset by `PANE_GAP / 2` on every side; bar and content sit inside the 1 px border:

| rect (pane = full container, bar 48) | left | top | width | height |
|---|---|---|---|---|
| `paneFrameRect` | `len(0, 4)` | `len(0, 4)` | `len(100, -8)` | `len(100, -8)` |
| `paneBarRect` | `len(0, 5)` | `len(0, 5)` | `len(100, -10)` | `len(0, 48)` |
| `paneContentRect` | `len(0, 5)` | `len(0, 53)` | `len(100, -10)` | `len(100, -58)` |

- [ ] **Step 1: Write the failing tests.** In `drawerGeometry.test.ts` assert the three rows of the table for `{ left: 0, top: 0, width: 100, height: 100 }` with `barHeight` 48, and for a right half pane `{ left: 50, top: 0, width: 50, height: 100 }` assert `paneFrameRect` = `{ left: len(50, 4), top: len(0, 4), width: len(50, -8), height: len(100, -8) }`. Update the expected rects of existing `computeDrawerLayout` / `paneLayers` tests to the new offsets. In `PaneLayout.test.tsx` add:
  - `draws one frame per pane after every content layer`: with two panes, two `[data-pane-frame]` elements exist, both siblings of the layers inside the same container, and every `[data-tab-layer]` precedes them in DOM order;
  - `marks only the focused pane frame when the layout is split`: two panes → exactly one `data-focused="true"`; one pane → none.
- [ ] **Step 2: Run** `npx vitest run src/lib/drawerGeometry.test.ts src/lib/paneLayers.test.ts src/components/center/PaneLayout.test.tsx` — Expected: FAIL.
- [ ] **Step 3: Implement.** Geometry per the table. In `PaneLayout`: the per-pane bar wrapper is positioned with `lenRectStyle(paneBarRect(rect, PANE_BAR_HEIGHT))` and gets the card top (`bg-bg-elev`, `rounded-t-[11px]`, bottom border `border-border`); after the layers and drawer chrome, and before `PaneResizers` and `PaneDragOverlay`, render each frame as `aria-hidden`, `pointer-events-none`, `rounded-[12px] border`, border color `border-border-focus` when `data-focused`, else `border-border`, with `box-shadow: 0 0 0 6px var(--color-bg)`. The shadow paints the ground over the square corners of the layers underneath, so layers need no radius of their own. The `PaneLayout` container keeps `bg-bg`. Shell: header placeholder unchanged; body row `bg-bg` with 4 px outer padding (`px-1 pb-1`), sidebar and right panel get 4 px inner padding and transparent backgrounds, so every visible gap is 8 px; `DragHandle` stays in the gap with no visible line.
- [ ] **Step 4: Run** the three files, then `npx vitest run --maxWorkers=3` and `npm run lint` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(desktop): draw panes as Grafit cards without reparenting layers`

---

### Task 5: App header with the project row, sessions-only pane bar

**Files:**
- Create: `src/components/layout/AppHeader.tsx`, `src/components/layout/AppHeader.test.tsx`, `src/components/center/HeaderProjectRow.tsx`, `src/components/center/HeaderProjectRow.test.tsx`
- Rename: `src/components/center/StackedTabBar.tsx` → `PaneBar.tsx`, `StackedTabBar.test.tsx` → `PaneBar.test.tsx` (`git mv`)
- Modify: `src/lib/tabGrouping.ts`, `src/lib/paneGeometry.ts`, `src/components/center/useTabBarActions.tsx`, `src/components/center/TabItem.tsx`, `src/components/center/PaneLayout.tsx`, `src/components/layout/AppShell.tsx`, `src/components/layout/DetachedShell.tsx`, `src/components/history/HistoryView.tsx`, `src/components/shared/Icon.tsx`
- Delete: `src/components/layout/TitleBar.tsx`, `src/components/history/ReadOnlyPill.tsx`
- Test: `src/lib/tabGrouping.test.ts`

**Interfaces:**
- Consumes: `PANE_BAR_HEIGHT`, `ACTIVITY_SHORT_LABEL`, `ACTIVITY_TEXT`, `activityPulses`, tokens.
- Produces: `pickProjectTab(tabs: Tab[], mruOrder: string[], projectId: number): string | undefined` (MRU tab of that project, else its first tab); `useTabBarActions(tabs, detachedProjectId?, options?: { closeShortcut?: boolean })` (default `true`; `false` registers no `mod+w` listener); `AppHeader({ variant }: { variant: { kind: 'main' } | { kind: 'project'; projectId: number } | { kind: 'session' } })`; `PaneBar` (props as `StackedTabBar` had); `PANE_BAR_HEIGHT = 48`; icons `lock`, `history` (clock outline as in `Historia.dc.html`).

- [ ] **Step 1: Write the failing tests**
  - `tabGrouping.test.ts`: `pickProjectTab` returns the most recent MRU tab of the project, falls back to the first tab of the project, returns `undefined` for a project with no tabs.
  - `HeaderProjectRow.test.tsx`:
    - `shows the project groups of the focused pane only`: two panes, pane A holds projects 1 and 2, pane B project 3, focus A → names of 1 and 2 visible, 3 absent; focus B → only 3.
    - `selects the project in the focused pane`: click group 2 → `findLeaf(layout, focusedPaneId).activeTabId` is `pickProjectTab(...)` for project 2.
    - `opens the group menu with "Wydziel do nowego okna"` on right click.
    - `closes exactly one tab on mod+w with the header row mounted`: render `HeaderProjectRow` plus `PaneBar` for both panes, active tab is an idle history session; dispatch `keydown` `mod+w` on `document` → `tabs.length` drops by exactly 1. Second case with a live terminal tab → exactly one `Zamknąć aktywny tab?` dialog.
  - `PaneBar.test.tsx` (adapt the existing file): shows only session tabs of the pane's selected project, `+` and `$` buttons; `shows Tylko odczyt for a history tab`; `shows the short activity label for a live session` (`Pracuje` with `text-accent`); no project row inside the bar.
  - `AppHeader.test.tsx`: main variant renders the groups row and `2 aktywne sesje` for two live tabs; project variant renders the project name and `Okno projektu`; header has `data-tauri-drag-region`.
- [ ] **Step 2: Run** the four test files — Expected: FAIL.
- [ ] **Step 3: Implement.**
  - `HeaderProjectRow`: tabs of the focused pane (`findLeaf(layout, focusedPaneId)`), `groupTabsByProject`, chips as in `Main.dc.html` (30 px, radius 8, dot, name, mono count; selected = `bg-bg-elev-2 border border-border-raised text-fg-strong`, no close button), wheel scrolls horizontally, `useTabBarActions(paneTabs, detachedProjectId, { closeShortcut: false })` for `showGroupMenu` and `overlays`; `StackedTabBar.selectProject` logic replaced by `pickProjectTab` in both places.
  - `PaneBar`: the old session row only, 48 px, tabs per spec "Pane bar" (active chip `bg-raised-strong`, unfocused-pane active chip `bg-field text-fg-secondary`, history tab `history` icon, live session dot with `activity-pulse` when `activityPulses`), then `+` / `$` (32 px icon buttons), spacer, status of the pane's active tab: live session → `ACTIVITY_SHORT_LABEL` in `ACTIVITY_TEXT`; history session → `lock` icon + `Tylko odczyt`; other kinds → nothing. Remove `ReadOnlyPill` and its use in `HistoryView`.
  - `AppHeader`: 44 px, `data-tauri-drag-region`, `paddingLeft` 78 on macOS else 16; main: 224 px logo block (mark SVG and wordmark from `Main.dc.html`) + `HeaderProjectRow` + right `N aktywne sesje` (count logic moved from `TitleBar`: live session/terminal tabs + drawer shells, green dot, hidden at 0); project: mark + `● <name> / Okno projektu` + count; session: mark + `HeaderProjectRow` + count. Mount in `AppShell` (main) and `DetachedShell` (`group` → project, `session` → session) replacing the macOS strip; delete `TitleBar.tsx`.
- [ ] **Step 4: Run** the four files, then `npx vitest run --maxWorkers=3`, `npm run lint` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(desktop): move the project row into the app header`

---

### Task 6: Live session console and terminal drawer chrome

**Files:**
- Modify: `src/lib/drawerGeometry.ts`, `src/components/center/TerminalDrawerChrome.tsx`, `src/components/center/TabContent.tsx` (session console wrapper only)
- Create: `src/lib/drawerShellLabel.ts`, `src/lib/drawerShellLabel.test.ts`
- Test: `src/lib/drawerGeometry.test.ts`, `src/lib/paneLayers.test.ts`, existing `TerminalDrawerChrome`/`PaneLayout` tests

**Interfaces:**
- Produces: `DRAWER_HEADER_HEIGHT = 36`; `drawerShellLabel(shellPath: string): string` (basename of the path, `'Terminal'` when empty).

- [ ] **Step 1: Write the failing tests:** `drawerShellLabel('/usr/bin/zsh') === 'zsh'`, `drawerShellLabel('') === 'Terminal'`, `drawerShellLabel('fish') === 'fish'`; in `drawerGeometry.test.ts` the header height and body top of `computeDrawerLayout` use 36.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement.** Header per spec "Center": 36 px, `bg-sunken`, top border `border-border`; one chip per drawer terminal (terminal icon + `drawerShellLabel(shellPath)`), the focused one pressed (`bg-raised-strong text-fg`), click calls `focusDrawerTerminal(ownerTabId, terminalId)`; then today's five actions as 28 px icon buttons with their current labels and handlers (split right, split down, `Wydziel do zakładki`, `Zamknij terminal`, `Schowaj panel`). Keep the header's `preventDefault` on mousedown. `CollapsedDrawerBar` uses the same header styling. No maximize button.
- [ ] **Step 4: Run** the geometry, layers, drawer and pane tests and lint — Expected: PASS.
- [ ] **Step 5: Commit** `style(desktop): restyle the terminal drawer header`

---

### Task 7: Terminal appearance model and settings

**Files:**
- Create: `src/lib/terminalAppearance.ts`, `src/lib/terminalAppearance.test.ts`
- Modify: `src/store/settingsSlice.ts`, `src/store/index.ts`
- Test: `src/store/settingsSlice.test.ts`, `src/store/migratePersisted.test.ts`

**Interfaces:**
- Produces:
  - Types `TerminalFontId = 'geistMono' | 'jetbrainsMono' | 'ibmPlexMono' | 'system'`, `TerminalLineHeight = 1.4 | 1.5 | 1.65`, `TerminalPaletteId = 'grafit' | 'grafitHighContrast' | 'legacy' | 'custom'`, `TerminalCursorStyle = 'block' | 'bar' | 'underline'`, `TerminalColors = { background: string; foreground: string; cursor?: string; ansi: string[] }` (`ansi` has 16 entries, normal 0–7 then bright 8–15).
  - `TERMINAL_FONTS: { id: TerminalFontId; label: string; css: string }[]` (labels `Geist Mono`, `JetBrains Mono`, `IBM Plex Mono`, `Systemowa monospace`; `css` uses the family names from Task 1, `system` = `ui-monospace, monospace`).
  - `TERMINAL_LINE_HEIGHTS: TerminalLineHeight[] = [1.4, 1.5, 1.65]`, `TERMINAL_FONT_SIZE_RANGE = { min: 10, max: 20 }`.
  - `TERMINAL_PALETTES: Record<Exclude<TerminalPaletteId, 'custom'>, { label: string; note: string; colors: TerminalColors }>`.
  - `TERMINAL_DEFAULTS = { fontId: 'geistMono', fontSize: 13, lineHeight: 1.65, paletteId: 'grafit', customPalette: null, cursorStyle: 'block', cursorBlink: true }`.
  - `buildTerminalTheme(paletteId: TerminalPaletteId, custom: TerminalColors | null, appTheme: 'dark' | 'light', accent: string): ITheme`.
  - `parseXtermTheme(raw: string): { ok: true; colors: TerminalColors } | { ok: false; error: string }`.
  - Guards `isTerminalFontId`, `isTerminalLineHeight`, `isTerminalPaletteId`, `isTerminalCursorStyle`, `isTerminalColors`.
  - Store state `terminalFontId`, `terminalFontSize`, `terminalLineHeight`, `terminalPaletteId`, `terminalCustomPalette`, `terminalCursorStyle`, `terminalCursorBlink` with setters `setTerminalFontId`, `setTerminalFontSize` (rounds, clamps 10–20, ignores non-finite), `setTerminalLineHeight`, `setTerminalPaletteId`, `setTerminalCustomPalette(colors: TerminalColors)` (also sets `terminalPaletteId: 'custom'`), `setTerminalCursorStyle`, `setTerminalCursorBlink`, `resetTerminalAppearance()`; all seven persisted.

Palettes (`ansi` in order black, red, green, yellow, blue, magenta, cyan, white, then the bright eight):
- `grafit`: label `Grafit`, note `Domyślna`, bg `#0F1012`, fg `#D7D9DD`, ansi `#2A2C31 #E5737A #7FCB9B #F0B44C #8FB3F9 #C49BF2 #5FD3B4 #D7D9DD #4A4D53 #FF8D93 #9BE0B3 #F6CB7D #ABC6FB #D7B7F7 #86E3CB #F2F3F4`.
- `grafitHighContrast`: label `Grafit — wysoki kontrast`, note `Jaśniejsze kolory na czarnym tle`, bg `#000000`, fg `#FFFFFF`, ansi `#3A3D43 #FF7B82 #8EF0B0 #FFD166 #9CC2FF #D8B0FF #6EF2D4 #FFFFFF #5A5E66 #FF9AA0 #A8F5C4 #FFE08F #B8D4FF #E4C8FF #93F7E1 #FFFFFF`.
- `legacy`: label `Obecna`, note `Kolory sprzed zmiany wyglądu`, bg `#1a1917`, fg `#e8e6e1`, ansi `#1a1917 #c14a3d #61c454 #f4be4f #5b9bd5 #b78640 #4db8a4 #e8e6e1 #6b6860 #ec6a5e #7dd56f #f5cf6e #7db8e8 #d4a04e #6dd4bf #faf8f5`.
- Light app theme (any palette): today's light values — bg `#ffffff`, fg `#1a1a1a`, cursor `#b78640`, black `#1a1a1a`, white `#52504a`, brightBlack `#94918a`, brightWhite `#1a1a1a`, the other twelve as `legacy`.

`buildTerminalTheme` maps `ansi` to the xterm keys, `cursor` = `colors.cursor ?? accent`, `cursorAccent` = background, `selectionBackground` `rgba(255,255,255,0.15)` (light `rgba(0,0,0,0.12)`); `custom` with `null` falls back to `grafit`.

`parseXtermTheme` rules: input must parse as JSON (else error `Nieprawidłowy JSON`) and be a non-array object (else `To nie jest obiekt motywu xterm.js`); recognised keys are `background`, `foreground`, `cursor` and the 16 xterm ANSI keys; every present recognised key must be `#rgb`, `#rrggbb` or `#rrggbbaa` (else `Nieprawidłowy kolor w polu „<key>”`); missing keys are filled from `grafit`; unknown keys are ignored.

- [ ] **Step 1: Write the failing tests** in `terminalAppearance.test.ts`:
  - `builds the Grafit theme by default`: `buildTerminalTheme('grafit', null, 'dark', '#F0B44C')` has `background: '#0F1012'`, `red: '#E5737A'`, `brightWhite: '#F2F3F4'`, `cursor: '#F0B44C'`.
  - `falls back to Grafit for an empty custom palette`.
  - `keeps the light colors in the light theme`: any palette → `background: '#ffffff'`, `white: '#52504a'`.
  - `parses a full xterm.js theme`, `fills missing keys from Grafit` (`{"background":"#101010"}` → `ansi[1]` `#E5737A`).
  - `rejects malformed palette JSON`: `'{'` → `Nieprawidłowy JSON`; `'[]'` → `To nie jest obiekt motywu xterm.js`; `'{"red":"blue"}'` → `Nieprawidłowy kolor w polu „red”`; `'{"red":"#12"}'` → same message.
  In `settingsSlice.test.ts`: `clamps the font size` (`setTerminalFontSize(42)` → 20, `(3)` → 10, `(13.6)` → 14, `(NaN)` unchanged); `setTerminalCustomPalette switches to the custom palette`; `resetTerminalAppearance restores TERMINAL_DEFAULTS`; `persists the terminal appearance` (values land in `abeoncode.settings`). In `migratePersisted.test.ts`: `drops invalid stored terminal values` (localStorage `{ terminalFontSize: 99, terminalLineHeight: 2, terminalPaletteId: 'neon', terminalCustomPalette: 'x' }` → size 20, line height 1.65, palette `grafit`, custom `null`).
- [ ] **Step 2: Run** the three files — Expected: FAIL.
- [ ] **Step 3: Implement** the module and the slice; persistence: `terminalFontSize`/`terminalLineHeight` as numbers (deserialize clamps / validates with the guards), `terminalCursorBlink` boolean, `terminalCustomPalette` JSON (validated with `isTerminalColors`), the rest strings validated with the guards; add every key to `Persisted`, `PERSISTED_KEYS`, `pickPersistedFields`, the serialize/deserialize switches and `applyPersistedToState`.
- [ ] **Step 4: Run** the three files and lint — Expected: PASS.
- [ ] **Step 5: Commit** `feat(desktop): add terminal appearance settings and palettes`

---

### Task 8: TerminalView applies the appearance live

**Files:**
- Create: `src/components/terminal/useTerminalAppearance.ts`
- Modify: `src/lib/terminalAppearance.ts`, `src/components/terminal/TerminalView.tsx`
- Test: `src/lib/terminalAppearance.test.ts`, `src/components/terminal/TerminalView.test.tsx`

**Interfaces:**
- Consumes: Task 7 store keys and `buildTerminalTheme`.
- Produces: `terminalOptions(a: TerminalAppearance, appTheme: 'dark' | 'light', accent: string): { fontFamily: string; fontSize: number; lineHeight: number; cursorStyle: TerminalCursorStyle; cursorBlink: boolean; theme: ITheme }` where `TerminalAppearance = { fontId; fontSize; lineHeight; paletteId; customPalette; cursorStyle; cursorBlink }` (exported type); `useTerminalAppearance(): TerminalAppearance` (one `useShallow` selector).

- [ ] **Step 1: Write the failing tests.** `terminalOptions` returns the `TERMINAL_FONTS` css for the font id and passes size, line height and cursor through. In `TerminalView.test.tsx` extend the xterm mock so the constructor pushes `this` into `probe.terminals` and `FitAddon.fit` is a `vi.fn()` on the probe, then add:
  - `uses the Grafit palette and the default font by default`: `probe.terminals[0].options.theme.background === '#0F1012'`, `options.fontSize === 13`, `options.lineHeight === 1.65`, `options.cursorStyle === 'block'`.
  - `applies appearance changes to an open terminal and refits`: after mount, `act(() => useStore.getState().setTerminalFontSize(16))` → `options.fontSize === 16` and `fit` called again; `setTerminalCursorStyle('bar')` → `options.cursorStyle === 'bar'`; `setTerminalPaletteId('legacy')` → `options.theme.background === '#1a1917'`.
  - `paints the padding with the terminal background`: the outer wrapper's inline `background-color` equals the theme background.
- [ ] **Step 2: Run** both files — Expected: FAIL.
- [ ] **Step 3: Implement.** Construct `Terminal` with `terminalOptions(...)` (`convertEol` unchanged); resolve the app theme from `data-theme` as today and the accent from `--color-accent`. An effect keyed on the appearance and the resolved theme assigns each option to `term.options`, and when the container is visible and sized calls `fit.fit()` (the existing `onResize` → `ptyResize` path does the PTY). Do not delay `term.open` or the PTY spawn for fonts: open immediately, then call `document.fonts?.load(\`${fontSize}px ${family}\`)` (when `document.fonts` exists, rejections ignored) and, once it resolves for a still-mounted terminal, re-assign `term.options.fontFamily` and refit; the same happens after every font family change. The `data-theme` `MutationObserver` reuses `terminalOptions`. Delete `buildXtermTheme`. The wrapper keeps `p-4 pb-6`; its background is the theme background (inline style), replacing `bg-bg-elev`.
- [ ] **Step 4: Run** both files, `npx vitest run src/components` and lint — Expected: PASS.
- [ ] **Step 5: Commit** `feat(desktop): apply terminal appearance live in every terminal`

---

### Task 9: Settings categories and search model

**Files:**
- Create: `src/lib/settingsCategories.ts`, `src/lib/settingsCategories.test.ts`
- Modify: `src/store/settingsSlice.ts`
- Test: `src/store/settingsSlice.test.ts`

**Interfaces:**
- Produces:
  - `SettingsCategoryId = 'general' | 'appearance' | 'terminal' | 'notifications' | 'shortcuts' | 'providers' | 'models' | 'permissions' | 'supervisor' | 'cloud' | 'clickup'`.
  - `SETTINGS_GROUPS: { id: 'app' | 'agents' | 'integrations'; label: string; categories: SettingsCategoryId[] }[]` — `Aplikacja`: general, appearance, terminal, notifications, shortcuts; `Agenci`: providers, models, permissions, supervisor; `Integracje`: cloud, clickup.
  - `SETTINGS_CATEGORIES: Record<SettingsCategoryId, { label: string; description: string; icon: IconName; keywords: string[] }>` — labels `Ogólne`, `Wygląd`, `Terminal`, `Powiadomienia`, `Skróty klawiszowe`, `Dostawcy CLI`, `Modele`, `Uprawnienia`, `Agent sterujący`, `AbeonCloud`, `ClickUp`; descriptions: general `Profil, projekty, sesje i narzędzia systemowe.`, terminal `Wygląd konsoli w sesjach agentów, akcjach i terminalach shell. Zmiany widać od razu w podglądzie.`, the others one Polish sentence each; `keywords` = every row label and description word group of that category's content (filled from the components in Task 10/12/13, kept in sync).
  - `normalizeSearch(text: string): string` (lower case, NFD, diacritics removed, `ł` → `l`), `filterSettingsCategories(query: string): SettingsCategoryId[]` (substring match on normalized label + keywords; blank query → all in group order).
  - `isTerminalCategorySeen(): boolean`, `markTerminalCategorySeen(): void` (localStorage key `abeoncode.settings.terminalSeen`, every access in try/catch).
  - Store: `settingsCategory: SettingsCategoryId` (default `'general'`, not persisted), `openSettings(category?: SettingsCategoryId)` (opens; switches category only when given), `setSettingsCategory(id)`.

- [ ] **Step 1: Write the failing tests**

```ts
expect(filterSettingsCategories('')).toEqual(['general', 'appearance', 'terminal', 'notifications', 'shortcuts', 'providers', 'models', 'permissions', 'supervisor', 'cloud', 'clickup']);
expect(filterSettingsCategories('interlinia')).toEqual(['terminal']);
expect(filterSettingsCategories('skroty')).toEqual(['shortcuts']);
expect(filterSettingsCategories('MOTYW')).toEqual(['appearance']);
expect(filterSettingsCategories('domyślny shell')).toEqual(['general']);
expect(filterSettingsCategories('zzz')).toEqual([]);
expect(normalizeSearch('Łódź ŻÓŁW')).toBe('lodz zolw');
```

`isTerminalCategorySeen` is false on a clean localStorage and true after `markTerminalCategorySeen()`; both survive a throwing `localStorage.getItem`. Store: `openSettings('clickup')` → `settingsOpen` true and `settingsCategory` `'clickup'`; a later `openSettings()` keeps `'clickup'`.
- [ ] **Step 2: Run** both files — Expected: FAIL.
- [ ] **Step 3: Implement** (keywords for this task: at least the strings the tests search plus every row label listed in the spec's settings table).
- [ ] **Step 4: Run** both files and lint — Expected: PASS.
- [ ] **Step 5: Commit** `feat(desktop): add the settings category and search model`

---

### Task 10: Settings view replaces the dialog

**Files:**
- Create: `src/components/settings/SettingsView.tsx`, `src/components/settings/SettingsNav.tsx`, `src/components/settings/controls.tsx`, `src/components/settings/SettingsView.test.tsx`, and one file per category under `src/components/settings/categories/`: `GeneralCategory.tsx`, `AppearanceCategory.tsx`, `TerminalCategory.tsx` (placeholder page with title and description until Task 13), `NotificationsCategory.tsx`, `ShortcutsCategory.tsx`, `ProvidersCategory.tsx`, `ModelsCategory.tsx`, `PermissionsCategory.tsx`, `SupervisorCategory.tsx`, `CloudCategory.tsx`, `ClickUpCategory.tsx`
- Move tests: `src/components/dialogs/SettingsDialogGeneral.test.tsx` → `src/components/settings/categories/GeneralCategory.test.tsx`, `SettingsDialogModels.test.tsx` → `categories/ModelsCategory.test.tsx`, `ClickUpTab.test.tsx` → `categories/ClickUpCategory.test.tsx`
- Delete: `src/components/dialogs/SettingsDialog.tsx`
- Modify: `src/App.tsx`, `src/components/layout/AppShell.tsx`, `src/components/layout/AppHeader.tsx`, `src/components/sidebar/SidebarFooter.tsx`, `src/components/layout/AppShell.test.tsx`

**Interfaces:**
- Consumes: Task 9 model and store.
- Produces: `SettingsView()`; `controls.tsx` exports `SettingsPage({ title, description, badge?, actions?, wide?, children })` (`wide` → max width 1100 px, else 760 px), `SettingsSection({ label, children })`, `SettingsRow({ label, description?, htmlFor?, labelId?, children })`, `Segmented<T extends string | number>({ value, options: { value: T; label: ReactNode }[], onChange, labelledBy })`, `Switch({ checked, onChange, labelledBy })`, `Stepper({ value, min, max, unit, onChange, labelledBy, decreaseLabel, increaseLabel })`, `SelectField(props: SelectHTMLAttributes)`, `SavedHint()` (check + `Zmiany zapisują się automatycznie`); `SidebarFooter({ showSettingsButton = true })`. `AppHeader` shows `Ustawienia / <label>` instead of the project row while `settingsOpen`.

Content mapping (moved as-is, restyled in Task 12): `GeneralCategory` = display name, projects base path, session restore, default history view, default shell, default editor; `AppearanceCategory` = theme + `Pokaż aktywne sesje nad projektami`; `NotificationsCategory` = `NotificationsSection`; `PermissionsCategory` = `Pomijaj pytania o uprawnienia`; `ProvidersCategory` = `CliTab`; `ModelsCategory` = `ModelsTab`; `ShortcutsCategory` = `ShortcutsTab`; `SupervisorCategory` wraps `SupervisorSettingsTab`; `CloudCategory` = `CloudTab`; `ClickUpCategory` = `ClickUpTab`.

- [ ] **Step 1: Write the failing tests** `SettingsView.test.tsx` (mock the same tauri calls as the moved tests):
  - `lists the three groups and opens a category`: `Aplikacja`, `Agenci`, `Integracje` headings; click `Modele` → models content visible, `settingsCategory` `'models'`.
  - `filters the navigation from the search field`: type `interlinia` → only `Terminal` in the nav, Terminal page open; clear → all eleven back.
  - `closes on Esc and on Wróć do sesji`; `ignores an Esc another handler already consumed` (dispatch a `keydown` Escape with `defaultPrevented` → stays open).
  - `shows bypass next to Uprawnienia while permissions are skipped`.
  - `shows Nowe on Terminal until the category is opened once`.
  In `AppShell.test.tsx`: `keeps the panes mounted under the settings view` (open settings → `[data-pane-id]` and `[data-tab-layer]` still in the document, the shell body has the `inert` attribute, the header shows `Ustawienia / Ogólne`); `blocks the shell while open and restores focus on close` (focus a button inside a tab layer, open settings → that element is no longer `document.activeElement`; close → it is again).
  Update the moved tests to render the category component (or `SettingsView` with `settingsCategory` set) instead of `SettingsDialog`; their assertions stay.
- [ ] **Step 2: Run** `npx vitest run src/components/settings src/components/layout/AppShell.test.tsx` — Expected: FAIL.
- [ ] **Step 3: Implement.** `SettingsView` per spec "Settings view" and `Ustawienia.dc.html`: left column (sidebar width) with `Wróć do sesji` + `Esc` kbd, search input `Szukaj w ustawieniach` (filters via `filterSettingsCategories`; if the open category drops out, open the first match), `SettingsNav` (group labels, 30 px items with icons, `Nowe` pill on terminal while `!isTerminalCategorySeen()`, mono `bypass` in accent on permissions while `skipPermissions`), `SidebarFooter showSettingsButton={false}`; content card (`bg-bg-elev`, border, radius 12, scrolls) rendering the category component. Opening Terminal calls `markTerminalCategorySeen()`. Esc: a document `keydown` listener (bubble phase) closes unless `e.defaultPrevented` or a `[role="dialog"]` is open. `AppShell`: when `settingsOpen`, render `SettingsView` absolutely over the body row (`inset-0`, `bg-bg`, above everything but dialogs), set `inert` on the body row element itself (no new wrapper), store `document.activeElement` on open, blur it, and on close `focus()` it again if still connected. `App.tsx` no longer renders a settings dialog. Split `SettingsDialog.tsx` by the mapping above; shared helpers it holds (`useClaudeOptions`, option arrays) move to the category file that uses them, or to `categories/shared.ts` when two use them.
- [ ] **Step 4: Run** `npx vitest run --maxWorkers=3` and lint — Expected: PASS.
- [ ] **Step 5: Commit** `feat(desktop): open settings as a full view in the main window`

---

### Task 11: Global shortcuts pause while settings are open

**Files:**
- Modify: `src/components/layout/AppShell.tsx`, `src/components/center/useTabBarActions.tsx`, `src/components/sidebar/Sidebar.tsx`, `src/components/center/ProjectLauncher.tsx`, `src/components/center/TabSwitcher.tsx`, `src/components/center/useTerminalDrawerShortcuts.ts`, `src/components/history/HistoryView.tsx`
- Test: `src/components/layout/AppShell.test.tsx`, `src/components/center/PaneBar.test.tsx`, a Sidebar test file (existing or `src/components/sidebar/Sidebar.test.tsx`)

**Interfaces:**
- Consumes: `settingsOpen`.

- [ ] **Step 1: Write the failing tests:** with `settingsOpen: true`, `mod+n` and `mod+t` change no tabs and `mod+1` starts no action (`AppShell.test.tsx`, `ignores global shortcuts while settings are open`); `mod+w` leaves `tabs` unchanged (`PaneBar.test.tsx`); `mod+k` does not focus the sidebar search. Each test also checks the shortcut works again after `closeSettings()`.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement:** first line of each listed handler `if (useStore.getState().settingsOpen) return;`. The shortcut recorder in `ShortcutsCategory` keeps working (its own listener is not gated).
- [ ] **Step 4: Run** the three files plus `src/components/settings` — Expected: PASS.
- [ ] **Step 5: Commit** `fix(desktop): pause global shortcuts while settings are open`

---

### Task 12: Restyle the settings categories

**Files:**
- Modify: every file in `src/components/settings/categories/` except `TerminalCategory.tsx`, `src/components/dialogs/SupervisorSettingsTab.tsx`, `src/components/dialogs/SupervisorDiscordSection.tsx`, `src/lib/settingsCategories.ts` (keywords)
- Test: the moved category tests, `src/components/settings/SettingsView.test.tsx`

**Interfaces:**
- Consumes: `controls.tsx` (Task 10).

- [ ] **Step 1: Write the failing tests:** `GeneralCategory.test.tsx` adds `renders the Ogólne page as in the mockup`: title `Ogólne`, description `Profil, projekty, sesje i narzędzia systemowe.`, section labels `Profil i projekty`, `Sesje`, `Narzędzia systemowe`, `Zmiany zapisują się automatycznie`; session restore is a `Segmented` group (`Pytaj` has `aria-pressed="true"` by default). `PermissionsCategory` (new test file): the skip toggle is a `role="switch"` with the existing description mentioning `--dangerously-skip-permissions`. A keyword sync test in `settingsCategories.test.ts`: every category's `SettingsRow` labels rendered on its page are findable by `filterSettingsCategories` (render each category, collect `[data-settings-row-label]` texts, assert each maps back to that category).
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** every category with `SettingsPage` / `SettingsSection` / `SettingsRow` and the controls, following `Ustawienia.dc.html` (row: label 13.5/500 `text-fg-strong`, description 12 px `text-muted`, control right, wrapping under at narrow widths; sections in `bg-sunken` cards with `border-border-subtle` row dividers). `SettingsRow` renders its label with `data-settings-row-label`. Behavior, labels and handlers of every control stay as today; only markup and classes change. Extend `keywords` until the sync test passes.
- [ ] **Step 4: Run** `npx vitest run src/components/settings src/components/dialogs src/lib/settingsCategories.test.ts` and lint — Expected: PASS.
- [ ] **Step 5: Commit** `style(desktop): restyle the settings categories`

---

### Task 13: Terminal settings category

**Files:**
- Modify: `src/components/settings/categories/TerminalCategory.tsx`
- Create: `src/components/settings/categories/TerminalPreview.tsx`, `src/components/settings/categories/CustomPaletteEditor.tsx`, `src/components/settings/categories/TerminalCategory.test.tsx`

**Interfaces:**
- Consumes: Task 7 constants, setters and `parseXtermTheme`; `controls.tsx`.

- [ ] **Step 1: Write the failing tests**
  - `changes the font size with the stepper and stops at 20`: from 19 click `Zwiększ czcionkę` twice → store 20, the plus button is disabled; label shows `20 px`.
  - `selects a palette card`: click `Grafit — wysoki kontrast` → `terminalPaletteId` `'grafitHighContrast'`, that card `aria-pressed="true"`.
  - `rejects malformed palette JSON without touching the store`: open `Własna`, paste `{"red":"blue"}` and apply → text `Nieprawidłowy kolor w polu „red”` visible, `terminalCustomPalette` still `null`, `terminalPaletteId` unchanged.
  - `applies a pasted xterm.js theme`: valid JSON → `terminalPaletteId` `'custom'`, `terminalCustomPalette.background` equals the pasted value.
  - `restores the defaults`: after changes, `Przywróć domyślne` → store equals `TERMINAL_DEFAULTS`.
  - `renders sixteen swatches of the chosen palette` in the preview (`[data-ansi-swatch]` count 16, first style background `#2A2C31` for Grafit).
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** per `UstawieniaTerminal.dc.html` and spec "Terminal settings": `SettingsPage wide` with title `Terminal`, `Nowe` badge while unseen, description from `SETTINGS_CATEGORIES.terminal`, action `Przywróć domyślne`; sections `Czcionka` (Krój select, Rozmiar stepper with `Zmniejsz czcionkę`/`Zwiększ czcionkę`, Interlinia segmented shown as `1,4` / `1,5` / `1,65`), `Kolory` (palette cards: name, check in accent when selected, 8-swatch strip on the palette background, note; plus the dashed `Własna` card with `Ustaw 16 kolorów ręcznie albo wklej motyw xterm.js (JSON).`; description `16 kolorów terminala. Zmienia też kolory paska statusu Claude Code, jeśli Twój skrypt statusline używa kolorów ANSI.`), `Kursor` (Kształt segmented `Blok`/`Belka`/`Podkreślenie`, Miganie switch). `CustomPaletteEditor`: 18 color inputs (background, foreground, 16 ANSI) seeded from the current custom palette or Grafit, a textarea `Wklej motyw xterm.js (JSON)` with an apply button and the inline parser error, `Zapisz` → `setTerminalCustomPalette`. `TerminalPreview`: `Claude Code` / `Shell` segmented, static sample from the mockup rendered in the chosen font, size, line height and palette, `0–7` / `8–15` swatch rows (`data-ansi-swatch`), note `Zmiany obejmą też otwarte już terminale.`
- [ ] **Step 4: Run** the new test file, `npx vitest run src/components/settings` and lint — Expected: PASS.
- [ ] **Step 5: Commit** `feat(desktop): add the Terminal settings category`

---

### Task 14: Sidebar

**Files:**
- Create: `src/lib/initials.ts`, `src/lib/initials.test.ts`
- Modify: `src/components/sidebar/Sidebar.tsx`, `ActiveSessionsPanel.tsx`, `ProjectItem.tsx`, `SessionList.tsx`, `SessionItem.tsx`, `SidebarFooter.tsx`, `SortMenu.tsx`, `AddProjectButton.tsx`, `SubagentBadge.tsx`
- Test: existing sidebar tests

**Interfaces:**
- Produces: `initialsOf(name: string): string` — uppercase first letters of the first two words; one word → one letter; blank → `''`.

- [ ] **Step 1: Write the failing tests:** `initialsOf('Piotr Szweda') === 'PS'`, `initialsOf('piotr') === 'P'`, `initialsOf('  Jan  Maria Rokita ') === 'JM'`, `initialsOf('  ') === ''`; a `SidebarFooter` test `shows two initials for the display name` (`displayName: 'Piotr Szweda'` → `PS`).
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** `initialsOf`; footer uses `initialsOf(displayName) || user?.initials || 'D'`. Restyle per `Main.dc.html` and spec "Sidebar": search input styled as the mockup field with a `Ctrl K` kbd (stays an input, `mod+k` keeps focusing it); `Aktywne` header + count and tiles (`bg-bg-elev-2`/`border-border-raised`, radius 10, activity dot, title, project in `text-info`, message count, time); `Projekty` header with sort and add 26 px icon buttons; project rows 28 px radius 7 (dot, name, mono count, selected `bg-bg-elev-2 text-fg-strong`, else `text-fg-secondary`); expanded session rows in the same idiom; footer 28 px avatar `bg-track`. Behavior unchanged.
- [ ] **Step 4: Run** `npx vitest run src/components/sidebar src/lib/initials.test.ts` and lint — Expected: PASS.
- [ ] **Step 5: Commit** `style(desktop): restyle the sidebar`

---

### Task 15: Right panel (toolbar, actions, git, usage)

**Files:**
- Modify: `src/components/layout/DetachedShell.tsx` (passes `detached`), `src/components/right/RightPanel.tsx`, `ProjectToolbar.tsx`, `ActionsSection.tsx`, `ActionList.tsx`, `ActionRow.tsx`, `GitSection.tsx`, `GitRepoGroup.tsx`, `GitFileList.tsx`, `GitFileRow.tsx`, `GitHistory.tsx`, `UsageSection.tsx`
- Test: `ActionRow.test.tsx`, `ProjectToolbar.test.tsx`, `GitSection.test.tsx`, `UsageSection.test.tsx`

- [ ] **Step 1: Write the failing tests:** `ActionRow.test.tsx` `shows działa while the action runs` (running action → text `działa` with class `text-success`; exited → its existing exit text); `ProjectToolbar.test.tsx` `renders the three actions without a pressed state` (`Terminal`, `Edytor`, `Notatki` buttons, none with `aria-pressed`).
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** per spec "Right panel" and the mockups: no divider lines (`gap` 20 px), `RightPanel` gets `detached?: boolean` passed through to `ClickUpSection` (used in Task 16; `DetachedShell` passes `detached`); toolbar as a 3-column group on a `bg-sunken` track with `border-border`, radius 10; action rows (30 px main button `bg-bg-elev-2 border-border-raised`, running main button with a 14 % success tint, source line mono 11 px, `kbd`), every current control kept; Git `Zmiany`/`Historia` small toggles, branch card, file rows with status letter colors (modified `text-accent`, added `text-success`, deleted `text-danger`), `+n` / `−m`; usage toggles and 4 px bars (`bg-track` / `bg-accent`).
- [ ] **Step 4: Run** `npx vitest run src/components/right` and lint — Expected: PASS.
- [ ] **Step 5: Commit** `style(desktop): restyle the right panel`

---

### Task 16: ClickUp section states

**Files:**
- Modify: `src/components/right/ClickUpSection.tsx`
- Test: `src/components/right/ClickUpSection.test.tsx`

**Interfaces:**
- Consumes: `openSettings('clickup')` (Task 9), `ClickUpSection({ detached }: { detached?: boolean })` prop from Task 15.

- [ ] **Step 1: Write the failing tests:**
  - `lists linked tasks with id, name and status` (rows render `customId ?? taskId.slice(0, 6)`, name, status pill).
  - `shows the empty state with Powiąż zadania`: text `Ten projekt nie ma jeszcze powiązanych zadań.`, button opens the link dialog.
  - `asks for a scope`: no config → `Wybierz workspace i space, z których mają pochodzić zadania tego projektu.` and `Ustaw zakres` opens the scope dialog.
  - `sends an invalid token to the ClickUp settings`: `Token ClickUp jest nieprawidłowy albo wygasł. Zadania nie będą się odświeżać.`; click `Otwórz ustawienia ClickUp` → `settingsOpen` true, `settingsCategory` `'clickup'`.
  - `explains where to fix the token in a detached window`: `detached` → text `Popraw token w ustawieniach głównego okna.` and no `Otwórz ustawienia ClickUp` button.
  - `stays hidden without a token` (unchanged behavior).
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** per `ClickUpStany.dc.html` (header `Zadania ClickUp` with the 26 px `Zakres ClickUp` button, 32 px rows, neutral status pill, dashed empty box, sunken notice cards, invalid-token card with a danger-tinted border).
- [ ] **Step 4: Run** the file and lint — Expected: PASS.
- [ ] **Step 5: Commit** `feat(desktop): show ClickUp section states in the Grafit style`

---

### Task 17: History view

**Files:**
- Modify: `src/components/history/HistoryHeader.tsx`, `HistorySearchBar.tsx`, `HistoryStream.tsx`, `HistoryView.tsx`, `SessionFooter.tsx`, `Markdown.tsx`, `SubagentHeader.tsx`, `SubagentView.tsx`, `blocks/UserBubble.tsx`, `blocks/AssistantBubble.tsx`, `blocks/ThinkingBlock.tsx`, `blocks/ToolUseBlock.tsx`, `blocks/ToolResultBlock.tsx`, `blocks/SystemBlock.tsx`, `blocks/AttachmentBlock.tsx`, `src/styles/globals.css` (shiki background)
- Create: `src/components/history/HistoryHeader.test.tsx`, `src/components/history/SessionFooter.test.tsx`, `src/components/history/blocks/AssistantBubble.test.tsx`, `src/lib/formatClock.ts`, `src/lib/formatClock.test.ts`

**Interfaces:**
- Consumes: `ACTIVITY_SHORT_LABEL`, `ACTIVITY_DOT`, `PROVIDER_LABEL` (`lib/providers`).
- Produces: `formatClock(timestampMs: number): string` (`HH:MM`, `pl-PL`, 24 h); `UserBubble({ text, timestamp })`, `AssistantBubble({ text, timestamp, providerLabel })` (`HistoryStream` passes `block.timestamp` and the session provider's `PROVIDER_LABEL`).

- [ ] **Step 1: Write the failing tests:** `formatClock` of a fixed local date at 18:42 → `'18:42'`; `HistoryHeader` `shows the short activity label in a neutral pill` (`Bezczynna`, dot `bg-muted`, no filled `bg-success`/`bg-accent` pill), `keeps the title editable` (click title → input); `SessionFooter` `explains the resume and continues in the terminal` (text `Kontynuacja zamieni historię na terminal:` + `claude --resume <8 chars>`, click `Kontynuuj w terminalu` → `setSessionMode(tabId, 'terminal')`); `AssistantBubble` `labels the message with the provider and time` (`Codex`, `18:42`).
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** per `Historia.dc.html` and spec "History view": header block (mono id + date, 18 px title, neutral pill, 30 px icon buttons, meta row `N tur · <branch> · <provider · model>`, `Komunikacja`/`Pełny` segmented); search bar row under the header; stream column `max-w-[780px] mx-auto`; user card `bg-bg-elev-2 border border-border-raised`, radius 10; assistant `✻` in accent + provider + time, body 13.5 px / 1.65; thinking row `Myślenie` + `N znaków`; tool rows 32 px `bg-console border-border` radius 8 with the input `pre` on expand; system rows as small muted dots; inline code chip `bg-raised-strong` mono 12.5 px; code blocks keep the `github-dark`/`github-light` shiki themes and get `background-color: var(--color-console) !important` on `.shiki` in dark; footer `bg-console` with the secondary `Eksportuj transkrypt` (still no handler) and the primary accent `Kontynuuj w terminalu` (`text-accent-fg`).
- [ ] **Step 4: Run** `npx vitest run src/components/history src/lib/formatClock.test.ts` and lint — Expected: PASS.
- [ ] **Step 5: Commit** `style(desktop): restyle the session history view`

---

### Task 18: Dialogs, menus, toasts, notes window, supervisor panel

**Files:**
- Modify: `src/styles/globals.css` (component classes), every file in `src/components/dialogs/`, `src/components/center/TabContextMenu.tsx`, `GroupContextMenu.tsx`, `TabSwitcher.tsx`, `ProjectLauncher.tsx`, `ProviderPicker.tsx`, `src/components/sidebar/ProjectActionsMenu.tsx`, `ProjectManageMenu.tsx`, `SortMenu.tsx`, `src/components/right/ClickUpScopeDialog.tsx`, `src/components/notes/*.tsx`, `src/components/supervisor/*.tsx`, `src/components/shared/IconBtn.tsx`, `Kbd.tsx`, `TabButton.tsx`, `src/App.tsx` (Toaster)
- Test: existing tests of those components

**Interfaces:**
- Produces (in `@layer components` of `globals.css`): `.dialog-backdrop`, `.dialog-panel`, `.menu-panel`, `.menu-item`, `.btn-primary`, `.btn-secondary`, `.btn-danger`, `.field`, `.kbd` — values from spec "Other surfaces" (panel `bg-elev`, border, radius 12; backdrop 60 % black; menu `bg-elev-2`, `border-raised`, radius 9, 30 px items; primary accent with `accent-fg`; secondary `button` + `border-strong`; field `field` + `border-strong`, radius 8).

- [ ] **Step 1: Write the failing test** `src/styles/tokens.test.ts` adds `defines the shared component classes`: the CSS contains `.dialog-panel`, `.menu-panel`, `.btn-primary`, `.field`.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** the classes and apply them in the listed components (markup structure, labels and handlers unchanged); Toaster `toastOptions.style` uses `var(--color-bg-elev)`, `var(--color-border)`, radius 10, the Geist family; notes window and supervisor panel switch hard-coded surfaces to tokens only.
- [ ] **Step 4: Run** `npx vitest run --maxWorkers=3` and lint — Expected: PASS.
- [ ] **Step 5: Commit** `style(desktop): restyle dialogs, menus and secondary windows`

---

### Task 19: Documentation and final verification

**Files:**
- Modify: `DesktopApp/CLAUDE.md`

- [ ] **Step 1: Update `DesktopApp/CLAUDE.md`:** folder map (`components/settings/` with categories, `lib/terminalAppearance.ts`, `lib/settingsCategories.ts`, `layout/AppHeader.tsx`, `center/PaneBar.tsx` + `HeaderProjectRow.tsx`; remove `TitleBar.tsx`, `SettingsDialog`); replace "Tab bar layout modes" with "Header project row and pane bar" (focused-pane groups in the header, `closeShortcut: false`, `PANE_BAR_HEIGHT` 48 feeds `paneBarRect`/`paneContentRect`, frames drawn over layers with the ground-colored shadow); drawer header 36 px; a "Settings view" section (rendered over the inert shell, panes stay mounted, focus restore, shortcuts paused); a "Terminal appearance" section (persisted keys, palettes, live `term.options` + refit, fonts bundled via `@fontsource`, wait for `document.fonts.load`).
- [ ] **Step 2: Run** `npx vitest run --maxWorkers=3`, `npm run lint`, `npm run build`, `npm run test:rust` — Expected: all PASS (Rust untouched).
- [ ] **Step 3: Manual QA in `npm run tauri dev` on COSMIC** (record results in the commit body; anything failing becomes a fix task before release):
  - open/close settings with a live Claude session and a running action: no restart, scrollback intact, keyboard back in the terminal;
  - change font, size, line height, palette, cursor with a session, a shell tab and a two-split drawer open;
  - split panes, focus each (header row and frame border follow), drag a tab between panes, resize;
  - drawer open/collapse/split/detach; history view both modes, search, continue in terminal;
  - detach a project group and a session (headers, ClickUp invalid-token text);
  - `Ctrl+K/W/T/N`, `Ctrl+1–9`, drawer shortcuts with and without settings open;
  - a narrow window (≈ 900 px) and the light theme still usable.
- [ ] **Step 4: Commit** `docs(desktop): document the Grafit shell, settings view and terminal appearance`
