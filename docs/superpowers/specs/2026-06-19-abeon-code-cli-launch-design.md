# `abeon-code` — uruchamianie aplikacji i sesji z konsoli

## Cel

Umożliwić wywołanie z powłoki komendy `abeon-code .` (lub `abeon-code <ścieżka>`),
która:

1. otwiera aplikację desktop AbeonCode (albo fokusuje już działającą instancję),
2. dla katalogu znajduje istniejący projekt albo tworzy nowy,
3. uruchamia w nim **nową sesję** (jak akcja „New session" w UI).

Zakres v1: Linux + macOS, działanie na **zainstalowanej** aplikacji.

## Decyzje projektowe

- **Istniejący projekt → zawsze nowa sesja.** Spójne z zachowaniem dla nowego
  projektu. Uruchomienie przechodzi przez istniejące `openNewSessionTab`, więc
  przy >1 włączonym providerze pojawia się standardowy provider-picker.
- **Nazwa nowego projektu** = basename katalogu.
- **Argument wskazujący plik** (nie katalog) → błąd; akceptujemy wyłącznie katalogi.
- **Brak argumentu** → przyjmujemy `.` (bieżący katalog).
- **Dwa punkty wejścia, jeden rdzeń:** CLI (argv) i deep-link (`abeon-code://`)
  zbiegają się w jednym handlerze frontendu `openProjectPath`.

## Architektura

### Punkty wejścia

1. **CLI (A):** wrapper `abeon-code` rozwija argument do ścieżki bezwzględnej
   i uruchamia binarkę aplikacji, przekazując ścieżkę jako argument pozycyjny.
2. **Deep-link (B):** `abeon-code://open?path=<abs>` z dowolnego źródła
   (przeglądarka, inny program), routowany do działającej instancji.

### Backend (`src-tauri/`)

- Rejestracja `tauri-plugin-single-instance` (callback: `argv`, `cwd`) oraz
  `tauri-plugin-deep-link`.
- `AppState.pending_open_paths: Mutex<Vec<String>>` — bufor ścieżek z zimnego
  startu, zanim frontend zarejestruje listenery.
- Komenda `take_pending_open_paths() -> Vec<String>` — frontend pobiera (pull)
  przy boocie; deterministycznie unika race'a z eventem.
- Komenda `find_or_create_project(path: String) -> Project` — kanonizuje ścieżkę,
  szuka istniejącego projektu, a przy braku tworzy nowy (nazwa = basename).
  Waliduje, że ścieżka istnieje i jest katalogiem.
- `projects_repo::get_by_path(conn, path) -> AppResult<Option<Project>>` — nowy
  lookup po ścieżce (dziś trzeba iterować `list()`).
- Zdarzenie `cli://open-path` emitowane do frontendu przy ciepłym starcie.
- Komenda `install_cli_command() -> AppResult<String>` — zapisuje wrapper na PATH
  (styl VS Code), zwraca ścieżkę docelową.

### Frontend (`src/`)

- Wspólny handler `openProjectPath(absPath)`:
  1. `project = await find_or_create_project(absPath)`
  2. `await loadProjects()` — sidebar widzi nowy/istniejący projekt
  3. `openNewSessionTab(project.id)` — nowa karta sesji staje się aktywna
     (to jest obserwowalne „zaznaczenie" projektu; brak osobnej akcji
     `selectProject` w store). Podniesienie okna robi Rust w `dispatch_open`.
- Boot: po hydratacji `take_pending_open_paths()` → dla każdej ścieżki handler.
- Listener `onCliOpenPath` (w `AppShell`/store) → handler.
- Ustawienia: przycisk „Zainstaluj komendę `abeon-code`" → `install_cli_command()`.

### Wrapper `abeon-code`

Skrypt powłoki lokalizujący binarkę per-OS:
- Linux: instalacja `.deb`/AppImage; wrapper w `~/.local/bin`.
- macOS: uruchamia `AbeonCode.app/Contents/MacOS/AbeonCode`; wrapper w katalogu
  zapisywalnym bez sudo (np. `~/.local/bin`) z ostrzeżeniem, jeśli nie jest na PATH.

Generowany przez `install_cli_command()` z realną ścieżką binarki
(`std::env::current_exe()`), więc nie zgadujemy lokalizacji.

## Przepływ danych

### Scenariusz 1 — app nie działa (zimny start), CLI

1. Wrapper: `path = realpath "$1"` (`.` → `$PWD`), uruchamia binarkę z argumentem.
2. Tauri `setup`: parsuje `std::env::args()`, pierwszy argument wyglądający na
   ścieżkę → `pending_open_paths.push(path)`.
3. Frontend boot: `take_pending_open_paths()` → dla każdej `openProjectPath`.

### Scenariusz 2 — app działa (ciepły start), CLI

1. Wrapper jak wyżej; drugi proces uruchamia binarkę z argumentem.
2. `tauri-plugin-single-instance` przechwytuje uruchomienie → callback
   `(app, argv, cwd)`; drugi proces kończy się sam.
3. Callback: wyłuskaj ścieżkę z `argv` (względną rozwiń względem `cwd`),
   `show()` + `unminimize()` + `set_focus()`, emituj `cli://open-path`.
4. Frontend listener → `openProjectPath`.

### Scenariusz 3 — deep-link

- App nie działa (Linux/Windows): OS uruchamia binarkę z URL-em jako jedynym
  argumentem CLI, więc obsługuje go **ten sam tor co Scenariusz 1** —
  `scan_args_into_pending` → `parse_open_input` rozpoznaje schemat
  `abeon-code://` → `pending_open_paths.push` → pull przy boocie.
  (Plugin emituje `deep-link://new-url` w fazie setupu pluginu, zanim
  zarejestrujemy `on_open_url`, więc cold-startu nie łapiemy przez handler —
  tor argv go pokrywa.) macOS dostarcza cold-start przez `RunEvent::Opened` /
  `on_open_url` — wymaga manualnego smoke-testu.
- App działa: URL przekazany do instancji → `on_open_url` parsuje → emit
  `cli://open-path`.

### Wspólny rdzeń

```
project = await find_or_create_project(absPath)
await loadProjects()
openNewSessionTab(project.id)   // nowa karta sesji = aktywny projekt
```

## Obsługa błędów i przypadki brzegowe

- **Kanonizacja** przez `std::fs::canonicalize` — rozwiązuje symlinki i `..`,
  jeden katalog → jeden projekt (spójne z UNIQUE na `path`).
- **Ścieżka nie istnieje / nie jest katalogiem** → `AppError`; frontend pokazuje
  błąd i nie tworzy projektu. Prezentacja: istniejący toast/inline, a w razie
  braku — `tauri-plugin-notification` (do potwierdzenia przy implementacji).
- **Brak argumentu** → wrapper podstawia `.`.
- **Argument = plik** → błąd.
- **Wiele szybkich wywołań** → `pending_open_paths` jako kolejka; każde otwiera
  własną sesję.
- **Zły/niezakodowany `path` w deep-linku** → parsujemy ostrożnie, błąd ignorujemy.
- **Argv ze śmieciami/flagami** → bierzemy pierwszy argument wyglądający na ścieżkę
  (`/`, `.`, `~`).
- **Okno ukryte/zminimalizowane** → `show()` + `unminimize()` + `set_focus()`.

## Konfiguracja OS

- `tauri.conf.json`: konfiguracja `deep-link` ze schematem `abeon-code`
  (Linux: wpis `.desktop` z `x-scheme-handler`; macOS: `CFBundleURLTypes`).
  Aktywne po instalacji aplikacji.

## Testy

### Rust (unit)

- `projects_repo::get_by_path` — trafienie i brak.
- `find_or_create_project` — kanonizacja, nazwa = basename, walidacja
  (katalog / plik / nieistniejący), idempotencja (drugie wywołanie nie tworzy
  duplikatu).
- Parser argv (wybór pierwszego argumentu-ścieżki).
- Parser URL deep-link (`?path=`).

### Frontend (Vitest)

- `openProjectPath` z mockiem `lib/tauri.ts`: kolejność
  `find_or_create_project` → `loadProjects` → `openNewSessionTab`;
  obsługa błędu z komendy.

### Manualne (udokumentowane w docs)

- Zimny i ciepły start przez CLI.
- Deep-link przy działającej i niedziałającej aplikacji.
- Instalacja komendy z Ustawień i działanie na świeżym shellu.

(Routing single-instance/deep-link jest trudny do zautomatyzowania w CI.)

## Poza zakresem (v1)

- Windows (wymaga osobnej instalacji wrappera i rejestracji schematu).
- Wznawianie ostatniej sesji zamiast tworzenia nowej.
- Otwieranie pliku → katalog nadrzędny.
- Przekazywanie dodatkowych flag (np. wybór providera) z CLI.
