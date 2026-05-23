# Spec A — Settings Persistence Migration (localStorage → SQLite)

**Date:** 2026-05-23
**Project path:** `/home/pszweda/projects/cyberstudio/AbeonCode`
**Status:** Draft for implementation planning
**Successor:** Spec B — Project sort feature (depends on this)

## 1. Cel

Przenieść warstwę persystencji ustawień użytkownika z `localStorage` (obecnie jedyne źródło prawdy) do tabeli `settings` w SQLite (autorytatywne źródło). `localStorage` pozostaje jako synchroniczny cache dla instant-loadu przy starcie aplikacji.

Zmiana jest **niewidoczna dla użytkownika**: wszystkie obecne ustawienia (motyw, szerokości paneli, modele, baza projektów, displayName, skipPermissions) działają identycznie. Tylko warstwa storage się zmienia.

**Powód:**
- SQLite żyje w katalogu app-data, jest trwalsze niż `localStorage` (które bywa czyszczone przez przeglądarki/WebView).
- Otwiera drogę do czytania ustawień z backendu (Rust) w przyszłości — bez konieczności kolejnej migracji.
- Spec B (sortowanie projektów) korzysta z tej warstwy dla klucza `sidebar_sort_mode`.

## 2. Decyzje kluczowe

| Obszar | Decyzja | Powód |
|---|---|---|
| Storage truth | SQLite tabela `settings` | Trwałość, otwiera drogę dla backend reads |
| Sync cache | `localStorage` | Eliminuje async-load flash przy starcie |
| Strategia loadu | Sync localStorage → render → async SQLite reconcile | Najlepszy UX, brak loading gate'u |
| Schema | One row per key, complex values jako JSON string | Granularne update'y, czytelne SQL |
| Save strategy | Diff-based: tylko zmienione klucze → `setSetting()` | Mniej IPC niż dump-all |
| Migracja | Jednorazowa, automatyczna, idempotentna z flagą `migrated_v2` | Bezstratna dla istniejących użytkowników |
| Backend reads | Nie na razie — generyczne API `get_setting(key)` | YAGNI, łatwo dodać typed access później |
| Error handling | Fire-and-forget z `console.error`, brak toastów | UX > guarantee na każdym tracku ustawienia |

## 3. Architektura

```
┌──────────────────────────────────────────────────────────────────┐
│ Frontend (React + Zustand)                                       │
│                                                                  │
│  store/index.ts                                                  │
│    Boot (sync, top-level module):                                │
│      1. read localStorage → apply to state → first render        │
│    Boot (async, after mount):                                    │
│      2. tauri.getAllSettings()                                   │
│      3. reconcile (Case 1–4 below)                               │
│    On state change (subscribe handler):                          │
│      4. diff vs prevSnapshot                                     │
│      5. write localStorage (instant)                             │
│      6. tauri.setSetting() per changed key (fire-and-forget)     │
└──────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌──────────────────────────────────────────────────────────────────┐
│ Backend (Rust / Tauri)                                           │
│                                                                  │
│  commands/settings.rs (dopisać):                                 │
│    get_setting(key: String) -> Option<String>                    │
│    get_all_settings() -> HashMap<String, String>                 │
│    set_setting(key: String, value: String) -> ()                 │
│    delete_setting(key: String) -> ()                             │
│                                                                  │
│  db/settings_repo.rs (nowe):                                     │
│    get / get_all / set / delete                                  │
│                                                                  │
│  Tabela settings (już istnieje, migrations/001_initial.sql:22):  │
│    key TEXT PRIMARY KEY, value TEXT NOT NULL                     │
└──────────────────────────────────────────────────────────────────┘
```

## 4. Reconciliation cases na boot

| Case | localStorage | SQLite | Akcja |
|---|---|---|---|
| 1 | ma dane, brak `migrated_v2` | pusty | **Migracja jednorazowa**: writeAll(localStorage) → SQLite. Set `migrated_v2='1'` w SQLite. |
| 2 | ma dane | ma dane | No-op gdy zgodne; różnice → SQLite wygrywa, nadpisz state + localStorage |
| 3 | pusty | ma dane | SQLite wygrywa: hydratuj state + zapisz cache do localStorage |
| 4 | pusty | pusty | Defaults (świeża instalacja) |

