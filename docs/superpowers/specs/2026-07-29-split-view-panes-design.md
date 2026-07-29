# Podział obszaru roboczego na panele (split view)

Data: 2026-07-29
Zakres: `DesktopApp/`

## Cel

Umożliwić podział centralnego obszaru na wiele niezależnych paneli. Przeciągnięcie zakładki
na krawędź panelu dzieli go na dwa; każdy panel ma własny pasek zakładek i własną zakładkę
aktywną. Podziały można zagnieżdżać, więc liczba jednocześnie widocznych obszarów nie jest
ograniczona do dwóch.

Model docelowy to „grupy edytora" znane z VS Code / Zed: layout stoi **nad** zakładkami,
a zakładki się do niego przypinają. Odrzucony wariant alternatywny — split *wewnątrz* jednej
zakładki (iTerm2, tmux) — wymagałby nowego bytu ponad `Tab` i przebudowy `tabsSlice` oraz
persystencji od podstaw.

## Stan obecny

- `store/tabsSlice.ts` trzyma płaską listę `Tab[]` plus pojedyncze `activeTabId`, `mruOrder`,
  `navHistory`/`navIndex`.
- `components/center/TabContent.tsx` renderuje **wszystkie** zakładki równocześnie jako warstwy
  `absolute inset-0` w jednym kontenerze `relative`; przełączana jest wyłącznie widoczność
  (`invisible pointer-events-none`). Zakładki nigdy nie są odmontowywane.
- `TerminalView` tworzy PTY na mount i zabija na unmount. Ma `ResizeObserver` → `fit()` →
  `ptyResize` oraz bufor `pendingWrites` dla wyjścia przychodzącego, gdy `visible === false`.
- `activeTabId` czytają: `TitleBar`, `AppShell` (tytuł okna, obsługa attention), cały `RightPanel`
  (`GitSection`, `ActionsSection`, `UsageSection`, `ClickUpSection`), `HistoryView`, `TabSwitcher`,
  `lib/detachGroup.ts`, persystencja w `store/index.ts`.
