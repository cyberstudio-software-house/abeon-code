# AbeonCode — Design Spec

**Date:** 2026-05-21
**Project path:** `/home/pszweda/projects/cyberstudio/AbeonCode`
**Status:** Draft for implementation planning

## 1. Cel

Desktopowa aplikacja (Tauri 2) do zarządzania wieloma sesjami Claude Code z jednego miejsca: lista projektów, podgląd historii sesji, wbudowany terminal do kontynuacji rozmowy oraz panel boczny z akcjami (npm/composer/ddev/docker/make) i statusem git.

Aplikacja czyta sesje bezpośrednio z `~/.claude/projects/<encoded-path>/<session-uuid>.jsonl` — JSONL jest źródłem prawdy, nie duplikujemy danych do własnej bazy.

**Encoding ścieżek przez Claude Code:** absolutna ścieżka projektu z `/` zamienionym na `-` (np. `/home/pszweda/projects/cyberstudio/AbeonCode` → `-home-pszweda-projects-cyberstudio-AbeonCode`). Encoding jest nieinformacyjny przy dekodowaniu (nie wiadomo gdzie jest granica katalogu, jeśli nazwa zawiera `-`), więc:
- Przy **dodawaniu projektu** kodujemy `path` w aplikacji żeby ustalić `claude_dir`
- Przy **listowaniu sesji** czytamy prawdziwy `cwd` z pierwszego rekordu JSONL (gdzie jest dostępny) i porównujemy z `projects.path` — to gwarancja, że nie pomylimy projektu

## 2. Decyzje kluczowe

| Obszar | Decyzja |
|---|---|
| Platformy | Linux (główny) + macOS |
| Stack | Tauri 2, Rust backend, React 18 + TS + Vite frontend |
| Odkrywanie projektów | Ręczne dodawanie + auto-detekcja skryptów przy dodawaniu |
| Terminal | Wbudowany xterm.js + `portable-pty` (Rust) |
| Render historii | Pełny chat-view: user/assistant/tools/thinking + chat bubbles + markdown |
| Akcje | Ręcznie pinowane per projekt, tab-per-akcja w centrum |
| Prawy panel | Pionowy split: akcje u góry, git u dołu |
| Motyw | Ciemny + jasny (przełącznik, plus opcja "system") |
| Storage | SQLite (`~/.config/AbeonCode/abeoncode.db`) — tylko konfiguracja |

## 3. Stack techniczny

**Backend (Rust):**
- `tauri` 2.x (framework)
- `tokio` (async runtime)
- `portable-pty` (PTY cross-platform, Linux/macOS)
- `notify` (file watcher dla JSONL i git)
- `git2` (git status)
- `rusqlite` + `r2d2` (lokalna baza)
- `serde` + `serde_json` (JSONL parsing, typy współdzielone z TS)
- `thiserror` (AppError)

**Frontend (TypeScript):**
- React 18 + Vite
- Tailwind CSS (CSS variables dla motywów)
- `zustand` (state management, podzielony na slices)
- `@xterm/xterm` + `@xterm/addon-fit` + `@xterm/addon-web-links`
- `react-virtuoso` (wirtualizacja długich list — historia sesji)
- `react-markdown` + `remark-gfm` + `rehype-raw` (render markdown w wiadomościach)
- `shiki` (highlighting bloków kodu)
- `sonner` lub `react-hot-toast` (toasty)
- `@tauri-apps/api` (bridge)

## 4. Architektura