**Idempotencja:** Flaga `migrated_v2` w tabeli `settings` zapobiega podwójnej migracji. Po jej ustawieniu, localStorage nie jest już brane pod uwagę jako źródło migracji — jest tylko cache.

## 5. Save flow (subscribe)

```ts
let prevSnapshot = pickPersistedFields(useStore.getState());

useStore.subscribe((state) => {
  const next = pickPersistedFields(state);
  const changed = diffKeys(prevSnapshot, next);   // ["theme"] gdy theme się zmienił
  if (changed.length === 0) return;

  // 1. Cache localStorage (synchronicznie, całość)
  localStorage.setItem(PERSIST_KEY, JSON.stringify(next));

  // 2. SQLite per-key (async, fire-and-forget)
  for (const key of changed) {
    const value = serialize(next[key]);            // JSON.stringify dla obiektów
    tauri.setSetting(key, value).catch(err => console.error('setSetting', key, err));
  }

  prevSnapshot = next;
});
```

**Diff dla obiektów:** `modelEfforts`, `customModels` to obiekty. Diff przez stable JSON.stringify (sort keys). Dla 1-poziomowych obiektów wystarczające.

## 6. Komponenty / pliki

### Backend (Rust)

**Nowy plik:** `src-tauri/src/db/settings_repo.rs`
```rust
pub fn get(conn: &Connection, key: &str) -> AppResult<Option<String>>
pub fn get_all(conn: &Connection) -> AppResult<HashMap<String, String>>
pub fn set(conn: &Connection, key: &str, value: &str) -> AppResult<()>  // INSERT OR REPLACE
pub fn delete(conn: &Connection, key: &str) -> AppResult<()>
```
Tests: roundtrip (set→get), get_all returns all rows, set overwrites, delete removes.

**Zmienić:** `src-tauri/src/commands/settings.rs`
- Dopisać 4 komendy `#[tauri::command]` wokół `settings_repo`.
- Wszystkie komendy biorą `State<AppState>`, używają `state.db.get()?`.

**Zmienić:** `src-tauri/src/lib.rs`
- Dodać do `generate_handler!`: `get_setting`, `get_all_settings`, `set_setting`, `delete_setting`.

**Zmienić:** `src-tauri/src/db/mod.rs`
- Eksportować `pub mod settings_repo;` (sprawdzić istniejący wzorzec).

### Frontend

**Zmienić:** `src/lib/tauri.ts`
- Dodać:
  ```ts
  getSetting(key: string): Promise<string | null>
  getAllSettings(): Promise<Record<string, string>>
  setSetting(key: string, value: string): Promise<void>
  deleteSetting(key: string): Promise<void>
  ```

**Zmienić:** `src/store/index.ts` (najwięcej zmian)
- Zachować obecny sync load z localStorage (linie 43-57).
- Wyekstrahować `PERSISTED_KEYS` jako tablicę nazw (`['theme', 'leftWidth', ...]`), żeby diff i serializacja były spójne.
- Dodać helper `pickPersistedFields(state)` + `serialize(value)`.
- Przerobić subscribe (linie 59-75): trzymać `prevSnapshot`, diffować, wywoływać `setSetting` per klucz.
- Dodać `hydrateFromSqlite()`: top-level async IIFE po sync-loadzie, wywołuje `getAllSettings`, reconciluje wg Case 1-4.
- Po hydratacji ustawić `prevSnapshot` od nowa, żeby reconcile nie wywołał kaskady setSetting'ów.

**Hydracja — gdzie wywołać:**
Top-level `void hydrateFromSqlite()` w `store/index.ts` po sync-loadzie. To IIFE startuje async, ale moduł eksportuje już wypełniony store. React mount na podstawie localStorage; gdy SQLite wróci (~10-20ms), `setState` zaktualizuje pola które się różniły.

## 7. Serializacja wartości

