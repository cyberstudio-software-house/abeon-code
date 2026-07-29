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
   pobierane dopiero po interakcji użytkownika. Raz otwarte odświeżają się dalej: lista przy
   każdej zmianie liczników, transcript ze zdarzeń watchera.

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

### Porównanie czasów zapisu na ścieżce ogona

Ogon 8 KB gubi notyfikację, gdy zaraz po niej do logu sesji trafi duży `tool_result`
(nierzadko 10 KB). Zestaw zakończonych jest wtedy niepełny, mtime `.jsonl` agenta świeży,
a licznik przez `AGENT_STALE_MS` pokazywał fantomowego pracującego agenta: sesja stała
`Running`, dzwonek milczał, a rozwinięta lista — robiona pełnym skanem — pokazywała tego
samego agenta jako `✓ Zakończony`.

Reguła: **jeśli mtime logu sesji jest nowszy niż mtime `agent-<id>.jsonl`, agent już nie
pisze i nie liczy się do pracujących.** Żywy agent pisze do swojego pliku nieustannie, więc
w normalnej pracy to jego plik jest młodszy.

Reguła obowiązuje wyłącznie tam, gdzie zestaw zakończonych jest niepełny, czyli na ścieżce
licznikowej (`session_agent_counts` → `count_agents`). Pełny skan (`scan_session` → `scan_dir`)
czyta cały log, ma komplet notyfikacji i zostaje bez zmian. Skutek uboczny do zaakceptowania:
agent milczący krócej niż `AGENT_STALE_MS`, dla którego notyfikacja jeszcze nie przyszła,
zniknie z licznika, choć lista pokaże go jako `● Pracuje`. To wciąż mniejszy błąd niż
utrzymywanie sesji w stanie „pracuje" i blokowanie powiadomienia.

## Backend

Typy w `src-tauri/src/domain/subagent.rs` (tam mieszkają struktury z `ts-rs`):

- `SubagentInfo { agent_id, agent_type, description, status, started_at, ended_at }`
- `SubagentStatus { Running, Completed, Stale }`

Logika w nowym module `src-tauri/src/sessions/subagents.rs`:

- `subagents_dir(session_path) -> PathBuf`
- `collect_completed_ids(lines) -> HashSet<String>` — wyciąga `<task-id>` z linii zawierających
  `<task-notification>`, z `line.contains(...)` jako filtrem przed parsowaniem JSON.
- `scan_dir(dir, completed, now_ms) -> Vec<SubagentInfo>` — pełny opis agentów; czyta
  i parsuje każdy `.meta.json`, bo stamtąd biorą się `agentType` i `description`.
- `scan_session(session_path, now_ms) -> AppResult<Vec<SubagentInfo>>` — czyta cały log sesji
  (filtrując linie po `<task-notification>`) i podaje wynik do `scan_dir`.
- `count_agents(dir, completed, now_ms, parent_mtime_ms) -> (u32, u32)` — sama para liczników,
  wyłącznie z nazw plików i mtime'ów, bez otwierania `.meta.json`.
- `count_running(list) -> u32` — liczy pracujących w gotowej liście z `scan_dir`.

Dwa punkty wejścia różnią się budżetem:

- `reader::session_agent_counts()` — dla `list_sessions` (co 10 s × N sesji × M projektów)
  oraz dla watchera. Czyta tylko ogon głównego logu i idzie przez `count_agents`, więc na
  katalog z setką agentów przypada jeden `read_dir` i po jednym `stat` na wpis. Największy
  zaobserwowany katalog to 119 agentów, na dysku było ich 713.
- komenda `list_subagents` → `scan_session`, raz na kliknięcie użytkownika. Skanuje cały log,
  żeby poprawnie oznaczyć również agentów sprzed wielu linii, i parsuje `.meta.json`.

### Kolejność w `list_sessions`

`compute_activity()` czyta ogon we własnym zakresie i ma dwie szybkie ścieżki po mtime,
które ten odczyt pomijają. Oba miejsca budujące `SessionMeta` (`reader.rs`, `meta_for_file_fast`
i `read_history_at`) idą tak:

