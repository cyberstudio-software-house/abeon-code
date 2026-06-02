# Akcje w tle — projekt

Data: 2026-06-02
Zakres: `DesktopApp/`

## Problem

Dziś uruchomienie akcji natychmiast otwiera nową zakładkę z terminalem, a sam
proces PTY jest spawnowany **wewnątrz** `TerminalView` (`spawnPty` w
`TerminalView.tsx:156`). Cykl życia procesu jest więc sklejony z komponentem
zakładki: proces nie istnieje dopóki nie zamontuje się terminal, a odmontowanie
(zamknięcie zakładki) zabija PTY (`ptyKill` w `TerminalView.tsx:228`).

Cel:
1. Uruchomienie akcji odbywa się **w tle**, bez otwierania zakładki — globalnie,
   we wszystkich miejscach (prawy panel, skróty `Ctrl/Cmd+1..9`, nowy dropdown).
2. Dodatkowy przycisk otwiera zakładkę ze stanem (outputem) danego procesu.
3. **Output procesu musi być oglądalny także po jego zakończeniu** (`exit`) —
   to twardy wymóg: użytkownik chce sprawdzić historię zakończonego procesu.
4. Na liście projektów, obok ikon edytora i terminala, dochodzi trzecia ikona
   otwierająca dropdown z listą akcji. Klik na akcji jeszcze nieuruchomionej ją
   uruchamia (w tle); akcja już uruchomiona pokazuje się jako zakładka.

„Uruchomiona/otwarta" akcja = proces, który został wystartowany i nie został
jeszcze odrzucony przez użytkownika (przez zamknięcie zakładki / `dismiss`).
Proces może już zakończyć działanie (`exit`) — wciąż jest „otwarty" i oglądalny,
dopóki użytkownik go nie zamknie.

## Architektura

Własność PTY przenosi się z `TerminalView` do **process managera**. Manager ma
dwie warstwy, świadomie rozdzielone:

- **Moduł-singleton `src/lib/processManager.ts`** — trzyma rzeczy nieserializowalne
  i imperatywne: `ptyId`, bufory bajtów (`Uint8Array[]`), funkcje odpinające
  listenery Tauri, zbiór subskrybentów live. To NIE jest stan Zustand (bufory i
  callbacki powodowałyby re-rendery i nie są serializowalne).
- **Rozszerzony `src/store/actionsSlice.ts`** — trzyma tylko lekki, reaktywny
  status do odświeżania UI: `runningActions: Record<actionId, RunningAction>`,
  gdzie `RunningAction = { actionId, ptyId, status, exitCode? }`,
  `status: 'running' | 'exited'`.

`TerminalView` dla `kind: 'action'` przestaje być spawnerem — staje się
**podpinaczem** (attacher) do istniejącego PTY zarządzanego przez managera.

### API managera

```ts
// src/lib/processManager.ts (sygnatury docelowe)
start(projectId: number, action: Action): Promise<void>
  // spawnPty(kind:'action'), zapis ptyId, podpięcie globalnego listenera
  // pty:<id>:output (append do bufora + notyfikacja subskrybentów) i
  // pty:<id>:exit (append "[process exited with code N]" do bufora,
  // status -> 'exited'). Ustawia status 'running' w store. Bez zakładki.

attach(actionId: number, sink: { write(bytes: Uint8Array): void }): () => void
  // 1) przegrywa cały dotychczasowy bufor do sink.write
  // 2) rejestruje sink jako subskrybenta live
  // zwraca detach() (wyrejestrowanie subskrybenta; NIE zabija PTY)

write(actionId: number, dataBase64: string): void   // -> ptyWrite
resize(actionId: number, cols: number, rows: number): void  // -> ptyResize
stop(actionId: number): void
  // ptyKill; bufor i status zostają (proces 'exited', oglądalny)
dismiss(actionId: number): void
  // zabij jeśli żyje + odepnij listenery + wyczyść bufor + usuń z runningActions
```

Live-stream do podpiętego terminala idzie przez subskrybenta zarejestrowanego
w `attach`. Manager przy `output`: `buffer.push(bytes)` + `subscribers.forEach(s => s.write(bytes))`.

### Cykl życia (status w `runningActions[actionId]`)

```
brak ──start──▶ running ──exit (samo) / stop──▶ exited ──dismiss──▶ brak
                   │                                                  ▲
                   └──────────────── dismiss ─────────────────────────┘
```

Re-run = `dismiss(actionId)` + `start(...)`.

## Przepływy

### Uruchomienie (w tle)
Wszystkie wejścia wołają `processManager.start(projectId, action)`:
- prawy panel: `ActionRow` przycisk ▶,
- skróty: `AppShell` `Ctrl/Cmd+1..9` (dziś woła `upsertActionTab`),
- nowy dropdown: `ProjectActionsMenu` klik na nieuruchomionej akcji.

Żadna zakładka się nie otwiera. Manager buforuje wyjście od startu.

### Podgląd outputu (otwarcie zakładki)
„Pokaż output" / klik na uruchomionej akcji w dropdownie → `upsertActionTab(...)`
(istniejąca metoda `tabsSlice`). `TabContent` renderuje `TerminalView(kind=action)`,
który zamiast `spawnPty` woła `processManager.attach(actionId, sink)`:
- przegranie bufora przy `attach` przechodzi przez istniejący gate `visible` /
  `pendingWrites` — jeśli zakładka jest ukryta, bajty trafiają do `pendingWrites`
  i są flushowane gdy staje się widoczna (CLAUDE.md: nie pisać do niedopasowanego
  xterm),
