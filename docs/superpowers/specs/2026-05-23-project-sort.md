# Spec B — Project Sort (Manual / Alphabetical / Last Activity)

**Date:** 2026-05-23
**Project path:** `/home/pszweda/projects/cyberstudio/AbeonCode`
**Status:** Draft for implementation planning
**Prerequisite:** Spec A — Settings Persistence Migration (`docs/superpowers/specs/2026-05-23-settings-persistence-sqlite.md`) — DONE.

## 1. Cel

Dodać do listy projektów w sidebar możliwość sortowania w trzech trybach: **manualnie** (obecna kolejność wg `sort_order`), **alfabetycznie** (A→Z, świadome polskich znaków), oraz **wg ostatniej aktywności** (najnowsze na górze, na podstawie `mtime` plików JSONL w katalogu `.claude/projects/<dir>/`).

Wybrany tryb jest persistowany (key `sortMode` w warstwie z Spec A) i odświeżany przy fokusie okna (`tauri://focus`), żeby lista odzwierciedlała rzeczywistą aktywność po pracy w terminalu zewnętrznym.

## 2. Decyzje kluczowe

| Obszar | Decyzja | Powód |
|---|---|---|
| Tryby | `'manual'`, `'alpha'`, `'activity'` | Naturalne wybory; manual zachowuje obecne zachowanie |
| Manual semantyka | Sortuj wg `sort_order ASC, created_at ASC` (jak dziś w SQL) | Zero zmian w istniejącym porządku |
| Activity definition | `max(mtime)` ze wszystkich `*.jsonl` w `.claude/projects/<dir>/` | „Kiedy ostatni raz pracowałem z Claude w tym projekcie" |
| Activity payload type | `HashMap<i64, i64>` (mapa project_id → mtime_ms) | Frontend dostaje gotowy `Record<number, number>` bez konwersji |
| Projects bez sesji | Backend pomija; frontend traktuje brak klucza jako `mtime=0` | Mniejszy payload, prostsza logika |
| UI placement | Mała ikona obok `+` w nagłówku „Projekty"; klik → popover z 3 opcjami | Spójne z istniejącym wzorcem (HistoryHeader też ma ikony w nagłówkach) |
| Kierunek | Naturalne defaults bez toggle: alpha = A→Z, activity = newest first, manual = sort_order ASC | Pokrywa 95% przypadków, mniej UI |
| Architektura | Sort na froncie (Zustand selector); backend dostarcza tylko activity mapę | Brak migracji DB; selektor jest czysty; łatwo testowalny |
| Persistencja | Klucz `sortMode` w `PERSISTED_KEYS` (auto via Spec A) | Zero dodatkowego kodu persystencji |
| Refresh | Listener `tauri://focus` + ładowanie przy mount | „Żywa" lista, bez polling |
| Drag-and-drop | Out of scope — nie ma we froncie, nic nie wyłączamy | Backend ma `reorder_projects`, ale front nigdy go nie wpiął |

## 3. Architektura

```
┌──────────────────────────────────────────────────────────────────┐
│ Frontend (React + Zustand)                                       │
│                                                                  │
│  ┌─────────────────────────┐    ┌────────────────────────────┐  │
│  │ projectsSlice           │    │ settingsSlice              │  │
│  │  - projects: Project[]  │    │  - sortMode: SortMode      │  │
│  │  - activity:            │    │  - setSortMode()           │  │
│  │      Record<number,     │    └────────────────────────────┘  │
│  │              number>    │                                    │
│  │  - loadActivity()       │                                    │
│  └─────────────────────────┘                                    │
│       ▲                                                          │
│       │                                                          │
│  ┌────┴─────────────────────────────────────────────────────┐  │
│  │ Sidebar.tsx                                               │  │
│  │  - <SortMenu />  (popover obok '+')                       │  │
│  │  - useEffect: loadActivity() na mount                     │  │
│  │  - useEffect: getCurrentWebviewWindow()                   │  │
│  │      .listen('tauri://focus', loadActivity)               │  │
│  │  - lista renderowana z selectSortedProjects()             │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                  │
│  selectSortedProjects(state) — pure function:                    │
│    switch (state.sortMode):                                      │
│      'manual':   sort by sortOrder ASC, createdAt ASC            │
│      'alpha':    sort by name.localeCompare({sensitivity:'base'})│
│      'activity': sort by (activity[id] ?? 0) DESC                │
└──────────────────────────────────────────────────────────────────┘
                            │
                            │ tauri.invoke
                            ▼
┌──────────────────────────────────────────────────────────────────┐
│ Backend (Rust / Tauri)                                           │
│                                                                  │
│  get_projects_activity(state) -> AppResult<HashMap<i64, i64>>    │
│   1. list projects from DB                                       │
│   2. dla każdego: build path ~/.claude/projects/<claude_dir>/    │
│   3. read_dir, filter *.jsonl, for each f: fs::metadata.modified │
│   4. take max(mtime_ms), skip if no jsonl files                  │
│   5. zwróć tylko projekty z sesją (mapa może być mniejsza niż    │
│      liczba projektów)                                           │
└──────────────────────────────────────────────────────────────────┘
```