```
┌──────────────────────────────────────────────────────────────────┐
│                     Frontend (React)                              │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────────────────┐  │
│  │ Sidebar      │  │ CenterPanel  │  │ RightPanel             │  │
│  │ (Projects +  │  │ (Tabs:       │  │ (Actions top,          │  │
│  │  Sessions)   │  │  History |   │  │  Git bottom)           │  │
│  │              │  │  Terminal |  │  │                        │  │
│  │              │  │  ActionLog)  │  │                        │  │
│  └──────────────┘  └──────────────┘  └────────────────────────┘  │
│                          │                                        │
│           Tauri invoke (commands) / Tauri events                  │
└──────────────────────────┼────────────────────────────────────────┘
                           │
┌──────────────────────────┼────────────────────────────────────────┐
│                    Backend (Rust)                                  │
│  ┌───────────────┐  ┌────────────┐  ┌──────────────────────────┐  │
│  │ Projects      │  │ Sessions   │  │ PTY Manager              │  │
│  │ (SQLite)      │  │ (JSONL     │  │ (portable-pty)           │  │
│  └───────────────┘  │  reader +  │  │                          │  │
│  ┌───────────────┐  │  watcher)  │  └──────────────────────────┘  │
│  │ Git (git2)    │  └────────────┘  ┌──────────────────────────┐  │
│  └───────────────┘  ┌────────────┐  │ Settings                 │  │
│                     │ Detectors  │  └──────────────────────────┘  │
│                     │ (npm,      │                                │
│                     │  composer, │                                │
│                     │  make,     │                                │
│                     │  ddev,     │                                │
│                     │  docker)   │                                │
│                     └────────────┘                                │
└────────────────────────────────────────────────────────────────────┘
```

## 5. Model danych

### SQLite (`~/.config/AbeonCode/abeoncode.db`)

```sql
CREATE TABLE projects (
  id           INTEGER PRIMARY KEY,
  name         TEXT NOT NULL,
  path         TEXT NOT NULL UNIQUE,
  claude_dir   TEXT NOT NULL,
  color        TEXT,
  sort_order   INTEGER DEFAULT 0,
  created_at   INTEGER NOT NULL
);

CREATE TABLE actions (
  id           INTEGER PRIMARY KEY,
  project_id   INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  label        TEXT NOT NULL,
  command      TEXT NOT NULL,
  working_dir  TEXT,
  source       TEXT,                -- 'npm'|'composer'|'make'|'ddev'|'docker'|'manual'
  sort_order   INTEGER DEFAULT 0
);

CREATE TABLE settings (
  key          TEXT PRIMARY KEY,
  value        TEXT NOT NULL
);
```

### Typy domenowe (Rust → współdzielone z TS przez `serde`)

```rust
struct Project { id, name, path, claude_dir, color, sort_order, created_at }
struct Action { id, project_id, label, command, working_dir, source, sort_order }

struct SessionMeta {
  id: String,                    // UUID z nazwy pliku
  project_id: i64,
  title: String,                 // pierwszy user prompt skrócony do ~80 znaków; fallback: pierwszy assistant text; fallback: timestamp "YYYY-MM-DD HH:mm"
  message_count: usize,
  last_modified: i64,            // unix ms
  git_branch: Option<String>,
  cwd: Option<String>,
}

enum HistoryBlock {
  UserText { text, timestamp, uuid },
  AssistantText { text, timestamp, uuid },
  AssistantThinking { text, timestamp, uuid },
  ToolUse { name, input_summary, raw_input, timestamp, uuid },
  ToolResult { content, is_error, timestamp, uuid },
  Attachment { kind, name, timestamp, uuid },
  System { subtype, message, timestamp, uuid },
}
```

### Parsowanie JSONL

- Backend trzyma file handle + offset per otwartą sesję
- Filtrowanie w Rust: pomijamy rekordy typów `queue-operation`, `last-prompt` (infrastruktura)
- Initial read: tail ostatnich `limit` (default 200) rekordów
- "Załaduj wcześniejsze" — kolejne strony wstecz przez `before_uuid`
- Watcher `notify` na każdym otwartym pliku → emit `session:<id>:append`

## 6. Struktura komponentów frontendowych

