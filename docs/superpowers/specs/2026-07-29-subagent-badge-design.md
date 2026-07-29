# Odznaka subagentów przy sesji i podgląd ich pracy

Data: 2026-07-29
Zakres: `DesktopApp/`

## Cel

Pokazać przy sesji, że pracują dla niej subagenty Claude Code, dać dostęp do listy tych
agentów i pozwolić otworzyć transcript pracy każdego z nich. Przy okazji naprawić
wyliczanie aktywności, które w czasie pracy subagentów pokazuje sesję jako czekającą na
użytkownika.

## Stan obecny

- Claude Code zapisuje subagenty poza głównym logiem sesji:
  `~/.claude/projects/<encoded>/<sessionId>/subagents/agent-<agentId>.jsonl`
  plus `agent-<agentId>.meta.json` z `{agentType, description, toolUseId, spawnDepth}`.
  Format linii w pliku agenta jest identyczny z głównym logiem.
- Start agenta w głównym logu to `tool_use` o nazwie `Agent`. Odpowiadający `tool_result`
  przychodzi po ~200 ms i potwierdza **start**, nie wynik — agenty domyślnie pracują w tle.
- Koniec agenta to wiadomość `user` w głównym logu zawierająca `<task-notification>`
  z `<task-id>` równym `agentId` oraz `<tool-use-id>`.
- `sessions/activity.rs` rozstrzyga aktywność po ostatnim znaczącym zdarzeniu w ogonie
  (8 KB) głównego logu. Blok `Agent` jest dla niej rozwiązany, więc po starcie agentów
  ostatnim zdarzeniem bywa tekst asystenta → `WaitingUser`.
- `sessions/watcher.rs` przelicza aktywność wyłącznie dla sesji, której główny plik się
  zmienił (`handle_change`, `RecursiveMode::NonRecursive`). Zapisy do `subagents/` nie
  generują zdarzeń, więc powiadomienie o uwagę zwykle nie powstaje.
- `store/sessionsSlice.ts` odpytuje `list_sessions` co 10 s dla wszystkich sesji projektu.
  To ta ścieżka wyświetla fałszywe „czeka na Ciebie" przez cały czas pracy agentów.
- `TabContent.tsx` renderuje tab sesji jako `history` **albo** `terminal`. Zmiana trybu
  odmontowuje `TerminalView`, którego cleanup zabija PTY.

Pomiar na sesji `81dfbad8` (2026-07-01): start agentów 05:15:46 i 05:15:56, ostatni zapis
do głównego logu 05:16:10, faktyczny koniec agentów 05:17:20. Przez 70 s sidebar pokazywał
sesję jako czekającą na użytkownika.

## Decyzje projektowe

1. **Odznaka obejmuje agenty pracujące i zakończone.** Licznik i kolor akcentu dotyczą
   pracujących; podlista wymienia wszystkie, bo po zakończeniu agenta jego praca jest
   dziś nieodzyskiwalna z poziomu aplikacji.
2. **Kliknięcie agenta otwiera jego transcript**, czytany istniejącym `parse_line()`.
3. **Transcript żyje wewnątrz taba sesji**, jako warstwa nad dotychczasowym widokiem.
   Bez nowego rodzaju zakładki, więc strażnik zamykania, seedowanie okien wydzielonych
   i `capabilities/default.json` pozostają bez zmian.
4. **Żywe agenty wymuszają `Running`.** Enum `SessionActivity` nie zyskuje wariantu, więc
   kontrakt z aplikacją mobilną (`domain/roster.rs`) i mapy `ACTIVITY_TEXT` / `ACTIVITY_LABEL`
   są nietknięte.
5. **Licznik jedzie istniejącym pollingiem, szczegóły na żądanie.** Pełna lista i transcript
   pobierane dopiero po interakcji użytkownika.

## Rozpoznawanie statusu agenta

Trzy źródła, rozstrzygane w kolejności:

1. `agent-<id>.meta.json` — istnienie agenta oraz jego typ, opis i czas startu (mtime pliku).
2. `<task-id>` z `<task-notification>` w głównym logu — agent `Completed`, `ended_at` = mtime
   jego `.jsonl`.
3. Brak notyfikacji, a mtime `agent-<id>.jsonl` starszy niż `AGENT_STALE_MS` (120 s) —
   agent `Stale`, czyli przerwany razem z CLI. Nie liczy się do pracujących.

Punkt 3 obsługuje dwa różne przypadki: agenta ubitego wraz z procesem (notyfikacja nigdy nie
przyjdzie) oraz agenta zakończonego dawno, którego notyfikacja wypadła z 8 KB ogona czytanego
przez `list_sessions`. Żaden z mechanizmów 2 i 3 sam nie wystarcza.

`AGENT_STALE_MS` jest wartością do skalibrowania na żywych sesjach — agent wykonujący długie
polecenie (np. pełny bieg testów) może milczeć dłużej niż 120 s i zostanie wtedy błędnie
uznany za przerwanego.

## Backend

Typy w `src-tauri/src/domain/subagent.rs` (tam mieszkają struktury z `ts-rs`):

- `SubagentInfo { agent_id, agent_type, description, status, started_at, ended_at }`
- `SubagentStatus { Running, Completed, Stale }`

Logika w nowym module `src-tauri/src/sessions/subagents.rs`:

- `subagents_dir(session_path) -> PathBuf`
- `collect_completed_ids(lines) -> HashSet<String>` — wyciąga `<task-id>` z linii zawierających
  `<task-notification>`, z `line.contains(...)` jako filtrem przed parsowaniem JSON.
