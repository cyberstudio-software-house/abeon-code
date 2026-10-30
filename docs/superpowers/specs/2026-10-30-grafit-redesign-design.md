# Grafit redesign (version A) — design

Date: 2026-10-30 · App: `DesktopApp/` · Scope: new dark visual system for the whole desktop app, a
restructured shell (app header with project row, center column as cards), settings as a full
in-window view with new categories, a new Terminal settings category (fonts, ANSI palettes, cursor),
restyled history view, right panel, terminal drawer, dialogs and detached windows.

Source design: Claude Design canvas "AbeonCode — redesign"
(https://claude.ai/artifact/QrCC74NzLtt42AmVLtKCWs), version A "Grafit". Snapshots of the six
version A artboards live next to this file in `2026-10-30-grafit-redesign/` and are the visual
reference for every value not restated here (they are `.dc.html` files: plain HTML with inline
styles, readable as markup; `{{accent}}` is `#F0B44C`):

| File | Shows |
|------|-------|
| `Main.dc.html` | Main window: live Claude session, terminal drawer, sidebar, right panel |
| `Historia.dc.html` | Session in history mode, history search bar, ClickUp section in the right panel |
| `OknoWydzielone.dc.html` | Detached project window with two panes, running action |
| `ClickUpStany.dc.html` | The four states of the ClickUp section |
| `Ustawienia.dc.html` | Settings view, category "Ogólne" |
| `UstawieniaTerminal.dc.html` | Settings view, category "Terminal" (new) |

## Intent

The user picked version A of three redesign directions and wants all of it done in one go, not
just a recolor of the main window. The app today uses a warm cream/gold palette; Grafit is a cool
graphite dark theme with one amber accent, Geist + Geist Mono, a floating center card and a calmer,
denser information hierarchy. The work is visual and structural; no domain behavior (sessions,
PTYs, git, actions, supervisor, ClickUp, cloud) changes.

## Decisions agreed with the user

1. **All of version A**, including the full-view settings and the new Terminal category.
2. **Light theme is out of scope for now.** It keeps working with today's light colors; nobody
   polishes it in this project.
3. **The COSMIC (system) title bar stays.** No `decorations: false`, no custom minimize/maximize/
   close buttons. The design's in-app window controls are dropped; the app header sits below the
   system title bar.
4. **Only the two-row tab layout remains.** The "Układ zakładek" setting and the classic one-row
   `TabBar` are removed. Version A's split of the two rows (projects in the app header, sessions in
   the pane card) is the layout.
5. **Proposals accepted as drawn** ("wygląda ok"): history view, ClickUp section and its four
   states, detached window (artboards `Historia`, `ClickUpStany`, `OknoWydzielone`).
6. **Summary of the remaining calls accepted** ("wszystko się zgadza"): settings category split,
   settings search, Terminal category contents and defaults, bundled fonts, right-panel toolbar as
   action buttons, no "Wyjście akcji" drawer tab, no elapsed-time counter, project rows keep
   expanding into session lists.
7. **Activity colors follow the design**: amber (accent) means "the agent is working"; waiting for
   the user moves to blue. The user accepted that today's meaning of amber ("waiting for you", the
   attention bell) flips.

## Goals

- One coherent Grafit look across every surface of the main window, detached windows and the notes
  window, driven by design tokens, not per-component hex values.
- The shell structure of version A: app header with logo and project row, sidebar and right panel
  on the bare ground, center pane(s) as rounded cards.
- Settings as a full in-window view with grouped navigation and search.
- User-configurable terminal appearance applied live to every xterm instance.

## Non-goals