1. `stat` katalogu `<sessionId>/subagents/`. Gdy go nie ma — `compute_activity()` bez zmian,
   liczniki zerowe. To ścieżka dla większości sesji i jej koszt rośnie o jeden nieudany `stat`.
2. Gdy katalog istnieje — `session_agent_counts()` czyta ogon i liczy agentów, po czym
   `compute_activity_with_agents()` dostaje gotową liczbę żywych agentów.

Ogon **nie jest** współdzielony między tymi krokami: `session_agent_counts()` i
`compute_activity()` czytają go osobno. Sesja z katalogiem `subagents/` płaci więc za dwa
odczyty 8 KB. Współdzielenie wymagałoby przepuszczenia wczytanych linii przez sygnaturę
`compute_activity`, na co świadomie nie poszliśmy — koszt dotyczy tylko sesji z agentami.

Zmiany w istniejących plikach:

- `sessions/activity.rs` — wariant `compute_activity` przyjmujący liczbę żywych agentów oraz
  wcześniej wczytany ogon; gdy agentów jest więcej niż zero, zwraca `Running` przed
  dotychczasową logiką. Obecna sygnatura zostaje dla ścieżki bez agentów.
- `sessions/reader.rs` — `meta_for_file_fast()` wypełnia nowe pola `SessionMeta` zgodnie
  z kolejnością powyżej; wariant `read_history()` przyjmujący ścieżkę, by dało się go użyć
  dla pliku agenta.
- `sessions/watcher.rs` — watch rekursywny plus rozpoznawanie ścieżek `subagents/` w
  `handle_change`, żeby otwarty transcript odświeżał się na żywo.
- `domain/session.rs` — `SessionMeta` i `ActiveSession` zyskują `running_agents: u32`,
  `total_agents: u32`. `ActiveSession` musi nieść je wprost, bo panel aktywnych sesji jest
  widokiem międzyprojektowym, a `sessionsByProject` po stronie frontu zna tylko projekty
  rozwinięte w sidebarze.
- `commands/sessions.rs` — `list_subagents(project_id, session_id)` oraz
  `read_subagent_history(project_id, session_id, agent_id, limit, before)`, zarejestrowane
  w `lib.rs`.

Typy `ts-rs` materializują się dopiero przy `cargo test`.

## Frontend

- `lib/tauri.ts` — wrappery obu komend.
- `store/sessionsSlice.ts` — `subagentsBySession` oraz `loadSubagents()`, wołane przy
  rozwinięciu podlisty. `refreshActivity()` przepisuje z odpowiedzi backendu nie tylko
  `activity`, ale i oba liczniki — inaczej odznaka zamarza na stanie z pierwszego wczytania
  projektu.
- `hooks/useSubagentRow.ts` — wspólny stan wiersza dla `SessionItem` i `ActiveSessionsPanel`.
  Rozwinięta lista przeładowuje się przy każdej zmianie pary `(runningAgents, totalAgents)`,
  bo inaczej licznik i lista rozjeżdżają się na oczach użytkownika (statusy stoją na ●,
  a nowe agenty nie dochodzą). Hook trzyma też błąd ostatniego wywołania.
- `store/tabsSlice.ts` — opcjonalne `viewingSubagentId?: string` na tabie `session`
  i akcja `viewSubagent(tabId, agentId | null)`.
- `components/sidebar/SubagentBadge.tsx` — `🤖 N` obok ikony providera w `SessionItem`
  i w `ActiveSessionsPanel`. Kolor akcentu gdy coś pracuje, wyszarzenie gdy same zakończone,
  ukryta gdy `totalAgents === 0`. Kliknięcie rozwija listę i musi wołać `stopPropagation()`,
  bo `<li>` sesji ma własny `onClick`.
- `components/sidebar/SubagentList.tsx` — wiersz na agenta: znacznik statusu
  (● pracuje, ✓ zakończony, ⚠ przerwany), typ, opis, czas trwania. Stan rozwinięcia
  jest lokalny w komponencie. Trzy stany zamiast jednego: `undefined` to wczytywanie,
  pusta tablica to faktyczny brak agentów, a błąd pokazuje komunikat — „Brak agentów"
  samo w sobie jest z definicji nieprawdziwe, bo listę otwiera odznaka renderowana dopiero
  przy `totalAgents > 0`.
