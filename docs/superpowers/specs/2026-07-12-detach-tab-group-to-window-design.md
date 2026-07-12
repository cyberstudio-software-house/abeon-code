# Wydzielenie grupy zakładek do nowego okna

Data: 2026-07-12
Zakres: `DesktopApp/`

## Cel

Umożliwić przeniesienie całej grupy projektowej zakładek (wszystkie zakładki jednego
projektu z `TabBar`) do osobnego okna aplikacji. Dziś odczepić można wyłącznie
pojedynczą zakładkę sesji (`lib/detachSession.ts`).

## Stan obecny

- Grupy w `TabBar` to grupy per projekt (`lib/tabGrouping.ts`), nagłówek służy tylko
  do zwijania. Nagłówki renderują się wyłącznie gdy otwarte są ≥2 projekty (`showGroups`).
- Detach pojedynczej sesji: `TabContextMenu` → `detachSessionTab()` tworzy `WebviewWindow`
  z URL-em `index.html?view=session&…`. Nowy webview ma własny, pusty store; zakładka jest
  seedowana z query stringa (`store/index.ts`), a persystencja w oknach odczepionych jest
  wyłączona.
- PTY sesji i shella tworzy `TerminalView` na mount i zabija na unmount. PTY akcji należy do
  `processManager` (stan modułu JS w danym oknie) i ginie dopiero przy jawnym `dismiss()`.
- Rust rozsyła wyjście PTY przez `app.emit` (`pty/handle.rs`) — broadcast do wszystkich okien.
  Dowolne okno może więc nasłuchiwać `pty:<id>:output` i pisać przez `pty_write`.

## Decyzje projektowe

1. **Grupa = grupa projektowa.** Bez multi-selekcji zakładek i bez nowego modelu grup.
2. **Przenosimy wszystkie zakładki projektu**, z ostrzeżeniem o skutkach dla żywych procesów.
3. **Działająca akcja jest przejmowana, nie zabijana.** Nowe okno adoptuje żywy PTY po `ptyId`;
   scrollback (bufor w pamięci JS starego okna) nie jedzie razem z nim.
4. **Okno wydzielone dostaje pasek zakładek i przycisk „+"** (nowa sesja / nowy terminal),
   zachowuje prawy panel. Bez sidebara.