- Polishing the light theme, an accent-color picker, custom window decorations.
- New features drawn or implied by the mockups but absent today: an elapsed-time counter next to
  "Pracuje" or on running actions, a "Wyjście akcji" tab and a maximize button in the terminal
  drawer, closing a whole project group from its chip, "Więcej opcji sesji" (⋯) and "Zatrzymaj
  akcję" buttons in the pane bar, a "return to main window" action for detached windows,
  cross-window settings sync, ClickUp status colors (the API data has none), a working
  "Eksportuj transkrypt" button (it has no handler today; it stays as it is). The rule for the
  builder: a control drawn in a mockup with no feature behind it today is dropped, and a control
  that exists today but is missing from a mockup is kept and restyled.
- Changing the default project color palette (`lib/projectColors.ts`).
- Redesigning the layout of the notes window or the supervisor panel (they get the tokens only).
- MobileApp, CloudService.

## Anti-goals (a failure even if it looks right)

- **Any live PTY dying, restarting or losing scrollback because of the redesign**: opening and
  closing settings, focusing panes, splitting, detaching, changing terminal settings.
- Misaligned or clipped terminal glyphs (font not loaded before xterm measures it).
- A regression in the global shortcuts (`Ctrl/Cmd+K`, `W`, `T`, drawer shortcuts) or in the
  close-with-live-process guards.
- Settings values lost or reset by removing `tabLayoutMode` or adding the new keys.
- A layout that only works at 1440×900: the app must stay usable at narrow window widths the way it
  is today (resizable columns, panes, drawer).

## Constraints (from the codebase)

- **Content layers never change DOM parent and keep their relative order** (`DesktopApp/CLAUDE.md`,
  Gotchas). Pane cards must therefore be drawn as separate absolutely positioned frames (border,
  radius, background) behind/around the layers, never as wrappers of them. Rounded bottom corners
  are achieved by styling the layer element itself (`border-radius` + `overflow: hidden`), not a
  new parent.
- **Geometry is computed, not CSS-flowed**: `lib/paneGeometry.ts` (`tabBarHeight`,
  `TAB_BAR_HEIGHT`, `STACKED_TAB_BAR_HEIGHT`), `lib/drawerGeometry.ts` (`DRAWER_HEADER_HEIGHT`, now
  28 px), `lib/paneLayers.ts`, `usePaneDrag`, `PaneResizers`. Card gaps (8 px), card borders (1 px)
  and new bar heights must go through these, or layers overlap the chrome.
- **Settings view must not unmount `PaneLayout`** or resize the terminals. Hidden layers keep their
  open-size rects (same rule the collapsed drawer uses). Output written meanwhile goes through the
  existing `pendingWrites` buffering. On close, keyboard focus returns to the terminal that had it.
- `TerminalView`: never `term.dispose()`; theme changes are applied by setting `term.options`
  (today a `MutationObserver` on `data-theme` re-applies `buildXtermTheme()`); changing font family,
  size or line height must be followed by a fit and a `pty_resize`.
- Settings persistence is two-tier (`PERSISTED_KEYS`, serialize/deserialize switches,
  localStorage + SQLite, hydration-race ordering). Detached windows never persist.
- New window labels and capabilities are untouched (no new windows).
- macOS uses `titleBarStyle: "Overlay"`: the app header keeps today's 78 px left inset there and a
  `data-tauri-drag-region`.
- Identifiers in English, UI text in Polish, no code comments unless the why is non-obvious.

## Visual system (Grafit)

Values are fixed by the design; token **names** are the builder's choice. Existing token names
(`bg`, `bg-elev`, `bg-elev-2`, `fg`, `fg-secondary`, `muted`, `border`, `accent`, `accent-fg`,
`danger`, `success`, `warn`) should be reused where the role matches, so most components restyle
without edits; new roles get new tokens in `globals.css` + `tailwind.config.ts`. Every new token
also gets a light-theme value, approximated from today's light palette.

**Surfaces**