## 4. Komponenty / pliki

### Backend (Rust)

**NEW:** `src-tauri/src/commands/activity.rs`
```rust
#[tauri::command]
pub fn get_projects_activity(state: State<AppState>) -> AppResult<HashMap<i64, i64>>
```

**MODIFY:** `src-tauri/src/commands/mod.rs` — dodać `pub mod activity;`.

**MODIFY:** `src-tauri/src/lib.rs` — zarejestrować `commands::activity::get_projects_activity` w `generate_handler!`.

### Frontend

**NEW:** `src/types/SortMode.ts`
```ts
export type SortMode = 'manual' | 'alpha' | 'activity';
```
(Lub inline w `settingsSlice.ts` jeśli plik typów wydaje się przesadą.)

**MODIFY:** `src/store/settingsSlice.ts`
- Dodać `sortMode: SortMode` (default `'manual'`).
- Dodać `setSortMode(mode: SortMode)`.

**MODIFY:** `src/store/index.ts`
- Dodać `'sortMode'` do `PERSISTED_KEYS`.
- Rozszerzyć typ `Persisted` o `sortMode?: SortMode`.
- Dodać case w `serializeValue`/`deserializeValue` — string union, trivial `String(value)` / cast.
- Dodać case w `applyPersistedToState` — `if (p.sortMode !== undefined) patch.sortMode = p.sortMode;`.
- Dodać `sortMode` do return value `pickPersistedFields`.

**MODIFY:** `src/store/projectsSlice.ts`
- Dodać `activity: Record<number, number>` (default `{}`).
- Dodać `loadActivity(): Promise<void>` z flagą `inFlight` (zapobiega równoczesnym callom).

