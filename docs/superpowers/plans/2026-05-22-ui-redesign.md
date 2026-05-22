# AbeonCode UI Redesign — Plan implementacji

> Źródło: `docs/AI Coding App-handoff.zip` (Atelier design system, HTML/CSS/JS prototype)
> Mockup screenshot + odpowiedzi usera z 2026-05-22

## Stan wyjściowy

MVP zrealizowany (40 tasków, 48 commitów na `feat/mvp-implementation`). Backend działa:
SQLite, JSONL parser, PTY, detektory, git2. Frontend działa: 3-kolumnowy layout,
projekty, sesje, historia, terminal. Teraz trzeba dopasować UI do docelowego designu.

## Kluczowe różnice: obecny stan vs design handoff

| Obszar | Obecny stan | Design "Atelier" |
|--------|-------------|-------------------|
| **Paleta kolorów** | Dark-first (#0f1115 bg) | Light-first warm (#faf8f5 bg), terracotta accent oklch(0.62 0.13 35) |
| **Fonty** | System sans/mono | Geist + Geist Mono (Google Fonts) |
| **Historia sesji** | Chat bubbles (user prawo, asystent lewo) | Flat transcript grid [72px label \| content], "TY" / "CLAUDE" |
| **Tool blocks** | Collapsible `<details>` + dashed border | Inline pills "Read › src/path" (jednolinijkowe) |
| **Sidebar projekty** | Nazwa only | Nazwa + path (mono) + session count + live dot |
| **Sidebar sesje** | Tytuł + relative time | Tytuł + "s-id · N tur · czas" + active highlight |
| **Sidebar header** | "PROJEKTY" label | + Search input z ⌘K |
| **Sidebar footer** | ThemeSwitcher | Avatar (git initials) + imię + model + settings cog |
| **Right panel akcje** | Prosta lista ▶/■ | Karty z hint, Kbd shortcut (⌘1-5), play/pause w ramce |
| **Right panel git** | Lista M/A/D + path | Branch card + pliki z +N/-N + przyciski diff/stash/commit |
| **TitleBar** | Brak (nowo dodany import) | Traffic lights (native macOS) + "claude code · sessions" + active count + cost |
| **Session header** | Prosty tytuł + ▶ Kontynuuj | Breadcrumb + h1 20px + badge "aktywna" + stats row + icon buttons |
| **Session footer** | Brak | resume command + eksport + "Kontynuuj w terminalu" (tylko history mode) |
| **Spacing/typography** | Tailwind defaults, text-xs/text-sm | Precyzyjne: 10/11/11.5/12/12.5/13/13.5/20px, tracking-wide dla labels |

---

## Fazy implementacji

### Faza A: Design tokens + fonty (XS, ~30 min)

**Cel:** Zastąpić obecną paletę kolorów i fonty designem "Atelier".

**Pliki:**
- Modify: `src/styles/globals.css` — nowy `@theme {}` block z Atelier palette
- Modify: `tailwind.config.ts` — nowe nazwy kolorów (bg, surface, surface-soft, ink, ink-2, ink-3, line, line-soft, accent, accent-ink, accent-soft, good, warn, bad)
- Modify: `index.html` — dodać Google Fonts `Geist` + `Geist Mono`
- Create: dark mode warianty (design pokazuje tylko light — trzeba stworzyć dark equivalents)

**Detale z handoff:**
```
Light (Atelier):
  bg:           #faf8f5
  surface:      #ffffff
  surface-soft: #f4f1eb
  ink:          #1a1a1a
  ink-2:        #52504a
  ink-3:        #94918a
  line:         oklch(0.18 0.005 70 / 0.08)
  line-soft:    oklch(0.18 0.005 70 / 0.04)
  accent:       oklch(0.62 0.13 35)         — terracotta
  accent-ink:   oklch(0.38 0.08 35)
  accent-soft:  oklch(0.96 0.025 35)
  good:         oklch(0.62 0.11 145)
  warn:         oklch(0.68 0.13 70)
  bad:          oklch(0.58 0.18 25)
  font-sans:    'Geist', -apple-system, system-ui, sans-serif
  font-mono:    'Geist Mono', ui-monospace, SFMono-Regular, monospace
  radius:       xs=3px, sm=5px, md=6px, lg=8px
  
Dark (do zaprojektowania — inwersja Atelier):
  bg:           ~#1a1917
  surface:      ~#242220
  surface-soft: ~#2c2a27
  ink:          ~#e8e6e3
  ink-2:        ~#a8a5a0
  ink-3:        ~#6b6860
  ... (reszta analogicznie)
```

**Dodatkowe CSS z handoff:**
```css
font-feature-settings: "ss01", "cv11";       /* Geist ligatures */
-webkit-font-smoothing: antialiased;
.scroll-thin::-webkit-scrollbar { width: 6px; }
.scroll-thin::-webkit-scrollbar-thumb { background: var(--color-line); border-radius: 99px; }
.path-ellipsis { direction: rtl; text-align: left; overflow: hidden; text-overflow: ellipsis; }
```

**Wpływ:** Wszystkie istniejące klasy (`bg-bg`, `text-fg`, `border-border` itd.) muszą być zamapowane na nowe nazwy. Migration: rename tailwind classes across all components.

**Mapping nazw:**
```
OBECNE         → NOWE (z designu)
bg             → bg
bg-elev        → surface
bg-elev-2      → surface-soft
fg             → ink
muted          → ink-3
border         → line
accent         → accent
accent-fg      → accent-ink (UWAGA: odwrotne znaczenie)
danger         → bad
success        → good
warn           → warn
```

---

### Faza B: TitleBar + native window controls (S, ~1h)

**Cel:** Stworzyć brakujący `TitleBar.tsx` (build się wywali bez niego) z native macOS controls.

**Pliki:**
- Create: `src/components/layout/TitleBar.tsx`
- Modify: `src-tauri/tauri.conf.json` — `titleBarStyle: "Overlay"`, `hiddenTitle: true`, `dragDropEnabled: false`
- Modify: `src-tauri/capabilities/default.json` — dodać `os:default` dla detekcji platformy
- Install: `@tauri-apps/plugin-os` (frontend + backend `tauri-plugin-os = "2"`)

**Layout z handoff (`app.jsx` WindowChrome):**
```
h-9 (36px), bg-bg, border-b border-line, flex items-center, gap-3.5, px-3.5
├── [78px padding na macOS — natywne traffic lights]  ← render by OS, not HTML
├── "claude code · sessions" (font-mono, text-[11px], text-ink-3, tracking-wide)
├── flex-1 spacer
├── "● 3 aktywne sesje" (text-[11px], text-ink-2, green dot 1.5x1.5)
├── "·" separator
└── "$4.07 dziś" (font-mono, text-[11px])
```

**Native controls:**
- macOS: `titleBarStyle: "Overlay"` → system rysuje traffic lights, my dodajemy padding-left ~78px + `data-tauri-drag-region` na TitleBar
- Linux: system decorations (domyślne Tauri), nasz TitleBar nie renderuje fake buttons

**Dane do wyświetlenia:**
- Aktywne sesje: count z `tabs` slice (kind=session, mode=terminal) + `runningActions`
- Koszt: **TODO** (placeholder "$0.00 dziś"), do zaimplementowania po dodaniu parsera usage tokens

---

### Faza C: Sidebar redesign (M, ~2-3h)

**Cel:** Dopasować sidebar do designu.

**Pliki:**
- Modify: `src/components/sidebar/Sidebar.tsx`
- Create: `src/components/sidebar/SidebarSearch.tsx`
- Modify: `src/components/sidebar/ProjectItem.tsx`
- Modify: `src/components/sidebar/SessionItem.tsx`
- Modify: `src/components/sidebar/SessionList.tsx` — "Załaduj N starszych" z dokładną liczbą
- Create: `src/components/sidebar/SidebarFooter.tsx`
- Modify: `src/components/sidebar/AddProjectButton.tsx` — usunąć (przeniesiony do context menu lub header)
- Modify: backend `list_sessions` → dodać `total_count` per projekt
- Create: backend command `get_git_user()` → odczyt `git config user.name` + initials

**Sidebar z handoff (`sidebar.jsx`):**

```
aside, flex flex-col, min-h-0, border-r, bg-bg
├── SidebarHeader
│   ├── "PROJEKTY" (text-[10px], tracking-[0.14em], uppercase, ink-3)
│   └── SearchInput (bg-surface, border-line, rounded-md, ⌘K)
├── ProjectList (flex-1, overflow-y-auto, scroll-thin)
│   └── SidebarProject
│       ├── button (gap-2, px-2.5, py-[7px], rounded-md)
│       │   ├── Chevron (rotate-90 when open)
│       │   ├── div: name (12.5px, semibold when open) + path (mono 10px, ink-3)
│       │   ├── live dot (1.5x1.5, accent) — only if live > 0
│       │   └── session count (mono 10px, ink-3)
│       └── SessionList (mt-1, mb-2.5, ml-4, pl-2.5, border-l border-line)
│           ├── SidebarSession
│           │   ├── dot (1.5x1.5, accent if active, ink-3 opacity-40 if not)
│           │   ├── div: title (12px, medium+accent-ink if active) + metadata (mono 10px)
│           │   └── metadata: "s-{id} · {turns} tur · {when}"
│           └── SidebarLoadMore ("Załaduj {N} starszych", chevDown icon)
└── SidebarFooter
    ├── Avatar circle (w-6 h-6, rounded-full, bg-accent-soft, initials)
    ├── Name + model (12px + mono 10px ink-3)
    └── Settings cog (ml-auto)
```

**Nowe dane potrzebne w backendzie:**
- `count_sessions(project_id) → usize` — łączna liczba sesji (nie ładowanych)
- `get_git_user() → { name: String, email: String }` — z `git config --global user.name` / `user.email`
- `SessionMeta.turns` — alias na `message_count` (lub nowe pole)
- `SessionMeta.session_short_id` — `&id[..4]` do wyświetlania w UI

**Search `⌘K`:**
- Frontend-only filter po `project.name`, `project.path`, `session.title`
- `useEffect` z `document.addEventListener('keydown', ...)` sprawdzające `metaKey + 'k'`
- State w `settingsSlice` lub `searchQuery` w Sidebar local state

**Footer dane:**
- Git user name: Tauri command `get_git_user()` → Rust: `Command::new("git").args(&["config", "user.name"])` (na start apki)
- Initials: first chars of space-separated name parts
- Model: placeholder "claude-sonnet-4-5" (TODO: odczyt z `~/.claude/config.json`)
- Settings cog: na razie otwiera alert/placeholder modal

---

### Faza D: Session View redesign (L, ~3-4h)

**Cel:** Przebudować center panel z bubbles na flat transcript + nowy header/footer.

**Pliki:**
- Modify: `src/components/history/HistoryHeader.tsx` — breadcrumb + h1 + badge + stats + icon btns
- Modify: `src/components/history/HistoryStream.tsx` — grid layout [72px | 1fr]
- Modify: `src/components/history/HistoryView.tsx` — dodać ReadOnlyPill + SessionFooter
- Modify: `src/components/history/blocks/UserBubble.tsx` → `UserTurn.tsx` (flat, bez bombelki)
- Modify: `src/components/history/blocks/AssistantBubble.tsx` → `AssistantTurn.tsx` (flat)
- Modify: `src/components/history/blocks/ToolUseBlock.tsx` → inline pill
- Create: `src/components/history/ReadOnlyPill.tsx`
- Create: `src/components/history/SessionFooter.tsx`
- Create: `src/components/shared/Icon.tsx` — SVG icon set z handoff
- Create: `src/components/shared/IconBtn.tsx`
- Create: `src/components/shared/Kbd.tsx`
- Modify: backend `SessionMeta` → dodać `total_turns`, `input_tokens`, `output_tokens`
- Create: backend command `export_session(session_id, format: "md"|"json")` → save dialog

**Turn layout z handoff (`session-view.jsx`):**
```
grid grid-cols-[72px_1fr] gap-3.5
├── label: "TY" or "CLAUDE" (font-mono, text-[10px], text-ink-3, tracking-wide, pt-0.5)
└── content
    ├── text (13.5px, leading-[1.6], max-w-[640px], text-wrap: pretty)
    │   user: text-ink, claude: text-ink-2
    └── tools (mt-2.5, flex-col gap-1)
        └── ToolPill: "Read › src/path" (border, bg-surface, rounded-sm, mono 11px)
```

**SessionHeader z handoff:**
```
px-7, pt-[18px], pb-3.5, border-b border-line
├── breadcrumb: "monorepo-web · sesja s-9af2 · rozpoczęta 12 min temu" (mono 10px, ink-3)
├── row: h1 (20px, font-medium, tracking-[-0.3px]) + badge + icon buttons
│   ├── "Build session manager UI"
│   ├── badge "● aktywna" (mono 10px, accent-ink, bg-accent-soft, rounded-full)
│   └── IconBtn: copy, branch (fork), more (3 dots)
└── stats: "47 tur · ↑184k ↓41k tokenów · $1.84 · 14 narzędzi" (mono 11px, ink-2)
```

**SessionFooter z handoff (TYLKO w history mode, znika w terminal mode per user):**
```
border-t border-line, px-7, py-3.5, bg-surface, flex items-center gap-3
├── text: "Kontynuacja podmieni historię na terminal: claude --resume s-9af2"
├── btn: "Wyeksportuj transkrypt" (border, bg-surface, rounded-md)
└── btn primary: "▶ Kontynuuj w terminalu" (bg-ink, text-surface, rounded-md, font-medium)
```

**Stats — potrzebne z backendu:**
- `total_turns`: liczymy pary user+assistant w JSONL
- `input_tokens` / `output_tokens`: sumujemy z `usage` field w assistant messages
- `cost_usd`: **TODO** — na razie placeholder, do zaimplementowania po cennikach w settings
- `tool_count`: liczymy unikalne tool_use w sesji

**Eksport transkryptu:**
- Tauri command: `export_session(session_id, format)` → parsuje JSONL → generuje MD lub JSON → `dialog::save()` → zapis
- Formats: Markdown (human-readable transcript) + JSON (raw blocks)

---

### Faza E: Right Panel redesign (M, ~2h)

**Cel:** Dopasować akcje (karty z shortcuts) i git (branch card + diff stats + action buttons).

**Pliki:**
- Modify: `src/components/right/RightPanel.tsx`
- Modify: `src/components/right/ActionsSection.tsx` — header z "z package.json" subtitle
- Modify: `src/components/right/ActionRow.tsx` → karta z play/pause icon + hint + Kbd
- Modify: `src/components/right/ActionList.tsx`
- Modify: `src/components/right/GitSection.tsx` — branch card + action buttons
- Modify: `src/components/right/GitFileRow.tsx` — dodać +N/-N stats
- Create: `src/components/right/GitActions.tsx` — diff/stash/commit buttons
- Modify: backend `GitFile` domain — dodać `additions: usize, deletions: usize`
- Modify: backend `git/mod.rs` — `DiffStats` per plik via git2
- Create: backend commands: `git_diff(project_id, file_path?)`, `git_stash(project_id)`, `git_commit_dialog(project_id)` (otwiera dialog w frontend)
- Add: global keyboard listener `⌘1-9` → uruchom N-tą akcję aktywnego projektu

**ActionRow z handoff:**
```
button, w-full flex items-center gap-2.5 px-2.5 py-[7px] rounded-md
├── icon container (w-[18px] h-[18px], rounded-xs)
│   running: bg-accent-soft, text-accent-ink, pause icon
│   idle: border border-line, text-ink-2, play icon
├── div: label (mono 12px) + hint (10px, ink-3)
│   running: + " · uruchomione · :PORT"
└── Kbd (⌘1, ⌘2, etc.)
```

**GitSection z handoff:**
```
border-t border-line, px-[18px], pt-4, pb-[18px]
├── header: "ZMIANY" + "{N} plików" counter
├── branch card (border, bg-surface, rounded-md, mono 11px)
│   ├── branch icon + branch name (text-ink)
│   └── ↑N ↓N (ml-auto, ink-3)
├── file list (flex-col, overflow-y-auto)
│   └── GitRow
│       ├── status letter (mono 10px, colored: M=warn, A=good, D=bad)
│       ├── path (mono 11.5px, path-ellipsis RTL)
│       ├── +N (mono 10px, good)
│       └── -N (mono 10px, bad)
└── actions row (flex gap-1.5)
    ├── [diff]
    ├── [stash]
    └── [commit...]
```

**Backend zmiany:**
- `git2::DiffStats` per file: `repo.diff_index_to_workdir()` + `diff.stats()` daje summary, per-file wymaga iteracji `diff.deltas()`
- `git_diff`: spawn `git diff` w PTY (terminal view) LUB zwróć diff text
- `git_stash`: `repo.stash_save()` via git2
- `git_commit_dialog`: frontend dialog z message input → backend `repo.commit()`

---

### Faza F: Shared components (S, ~1h)

**Cel:** Stworzyć współdzielone komponenty z design handoff.

**Pliki:**
- Create: `src/components/shared/Icon.tsx` — SVG icon set (search, chevR, chevD, play, pause, branch, copy, more, clock, arrow, settings, folder, terminal, refresh, plus, stop, dot)
- Create: `src/components/shared/IconBtn.tsx` — square bordered icon button (sizes sm/md/lg, tones default/ghost)
- Create: `src/components/shared/Kbd.tsx` — key-cap pill (mono 10px, border, rounded-xs)

Wszystkie z dokładnymi specs z `icons.jsx` handoff.

---

### Faza G: Telemetria + aktywność (S, ~1h)

**Cel:** Dane do TitleBar (aktywne sesje, koszt) + sidebar (active dots).

**Pliki:**
- Modify: `src/store/tabsSlice.ts` — selektor `activeSessionCount`
- Create: `src/store/telemetrySlice.ts` — `todayCost` (placeholder 0.00), `activePtyCount`
- Modify: backend `SessionMeta` — dodać optional `is_active: bool` (sprawdzaj czy PTY żyje)
- **TODO (osobne zadanie w settings):** parser usage tokenów z JSONL + cennik modeli

---

### Faza H: Dark mode Atelier (S, ~1h)

**Cel:** Stworzyć ciemny wariant palety Atelier.

Design handoff pokazuje TYLKO light mode. Dark mode trzeba zaprojektować — invertować jasności zachowując hue terracotta accent.

**Podejście:**
- `bg` → ciemny cream (#1a1917 lub #18171a)
- `surface` → ciemniejszy (#242220)
- `ink` → jasny (#e8e6e3)
- `accent`, `good`, `warn`, `bad` — zachować hue, podnieść lightness o ~0.15
- `line` → zmienić opacity z 0.08 na 0.12

---

## Sugerowana kolejność realizacji

```
F (shared components) → A (tokens+fonty) → B (TitleBar) → C (Sidebar) → D (SessionView) → E (RightPanel) → G (telemetria) → H (dark mode)
```

F najpierw bo Icon/IconBtn/Kbd są używane wszędzie.
A przed resztą bo zmiana nazw kolorów dotknie WSZYSTKICH komponentów.
B krytyczne bo build się wywali bez TitleBar.tsx.

---

## Nowe backend commands (podsumowanie)

| Command | Opis | Faza |
|---------|------|------|
| `count_sessions(project_id)` | Łączna liczba .jsonl plików | C |
| `get_git_user()` | `git config user.name` + `user.email` | C |
| `export_session(session_id, format)` | Parsuj JSONL → MD/JSON → save dialog | D |
| `git_diff(project_id, file?)` | git diff text lub spawn w PTY | E |
| `git_stash(project_id)` | `git stash push -u` | E |
| `git_commit(project_id, message)` | stage all + commit | E |
| Rozszerzenie `SessionMeta` | + turns, input_tokens, output_tokens, tool_count | D |
| Rozszerzenie `GitFile` | + additions, deletions | E |

---

## Otwarte TODO (do settings później)

- Cennik modeli (cost calculation) — hardcoded lookup table w settings
- Odczyt modelu Claude z `~/.claude/config.json`
- Settings dialog (theme switcher przeniesiony z footera sidebar → settings)
- Zarządzanie projektami (rename, delete, reorder) z context menu

---

## Szacowany effort łączny

| Faza | Effort | Opis |
|------|--------|------|
| F | ~1h | Shared: Icon, IconBtn, Kbd |
| A | ~1.5h | Paleta Atelier + Geist fonty + rename klas |
| B | ~1h | TitleBar + native macOS controls |
| C | ~3h | Sidebar (search, project cards, footer, backend) |
| D | ~4h | Session view (transcript, header, footer, eksport, backend) |
| E | ~2.5h | Right panel (action cards, git stats, commands) |
| G | ~1h | Telemetria placeholder |
| H | ~1h | Dark mode Atelier |
| **Suma** | **~15h** | |