| Role | Value | Used for |
|------|-------|----------|
| ground | `#0B0C0E` | window background, sidebar, right panel |
| surface | `#111215` | center/pane cards, git card, palette cards |
| console | `#0F1012` | agent console, xterm background, history footer, tool rows |
| sunken | `#0D0E10` | settings section cards, terminal drawer body |
| field | `#16171A` | inputs, selects, segmented-control track |
| raised | `#17181B` | selected list row, active project chip, small toggle "on", hover |
| raised-strong | `#1A1B1F` | active session tab in a pane bar |
| pressed | `#26282D` | pressed segment in a segmented control |
| button | `#1C1D21` | secondary buttons |
| avatar / track | `#1E2024` | avatar circle, progress-bar track |

**Borders**: card `#1D1F23` · row divider `#1B1D20` · field/kbd `#2A2C31` · segmented track
`#24262A` · raised chip `#26282C` · focused pane card `#2E3136` · console rule `#34373C`.

**Text**: strong `#F2F3F4` · body `#E6E7E9` · secondary `#C4C6CB` (also `#C9CBCF`) · icon/inactive
`#9DA1A9` · description `#8E939B` · section label `#858A93` · placeholder `#8A8F98` · separator
glyphs `#4A4D53`. All pass 4.5:1 on the ground.

**Accent and status**: accent `#F0B44C` · accent hover `#F6CB7D` · text on accent `#1B1405` ·
success `#7FCB9B` · danger `#E5737A` · info `#8FB3F9` · teal `#5FD3B4` · pink `#E58FB4`.
Focus ring: `2px solid` accent, `outline-offset: 2px` on `:focus-visible`.

**Session activity colors** (decision 7): running = accent with the 1.6 s pulse; waiting for the
user = info `#8FB3F9`, which also covers every attention marker drawn in accent today (sidebar
badges, bell icons, attention tiles); waiting for a tool approval = pink `#E58FB4`; idle =
`#8E939B`. The mapping lives in one place (`lib/activity.ts` and the attention styles). Short labels for pills and pane bars: "Pracuje", "Czeka na Ciebie",
"Czeka na zgodę", "Bezczynna"; the long `ACTIVITY_LABEL` texts stay as tooltips.

**Type**: Geist for UI (base 13 px / 1.45; weights 400/500/600), Geist Mono for code, ids, counts,
paths, kbd. Section labels: 11 px, 500, uppercase, `letter-spacing: 0.06em`, `#858A93`. Page titles
in settings 22 px/600; history title 18 px/600; row labels 13.5 px/500; descriptions 12 px.

**Shape and spacing**: cards radius 12; tiles, segmented tracks, search field 9–10; buttons and
inputs 8; list rows and small buttons 6–7; kbd 5; pills 999. Shell padding `0 8px 8px`, 8 px gaps
between columns and between pane cards. No horizontal divider lines between right-panel sections
(spacing only, 20–22 px).

**Icons**: inline stroke SVG, 13–15 px, stroke 1.4–1.6, as in the mockups; reuse/extend
`components/shared/Icon.tsx`. No emoji.

## Fonts

Bundle the fonts with the app instead of loading Google Fonts from `index.html` (offline use, and
xterm must measure a loaded font): Geist (400/500/600), Geist Mono (400/500), JetBrains Mono
(400/500), IBM Plex Mono (400/500), as local `woff2` (package choice is the builder's, e.g.
`@fontsource/*` or `geist`). Drop the unused Instrument Sans / Instrument Serif and their
`tailwind.config.ts` families. `TerminalView` waits for `document.fonts.load()` of the configured
family before opening xterm, and refits after a family change.

## Shell

- **App header** (44 px, `data-tauri-drag-region`, below the COSMIC title bar; replaces
  `TitleBar.tsx` and the macOS 28 px strip): a 224 px block with the logo mark and the
  "AbeonCode" wordmark aligned over the sidebar, then the **project row**, then on the right today's
  "N aktywne sesje" indicator (green dot), my call. No window controls.