- `scan_dir(dir, completed, now_ms) -> Vec<SubagentInfo>`
- `count_running(list) -> u32`

Dwa punkty wejścia różnią się budżetem: `reader::session_agent_counts()` (dla `list_sessions`,
co 10 s × N sesji) czyta tylko ogon głównego logu, a komenda `list_subagents` skanuje cały log,
żeby poprawnie oznaczyć również agentów sprzed wielu linii.

### Kolejność w `list_sessions`

`compute_activity()` czyta ogon we własnym zakresie i ma dwie szybkie ścieżki po mtime,
które ten odczyt pomijają. Żeby dołożenie agentów nie zmusiło każdej sesji do czytania
ogona, oba miejsca budujące `SessionMeta` (`reader.rs:151` i `reader.rs:248`) idą tak:

1. `stat` katalogu `<sessionId>/subagents/`. Gdy go nie ma — `compute_activity()` bez zmian,
   liczniki zerowe. To ścieżka dla większości sesji i jej koszt rośnie o jeden nieudany `stat`.
2. Gdy katalog istnieje — jeden odczyt ogona, `count_subagents()` na jego podstawie, potem
   wyliczenie aktywności z gotowym ogonem i liczbą żywych agentów.

Zmiany w istniejących plikach:

- `sessions/activity.rs` — wariant `compute_activity` przyjmujący liczbę żywych agentów oraz
  wcześniej wczytany ogon; gdy agentów jest więcej niż zero, zwraca `Running` przed
  dotychczasową logiką. Obecna sygnatura zostaje dla ścieżki bez agentów.
- `sessions/reader.rs` — `meta_for_file_fast()` wypełnia nowe pola `SessionMeta` zgodnie
  z kolejnością powyżej; wariant `read_history()` przyjmujący ścieżkę, by dało się go użyć
  dla pliku agenta.
- `sessions/watcher.rs` — watch rekursywny plus rozpoznawanie ścieżek `subagents/` w
  `handle_change`, żeby otwarty transcript odświeżał się na żywo.
- `domain/session.rs` — `SessionMeta` zyskuje `running_agents: u32`, `total_agents: u32`.
- `commands/sessions.rs` — `list_subagents(project_id, session_id)` oraz
  `read_subagent_history(project_id, session_id, agent_id, limit, before)`, zarejestrowane
  w `lib.rs`.

Typy `ts-rs` materializują się dopiero przy `cargo test`.

## Frontend

- `lib/tauri.ts` — wrappery obu komend.
- `store/sessionsSlice.ts` — `subagentsBySession` oraz `loadSubagents()`, wołane przy
  rozwinięciu podlisty.
- `store/tabsSlice.ts` — opcjonalne `viewingSubagentId?: string` na tabie `session`
  i akcja `viewSubagent(tabId, agentId | null)`.
- `components/sidebar/SubagentBadge.tsx` — `🤖 N` obok ikony providera w `SessionItem`
  i w `ActiveSessionsPanel`. Kolor akcentu gdy coś pracuje, wyszarzenie gdy same zakończone,
  ukryta gdy `totalAgents === 0`. Kliknięcie rozwija listę i musi wołać `stopPropagation()`,
  bo `<li>` sesji ma własny `onClick`.
- `components/sidebar/SubagentList.tsx` — wiersz na agenta: znacznik statusu
  (● pracuje, ✓ zakończony, ⚠ przerwany), typ, opis, czas trwania. Stan rozwinięcia
  jest lokalny w komponencie.
- `components/history/SubagentView.tsx` + `SubagentHeader.tsx` — pasek powrotu i strumień
  bloków złożony z istniejących komponentów `history/blocks/`.

## Widok transcriptu a żywe PTY

W `TabContent.tsx` gałąź dla `viewingSubagentId` wchodzi **przed** rozgałęzieniem na
`mode`, a dotychczasowy widok zostaje zamontowany i przykryty:

- `SubagentView` renderuje się jako `absolute inset-0` nad nim,
- `TerminalView` / `HistoryView` dostają `visible={visible && !viewingSubagentId}`.

Dzięki temu PTY sesji żyje, a bufor `TerminalView.pendingWrites` zachowuje się tak jak przy
przełączaniu zakładek. Przełączenie `mode` na potrzeby podglądu agenta jest zabronione —
odmontowanie `TerminalView` ubiłoby żywą sesję CLI.

Kliknięcie agenta w sidebarze dla sesji bez otwartego taba najpierw otwiera tab sesji,
potem ustawia `viewingSubagentId`.

## Testy

Rust:
- `scan_subagents` dla agenta pracującego, zakończonego i przerwanego,
- wyciąganie `<task-id>` z `<task-notification>`,
- `compute_activity` z żywym agentem zwraca `Running`,
- regresja: przy zerze agentów wszystkie dotychczasowe asercje `compute_activity`
  pozostają bez zmian,
- fixture: katalog `subagents/` z parą `.meta.json` + `.jsonl`.

Frontend:
- `SubagentBadge` — próg widoczności, licznik, wyszarzenie,
- `SubagentList` — kliknięcie woła akcję i nie otwiera sesji,
- `TabContent` — ustawienie `viewingSubagentId` nie odmontowuje `TerminalView`.

## Poza zakresem

- Codex — nie ma odpowiednika katalogu subagentów.
- Roster mobilny i zdalny mostek: liczniki agentów nie wchodzą do `domain/roster.rs`.
- Wyszukiwarka wewnątrz transcriptu subagenta.
- Persystencja rozwinięcia podlisty między uruchomieniami.
- Zagnieżdżanie po `spawnDepth` — agenty pokazujemy płasko.
