# Grafit — lista kontrolna ręcznego QA

Uruchom `npm run tauri dev` w `DesktopApp/` (COSMIC / Wayland). Sprawdź każdy punkt i odhacz. Wszystko, co nie przejdzie, staje się zadaniem naprawczym przed wydaniem.

## Ustawienia (widok nad aplikacją)

- [ ] Otwórz ustawienia przy żywej sesji Claude i uruchomionej akcji: sesja się nie restartuje, scrollback jest nietknięty, akcja dalej działa.
- [ ] Zamknij ustawienia przyciskiem „Wróć do sesji", potem ponownie otwórz i zamknij klawiszem Esc: klawiatura wraca do terminalu (od razu wpisujesz tekst do Claude, bez klikania).
- [ ] W WebKitGTK `inert` działa: przy otwartych ustawieniach Tab nie wchodzi do ukrytego sidebara ani terminali, a kliknięcie w tło nie aktywuje paneli pod spodem.
- [ ] Widok ustawień wygląda jak `Ustawienia.dc.html` (nagłówek strony, siatka wierszy, nawigacja z lewej, breadcrumb „Ustawienia / kategoria" w nagłówku okna).
- [ ] Wyszukiwarka ustawień filtruje kategorie (także bez polskich znaków, np. „czcionka", „sciezka") i przełącza na pierwszą pasującą.
- [ ] Przy otwartych ustawieniach `Ctrl+W`, `Ctrl+T`, `Ctrl+K`, `Ctrl+N`, `Ctrl+1` i skróty podziału szuflady (`Ctrl+Shift+O/E`, `Ctrl+Alt+strzałki`) nie robią nic widocznego w ukrytych zakładkach.
- [ ] W Ustawienia > Skróty nagraj nowe powiązanie (rejestrator łapie klawisze mimo wstrzymanych skrótów); po zamknięciu ustawień skróty znów działają, w tym nagrane.
- [ ] Modele: wiersze zawijają się poprawnie przy wąskim oknie, nic nie wychodzi poza kartę.
- [ ] Skróty: wiersze są czytelne, brak obciętych etykiet i nakładających się przycisków.
- [ ] Agent sterujący: blok Discord mieści się w karcie i wygląda poprawnie.

## Wygląd terminala

- [ ] Dwukolumnowa strona Terminal (opcje + podgląd) układa się poprawnie; na wąskim oknie kolumny zawijają się bez poziomego przewijania.
- [ ] Zmień krój, rozmiar, interlinię, paletę i kursor przy otwartej sesji Claude, karcie z shellem i szufladzie z dwoma podziałami: wszystkie terminale zmieniają wygląd na żywo, bez restartu i bez utraty scrollbacku.
- [ ] Po zmianie kroju lub rozmiaru liczba kolumn i wierszy dopasowuje się; w terminalu `stty size` (lub `tput cols`) zgadza się z tym, co widać.
- [ ] Zimny start aplikacji z wybraną czcionką JetBrains Mono lub IBM Plex Mono: glify są wyrównane do siatki od pierwszej linii (bez rozjechanych odstępów po leniwym załadowaniu czcionki), a rozmiar PTY zgadza się z widocznym.
- [ ] Przełączenie na paletę „Własna" z poprawnym JSON-em xterm.js działa, a błędny JSON pokazuje komunikat błędu bez zmiany palety.
- [ ] Kliknięcie karty „Własna", gdy ta paleta jest już wybrana, zwija edytor, a kolejne kliknięcie go rozwija; po przejściu na inną paletę kliknięcie „Własna" przywraca zapisane kolory.
- [ ] „Przywróć domyślne" przywraca Geist Mono 13, interlinię 1,65, paletę Grafit, kursor blok z miganiem.
- [ ] Odznaka „Nowe" przy Terminal znika po pierwszym wejściu w kategorię i nie wraca po restarcie.
- [ ] Motyw jasny: strona Terminal i podgląd są czytelne.

## Nagłówek, panele i karty

- [ ] Podziel panele (prawo i dół), kliknij każdy: wiersz projektów w nagłówku i ramka fokusu podążają za aktywnym panelem.
- [ ] Przeciągnij kartę sesji między panelami i na krawędź (nowy podział); zmień rozmiar uchwytami między panelami: uchwyty łapią się w całej szczelinie, nic nie miga.
- [ ] Rogi kart nad żywym terminalem są zaokrąglone (bez kwadratowych rogów płótna xterm wystających poza kartę), także przy otwartej szufladzie.
- [ ] Ramka fokusu to nieco jaśniejsza szara obwódka (#2E3136, zwykła ramka ma #1D1F23); jest widoczna tylko przy dwóch lub więcej panelach, a przy jednym panelu jej nie ma.
- [ ] Przy jednym panelu karta styka się z nagłówkiem (ujemny margines −4 px nie zakrywa przycisków nagłówka ani nie zostawia przerwy).
- [ ] Okno ok. 1024x640 oraz ok. 900 px szerokości: nagłówek, wiersz projektów (przewijany kółkiem), pasek panelu i prawy panel są używalne, nic się nie nakłada.
- [ ] Motyw jasny: nagłówek, pasek panelu, ramki i prawy panel są używalne.
- [ ] macOS (jeśli dostępny): nagłówek ma lewy margines 78 px i da się nim przeciągać okno; na COSMIC pasek tytułu systemowy zostaje bez zmian.

## Szuflada terminala

- [ ] Otwórz i zwiń szufladę (`Ctrl+T`), podziel ją w prawo i w dół, przesuń fokus `Ctrl+Alt+strzałki`, wydziel terminal do zakładki: PTY przeżywa, scrollback jest zachowany.
- [ ] Nagłówek szuflady ma 36 px, a zwinięty pasek nie zasłania treści sesji ani się z nią nie nakłada.
- [ ] `Ctrl+T`, `Ctrl+Shift+O/E`, `Ctrl+Alt+strzałki` działają bez otwartych ustawień i nie działają przy otwartych.

## Historia sesji

- [ ] Widok historii w obu trybach (Komunikacja i Pełny) wygląda spójnie z makietą `Historia.dc.html`.
- [ ] Wyniki narzędzi są sparowane z wywołaniami (stan: w toku / gotowe / błąd), brakujące czasy są ukryte, a nazwy dostawców skrócone.
- [ ] Wyszukiwanie w historii (`Ctrl+F`) podświetla i przewija do trafień.
- [ ] „Kontynuuj w terminalu" przełącza kartę na żywy terminal tej samej sesji.

## Okna wydzielone

- [ ] Wydziel grupę projektu do okna: nagłówek pokazuje logo i breadcrumb „<projekt> / Okno projektu", licznik „N aktywne", a układ zgadza się z `OknoWydzielone.dc.html`.
- [ ] Wydziel pojedynczą sesję do okna: nagłówek ma logo, wiersz projektów i licznik „N aktywne", pasek panelu ma `+` i `$`, podziały działają jak w głównym oknie.
- [ ] W oknie wydzielonym karta ClickUp z nieprawidłowym tokenem pokazuje komunikat o nieprawidłowym tokenie i podpowiedź „Popraw token w ustawieniach głównego okna.", bez przycisku ustawień (stany jak w `ClickUpStany.dc.html`).

## Skróty globalne

- [ ] `Ctrl+K` ustawia fokus w wyszukiwarce sidebara także przy sfokusowanym terminalu.
- [ ] `Ctrl+W` zamyka aktywną kartę (z potwierdzeniem przy aktywnym procesie) dokładnie raz, także gdy paneli jest kilka.
- [ ] `Ctrl+T` przełącza szufladę lub otwiera terminal; `Ctrl+N` otwiera nową sesję w aktywnym projekcie; `Ctrl+Shift+N` otwiera szybką wyszukiwarkę projektów; `Ctrl+1`–`Ctrl+9` uruchamiają akcję o danym numerze.
- [ ] Na macOS glif skrótu `⌘K` w sidebarze jest poprawny.

## Sidebar i panel prawy

- [ ] Wiersze sesji: stany hover i rozwinięty wyglądają poprawnie; animacja pulsu dla „Pracuje" działa i nie zacina.
- [ ] Kolory aktywności: bursztynowy = pracuje, niebieski = czeka na Ciebie.
- [ ] Prawy panel (pastylki, karty Git/Akcje/ClickUp) w motywie jasnym jest czytelny.
- [ ] Karta ClickUp w głównym oknie, w stanie nieprawidłowego tokenu (przycisk „Otwórz ustawienia ClickUp" pojawia się tylko tam): po kliknięciu ustawienia otwierają się na kategorii ClickUp, a po ich zamknięciu fokus wraca do terminalu.
- [ ] Przy fokusie w terminalu kliknij myszą ikonę ustawień w stopce sidebara, potem Esc: klawiatura wraca do terminalu.
- [ ] Przerywane i „niebezpieczne" karty ClickUp wyglądają poprawnie w motywie jasnym.

## Menu, dialogi i powiadomienia

- [ ] Menu kontekstowe i rozwijane: kolory hover są poprawne.
- [ ] Przycisk `btn-danger` ma czytelny tekst w motywie ciemnym.
- [ ] Toasty mają obramowania zależne od typu (sukces, błąd, informacja).
- [ ] `ClickUpTaskDialog`: stopka z sześcioma przyciskami przy wysokości 30 px mieści się bez zawijania i ucięć.