**NEW or inline:** `selectSortedProjects(state: AppState): Project[]` — pure selector.
- Inline w `projectsSlice.ts` jako eksportowana funkcja (zgodne z konwencją codebase'u — brak `selectors/` katalogu obecnie).

**MODIFY:** `src/lib/tauri.ts`
- Dodać `getProjectsActivity(): Promise<Record<number, number>>` wrapper.

**MODIFY:** `src/components/shared/Icon.tsx`
- Dodać ikonę `'sort'` (arrows-up-down lub similar — sprawdzić istniejący zestaw, użyć tej samej biblioteki).

**NEW:** `src/components/sidebar/SortMenu.tsx`
- Renderuje przycisk z ikoną sortowania.
- Klik → otwiera popover z 3 opcjami (manual, alpha, activity).
- Highlightuje aktywny tryb (checkmark lub akcent).
- onClick danej opcji → `setSortMode(mode)` + zamyka popover.

**MODIFY:** `src/components/sidebar/Sidebar.tsx`
- Render `<SortMenu />` obok `+` w nagłówku.
- `useEffect`: na mount wywołaj `loadActivity()`.
- `useEffect`: `getCurrentWebviewWindow().listen('tauri://focus', loadActivity)` z cleanup.
- Zmienić `const projects = useStore(s => s.projects);` na selektor sortujący — np. `useStore(selectSortedProjects)` lub deriwowane w komponencie.

## 5. Selektor sortowania (pełny kod)

```ts
export function selectSortedProjects(state: AppState): Project[] {
  const arr = [...state.projects];
  switch (state.sortMode) {
    case 'manual':
      return arr.sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt - b.createdAt);
    case 'alpha':
      return arr.sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
      );
    case 'activity': {
      const act = state.activity;
      return arr.sort((a, b) => (act[b.id] ?? 0) - (act[a.id] ?? 0));
    }
  }
}
```

`localeCompare` z `sensitivity: 'base'` — case-insensitive, świadome polskich znaków (ą obok a). Brak sesji → mtime traktowany jako 0 → projekt na końcu listy w trybie activity.

## 6. Save flow

`sortMode` to zwykły klucz w PERSISTED_KEYS:
- Sync boot: `loadFromLocalStorage()` → `applyPersistedToState({ sortMode: 'activity', ... })` → state ma sortMode.
- User klika SortMenu → `setSortMode('alpha')` → subscribe fires → diff wykrywa zmianę `sortMode` → zapisuje do localStorage + `tauri.setSetting('sortMode', 'alpha')` (fire-and-forget).
- Restart: hydrateFromSqlite Case 2 → state ma poprawny sortMode.

Zero dodatkowego kodu po stronie persystencji.

## 7. loadActivity flow

```ts
let activityInFlight = false;

loadActivity: async () => {
  if (activityInFlight) return;
  activityInFlight = true;
  try {
    const activity = await tauri.getProjectsActivity();
    set({ activity });
  } catch (err) {
    console.error('[projects] loadActivity failed', err);
  } finally {
    activityInFlight = false;
  }
}
```

Wywołania:
- Mount w `Sidebar.tsx` (initial population).
- `tauri://focus` listener (after window-blur work, np. terminal).

## 8. Edge cases

| Sytuacja | Zachowanie |
|---|---|
| Projekt bez sesji (`.claude/projects/<dir>/` nie istnieje LUB jest pusty) | Backend pomija w mapie; frontend `activity[id] === undefined` → traktowane jako `mtime = 0`; projekt na końcu w trybie activity |
| Pierwsze uruchomienie po update | `sortMode` nie ma w SQLite/localStorage → state pozostaje przy slice default `'manual'` → identyczne zachowanie jak przed feature |
| Focus event w trakcie ładowania activity | Flaga `activityInFlight` — drugi call pomijany |
| Bardzo wiele projektów (50+) z dużą liczbą sesji | `fs::metadata` per file: ~0.1-1ms × N. Dla 50 projektów × 20 sesji = ~1000 stat-callów = <100ms. Akceptowalne. |
| Projekt usunięty z DB ale `.claude/projects/<dir>/` zostaje | Backend list_projects nie zwraca usuniętego → nie zostanie zeskanowany — nieistotne. |
| Tryb 'activity' gdy wszystkie projekty mają identyczny lub brak mtime | Stabilne sortowanie (Array.sort jest stable od ES2019), kolejność wejściowa zachowana — czyli ta z DB |
| Race: user zmienia sortMode w trakcie loadActivity | Brak race — `set({ activity })` i `setSortMode()` to niezależne aktualizacje state'u. Selektor reagencja Zustand widzi obie. |

## 9. Testy

**Rust:** `commands/activity.rs` test:
- Tymczasowy katalog z `.claude/projects/<encoded>/session-1.jsonl` z mtime T1, `session-2.jsonl` z mtime T2 > T1.
- Wstaw projekt do DB z odpowiednim `claude_dir`.
- Wywołaj `get_projects_activity` → sprawdź mapa zwraca `{project_id: T2}`.
- Drugi test: projekt bez sesji nie pojawia się w mapie.

**Frontend:** manual:
1. Trzy tryby zmieniają widoczną kolejność listy.
2. Wybór trybu przeżywa restart aplikacji.
3. Refresh on focus: zewnętrznie zmień mtime pliku JSONL (`touch ~/.claude/projects/<dir>/sess.jsonl`), schowaj okno → focus → projekt na górze w trybie activity.
4. Projekt nowy bez sesji ląduje na końcu w activity-sort.
5. Polskie znaki w nazwie projektu sortują się poprawnie w trybie alpha (np. "Łódź" obok "Lublin", nie na końcu).

## 10. Out of scope

- Drag-and-drop w UI (nie istnieje obecnie; jeśli kiedyś zostanie dodany, sortMode!=='manual' wyłączy go).
- Animacja FLIP przy zmianie kolejności.
- Sekundarne klucze sortowania (np. „aktywność potem alfabetycznie").
- Custom direction toggle (asc/desc per mode).
- Sortowanie sesji wewnątrz projektu (osobna sprawa).
- Backend cache mtime (refresh-on-focus jest wystarczająco szybki).

## 11. Decyzje, które wpłyną na przyszłość

- **`activityInFlight` flag** — proste rozwiązanie dla bardzo prostego problemu. Jeśli kiedyś dojdzie więcej źródeł activity (np. push events z watchera), warto rozważyć abstrakcję.
- **Selector w `projectsSlice`** — jeśli pojawi się więcej derived state, warto wyekstrahować `src/store/selectors.ts`. Dziś byłoby przedwczesne (jeden selektor).
- **`SortMode` jako string union** — alternatywą byłaby tabela `enum` w Rust + ts-rs export, ale dla 3 wartości po stronie frontu to overkill.