```
App
├── ThemeProvider                       // dark|light|system, CSS vars
├── Layout (3-column resizable)
│   ├── Sidebar (240–320px)
│   │   ├── ProjectList
│   │   │   └── ProjectItem
│   │   │       ├── ProjectHeader      // name, chevron, kebab menu
│   │   │       └── SessionList        // 5 ostatnich + "Załaduj starsze"
│   │   │           └── SessionItem
│   │   └── AddProjectButton           // → AddProjectDialog
│   │
│   ├── CenterPanel (flex 1)
│   │   ├── TabBar                     // taby zamykalne, drag-reorder
│   │   └── TabContent
│   │       ├── HistoryView            // virtualized chat
│   │       │   ├── HistoryHeader      // title, meta, [▶ Kontynuuj]
│   │       │   └── HistoryStream      // react-virtuoso
│   │       │       └── HistoryBlock   // bubble | tool card | thinking collapse
│   │       ├── TerminalView           // xterm.js connected
│   │       └── ActionLogView          // xterm.js dla outputu akcji
│   │
│   └── RightPanel (260–340px)
│       ├── ActionsSection (top half)
│       │   ├── ActionsHeader          // "Akcje" + [+ Dodaj]
│       │   └── ActionList
│       │       └── ActionRow          // ▶/■ label, status dot, kebab
│       └── GitSection (bottom half)
│           ├── GitHeader              // "Zmiany · <branch>" + refresh
│           └── GitFileList
│               └── GitFileRow         // M/A/D/? + path
│
└── Dialogs
    ├── AddProjectDialog               // path picker + wykryte skrypty (checkboxy)
    ├── EditActionDialog
    └── ConfirmDialog
```

### Zustand store (slices)

- `projects` — lista, akcje, expanded state
- `sessions` — załadowane sesje per projekt, blocks per session
- `tabs` — otwarte taby `{kind: 'session'|'action', id}`, aktywny tab
- `pty` — `tabId → pty_id`, połączenie z xterm
- `git` — status per projekt (cache, refresh na focus + manual)
- `settings` — theme, panel widths

## 7. API — Tauri commands i events

### Commands (request/response)

```rust
// Projekty
list_projects() -> Vec<Project>
add_project(name, path) -> Project
update_project(id, patch) -> Project
remove_project(id) -> ()
reorder_projects(ids: Vec<i64>) -> ()

// Sesje
list_sessions(project_id, limit, offset) -> Vec<SessionMeta>
read_session_history(session_id, limit?, before_uuid?) -> { meta, blocks }
open_session_watch(session_id) -> ()
close_session_watch(session_id) -> ()

// PTY
spawn_pty(kind, project_id, session_id?, action_id?, cols, rows) -> { pty_id }
pty_write(pty_id, data) -> ()
pty_resize(pty_id, cols, rows) -> ()
pty_kill(pty_id) -> ()

// Akcje
list_actions(project_id) -> Vec<Action>
detect_scripts(project_path) -> Vec<DetectedScript>
add_action(project_id, label, command, working_dir?, source) -> Action
update_action(id, patch) -> Action
remove_action(id) -> ()

// Git
git_status(project_id) -> { branch, ahead, behind, files: Vec<GitFile> }
git_refresh(project_id) -> ()

// Settings
get_setting(key) -> Option<String>
set_setting(key, value) -> ()
```

### Events (backend → frontend)

```
pty:<pty_id>:output              { data: bytes (base64) }
pty:<pty_id>:exit                { code: i32 }

session:<session_id>:append      { blocks: Vec<HistoryBlock> }
session:<session_id>:replaced    { }

git:<project_id>:changed         { status }

action:<action_id>:status        { state: 'idle'|'running'|'exited', exit_code? }
```

### Detektory skryptów

```rust
trait ScriptDetector {
    fn name(&self) -> &str;
    fn detect(&self, path: &Path) -> Vec<DetectedScript>;
}

struct DetectedScript {
    source: String,
    label: String,
    command: String,
    description: Option<String>,
}
```

MVP: `NpmDetector` (package.json scripts), `ComposerDetector` (composer.json scripts), `MakeDetector` (Makefile targets), `DdevDetector` (`.ddev/config.yaml` → start/stop/restart/ssh/logs/describe), `DockerComposeDetector` (compose.yml services → up/down/logs/ps per service).

## 8. Flowy