- `components/history/SubagentView.tsx` + `SubagentHeader.tsx` — pasek powrotu i strumień
  bloków złożony z istniejących komponentów `history/blocks/`.

### Odczyty transcriptu

Trzy mechanizmy dzielą jeden zamek (`inFlight`/`queued` wewnątrz efektu), żeby nigdy nie
czytać pliku agenta (do 2,2 MB) dwoma ścieżkami naraz:

1. **Odczyt startowy** — pełny, ostatnie 200 bloków.
2. **Odświeżenie na żywo** — zdarzenie `session:<id>:agents` uruchamia odczyt dopiero
   `RELOAD_DEBOUNCE_MS` (300 ms) po ostatnim zdarzeniu z serii. Gałąź subagenta w watcherze
   wychodzi przed `sleep(50 ms)` z `handle_change`, więc zdarzenia lecą z prędkością zapisów
   agenta; samo szeregowanie zdejmuje równoległość, ale nie częstotliwość. Dławik siedzi po
   stronie widoku, bo tam jest koszt (odczyt + parsowanie całego pliku).
3. **Doczytywanie w górę** — `HistoryStream.onLoadMore` woła `read_subagent_history` z
   `limit` i `beforeUuid`, dokładnie jak `HistoryView`. Doczytane starsze strony przeżywają
   odświeżenie na żywo: świeże okno jest wszywane w miejsce nakładki po `uuid` pierwszego
   bloku, a nagłówek z wcześniejszych stron zostaje.

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
- `scan_dir` dla agenta pracującego, zakończonego i przerwanego,
- wyciąganie `<task-id>` z `<task-notification>`,
- zszycie obu: realna linia powiadomienia przepuszczona przez `collect_completed_ids`
  do `scan_dir` nad katalogiem nazwanym tym samym identyfikatorem — bez tego zmiana formatu
  Claude Code po cichu zrobiłaby z każdego agenta `Stale`,
- `count_agents` zgodne z `scan_dir` na tym samym katalogu oraz liczące agenta, którego
  `.meta.json` nie da się sparsować (dowód, że ścieżka licznikowa nie tyka JSON-a),
- `session_agent_counts` w obie strony reguły porównania czasów,
- `compute_activity` z żywym agentem zwraca `Running`,
- regresja: przy zerze agentów wszystkie dotychczasowe asercje `compute_activity`
  pozostają bez zmian,
- fixture: katalog `subagents/` z parą `.meta.json` + `.jsonl`.

Frontend:
- `SubagentBadge` — próg widoczności, licznik, wyszarzenie,
- `SubagentList` — kliknięcie woła akcję i nie otwiera sesji; wczytywanie, pustka i błąd
  to trzy różne komunikaty,
- `SessionItem` — rozwinięta lista przeładowuje się przy zmianie liczników, zwinięta nie,
- `sessionsSlice` — tick pollingu przenosi liczniki na już wczytaną sesję,
- `activeSessions` — wiersz niesie liczniki z `ActiveSession` i z fallbacku po `SessionMeta`,
- `SubagentView` — dławik na serii zdarzeń, doczytywanie starszych stron, przeżywanie
  doczytanych stron przy odświeżeniu,
- `HistoryView` — Ctrl+F milczy, gdy tab przykrywa transcript subagenta,
- `TabContent` — ustawienie `viewingSubagentId` nie odmontowuje `TerminalView`.

## Poza zakresem

- Codex — nie ma odpowiednika katalogu subagentów.
- Roster mobilny i zdalny mostek: liczniki agentów nie wchodzą do `domain/roster.rs`.
- Wyszukiwarka wewnątrz transcriptu subagenta.
- Persystencja rozwinięcia podlisty między uruchomieniami.
- Zagnieżdżanie po `spawnDepth` — agenty pokazujemy płasko.