- input (`term.onData`) i resize (`term.onResize`) idą przez `processManager.write/resize`,
- cleanup `TerminalView` woła `detach()` — **nie** `ptyKill`.

### Zakończenie procesu
Globalny listener managera na `pty:<id>:exit` dopisuje do bufora
`\r\n\x1b[33m[process exited with code N]\x1b[0m\r\n` i ustawia status `exited`.
Bufor żyje aż do `dismiss`, więc historia pozostaje oglądalna.

### Zamknięcie zakładki (zmieniona semantyka)
- `TerminalView` cleanup już **nie zabija** PTY (`detach` zamiast `ptyKill`).
- Zamknięcie zakładki akcji w `TabBar` woła `processManager.dismiss(actionId)`
  przed `closeTab(id)` (jeden seam: dotyczy X, środkowego kliknięcia i `Ctrl/Cmd+W`,
  bo wszystkie idą przez `closeWithGuard`).
- `ConfirmDialog` pokazujemy tylko gdy status `running`; dla `exited` zamykamy
  bez pytania (to tylko podgląd historii). `isActiveProcess` dla zakładki akcji
  = status `running` w `runningActions` (nie sam fakt bycia akcją).

## UI

### `ProjectItem` + nowy `ProjectActionsMenu`
W rzędzie przycisków (obecnie New session / terminal / editor — `ProjectItem.tsx:45-72`)
dochodzi **trzecia ikona** (np. `list`/`bolt`), która toggluje popover
`ProjectActionsMenu`:
- przy otwarciu `loadActions(projectId)` jeśli `actionsByProject[projectId]` puste,
- lista akcji projektu; wiersz akcji:
  - nieuruchomiona → klik = `processManager.start` (tło),
  - `running` → klik = pokaż zakładkę (`upsertActionTab`); przycisk `■ stop`,
  - `exited` → klik = pokaż zakładkę (podgląd historii); przyciski
    `↻ uruchom ponownie` (re-run) oraz `× wyczyść` (`dismiss`),
  - kropka statusu wg tej samej konwencji co `actionIconColor` w `TabBar.tsx`
    (szary = brak/zatrzymany sygnałem 130/143, zielony = running, czerwony =
    exited z błędem).
- ikona-trigger dostaje **kropkę/badge**, gdy projekt ma ≥1 akcję w `runningActions`
  (rozwiązuje problem „niewidzialnego tła", bo zakładki już nie sygnalizują startu).

### `ActionRow` (prawy panel)
- ▶ teraz = `processManager.start` w tle (nie `upsertActionTab`).
- gdy uruchomiona: przycisk „pokaż output" (`upsertActionTab`) + `■ stop` (running)
  lub `↻` re-run / `× dismiss` (exited).
- kropka/etykieta statusu (zastępuje obecne `· uruchomione` liczone z `tabs`,
  które teraz liczymy z `runningActions`).

## Błędy i edge-cases
- `spawnPty` rzuca → status nie wchodzi w `running`; komunikat (PL) w prawym panelu,
  bez wpisu w `runningActions`.
- Re-run gdy zakładka otwarta → `dismiss` + `start`; otwarty `TerminalView`
  re-`attach` do nowego `ptyId`/bufora (zmiana `ptyId` w propsach wymusza
  re-mount efektu attach).
- Pełny restart aplikacji → bufory giną (świadome ograniczenie podejścia A;
  ścieżka B — ring buffer w Ruście — to późniejszy upgrade bez zmian w UI dzięki
  stabilnemu API managera).
- Ukryta zakładka przy `attach` → przegranie bufora przez `pendingWrites`.

## Testy
- `processManager` (mock `tauri`): `start` buforuje output; `attach` przegrywa
  dotychczasowy bufor i odbiera live; `exit` ustawia status `exited` i dopisuje
  marker; `stop` zabija ale zostawia bufor; `dismiss` czyści bufor i usuwa status.
- `actionsSlice`: przejścia statusów (`brak→running→exited→brak`).
- `TabBar`: zamknięcie zakładki akcji woła `dismiss`; `ConfirmDialog` tylko dla
  `running`; `exited` zamyka bez pytania.
- `ProjectActionsMenu` (render): klik startuje vs pokazuje zakładkę zależnie od
  statusu; badge widoczny przy ≥1 aktywnej akcji.

## Pliki (do utworzenia / zmiany)
- **nowe**: `src/lib/processManager.ts`, `src/components/sidebar/ProjectActionsMenu.tsx`
- **zmiana**: `src/store/actionsSlice.ts` (status `running|exited`, `exitCode`),
  `src/components/right/ActionRow.tsx` (start w tle + przyciski/status),
  `src/components/sidebar/ProjectItem.tsx` (trzecia ikona + badge),
  `src/components/terminal/TerminalView.tsx` (attach zamiast spawn dla `kind=action`,
  brak `ptyKill` w cleanup dla akcji),
  `src/components/center/TabBar.tsx` (`dismiss` przy zamknięciu, confirm tylko dla
  `running`, `isActiveProcess` po statusie),
  `src/components/layout/AppShell.tsx` (`Ctrl/Cmd+1..9` → `start` w tle).

## Poza zakresem (YAGNI)
- Persystencja buforów między restartami aplikacji (podejście B w Ruście).
- Limit rozmiaru bufora / ring buffer (na razie nieograniczony, akceptowalne dla MVP).
- Globalny widok „wszystkie procesy w tle" ponad poziomem projektu.