| Field | Type | Serialize | Deserialize |
|---|---|---|---|
| `theme` | `'dark'\|'light'\|'system'` | `value as string` | `value as ThemeMode` |
| `leftWidth`, `rightWidth` | `number` | `String(n)` | `Number(v)` + clamp |
| `displayName`, `defaultModelId`, `projectsBasePath` | `string` | identycznie | identycznie |
| `skipPermissions` | `boolean` | `String(b)` (`"true"` / `"false"`) | `v === 'true'` |
| `modelEfforts` | `Record<string, EffortLevel>` | `JSON.stringify` | `JSON.parse` |
| `customModels` | `CustomModel[]` | `JSON.stringify` | `JSON.parse` |

Helper `serialize(value): string` z dispatchem po typie. Helper `deserializePersisted(map): Partial<Persisted>` parsuje `Record<string, string>` z SQLite na typowane pola, z walidacją i ignorowaniem nieznanych kluczy.

## 8. Edge cases

| Sytuacja | Zachowanie |
|---|---|
| SQLite locked/busy | `set_setting` zwraca error, frontend loguje `console.error`, nie crashuje. `localStorage` zachowuje zmianę. Następny restart przeczyta z localStorage (Case 1 ponownie, ale `migrated_v2` już ustawione w przypadku gdy `set_setting` udał się dla niego — w przeciwnym razie migracja spróbuje ponownie). |
| Pre-migration boot + zmiana ustawienia w pierwszych 50 ms | Race window: zmiana zapisuje się do localStorage natychmiast, do SQLite async. Jeśli SQLite reconcile (Case 1) dzieje się równolegle, używamy `prevSnapshot` z momentu PO sync-loadzie, więc zmiana jest detekowana jako zmiana i lecimy z setSetting. Bezpieczne. |
| User edytuje ręcznie tabelę `settings` w SQLite | Po restarcie zmiany załadują się (Case 2 nadpisze localStorage). |
| `customModels` ma kilkaset KB JSON | TEXT w SQLite OK, ale zapis blokuje WAL — fire-and-forget w Rust biegnie w tokio runtime, więc UI nie ucierpi. |
| Stary localStorage zostaje po migracji | Świadomy wybór: zostawiamy jako fallback przez kilka wersji. Można usunąć w późniejszej iteracji. |
| User restoruje DB z backupu (ma starsze ustawienia w SQLite niż w localStorage) | Case 2: SQLite wygrywa. Świadomy wybór — SQLite jest „truth". |

## 9. Testy

**Rust (`settings_repo.rs` tests):**
1. `set_get_roundtrip` — set("k","v") → get("k") == "v".
2. `set_overwrites` — set("k","v1") + set("k","v2") → get == "v2".
3. `get_all_returns_all` — 3× set → get_all().len() == 3, mapa zawiera wszystkie.
4. `delete_removes` — set + delete + get == None.
5. `get_missing_returns_none` — get("nonexistent") == None.

**Frontend (manual):**
1. **Fresh install** — wyczyść `~/.local/share/AbeonCode/` i localStorage → odpal → wszystkie defaults.
2. **Migracja** — pre-migration build ustaw motyw=light, leftWidth=300 → upgrade do nowego builda → restart → ustawienia zachowane, sprawdź `SELECT * FROM settings` (8+ rows + `migrated_v2`).
3. **Persistence po restarcie** — zmień theme → quit → restart → theme zachowany.
4. **Recovery z localStorage** — wyczyść localStorage przez devtools → restart → ustawienia ładują się z SQLite (Case 3).
5. **Diff save** — zmień theme → otwórz devtools network/console → tylko 1 invoke setSetting (`theme`), nie 8.
6. **Failure mode** — symuluj błąd Rust (np. uszkodzona DB) → ustawienia działają w sesji (localStorage), `console.error` widoczny.

## 10. Out of scope

- Cleaup starego `localStorage` po migracji (zostawiamy jako fallback).
- Backend reads (Rust czytający settings dla własnej logiki) — przyjdzie z konkretną potrzebą.
- Typed registry kluczy (string union dla `SettingKey`) — można dodać refactorem później.
- Multi-window sync — apka jest single-instance.
- Atomic transactions na wielu kluczach naraz.
- UI dla resetu wszystkich ustawień (opcjonalna funkcja, oddzielna sprawa).

## 11. Wpływ na Spec B

Po wdrożeniu tego speca, Spec B dodaje *jedno nowe pole* (`sortMode`) do `PERSISTED_KEYS` i korzysta z istniejącego mechanizmu bez dodatkowej infrastruktury.