### Otwarcie sesji
1. `SessionItem.onClick` → tab `kind: session` (jeśli nie istnieje), aktywuj
2. `HistoryView` mount → `invoke('read_session_history', { session_id, limit: 200 })`
3. Backend zwraca `SessionMeta + Vec<HistoryBlock>` (odfiltrowane)
4. Frontend renderuje przez `react-virtuoso`
5. `invoke('open_session_watch', { session_id })` — watcher startuje, kolejne rekordy lecą eventami

### Kontynuacja sesji
1. User klika **▶ Kontynuuj sesję**
2. `invoke('spawn_pty', { kind: 'claude', project_id, session_id, cols, rows })`
3. Backend: `portable-pty` spawn `bash -lc "claude --resume <id>"` w `cwd` projektu, zwraca `pty_id` (flaga `--resume` zweryfikowana w Claude Code CLI)
4. `HistoryView` przełącza się na `TerminalView`, xterm.js subskrybuje `pty:<pty_id>:output`
5. Input z xterm → `invoke('pty_write')`
6. Watcher JSONL nadal działa — gdy Claude pisze rekordy do pliku, frontend dostaje `session:<id>:append` (do wykorzystania np. dla licznika wiadomości w tabie)
7. Zamknięcie tabu → `pty_kill` + `close_session_watch`

### Dodanie projektu
1. User klika **+ Dodaj projekt**
2. Otwiera się `AddProjectDialog` z file pickerem (Tauri `dialog::open`)
3. Po wyborze ścieżki:
   - Walidacja: katalog istnieje, jest katalogiem
   - Sprawdzenie czy `~/.claude/projects/<encoded>` istnieje — jeśli nie, ostrzeżenie (ale można dodać)
   - `invoke('detect_scripts', { project_path })` → backend uruchamia wszystkie detektory równolegle, zwraca listę
4. Dialog pokazuje wykryte skrypty pogrupowane po `source`, user zaznacza które chce dodać + może edytować label
5. User wpisuje nazwę wyświetlaną (default: nazwa katalogu)
6. Submit → `invoke('add_project', ...)` + dla każdej zaznaczonej akcji `invoke('add_action', ...)`

### Uruchomienie akcji
1. User klika **▶** przy akcji
2. `invoke('spawn_pty', { kind: 'action', project_id, action_id, cols, rows })`
3. Backend: `bash -lc "<command>"` w `working_dir` (lub `project.path`)
4. Tworzy się nowy tab z `ActionLogView` (xterm.js)
5. Akcja oznaczona jako `running` (kropka kolor żółty), klik → przełącza tab
6. Po exit → status `exited`, kolor zielony (kod 0) lub czerwony (≠0), tab pozostaje otwarty do ręcznego zamknięcia

## 9. Error handling

### AppError

```rust
enum AppError {
    NotFound(String),
    InvalidPath { path, reason },
    ClaudeDirMissing { path },
    Parse { file, line, message },
    Pty { source },
    Io(io::Error),
    Git(git2::Error),
    Db(rusqlite::Error),
}
```

### Wzorce

- Globalny `ErrorBoundary` + `Toaster` we frontendzie
- Brak `~/.claude/projects/<encoded>` przy dodawaniu → ostrzeżenie + sugestia uruchomienia `claude` w katalogu raz
- Uszkodzony JSONL → renderujemy do błędnej linii + banner "Pominięto N rekordów"
- Brak `claude` w PATH przy spawn PTY → toast z instrukcją
- PTY exit kod 0 vs ≠0 → różne kolory wizualne w tabie i akcji
- Brak repo git → `GitSection` pokazuje "Nie jest repozytorium git", nie crash
- Zamknięcie taba z żywym PTY → confirm dialog

### Edge cases

| Sytuacja | Zachowanie |
|---|---|
| Sesja live (Claude poza apką pisze do JSONL) | Watcher tailuje, blocks dochodzą automatycznie |
| JSONL 100MB | Tail od końca, paging przez `before_uuid` |
| Bardzo długi `tool_result` | `HistoryBlock` z preview 200 znaków + "rozwiń" |
| Apka ubita w trakcie spawn PTY | Drop guard po stronie Rust ubija dzieci |
| Kolizja path w `projects` | `UNIQUE` na poziomie SQLite |
| Rename JSONL przez Claude Code | `notify` → reload + emit `:replaced` |
| Resize okna | `pty_resize` throttled 100ms |
| Komendy z aliasami | Spawn przez `bash -lc` (login shell, ładuje rc) |