- **Project row** = today's top row of `StackedTabBar`, lifted out of the pane into the header. It
  shows the project groups of the **focused pane** and keeps today's behavior and actions exactly
  (click selects the project in the focused pane; `GroupContextMenu` with "Wydziel do nowego
  okna"): dot, name, tab count; the selected group is a raised chip. The close (X) drawn on the
  selected chip in `Main.dc.html` is dropped: closing a whole group does not exist today. With a
  single pane this is identical to today; with splits, focusing another pane updates the row (my
  call).
- **Sidebar** and **right panel** on the ground, no background or borders of their own; resizable
  as today, with the drag handles living in the 8 px gaps.
- **Center**: one card per pane (`#111215`, border, radius 12). The focused pane's card border is
  `#2E3136`, the others `#1D1F23`.
- **Pane bar** (inside the card, top, 48 px; replaces the two-row `StackedTabBar` and the classic
  `TabBar`): the session row of the pane's selected project (tabs, `+` new agent session, `$` new
  shell), then on the right the active tab's status: "Pracuje" (accent) / other activity label for
  a live session, "Tylko odczyt" with a lock icon for a history tab. Active tab chip
  `#1A1B1F` with close button; inactive tabs text `#9DA1A9`; a live session tab has the pulsing
  activity dot, a history tab a clock icon, a shell tab a terminal icon, an action tab its status
  dot. In an unfocused pane the active chip is dimmer (`#16171A`, text `#C4C6CB`). The mockups'
  "Więcej opcji sesji" (⋯) button and the "Zatrzymaj akcję" button on the right of the bar are
  dropped; the tab context menu (right click) stays as today.
- `tabLayoutMode`, `TAB_BAR_HEIGHT` vs `STACKED_TAB_BAR_HEIGHT` and `tabBarHeight(mode)` collapse
  into one bar height; `TabBar.tsx` and its test are removed; every caller of `tabBarHeight` is
  updated.

## Sidebar

As in `Main.dc.html`: search field styled as in the mockup with a `Ctrl K` kbd (stays a real input,
`Ctrl/Cmd+K` still focuses it); "Aktywne" tiles (`ActiveSessionsPanel`, shown per the existing
setting); "Projekty" header with sort and add buttons; project rows 28 px (dot, name, session count;
selected row raised). Rows still expand into the session list as today (`SessionList`/
`SessionItem` restyled in the same idiom: indented 28 px rows, activity dot, title, relative time).
Footer: avatar with two initials, display name, model label, settings button.

## Center: live session and terminal drawer

- Agent console and all xterm instances use the terminal settings below (default palette Grafit,
  background `#0F1012`).
