# Panel terminala w sesji (szuflada z podziałami)

Data: 2026-09-30
Zakres: `DesktopApp/`

## Cel

Terminal otwierany z poziomu sesji ma najpierw wysuwać się jako panel („szuflada") na dole
obszaru sesji, zamiast od razu tworzyć zakładkę. W szufladzie można:

- **wydzielić terminal do osobnej zakładki** — od tego momentu działa jak dzisiejsza zakładka
  terminala, a proces i historia ekranu przeżywają przeniesienie;
- **dzielić terminal** na wiele shelli w prawo / w dół, z przeciąganymi separatorami i nawigacją
  klawiaturą — jak podziały w Ghostty.

Kryterium sukcesu: w sesji `mod+t` wysuwa szufladę z shellem w katalogu projektu; da się ją
podzielić, zmienić jej rozmiar, schować (procesy żyją dalej) i wydzielić terminal do zakładki
bez restartu procesu i bez utraty scrollbacku.

## Rozstrzygnięcia z brainstormingu

| Pytanie | Decyzja |
|---|---|
| Do czego przypięta jest szuflada | Do **zakładki sesji**. Każda sesja ma własną szufladę; przy splitach paneli szuflada leży w panelu, w którym jest jej sesja. Odrzucone: per projekt (dwie sesje jednego projektu widoczne w dwóch panelach nie mogą dzielić jednego xterma), globalna jak w VS Code (luźno związana z sesją). |
| Co wydziela „Wydziel do zakładki" przy wielu podziałach | **Tylko terminal z fokusem.** Reszta zostaje w szufladzie, podział się zwija. |
| Co robi `mod+t` / `$` w sesji z szufladą | **Przełącza szufladę**: schowana → wysuń + fokus (pierwszy raz tworzy shell); widoczna bez fokusu → fokus do szuflady; widoczna z fokusem → schowaj. Nowe terminale powstają tylko przez podział. |
| Architektura hostowania | **Podejście A**: terminale szuflady to warstwy we wspólnym kontenerze warstw `PaneLayout` (patrz niżej). Odrzucone: B — szuflada jako zwykły DOM + ponowne podpięcie PTY (utrata scrollbacku, nowa ścieżka „odmontuj bez kill"); C — terminale szuflady jako `Tab` z polem `placement` (każde miejsce iterujące po `tabs[]` musiałoby je pomijać). |

## Stan obecny

- `components/center/PaneLayout.tsx` renderuje paski zakładek per panel oraz **wszystkie**
  warstwy treści (`data-tab-layer`) jako rodzeństwo w jednym kontenerze, pozycjonowane inline
  `left/top/width/height` z `calc(% + px)`. Zmiana rodzica w DOM remountuje `TerminalView`,
  którego cleanup wywołuje `ptyKill` (niezmiennik opisany w `DesktopApp/CLAUDE.md` → Gotchas).
- `lib/paneTree.ts` — `PaneNode` (`leaf` z `tabIds`/`activeTabId`, `split` z `dir`/`sizes`),
  `insertBeside`, `collapseEmpty`, `reconcilePanes`. `reconcilePanes` dopina do panelu z fokusem
  każdą zakładkę z `tabs[]`, której nie ma w żadnym liściu.
- `lib/paneGeometry.ts` — `computePaneRects`, `computeSplitBoundaries`, `clampSizes`,
  `tabBarHeight(mode)`, `MIN_PANE_WIDTH`/`MIN_PANE_HEIGHT`.
- `components/center/PaneResizers.tsx` — separatory podziałów, związane na sztywno z
  `store.resizeSplit` i prostokątem kontenera `PaneLayout`.
- Wszystkie wejścia do terminala wołają `openNewTerminalTab(projectId)`: `$` w `TabBar` i
  `StackedTabBar`, skrót `newTerminal` (`mod+t`) w `AppShell`, przycisk „Terminal" w
  `right/ProjectToolbar`, `history/HistoryHeader`, `sidebar/ProjectItem`, `center/ProjectLauncher`.
- `TerminalView` — prop `focused` robi dwie rzeczy: woła `term.focus()` (efekt na
  `[visible, focused]`) oraz rejestruje `activeAgentPtyId` (konsument: „Wstaw do aktywnej sesji"
  w `ClickUpTaskDialog`). Przy wyjściu procesu dopisuje `[process exited with code N]`.
- `lib/tabProcess.ts` — `isTabLiveProcess` decyduje o `ConfirmDialog` przy zamykaniu; sesja w
  trybie historii nie jest dziś „żywa".
- `useTabBarActions.tsx` — `Ctrl+W` (capture na `document`), `closeWithGuard`, menu kontekstowe,
  wydzielanie sesji (`lib/detachSession.ts`) i grupy (`lib/detachGroup.ts`) do okien.
- Zakładki terminala nie są persystowane; `writeTabsToLocalStorage` zapisuje tylko sesje.

## Model danych

Nowy slice `store/terminalDrawersSlice.ts`, składany w `store/index.ts`. `tabs[]` i
`reconcilePanes` nie wiedzą o szufladach.

```ts
type DrawerTerminal = { id: string; projectId: number; title: string }; // id: `terminal:<uuid>`
type TerminalDrawer = {
  open: boolean;                  // schowana ≠ usunięta; procesy żyją
  hasFocus: boolean;              // strefa fokusu: szuflada vs sesja, pamiętana per sesja
  layout: PaneNode;               // typ z paneTree; każdy liść trzyma dokładnie jeden terminal
  focusedTerminalId: string | null;
};

drawers: Record<string, TerminalDrawer>;          // klucz: id zakładki sesji
drawerTerminals: Record<string, DrawerTerminal>;  // klucz: id terminala
```

Id terminala ma ten sam format co zakładka terminala (`terminal:<uuid>`) i **nie zmienia się**
przy wydzieleniu — na tym opiera się brak remountu.

Akcje:

- `toggleTerminalDrawer(tabId)` — maszyna trzech stanów z tabeli rozstrzygnięć.
- `showTerminalDrawer(tabId)` — jak toggle, ale nigdy nie chowa.
- `openTerminal(projectId, { toggle }: { toggle: boolean })` — jedyny punkt wejścia zamiast
  `openNewTerminalTab` we wszystkich wywołaniach. Jeśli aktywna zakładka to sesja **tego samego
  projektu** → szuflada (`toggle` ? `toggleTerminalDrawer` : `showTerminalDrawer`); w przeciwnym
  razie `openNewTerminalTab(projectId)` jak dziś. `toggle: true` dla `mod+t` i `$` w paskach
  zakładek; `toggle: false` dla przycisku „Terminal" w prawej kolumnie, nagłówka historii,
  sidebaru i launchera.
- `splitDrawerTerminal(tabId, dir: 'row' | 'col')` — nowy shell obok terminala z fokusem
  (`insertBeside`), fokus na nowy.
- `focusDrawerTerminal(tabId, terminalId)` / `focusDrawerSession(tabId)` — ustawiają `hasFocus`.
- `closeDrawerTerminal(terminalId)` — usuwa liść i zwija (`collapseEmpty`); fokus na sąsiada.
  Ostatni terminal → szuflada usunięta z `drawers`, fokus wraca do sesji.
- `detachDrawerTerminal(terminalId)` — **w jednym `set()`**: usuwa terminal z szuflady, dodaje
  `Tab { kind: 'terminal', id, projectId, title }` do `tabs[]`, wstawia jego id do liścia sesji
  tuż za nią, ustawia `activeTabId` i `focusedPaneId` na ten liść. Atomowość jest konieczna, by
  `reconcilePanes` nie zdążył dopiąć „sieroty" na koniec panelu z fokusem.
- `resizeDrawer(size)` / `resizeDrawerSplit(tabId, splitId, sizes)`.

Otwarcie szuflady na zakładce podglądu (`preview: true`) przypina ją (`preview: false`).

Wysokość szuflady: globalne ustawienie `terminalDrawerSize` (ułamek obszaru treści panelu,
zakres 0.2–0.8, domyślnie 0.35), dopisane do `PERSISTED_KEYS` i przełączników
serialize/deserialize. Zapis do store'u przy przeciąganiu, ale persystencja wyzwalana dopiero na
`mouseup` (nie powielać znanego problemu zapisu `localStorage` w każdej klatce resizera paneli).

## Layout i geometria

Dla panelu, którego aktywna zakładka to sesja z otwartą szufladą, obszar treści pod paskiem
zakładek dzieli się na: warstwę sesji `(1 − size)`, separator, nagłówek szuflady (28 px) i ciało
szuflady z terminalami rozłożonymi przez `computePaneRects(drawer.layout)`.

```
┌─ pasek zakładek (32/60 px) ───────────────┐
│ warstwa sesji        (1 − size) × treść   │
├═ separator ═══════════════════════════════┤
│ nagłówek 28 px   [⫴][⊟][⇱][✕][⌄]         │
├───────────────────┬───────────────────────┤
│ $ terminal A      │ $ terminal B          │
└───────────────────┴───────────────────────┘
```

Szuflada **wypycha** sesję (sesja dostaje mniej wierszy: `fit` + `ptyResize`), a nie nakłada się
na nią — pole promptu Claude'a jest na samym dole i nakładka by je zasłoniła.

**Geometria** — nowy czysty moduł `lib/drawerGeometry.ts`. Każda współrzędna jest liniowa w
postaci `a% + b px`, reprezentowana jako `{ pct: number; px: number }` z helperami dodawania i
skalowania; dopiero na końcu zamieniana na `calc(…)`. Funkcja
`computeDrawerLayout(paneRect, barHeight, size, drawerLayout)` zwraca prostokąty: sesji,
separatora, nagłówka i każdego terminala (po id). Dla panelu bez otwartej szuflady warstwa sesji
ma dzisiejszy prostokąt.

**Warstwy:**

- Warstwy zakładek i terminali szuflady to **jedna tablica** renderowana jednym `.map()`;
  każdy element ma identyczny kształt: `div` z kluczem = id oraz
  `<TabPanel tab={…} visible focused />`. Terminal szuflady renderuje się przez
  `TabPanel` z syntetycznym `{ kind: 'terminal', id, projectId, title }`, więc po wydzieleniu
  poddrzewo jest identyczne.
- Tablica jest sortowana po id, nie po kolejności w `tabs[]`. Względna kolejność istniejących
  warstw nigdy się nie zmienia, więc React nigdy nie wykonuje `insertBefore` na żywym węźle
  (przeniesienie węzła w DOM — nawet w obrębie rodzica — resetuje `scrollTop` i fokus xterma).
- Terminal szuflady jest widoczny wtedy i tylko wtedy, gdy jego sesja jest aktywną zakładką
  swojego panelu **i** `drawer.open`.
- Terminal schowanej szuflady lub nieaktywnej sesji: `invisible pointer-events-none`, ale
  **zachowuje ostatni prostokąt** szuflady — bez zwijania do zera, więc bez `ptyResize` do
  jednej kolumny.
- Przy ≥2 terminalach w szufladzie ten z fokusem ma ramkę w kolorze akcentu rysowaną przez
  osobny element-nakładkę `pointer-events-none` (klasa na warstwie by nie wystarczyła — tło
  `TerminalView` przykrywa `box-shadow: inset`).
- Nagłówek i separator szuflady to elementy renderowane obok pasków zakładek (nie warstwy
  terminali), więc mogą się montować i odmontowywać swobodnie.

**Resizery:** `PaneResizers` uogólniony do komponentu przyjmującego granice podziałów, ramkę
(prostokąt w px, z którego liczone jest `totalPx`) i callback `onResize`. Używany przez panele
i przez podziały w szufladzie. Separator sesja/szuflada to osobny, prosty uchwyt zmieniający
`terminalDrawerSize`. Minima: sesja i ciało szuflady po 120 px, podział w szufladzie
160 × 60 px.

## Interakcje, fokus i skróty

**Strefa fokusu:**

- `mousedown` (capture) na warstwie terminala szuflady lub jej nagłówku → `focusPane(paneId)` +
  `focusDrawerTerminal`. `mousedown` na warstwie sesji lub pasku zakładek panelu →
  `focusDrawerSession`.
- `TerminalView` dostaje opcjonalny prop `takeFocus` (domyślnie = `focused`), który steruje
  **wyłącznie** wywołaniem `term.focus()`. Sesja: `focused` bez zmian (pane z fokusem → nadal
  rejestruje `activeAgentPtyId`, więc „Wstaw do aktywnej sesji" celuje w Claude'a), a
  `takeFocus = paneFocused && !drawer.hasFocus`. Terminal szuflady:
  `focused = takeFocus = visible && paneFocused && drawer.hasFocus && focusedTerminalId === id`.
- Schowanie szuflady z fokusem oddaje fokus sesji.

**Nagłówek szuflady** (IconBtn, polskie `aria-label`, skrót w tooltipie), akcje dotyczą
terminala z fokusem: *Podziel w prawo*, *Podziel w dół*, *Wydziel do zakładki*,
*Zamknij terminal*, *Schowaj panel*.

**Skróty:**

| Skrót | Działanie | Konfigurowalny |
|---|---|---|
| `mod+t` (`newTerminal`) | w sesji: toggle szuflady; poza sesją: nowa zakładka terminala. Opis w `SHORTCUTS` zaktualizowany. | tak |
| `mod+shift+o` (nowy `splitTerminalRight`) | podział w prawo | tak |
| `mod+shift+e` (nowy `splitTerminalDown`) | podział w dół | tak |
| `mod+alt+←↑→↓` | fokus na sąsiedni podział w danym kierunku | nie — dopisany do `FIXED_SHORTCUTS` |
| `mod+w` (`closeTab`) przy fokusie w szufladzie | zamyka terminal z fokusem (nie zakładkę sesji) przez ten sam `ConfirmDialog` („Zamknąć terminal?") | tak (istniejący) |

Skróty podziału i nawigacji działają tylko, gdy strefą fokusu jest szuflada aktywnej sesji;
inaczej klawisze przechodzą do Claude'a bez `preventDefault`. Rejestracja jak inne globalne
skróty: `document`, `{ capture: true }`, `preventDefault()` + `stopPropagation()`.
`mod+d` odrzucone świadomie: na Linuksie `mod` = Ctrl, a `Ctrl+D` to EOF w shellu.

Nawigacja kierunkowa: czysta funkcja `neighborInDirection(layout, fromTerminalId, dir)` na
prostokątach z `computePaneRects` — wybiera terminal przylegający w danym kierunku z największym
pokryciem krawędzi; brak sąsiada → brak akcji.

**Wyjście z shella (jak Ghostty):** zdarzenie exit PTY terminala szuflady zamyka jego podział
bez pytania (ostatni → szuflada znika). `TerminalView` dostaje opcjonalny callback `onExit`,
trzymany w refie, by nie trafił do zależności efektu spawnującego PTY (zmiana callbacka nie
może restartować shella). Zakładki terminala zachowują się jak dziś (`[process exited…]`).

**Świadomie poza zakresem:** skrót do wydzielania, wskaźnik „schowana szuflada ma N shelli" na
zakładce sesji, przenoszenie zakładki terminala z powrotem do szuflady, podział zakładek
terminala, persystencja szuflad między restartami.

## Przypadki brzegowe

**Sprzątanie w jednym miejscu:** subskrybent w `store/index.ts` (obok `reconcileLayout`) usuwa
szuflady, których sesja zniknęła z `tabs[]`, oraz ich wpisy w `drawerTerminals` → warstwy się
odmontowują → cleanup `TerminalView` zabija PTY. Pokrywa każdą ścieżkę usuwania zakładki
(`closeTab`, `detachTabs`, podmiana podglądu w `openSessionTab`) bez kodu w każdej z nich.

| Sytuacja | Zachowanie |
|---|---|
| Zamknięcie sesji z terminalami w szufladzie | `isTabLiveProcess` zwraca `true` także dla sesji w trybie historii, jeśli ma niepustą szufladę; treść `ConfirmDialog` informuje, że zamknięte zostaną też terminale z panelu (N). |
| Szuflada na zakładce podglądu | Otwarcie szuflady przypina zakładkę (`preview: false`). |
| Wydzielenie sesji do okna (`detachSessionTab`) | Przed zamknięciem zakładki sesji wszystkie jej terminale z szuflady są wydzielane do zwykłych zakładek w oknie źródłowym — z żywymi PTY i historią. |
| Wydzielenie grupy projektu do okna | Terminale z szuflad sesji grupy dołączane do payloadu jako zwykłe `terminal` (`buildDetachPayload`) i liczone w `summarizeDetach` („N terminali straci historię powłoki"); w nowym oknie startują od nowa jako zakładki. Format payloadu bez zmian. |
| Przeciągnięcie sesji do innego panelu | Szuflada jedzie z nią; warstwy zmieniają tylko prostokąty. |
| Okna odłączone (`?view=session`, `group`) | Działa bez zmian — ten sam `PaneLayout`. Brak nowych labeli okien → `capabilities/default.json` bez zmian. |
| Historia ↔ live, podgląd subagenta | Bez wpływu na szufladę. |
| Nieudany spawn shella w szufladzie | Czerwony komunikat w podziale, jak dziś; brak exit → podział się nie zamyka. |
| Restart aplikacji | Szuflady nie wracają; `terminalDrawerSize` zapamiętany. `writeTabsToLocalStorage` bez zmian. |
| Licznik w `TitleBar` | Wlicza terminale z szuflad (żywe shelle). |
| Ctrl+Tab, wstecz/dalej, MRU, lista aktywnych sesji, most zdalny | Bez zmian — terminal szuflady nie jest zakładką, dopóki nie zostanie wydzielony. |

Backend (Rust): bez zmian — `spawnPty(kind: 'shell')` i cleanup `TerminalView` wystarczają.

## Testy

**Jednostkowe (TDD):**

- `lib/drawerGeometry.test.ts` — prostokąty sesji / separatora / nagłówka / terminali dla różnych
  `size`, obu wysokości paska (32/60 px) i zagnieżdżonych podziałów; arytmetyka `{pct, px}`;
  progi minimalne.
- `neighborInDirection` — cztery kierunki, brzegi, brak sąsiada, wybór przy kilku kandydatach.
- `store/terminalDrawersSlice.test.ts` — trzy stany toggle; `show` nigdy nie chowa; podział;
  zamknięcie ostatniego (szuflada znika, fokus wraca do sesji); atomowe wydzielenie (zakładka
  tuż za sesją w tym samym liściu, `activeTabId`, `focusedPaneId`); przypięcie podglądu; routing
  `openTerminal` (sesja tego projektu → szuflada; inny projekt / zakładka terminala / brak
  zakładek → zakładka).
- Subskrybent sprzątający: zamknięcie sesji usuwa szufladę i jej terminale.
- `isTabLiveProcess` z szufladą; `buildDetachPayload` / `summarizeDetach` z terminalami szuflad.

**Komponentowe (jsdom, wzorzec `PaneLayout.test.tsx`):**

- **Krytyczny:** wydzielenie terminala z szuflady do zakładki nie remountuje `TerminalView`
  (licznik mount/unmount zamockowanego widoku, ten sam węzeł DOM, `MutationObserver` nie
  rejestruje usunięcia węzła z rodzica).
- Przeniesienie sesji z szufladą do innego panelu nie remountuje żadnego terminala.
- Schowana szuflada zostawia warstwy zamontowane (`invisible`).
- `mod+w` przy fokusie w szufladzie zamyka terminal szuflady, nie sesję.
- Skróty podziału działają tylko przy fokusie w szufladzie.
- Zdarzenie exit PTY zamyka podział; przyciski nagłówka wywołują właściwe akcje.

**Bramka automatyczna:** `npm run lint` (zero błędów) i `npm test` w `DesktopApp/`.

**QA na żywo (`npm run tauri dev`) — osobne, jawne zadanie planu.** jsdom nie liczy `calc()`
ani `fit()`:

1. Szuflada w sesji: Claude przelicza wiersze, pole promptu widoczne.
2. Podział w prawo / w dół, przeciąganie separatorów; `tput cols` / `tput lines` w każdym
   podziale zgodne z tym, co widać.
3. Wydzielenie terminala z działającym `htop` i długim scrollbackiem — proces i historia
   przeżywają.
4. Schowaj / pokaż — procesy żyją, rozmiar zachowany.
5. `exit` zamyka podział; ostatni chowa szufladę.
6. Wydzielenie sesji z szufladą do okna; wydzielenie grupy.
7. Dwa panele, każdy z sesją i własną szufladą.