## 10. Bezpieczeństwo

- Tauri capabilities ograniczone:
  - `fs:allow-read`: `~/.claude/projects/**` + ścieżki projektów w SQLite
  - Brak generic `shell:allow-execute` — tylko nasz PTY manager
- Nie wysyłamy nic na zewnątrz (telemetria off domyślnie, nie ma jej)
- Brak przechowywania sekretów — apka nie ma własnych

## 11. Testowanie

- **Rust unit:** JSONL parsing (wszystkie typy bloków, edge cases), detektory (sample files), `AppError` mapping
- **Rust integration:** migracje SQLite, CRUD projektów/akcji, git status na tymczasowym repo, parsing realnych JSONL z `~/.claude/projects/` (kopiowane do tmp)
- **PTY tests:** spawn `echo`, `cat`, sprawdzenie I/O cyklu (nie testujemy Claude Code samego)
- **Frontend unit (Vitest):** każdy wariant `HistoryBlock`, reduce'y zustand
- **E2E (opcjonalne, post-MVP):** Playwright/WebDriver na 1–2 happy path
- **Smoke checklist w PR template:** dodaj projekt → otwórz sesję → kontynuuj → uruchom akcję → sprawdź git

## 12. Struktura katalogów projektu

```
AbeonCode/
├── src/                     # frontend React
│   ├── components/
│   │   ├── layout/
│   │   ├── sidebar/
│   │   ├── center/
│   │   ├── right/
│   │   ├── history/
│   │   ├── terminal/
│   │   └── dialogs/
│   ├── store/               # zustand slices
│   ├── lib/                 # bridge do Tauri, helpers
│   ├── types/               # współdzielone typy (generated z Rust przez ts-rs lub specta)
│   ├── styles/              # tailwind config, theme vars
│   ├── App.tsx
│   └── main.tsx
├── src-tauri/
│   ├── src/
│   │   ├── main.rs
│   │   ├── commands/        # po jednym module per area (projects, sessions, pty, git, actions, settings)
│   │   ├── domain/          # typy: Project, Action, SessionMeta, HistoryBlock, AppError
│   │   ├── sessions/        # JSONL reader, watcher, filtrowanie
│   │   ├── pty/             # PTY manager, drop guard
│   │   ├── detectors/       # ScriptDetector + implementacje
│   │   ├── git/             # git2 wrapper
│   │   ├── db/              # migracje, repositories
│   │   └── events/          # helpery emit
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   └── capabilities/
├── docs/
│   └── superpowers/
│       └── specs/
│           └── 2026-05-21-abeoncode-design.md  ← ten plik
├── package.json
├── vite.config.ts
├── tsconfig.json
├── tailwind.config.ts
├── .gitignore
└── README.md
```

## 13. Scope — co JEST w MVP, co NIE

**Jest:**
- Lewa kolumna z ręcznie dodawanymi projektami + lista sesji (5 ostatnich, paging)
- Środkowy panel z tabami: historia (chat bubbles), terminal (PTY), action log (PTY)
- Pełny render historii: text, thinking (collapsed), tool_use (card), attachments, markdown, code highlighting
- Prawy panel: akcje (start/stop, status) i git (branch, lista plików M/A/D/?)
- Auto-detekcja skryptów: npm, composer, make, ddev, docker-compose
- Motyw dark/light + system

**Nie jest (poza MVP):**
- Edycja JSONL / usuwanie rekordów sesji
- Synchronizacja między urządzeniami
- Telemetria / analytics
- Pluginy / rozszerzenia użytkownika
- Wbudowany edytor plików
- Git operations (commit/push/pull) — tylko status, do operacji idzie się do terminala
- Wsparcie Windows
- E2E test suite (post-MVP)