5. **Payload jedzie w query stringu** jako base64(JSON) — rozszerzenie istniejącego `windowMode`.
   Alternatywy odrzucone: handoff w `localStorage` (osierocone klucze), handoff po stronie Rusta
   (wymusza asynchroniczny boot store'a, dziś seedowanie jest synchroniczne).

## Zachowanie per rodzaj zakładki

| Rodzaj | Zachowanie po wydzieleniu |
|---|---|
| `session`, `mode: 'history'` | przeniesienie 1:1, żaden proces nie startuje — **tryb jest zachowywany** (pojedynczy detach wymusza dziś `mode: 'terminal'`; przy grupie wymusiłoby to start N procesów CLI) |
| `session`, `mode: 'terminal'` | CLI startuje w nowym oknie z `--resume`; semantyka flagi `fresh` bez zmian względem `detachSession` |
| `terminal` | nowy shell, pusty scrollback |
| `action` | adopcja żywego PTY (`adopt`), brak wcześniejszych logów; akcja zakończona jedzie jako `exited` |
| `providerPicker` | przeniesienie 1:1 |

## Wejście w funkcję

- Prawy klik na nagłówku grupy → `GroupContextMenu` → „Wydziel do nowego okna".
- Ta sama pozycja w `TabContextMenu` („Wydziel projekt do nowego okna") — nagłówki grup nie
  istnieją przy jednym otwartym projekcie, więc bez tego opcja byłaby wtedy nieosiągalna.
- `ConfirmDialog` wylicza skutki (ile sesji wznowi się od nowa, ile terminali straci historię,
  ile akcji zostanie przejętych bez logów). Gdy w grupie nie ma żywych procesów — dialog pomijamy.

## Kolejność przekazania

Zabicie starego PTY musi wyprzedzić start nowego, inaczej dwa procesy CLI pracują na tym samym
pliku sesji.

1. Główne okno tworzy `WebviewWindow` z payloadem grupy.
2. Na `tauri://created` usuwa zakładki `session` / `terminal` / `providerPicker` — odmontowanie
   `TerminalView` zabija ich PTY (ten sam moment, w którym `detachSession` zamyka zakładkę).
3. Nowe okno bootuje, adoptuje PTY akcji (`processManager.adopt`) i emituje `abeon:detach-ready`.
4. Główne okno na `abeon:detach-ready` robi `processManager.release(actionId)` (odsubskrybowanie
   **bez** `ptyKill`) i usuwa zakładki akcji.

Rozdzielenie kroków 2 i 4 zapewnia ciągłość logów akcji: adopcja jest addytywna (broadcast
zdarzeń), więc chwilowe nasłuchiwanie z dwóch okien jest nieszkodliwe. Sesje zachowują sprawdzoną
dziś sekwencję kill-przed-spawn.

Gdy nowe okno nie wystartuje (`tauri://error`), zakładki zostają w głównym oknie i pokazujemy toast.

## Duplikaty okien

Label okna: `project-<projectId>`. Jeśli okno o tym labelu już istnieje — `setFocus()` zamiast
tworzenia drugiego (analogicznie do `sessionWindowLabel`).

## Okno wydzielone

`DetachedSessionShell` uogólniamy do `DetachedShell` obsługującego oba tryby (`session`, `group`):

- tryb `group`: `TitleBar` + `TabBar` (bez nagłówków grup — jest jedna) + `TabContent` + `RightPanel`,
  plus przycisk „+" w `TabBar` otwierający nową sesję/terminal w `projectId` z trybu okna,
- strażnik zamknięcia okna sprawdza **wszystkie** zakładki, nie tylko aktywną (dzisiejszy
  `DetachedSessionShell` sprawdza tylko aktywną — przy wielu zakładkach to błąd), zamyka je wszystkie
  przez `flushSync` i wywołuje `processManager.dismiss()` dla akcji (tu proces ma już zginąć),
  a następnie `destroy()`.

## Pliki

Nowe:
- `src/lib/detachGroup.ts` — budowa payloadu, tworzenie okna, handshake `abeon:detach-ready`.
- `src/components/center/GroupContextMenu.tsx`.

Zmieniane:
- `src/lib/windowMode.ts` — `WindowMode` jako union (`session` | `group`), `buildGroupWindowUrl`,
  `groupWindowLabel`, parsowanie payloadu.
- `src/lib/processManager.ts` — `adopt(actionId, ptyId)`, `release(actionId)`.
- `src/store/tabsSlice.ts` — `tabsFromGroupMode()`, `detachTabs(ids)` (usunięcie bez zabijania).
- `src/store/index.ts` — seedowanie store'a w trybie `group`.
- `src/components/center/TabBar.tsx` — menu kontekstowe nagłówka grupy, opcjonalny przycisk „+".
- `src/components/center/TabContextMenu.tsx` — pozycja „Wydziel projekt do nowego okna".
- `src/components/layout/DetachedSessionShell.tsx` → `DetachedShell.tsx`.
- `src/App.tsx` — routing trybu okna.

## Testy

- `windowMode`: round-trip `buildGroupWindowUrl` → `parseWindowMode` (w tym tytuły z polskimi
  znakami i emoji — payload jest base64 z JSON-a).
- `tabsSlice`: `detachTabs` usuwa wskazane zakładki, poprawnie przelicza `activeTabId`, `mruOrder`,
  `navHistory`.
- `processManager`: `release` nie woła `ptyKill`, `dismiss` woła; `adopt` rejestruje nasłuch i
  ustawia `runningActions`.
- `TabBar`: menu kontekstowe nagłówka grupy oraz pozycja w menu zakładki wywołują detach z właściwym
  `projectId`.
- `DetachedShell`: strażnik zamknięcia wykrywa żywy proces w **nieaktywnej** zakładce.

## Poza zakresem v1

- Powrót grupy do głównego okna (re-attach).
- Przywracanie okien wydzielonych po restarcie aplikacji (okna odczepione nigdy nie persystują stanu).
- Przekierowanie kliknięcia w sesję w sidebarze głównego okna na okno wydzielone, w którym ta sesja
  żyje (hazard podwójnego otwarcia istnieje już dziś przy pojedynczym detachu).