- `activeAgentPtyId` ustawia każdy `TerminalView` typu `agent`, gdy `visible === true`
  (`TerminalView.tsx:313`). Konsument: `ClickUpTaskDialog` („wstaw do aktywnej sesji").
- `lib/tabGrouping.ts` grupuje zakładki po `projectId`; `TabBar` pokazuje nagłówki grup dopiero
  przy ≥2 projektach (`showGroups`) i podkreśla grupę kolorem z `getProjectColor`.
- `lib/detachSession.ts` / `lib/detachGroup.ts` odłączają zakładki do osobnych okien
  (`DetachedShell`), które nigdy nie persystują stanu.
- Persystencja zakładek: `localStorage` pod `abeoncode.tabs` (`store/index.ts:36`), zapis
  wyzwalany porównaniem `JSON.stringify(tabs) + '|' + activeTabId`, odczyt przez
  `sanitizeRestoredTabs`.
- W `package.json` nie ma żadnej biblioteki drag & drop ani dockingowej. `TabBar` nie obsługuje
  dziś nawet zmiany kolejności zakładek.

## Decyzje projektowe

1. **Layout nad zakładkami, nie w zakładce.** `Tab[]` zostaje płaskie i niezmienione. Dochodzi
   osobne drzewo paneli, którego liście przechowują wyłącznie identyfikatory zakładek.
2. **`activeTabId` pozostaje polem stanu**, zapisywanym przy każdej zmianie fokusu panelu jako
   aktywna zakładka panelu sfokusowanego. Wersja pochodna (selektor) byłaby czystsza, ale
   wymusiłaby zmiany w ~10 plikach i w kluczu persystencji. Ta decyzja realizuje wymaganie
   „prawy panel zawsze związany z panelem, gdzie jest fokus" bez dotykania `RightPanel`.
3. **Warstwa treści nigdy nie zmienia rodzica w DOM.** Pozycje paneli liczy czysta funkcja
   z drzewa layoutu i wystawia jako procenty w stylach inline. Przeniesienie zakładki między
   panelami zmienia tylko styl, więc `TerminalView` się nie remountuje i PTY nie ginie.
4. **Grupę w pasku zakładek tworzą tylko projekty mające ≥2 zakładki w danym panelu.** Projekt
   z pojedynczą zakładką ląduje na początku paska, poza grupami. Reguła jest wyprowadzalna ze
   stanu — nie wymaga flagi „przeniesiona ręcznie" na zakładce.
5. **Każda zakładka nosi kolor projektu** na lewej krawędzi (2px, `getProjectColor`), również
   wewnątrz grupy. Podkreślenie grupy zostaje bez zmian.
6. **Layout uzgadnia się z `tabs[]`, zamiast uczyć każdą akcję otwierającą zakładkę o panelach.**
   Jedna funkcja `reconcileLayout` dopina osierocone identyfikatory do panelu sfokusowanego
   i usuwa nieistniejące. Dzięki temu `openSessionTab`, `openNewTerminalTab`, `upsertActionTab`,
   `chooseProvider`, przywracanie po restarcie i przyszłe źródła zakładek (most zdalny) działają
   bez zmian.
7. **Gest przeciągania na pointer events**, bez biblioteki. HTML5 DnD jest w webview zawodne,
   a `onMouseDown` na zakładce jest już zajęte obsługą middle-click.
8. **Bez biblioteki dockingowej** (`dockview`, `react-mosaic`, `rc-dock`). Każda z nich przejmuje
   renderowanie pasków zakładek, a nasz `TabBar` niesie grupowanie po projektach, kolory, kropki
   aktywności, menu kontekstowe i odłączanie do okna. Adaptacja kosztowałaby więcej niż własne
   drzewo.

## Model stanu

```ts
type PaneLeaf = { kind: 'leaf'; id: string; tabIds: string[]; activeTabId: string | null };
type PaneSplit = { kind: 'split'; id: string; dir: 'row' | 'col'; sizes: number[]; children: PaneNode[] };
type PaneNode = PaneLeaf | PaneSplit;
```

Stan w nowym `store/panesSlice.ts`:

- `layout: PaneNode` — korzeń; przy starcie pojedynczy liść.
- `focusedPaneId: string`.

Niezmienniki (pilnowane przez `reconcileLayout`, weryfikowane testami):

- każde `tab.id` z `tabs[]` występuje w dokładnie jednym liściu,
- żaden liść nie zawiera identyfikatora spoza `tabs[]`,
- `leaf.activeTabId` należy do `leaf.tabIds` albo jest `null` (tylko dla pustego korzenia),
- `sizes.length === children.length`, `sizes` sumują się do 1, każdy ≥ minimum wynikającego
  z rozmiaru kontenera,
- `split.children.length ≥ 2`,
- `focusedPaneId` wskazuje istniejący liść.

Akcje:

| Akcja | Efekt |
|---|---|
| `focusPane(paneId)` | ustawia `focusedPaneId` i `activeTabId` na aktywną zakładkę tego liścia |
| `splitPane(targetPaneId, dir, before, tabId)` | tworzy nowy liść z `tabId` obok wskazanego, usuwa `tabId` ze źródła, dzieli miejsce po równo, ustawia fokus na nowym liściu |
| `moveTabToPane(tabId, targetPaneId, index)` | przenosi lub zmienia kolejność w obrębie panelu; przy pustym źródle zwija je |
| `setPaneActiveTab(paneId, tabId)` | aktywna zakładka panelu + fokus na ten panel |
| `resizeSplit(splitId, index, fraction)` | aktualizuje `sizes` z klamrowaniem do minimum |

Istniejące akcje `tabsSlice` wymagają dwóch punktowych zmian:

- `setActive(id)` dodatkowo ustawia `focusedPaneId` na panel będący właścicielem zakładki —
  dzięki temu klik w sesję na sidebarze i `TabSwitcher` (Ctrl+Tab po MRU) przenoszą fokus
  tam, gdzie zakładka faktycznie żyje.
- `openSessionTab` szuka zakładki `preview` **tylko w panelu sfokusowanym**, nie globalnie.
  Bez tego jeden slot podglądu byłby współdzielony przez wszystkie panele i skakałby między nimi.

## Geometria i renderowanie

```
computePaneRects(layout) → Map<paneId, { left: number; top: number; width: number; height: number }>  // w %
```

Funkcja czysta, bez pomiarów DOM — procenty wynikają wprost z `sizes[]`. Cała zawartość centrum
żyje w jednym kontenerze `relative`, w którym leżą obok siebie:

1. **Pasek zakładek każdego panelu** — `absolute`, `left/width` z prostokąta panelu,
   `top: <rect.top>%`, wysokość `TAB_BAR_HEIGHT` (32px, dzisiejsze `h-8`).
2. **Warstwa treści każdej zakładki** — `absolute`, prostokąt panelu-właściciela pomniejszony
   o pasek: `top: calc(<rect.top>% + 32px)`, `height: calc(<rect.height>% - 32px)`.
   Widoczna, gdy jest aktywną zakładką swojego panelu; poza tym dzisiejsze
   `invisible pointer-events-none`.
3. **Uchwyty resizerów** — `absolute` na granicach splitów, wizualnie 1px, obszar trafienia 5px
   (`transform: translateX(-50%)` / `translateY(-50%)`), kursor zależny od `dir`.

Zakładka niebędąca jeszcze w żadnym liściu (jedna klatka między dodaniem do `tabs[]`
a uzgodnieniem layoutu) renderuje się w panelu sfokusowanym — fallback w selektorze eliminuje
mignięcie.

Zmiana rozmiaru panelu nie wymaga żadnej dodatkowej logiki: `ResizeObserver` w `TerminalView`
wywołuje `fit()` i `ptyResize`, tak jak dziś przy zmianie szerokości okna.

## Pasek zakładek

`groupTabsByProject` dostaje wariant per panel: grupy powstają tylko dla projektów z ≥2
zakładkami w tym panelu, reszta trafia na początek listy jako zakładki luzem. Nagłówki grup
pokazują się, gdy w panelu istnieje co najmniej jedna grupa.

Każda zakładka renderuje 2px lewej krawędzi w `getProjectColor` projektu — także wewnątrz grupy,
także w panelu z jednym projektem. Kolor jest jedynym nośnikiem tożsamości projektu dla zakładek
wyrzuconych poza grupy.

Menu kontekstowe zakładki i grupy działa bez zmian; odłączanie do okna zostaje wyłącznie tam.

## Gest przeciągania

- Wciśnięcie lewego przycisku na zakładce zapamiętuje punkt startowy; drag zaczyna się po
  przekroczeniu 4px, więc zwykłe kliknięcie nadal tylko aktywuje zakładkę. Obsługa middle-click
  bez zmian.
- Podczas przeciągania nad obszarem treści panelu obowiązuje pięć stref: cztery pasy krawędziowe
  po 25% szerokości/wysokości (lewo i prawo → `dir: 'row'`, góra i dół → `dir: 'col'`) oraz
  środek → przeniesienie do tego panelu bez podziału.
- Nad paskiem zakładek: wstawienie na konkretną pozycję (zmiana kolejności w panelu lub
  przeniesienie z innego panelu).
- Strefa docelowa jest podświetlana półprzezroczystym prostokątem odpowiadającym przyszłemu
  kształtowi panelu.
- Upuszczenie poza obszarem centrum anuluje operację. Przeciągnięcie poza okno nie tworzy nowego
  okna — odłączanie zostaje w menu kontekstowym.

Reguła stref jako czysta funkcja: `dropZone(point, rect) → 'left' | 'right' | 'top' | 'bottom' | 'center'`.

## Cykl życia paneli

- Panel, który stracił ostatnią zakładkę, znika. Jego split zwija się: gdy zostaje jedno dziecko,
  zastępuje ono rodzica; uwolniona przestrzeń rozkłada się proporcjonalnie na rodzeństwo.
- Fokus po zniknięciu panelu przechodzi na poprzednie rodzeństwo, a gdy go nie ma — na następne;
  gdy zniknął cały split, na pierwszy liść w kolejności obchodzenia drzewa.
- Zamknięcie wszystkich zakładek zostawia jeden pusty liść z dotychczasowym komunikatem
  „Wybierz sesję z lewej".
- Minimalny rozmiar panelu: 240px szerokości, 120px wysokości. `sizes` są ułamkowe, więc minimum
  przelicza się na ułamek z rozmiaru kontenera zmierzonego w chwili startu przeciągania resizera
  (i przy podziale — z prostokąta panelu dzielonego). Podział poniżej minimum jest odrzucany
  (strefa zrzutu się nie pojawia).
  Praktyczny limit liczby paneli wynika z tego sam; nie ma sztywnego górnego ograniczenia.

## Fokus i skutki uboczne

- Klik gdziekolwiek w panelu (pasek lub treść) ustawia `focusedPaneId`. Listener `mousedown`
  w fazie **capture** na regionie panelu — inaczej textarea xterma przechwyci zdarzenie
  (ten sam wzorzec, co globalne skróty w `TabBar`/`Sidebar`).
- `activeAgentPtyId` przełącza wyzwalacz z `visible` na `visible && paneFocused`. Bez tego przy
  kilku widocznych agentach wygrywa ostatnio zamontowany i „wstaw do aktywnej sesji" trafia
  w losowy terminal. `TerminalView` dostaje prop `focused`.
- Czyszczenie attention w `AppShell` obejmuje **wszystkie widoczne** zakładki, nie tylko
  `activeTabId` — inaczej sesja oglądana w sąsiednim panelu generowałaby powiadomienia.
  Analogicznie warunek „użytkownik patrzy" w obsłudze `AttentionEvent`.
- Tytuł okna, `RightPanel` i `Ctrl+W` pozostają bez zmian dzięki decyzji 2.
- Nowe zakładki (nowa sesja, terminal, akcja, klik w sidebarze) trafiają do panelu sfokusowanego
  — wynika to z `reconcileLayout`, nie z modyfikacji akcji.

## Persystencja

Payload `abeoncode.tabs` zyskuje `layout` i `focusedPaneId`. Klucz zmiany w subskrypcji
`store/index.ts` obejmuje dodatkowo serializację layoutu.

Odczyt: po `sanitizeRestoredTabs` layout przechodzi walidację. Identyfikatory zakładek, które
nie przetrwały sanityzacji, są usuwane; puste liście zwijane; niespójne lub nieparsowalne drzewo
degraduje się do pojedynczego liścia ze wszystkimi zakładkami. Zasada: lepiej stracić układ niż
zakładkę.

## Okna odłączone

`DetachedShell` startuje zawsze z pojedynczym panelem, w obu trybach (`session`, `group`).
Payload w query stringu nie niesie layoutu. Podział wewnątrz okna odłączonego działa normalnie,
ale — jak cały stan tych okien — nie jest persystowany.

## Pliki

Nowe:

- `src/store/panesSlice.ts` — stan i akcje layoutu.
- `src/lib/paneTree.ts` — czyste operacje na drzewie: `splitLeaf`, `moveTab`, `removeTab`,
  `collapse`, `reconcileLayout`, `findLeafOfTab`, `nextFocusAfterRemoval`.
- `src/lib/paneGeometry.ts` — `computePaneRects`, `dropZone`, klamrowanie rozmiarów, stałe
  `TAB_BAR_HEIGHT`, `MIN_PANE_WIDTH`, `MIN_PANE_HEIGHT`.
- `src/components/center/PaneLayout.tsx` — kontener renderujący paski, warstwy treści i resizery.
- `src/components/center/PaneDragOverlay.tsx` — podświetlenie strefy zrzutu.

Zmieniane:

- `src/store/index.ts` — kompozycja slice'a, uzgadnianie layoutu, persystencja i restore.
- `src/store/tabsSlice.ts` — `setActive` przenosi fokus panelu; `openSessionTab` szuka `preview`
  w panelu sfokusowanym.
- `src/components/center/CenterPanel.tsx` — `TabBar` + `TabContent` zastąpione przez `PaneLayout`.
- `src/components/center/TabBar.tsx` — prop `paneId`, źródło zakładek z liścia, start przeciągania,
  kolor projektu na krawędzi zakładki.
- `src/components/center/TabContent.tsx` — renderowanie warstw sterowane prostokątami paneli.
- `src/lib/tabGrouping.ts` — reguła „grupa dopiero od 2 zakładek projektu".
- `src/components/terminal/TerminalView.tsx` — prop `focused`, warunek ustawiania
  `activeAgentPtyId`.
- `src/components/layout/AppShell.tsx` — attention dla wszystkich widocznych zakładek.
- `src/components/layout/DetachedShell.tsx` — seed pojedynczego panelu.

## Testy

Ciężar spoczywa na funkcjach czystych:

- `paneTree`: podział liścia w czterech kierunkach; przeniesienie ostatniej zakładki zwija panel
  i split; zwijanie zagnieżdżone (split z jednym dzieckiem znika); `reconcileLayout` dopina
  osierocone zakładki do panelu sfokusowanego i usuwa nieistniejące; wybór fokusu po usunięciu.
- `paneGeometry`: `computePaneRects` dla drzewa zagnieżdżonego sumuje się do 100% w każdej osi;
  `dropZone` na granicach pasów; odrzucenie podziału poniżej minimum.
- `tabGrouping`: projekt z jedną zakładką ląduje poza grupami na początku; z dwiema — tworzy grupę;
  panel jednoprojektowy nie pokazuje nagłówka.
- `panesSlice`: `focusPane` synchronizuje `activeTabId`; `setActive` na zakładkę z innego panelu
  przenosi fokus; `closeTab` aktualizuje layout, `mruOrder` i `navHistory`.
- `store/index`: round-trip persystencji layoutu; degradacja niespójnego drzewa do jednego liścia.
- `TabBar`: przeciągnięcie zakładki z progiem 4px, klik poniżej progu tylko aktywuje; kolor
  krawędzi odpowiada projektowi.
- Test integracyjny na kluczowy niezmiennik: przeniesienie zakładki między panelami **nie**
  remountuje `TerminalView` (stabilny węzeł DOM / licznik montowań).

## Poza zakresem v1

- Przenoszenie layoutu do okien odłączonych i z powrotem.
- Zapisywane układy / presety paneli.
- Przeciągnięcie zakładki poza okno jako skrót do odłączenia.
- Skróty klawiszowe do przełączania fokusu między panelami i do dzielenia bez myszy
  (tanie do dołożenia po v1).
- Maksymalizacja („zoom") panelu.
- Zakładki widoczne w dwóch panelach naraz — jedna zakładka należy zawsze do jednego panelu.