- **Terminal drawer** header 36 px (`DRAWER_HEADER_HEIGHT` 28 → 36, through `drawerGeometry.ts`):
  one pressed-style chip per drawer shell (terminal icon + shell name), then today's five actions as
  28 px icon buttons (split right, split down, "Wydziel do zakładki", "Zamknij terminal", "Schowaj
  panel"); the mockup's maximize button is dropped (no such feature); body background `#0D0E10`. The collapsed drawer bar uses the same header
  styling. Behavior (splits, detach, focus handling, `preventDefault` on header mousedown) unchanged.

## History view

As in `Historia.dc.html` (interactive: the view-mode switch and the search toggle work there).

- Header block below the pane bar: mono `sesja <8 chars> · <date>`; editable title (18 px) with
  the activity pill (neutral: dot + short label on `#16171A`, not today's filled pill); icon buttons
  Szukaj w sesji, Generuj tytuł, Kopiuj ID, Otwórz terminal (existing behaviors, existing
  generating/copied feedback texts); meta row `N tur · <branch> · <provider · model>` and the
  "Komunikacja / Pełny" segmented control.
- Search bar (`HistorySearchBar`) as a row under the header: input, `k z n` counter, previous/next,
  close.
- Stream: centered column, max-width 780 px. User messages: label "Ty" + time, text in a raised
  card (`#17181B`, border `#26282D`, radius 10). Assistant: `✻` in accent + provider name
  ("Claude", "Codex", "OpenCode") + time, then plain text (13.5 px / 1.65, `#D7D9DD`). Times only
  where the block data has them.
- "Pełny" mode adds: thinking as a collapsed row ("Myślenie · N znaków"); tool use as 32 px rows
  (`#0F1012`, border, radius 8: icon, tool name, mono summary, check mark when done), expanding to
  the input/result `pre`; system/hook lines as small muted dot rows. Attachments and subagent
  headers follow the same idiom.
- Markdown: inline code chip (`#1A1B1F`, mono 12.5 px), lists, links in accent; code blocks use a
  shiki dark theme whose background matches `#0F1012` (builder picks or tunes the theme).
- Footer bar (`#0F1012`): "Kontynuacja zamieni historię na terminal: claude --resume <id>",
  secondary "Eksportuj transkrypt", primary "Kontynuuj w terminalu" (accent background,
  `#1B1405` text). The primary accent button is reserved for this kind of main action.
- `SubagentView` reuses the same header/stream styling.

## Right panel

Order unchanged: project toolbar, Akcje, Zadania ClickUp, Git, Zużycie/Limity (pushed to the
bottom).

- **Project toolbar**: Terminal / Edytor / Notatki as three equal buttons in one segmented-looking
  group (`#121316` track). They are actions, so none shows a pressed state.
- **Akcje**: rows with a 30 px main button, name, mono source line, `Ctrl N` kbd; "Dodaj akcję"
  text button; "wykrywane automatycznie" caption next to the section label. Every control and
  behavior of today's `ActionRow` stays (open output of a running action, restart and clear after
  exit, error tone, edit/delete on hover), only restyled. While running, the main button gets the
  14 % success tint and the source line reads "działa" in success color. The mockup's stop icon and
  "mm:ss" timer in `OknoWydzielone.dc.html` are dropped (no start time exists to show).
- **Zadania ClickUp** (`ClickUpStany.dc.html`): header with the scope button; rows 32 px (mono id,
  name, neutral status pill); "Powiąż zadania". States: list; no links (dashed box + button); scope
  not set (card + "Ustaw zakres"); invalid token (card with a danger border tint + "Otwórz ustawienia
  ClickUp", which opens the settings view on the ClickUp category; in detached windows, where the
  settings view does not exist, the button is replaced by the text "Popraw token w ustawieniach
  głównego okna."). Hidden when no token, as today.
- **Git**: "Zmiany / Historia" small toggle, file count, refresh; branch card (`#111215`, radius 10)
  with branch and ahead/behind, clean-state line with a success check; file rows (status letter in
  accent/success/danger, mono path, `+n −m`). Commit box, history list and diff dialogs in the same
  idiom.
- **Zużycie / Limity**: small toggle; label + mono percentage, 4 px bar in accent on `#1E2024`,
  reset time.

## Settings view

Replaces `SettingsDialog`. Opens in the main window in place of the sidebar, center and right panel
(`Ustawienia.dc.html`); `PaneLayout` stays mounted underneath (see Constraints).

- App header: breadcrumb "Ustawienia / <kategoria>" instead of the project row.
- Left column (sidebar width): "Wróć do sesji" with an `Esc` kbd; search field "Szukaj w
  ustawieniach"; grouped navigation; footer with the profile (no settings button).
- `Esc` closes the view unless a nested menu, select or dialog consumes it first (my call).
- While the view is open, the global shortcuts that act on hidden UI do nothing: `Ctrl/Cmd+W`,
  `Ctrl/Cmd+T`, `Ctrl/Cmd+K`, action shortcuts and drawer shortcuts (my call). They work again
  after the view closes.
- The settings view exists only in the main window, as `SettingsDialog` does today.
- Navigation and where today's content goes:

  | Group | Category | Content (today's source) |
  |-------|----------|--------------------------|
  | Aplikacja | Ogólne | Nazwa wyświetlana, Ścieżka bazowa projektów (+ "Wybierz…"), Sesje po uruchomieniu, Domyślny widok historii, Domyślny shell, Domyślny edytor (`GeneralTab`) |
  | | Wygląd | Motyw (Ciemny / Jasny / Systemowy), "Pokaż aktywne sesje nad projektami" (`GeneralTab`) |
  | | Terminal | new, below; "Nowe" pill until the category is opened once (localStorage-only flag) |
  | | Powiadomienia | `NotificationsSection` |
  | | Skróty klawiszowe | `ShortcutsTab` |
  | Agenci | Dostawcy CLI | `CliTab` (providers, title generation, CLI command, Claude skill) |
  | | Modele | `ModelsTab` |
  | | Uprawnienia | "Pomijaj pytania o uprawnienia" (`skipPermissions`); mono "bypass" in accent next to the nav item while it is on |
  | | Agent sterujący | `SupervisorSettingsTab` |
  | Integracje | AbeonCloud | `CloudTab` |
  | | ClickUp | `ClickUpTab` |

  "Układ zakładek" disappears.
- Content card: title + one-line description, "Zmiany zapisują się automatycznie" with a check
  (settings already save on change); sections = uppercase label + sunken card of rows; a row is
  label (13.5/500) + description (12 px) on the left, control on the right, wrapping under at
  narrow widths. Controls: text input, select with custom chevron, segmented control, switch
  (`role="switch"`), stepper. Max content width 760 px (Terminal: 1100 px, with the preview
  column).
- **Search** (my call): each category declares its searchable strings (row labels and
  descriptions); typing filters the navigation to matching categories; if the open category stops
  matching, the first match opens; empty query restores everything.
- `openSettings` gains an optional category argument (used by the ClickUp invalid-token state and
  anywhere a deep link makes sense).

## Terminal settings (new)

As in `UstawieniaTerminal.dc.html`. Applies live to every `TerminalView` of the main window
(agent, action, shell, drawer, supervisor), open ones included. Detached windows pick the new values
up the next time they open, like every other setting today; no cross-window sync is added (my call).

| Setting | Options | Default |
|---------|---------|---------|
| Krój | Geist Mono, JetBrains Mono, IBM Plex Mono, Systemowa monospace (`ui-monospace, monospace`) | Geist Mono |
| Rozmiar | stepper 10–20 px | 13 |
| Interlinia | 1,4 / 1,5 / 1,65 | 1,65 (today 1.4) |
| Paleta ANSI | Grafit · Grafit — wysoki kontrast · Obecna · Własna | Grafit |
| Kształt kursora | Blok / Belka / Podkreślenie (xterm `block` / `bar` / `underline`) | Blok |
| Miganie | switch | on |

Palettes (normal 0–7, then bright 8–15; background / foreground):

- **Grafit**: `#2A2C31 #E5737A #7FCB9B #F0B44C #8FB3F9 #C49BF2 #5FD3B4 #D7D9DD`; bright
  `#4A4D53 #FF8D93 #9BE0B3 #F6CB7D #ABC6FB #D7B7F7 #86E3CB #F2F3F4`; bg `#0F1012`, fg `#D7D9DD`,
  cursor accent.
- **Grafit — wysoki kontrast**: `#3A3D43 #FF7B82 #8EF0B0 #FFD166 #9CC2FF #D8B0FF #6EF2D4 #FFFFFF`;
  bright variants derived by the builder (lighter, `brightWhite` `#FFFFFF`); bg `#000000`.
- **Obecna**: today's dark values from `buildXtermTheme()`.
- **Własna**: an editor with the 16 colors (plus background/foreground) and a "paste xterm.js theme
  (JSON)" field; invalid JSON shows an inline error and keeps the previous colors.

Also: "Przywróć domyślne"; a static preview (not a live xterm) with a "Claude Code / Shell" toggle
rendering sample output in the chosen palette, font and line height, and the 0–7 / 8–15 swatch rows;
the note "Zmiany obejmą też otwarte już terminale". The palette note warns that it also changes the
Claude Code status line colors when the user's statusline script uses ANSI colors. In the light
theme terminals keep today's light colors whatever the palette (light is out of scope, my call).

## Detached windows

As in `OknoWydzielone.dc.html`: no sidebar; app header with the logo mark, then for a project
window "● <projekt> / Okno projektu", for a session window the project row as in the main window
(my call; it usually holds one project); "N aktywne" on the right. Panes and right panel exactly as
in the main window. Behavior (detach handshake, close guard, attention) unchanged.

## Other surfaces

- **Dialogs** (`dialogs/*`, confirm, add/edit project, actions, ClickUp, diff, pairing, update,
  restore sessions): surface card (`#111215`, border, radius 12), backdrop ~60 % black, field-style
  inputs, primary = accent, secondary = button style, danger actions in danger color.
- **Context menus and popovers** (tab, group, project, sort menus, tab switcher, project launcher,
  provider picker): `#17181B`, border `#26282C`, radius 9, 30 px rows, kbd hints in mono.
- **Toasts** (`sonner`): dark Grafit styling.
- **Notes window, supervisor panel**: tokens only.

## Persistence

- Remove `tabLayoutMode` from the store, `PERSISTED_KEYS` and the serialize/deserialize switches;
  a stored value is ignored on hydration (no error, no other key affected).
- Add persisted keys for terminal font family, size, line height, palette id, custom palette and
  cursor style/blink (names and shapes are the builder's), through both tiers.
- The "Nowe" flag of the Terminal category is localStorage-only.

## Calls made in the design phase (check these)

1. The header project row shows the focused pane's projects; no close (X) on the selected chip.
2. "N aktywne sesje" kept on the right of the app header.
3. Waiting for a tool approval = pink `#E58FB4`.
4. Terminal palette ignored in the light theme; terminal settings apply live in the main window
   only, detached windows pick them up when next opened.
5. Settings search filters categories; `Esc` closes settings unless something nested consumes it;
   global shortcuts that act on hidden UI are off while settings are open.
6. "Nowe" pill on Terminal until first visit.
7. Bundled fonts; Instrument fonts dropped.
8. Drawer header keeps today's five actions, no maximize; action rows keep today's controls, no
   timer; pane bar without ⋯ and stop buttons; in detached windows the ClickUp invalid-token state
   shows a text instead of the settings button.
9. Project toolbar buttons are actions, not a toggle; project rows still expand into sessions.

## Left to the builder

Token names and file organization; bar heights within the mockup's range; the shiki theme; the
high-contrast bright colors; the custom-palette editor layout; how hidden layers are kept alive
under the settings view (as long as the constraints hold); splitting `SettingsDialog.tsx` (1447
lines) into per-category files; font package; test strategy and the order of work.

## Verification

- `npm run lint` clean, `npm test` (use `npx vitest run --maxWorkers=3` when flaky under load),
  `npm run test:rust` untouched but green.
- Unit tests for: palette → xterm `ITheme`, custom-palette JSON parsing, persistence round trip of
  the new keys and the ignored `tabLayoutMode`, settings search filtering, header project row with
  two panes, removed classic layout paths.
- Manual QA in `npm run tauri dev` on COSMIC: open/close settings with a live Claude session and a
  running action (no restart, scrollback intact, focus returns); change terminal font/size/line
  height/palette/cursor with live terminals; split panes and focus each; drawer open/collapse/split/
  detach; history view both modes, search, continue in terminal; detach a project group and a
  session; ClickUp section states; narrow-window behavior; `Ctrl/Cmd+K/W/T`.
