# Przeglądarka plików — lista kontrolna ręcznego QA

Data: 2026-11-11 · Aplikacja: `DesktopApp/` · Spec: `2026-11-11-file-browser-design.md`

Testy automatyczne nie sprawdzają działania w prawdziwym oknie, więc ta lista pokrywa to, co trzeba
obejrzeć ręcznie w uruchomionej aplikacji (`npm run tauri dev` albo zainstalowana wersja). Przy
każdym kroku zapisz wynik: OK / nie OK / nie sprawdzono. Do testów wygodnie mieć projekt będący
repozytorium Git z plikiem `.env` w `.gitignore`.

## 1. Panel plików i wyszukiwanie

1. Otwórz projekt z aktywną zakładką i kliknij „Pliki” w prawej kolumnie. Panel zastępuje
   narzędzia projektu, pole „Szukaj pliku…” ma fokus, a w drzewie widać katalogi przed plikami.
2. Sprawdź, że `.git` nie jest na liście, a `.env` i inne pliki z kropką są widoczne. Pliki z
   `.gitignore` są przygaszone, a zmienione w Git mają kolor i literę statusu jak w panelu Git.
3. Kliknij katalog: rozwija się i zwija. Zwinięcie rodzica zwija też jego rozwinięte podkatalogi
   (po ponownym rozwinięciu są zwinięte).
4. Wpisz fragment nazwy pliku. Lista wyników zastępuje drzewo, kolejność to: dokładna nazwa,
   początek nazwy, reszta. Strzałki góra/dół zmieniają zaznaczenie, Enter otwiera plik, Esc czyści
   pole i wraca do drzewa z zachowanym rozwinięciem.
5. Wpisz zapytanie ze znakiem `/` (np. `src/app`): dopasowanie działa po ścieżce względnej.
6. Wyszukaj `.env`: plik z `.gitignore` leżący w nieignorowanym katalogu musi się znaleźć, a
   pliki z `node_modules` nie.
7. Kliknij prawym przyciskiem plik w drzewie i w wynikach wyszukiwania: „Kopiuj ścieżkę” wkłada
   ścieżkę względną do schowka, „Wstaw ścieżkę do sesji” wpisuje ją do aktywnej sesji agenta
   (bez aktywnej sesji pozycja jest wyłączona). Dla pliku z nowym wierszem w nazwie (`touch
   $'a\nb'`) pozycja pokazuje błąd „Ścieżka zawiera niedozwolone znaki” i nic nie wpisuje.
8. Panele plików i notatek nigdy nie są widoczne razem: przy otwartym panelu pasek narzędzi
   projektu (z przyciskami „Pliki” i „Notatki”) jest ukryty. Zamknij panel plików przyciskiem ✕,
   otwórz „Notatki”, zamknij je ✕ i otwórz „Pliki”: za każdym razem widać tylko jeden panel, a po
   ✕ wraca pasek narzędzi z resztą prawej kolumny.
9. Zamknij ostatnią zakładkę: panel plików zamyka się sam. Przełącz się na zakładkę innego
   projektu przy otwartym panelu: drzewo przełącza się na ten projekt.

## 2. Duże repozytorium

10. Otwórz projekt z dużym `node_modules` i rozwiń go w drzewie. Okno nie zacina się, po
    rozwinięciu widać najwyżej 2000 pozycji i napis „pokazano pierwsze 2000”.
11. Przy rozwiniętym `node_modules` wpisz nazwę pliku w wyszukiwarce: wyniki pojawiają się bez
    zawieszenia aplikacji, a dla bardzo częstej nazwy pojawia się „pokazano pierwsze 200”.
12. W dużym repozytorium wpisz bardzo częstą nazwę i zaraz potem wyczyść pole (Esc) albo zamknij
    panel ✕, a potem wyszukaj coś innego: aplikacja nie zacina się, a nowe wyniki przychodzą od razu
    (przerwane przeszukiwanie kończy się przy następnym katalogu, nie po 200 000 pozycjach).
13. Zwiń `node_modules` i sprawdź, że aplikacja dalej reaguje na zmiany w innych katalogach (np.
    `touch nowy.txt` w katalogu głównym pojawia się w drzewie w ciągu ułamka sekundy).

## 3. Zakładka pliku, edytor i Markdown

14. Otwórz plik tekstowy: otwiera się w nowej zakładce w trybie edycji, z numerami linii i
    kolorowaniem składni. Ponowne kliknięcie tego pliku w drzewie aktywuje istniejącą zakładkę.
15. Zmień treść: w zakładce pojawia się „●”, pasek pokazuje „Niezapisane zmiany”, a „Zapisz”
    się aktywuje. Zapisz przyciskiem i `Ctrl/Cmd+S`: „●” znika, na chwilę widać „Zapisano”.
16. Otwórz plik `.md`: otwiera się jako podgląd, „Edytuj” przełącza na źródło, „Podgląd” wraca,
    a niezapisane zmiany są widoczne w podglądzie. Po powrocie do edycji historia cofania jest
    pusta (znane ograniczenie).
17. Otwórz obraz (png/svg), plik binarny i plik większy niż 1 MiB: obraz jest dopasowany do
    okna, pozostałe dwa pokazują komunikat z rozmiarem, bez treści.
18. Otwórz plik z końcówkami CRLF i plik z BOM, zmień jedną linię i zapisz: końcówki i BOM
    zostają (`file nazwa`, `xxd | head`).
19. Skopiuj do schowka kilka linii z końcówkami CRLF (`printf 'A=1\r\nB=2\r\n' | wl-copy`, na X11
    `xclip -selection clipboard`, na Windows zwykłe kopiowanie) i wklej je do pliku z końcówkami
    LF oraz do pliku z CRLF, po czym zapisz oba. `xxd nazwa`: w pliku LF wklejone linie kończą się
    samym `0a` (bez `0d`), a w pliku CRLF parą `0d 0a`, nigdzie nie ma `0d 0d 0a` ani
    pojedynczego `0d` na końcu wartości.
20. Przy fokusie w edytorze naciśnij `Ctrl/Cmd+W`: zakładka zamyka się (z pytaniem, gdy plik jest
    zmieniony), a nie jest przechwycona przez edytor. Naciśnij `Ctrl/Cmd+K`: fokus trafia do
    wyszukiwarki w lewej kolumnie. `Ctrl/Cmd+F` w edytorze otwiera panel wyszukiwania w pliku.
21. Sprawdź kolory edytora i panelu wyszukiwania w pliku (`Ctrl/Cmd+F`) w motywie ciemnym i
    jasnym: tło, numery linii, zaznaczenie, pola tekstowe i przyciski mają kolory aplikacji, a
    przełączenie motywu przy otwartym edytorze od razu zmienia kolory.
22. Otwórz plik `.env` (podświetlanie `KEY=value`) oraz pliki JSON, YAML, PHP, Rust i
    TypeScript: składnia jest kolorowana, a nieznane rozszerzenie otwiera się jako zwykły tekst.

## 4. Zmiany na dysku

23. Otwórz niezmieniony plik, który agent (albo `echo >> plik` w terminalu) dopisze. Zawartość
    odświeża się po chwili, bez paska.
24. Otwórz długi plik, przewiń go w dół i ustaw kursor, a potem zmień ostatnią linię z
    zewnątrz: po odświeżeniu pozycja przewinięcia i kursor się nie przesuwają. Naciśnij `Ctrl+Z`:
    nic się nie cofa (historia jest czyszczona przy odświeżeniu z dysku).
25. Zmień plik w edytorze (bez zapisu), a potem zmień go z zewnątrz: pojawia się pasek „Plik
    zmienił się na dysku” z „Wczytaj ponownie” i „Zostaw moje”. „Zostaw moje” zostawia edycje,
    a kolejny zapis przechodzi bez okna konfliktu (zakładka wczytuje treść i wersję z dysku jako
    nowy punkt odniesienia; okno pojawi się tylko wtedy, gdy plik w międzyczasie znowu zmieni się z
    zewnątrz).
26. Po „Zostaw moje” cofaj (`Ctrl+Z`) własne zmiany aż do tekstu sprzed zmiany z zewnątrz:
    zakładka dalej pokazuje „●” i „Niezapisane zmiany”, bo ten tekst różni się od dysku, a „Zapisz”
    zapisuje go. Powtórz i zamiast cofania wpisz dokładnie treść, która jest na dysku: „●” znika.
27. Przy tym samym ustawieniu naciśnij „Zapisz”: pojawia się okno „Plik zmienił się na dysku” z
    „Nadpisz” / „Wczytaj ponownie” / „Anuluj”. „Nadpisz” zapisuje moją wersję, „Anuluj” zamyka
    okno i fokus wraca do edytora.
28. Sprawdź, że własny zapis nie wywołuje paska „Plik zmienił się na dysku” (zapisz kilka razy
    pod rząd, także szybko po sobie).
29. Edytuj `.env` w aplikacji, gdy sesja agenta zapisuje pliki w projekcie: po zmianie pliku przez
    agenta pojawia się pasek „Plik zmienił się na dysku”, a zapis kończy się oknem konfliktu
    zamiast po cichu nadpisać wersję agenta.
30. Usuń otwarty plik z zewnątrz (`rm`): pojawia się pasek „Plik został usunięty”, treść zostaje, a
    „Zapisz” tworzy plik ponownie. Zakładka z usuniętym plikiem pyta o zapis przy zamknięciu.
31. Przełączenie gałęzi (`git checkout inna-galaz`), w której otwarty plik z katalogu głównego
    projektu nie istnieje, a potem powrót (`git checkout -`): zakładka z niezmienionym buforem po
    powrocie wczytuje plik po cichu, bez paska. Powtórz z zakładką z niezapisanymi zmianami: tekst
    zostaje, a pojawia się pasek „Plik zmienił się na dysku”. Plik z katalogu, który znika razem
    z gałęzią, sprawdza krok 34.
32. Zapisz usunięty plik, który w międzyczasie pojawił się ponownie z inną treścią: zakładka
    zostaje zmieniona, pojawia się okno konfliktu, a „Nadpisz” zapisuje.
33. Rozwiń w drzewie katalog (np. `qa-tmp/`) i otwórz w nim plik bez wprowadzania zmian. Usuń
    katalog z zewnątrz (`rm -rf qa-tmp`): katalog znika z drzewa, a zakładka pokazuje „Plik
    został usunięty”. Utwórz katalog ponownie z tym plikiem o innej treści (`mkdir qa-tmp && echo
    nowa > qa-tmp/plik.txt`). Przy otwartym panelu plików w ciągu ok. 3 s, a bez panelu najpóźniej
    po przełączeniu fokusu okna (na inne okno i z powrotem) albo po przejściu na zakładkę tego
    pliku, drzewo pokazuje zawartość katalogu (bez „Nie udało się wczytać katalogu”), a zakładka
    wczytuje nową treść po cichu, bez paska. Potem dodaj w tym katalogu kolejny plik i zmień
    otwarty plik z zewnątrz: drzewo i zakładka odświeżają się same, bez przełączania fokusu
    (obserwacja katalogu znowu działa).
34. To samo z gałęzią Git: rozwiń katalog, który istnieje tylko na bieżącej gałęzi, i otwórz z
    niego dwa pliki, jeden bez zmian i jeden z niezapisanymi zmianami. `git checkout
    gałąź-bez-katalogu`, a potem `git checkout -`. Po powrocie (najpóźniej po przełączeniu fokusu
    okna) drzewo pokazuje katalog z zawartością, niezmieniona zakładka wczytuje plik po cichu, a
    zakładka ze zmianami zostawia tekst i pokazuje pasek „Plik zmienił się na dysku”. Kolejne
    zmiany w tym katalogu z zewnątrz widać od razu.
35. Katalog odtworzony bez opuszczania okna: przy otwartym panelu rozwiń `qa-tmp/` i otwórz z niego
    plik, a potem w terminalu wewnątrz aplikacji (fokus zostaje w oknie) wykonaj `rm -rf qa-tmp &&
    mkdir qa-tmp && echo nowa > qa-tmp/plik.txt`. Bez klikania czegokolwiek, w ciągu ok. 3 s, drzewo
    pokazuje `qa-tmp/` z zawartością i zakładka wczytuje „nowa”.
36. Plik przez dowiązanie: `mkdir -p config && echo A=1 > config/real.env && ln -s config/real.env
    .env`, otwórz `.env` z drzewa. Dopisz z zewnątrz do celu (`echo B=2 >> config/real.env`):
    niezmieniona zakładka odświeża się sama po chwili, bez przełączania fokusu (obserwowany jest
    katalog `config`). Przy otwartym panelu przestaw dowiązanie do innego katalogu (`mkdir -p vault
    && echo C=3 > vault/other.env && ln -sfn vault/other.env .env`): zakładka wczytuje „C=3”, a
    dalsze zmiany w `vault/other.env` też ją odświeżają.

## 5. Pliki specjalne i zapis w miejscu

37. Zapisz plik `.env` podmontowany jako pojedynczy plik do kontenera (`docker run -v
    $PWD/.env:/app/.env ...`): zapis się udaje, a kontener widzi nową treść (zapis w miejscu
    zachowuje i-węzeł).
38. Zapisz plik z twardym dowiązaniem (`ln .env .env.link`): obie nazwy pokazują nową treść
    (`stat -c %i` daje ten sam numer przed i po).
39. Zapisz plik tylko do odczytu (`chmod 444`): zapis kończy się komunikatem błędu w pasku,
    plik nie zostaje zastąpiony, bufor zostaje zmieniony. To samo po „Nadpisz”.
40. Zapisz plik w katalogu bez prawa zapisu (`chmod 555 katalog`): zapis się udaje w miejscu,
    gdy sam plik jest zapisywalny. Uprawnienia pliku po zapisie są takie jak przed.
41. Utwórz kolejkę FIFO (`mkfifo kolejka`) w projekcie i spróbuj ją otworzyć z drzewa: aplikacja
    nie zawiesza się, zakładka pokazuje błąd z „Spróbuj ponownie”.

## 6. Okna odłączone i ochrona niezapisanych plików

42. Odłącz grupę projektu do osobnego okna, gdy ma otwarty plik z zapisaną treścią: plik otwiera
    się w nowym oknie, wczytany z dysku.
43. Zdarzenia zmiany katalogu mają trafiać tylko do okna, które go obserwuje. Rozwiń ten sam
    katalog w oknie głównym i w odłączonym (panel plików w obu), dodaj plik z zewnątrz: drzewo
    odświeża się w obu oknach, a otwarty w jednym z nich plik tego katalogu reaguje na zmianę na
    dysku tylko w swoim oknie. Zamknij jedno okno: drugie dalej odświeża drzewo.
44. Zamknij zakładkę z niezapisanym plikiem (X, środkowy przycisk, `Ctrl/Cmd+W`): okno
    „Niezapisane zmiany” z listą plików. „Zapisz” zapisuje i zamyka, „Odrzuć zmiany” zamyka bez
    zapisu, „Anuluj” (i Esc) zostawia zakładkę.
45. Odłącz grupę projektu z niezapisanym plikiem: najpierw pojawia się to samo okno, a „Anuluj”
    przerywa odłączanie.
46. Zamknij okno główne z niezapisanym plikiem: okno pyta o zapis przed pytaniami o notatki i o
    działające sesje. To samo dla okna odłączonego.
47. Sprawdź błąd zapisu w oknie „Niezapisane zmiany” (np. plik tylko do odczytu): okno zostaje
    otwarte, pokazuje „Nie udało się zapisać wszystkich plików.”, fokus wraca na „Zapisz”, a
    „Odrzuć zmiany” nadal działa. Dla pliku zmienionego z zewnątrz po edycji okno pokazuje „Plik …
    zmienił się na dysku. Otwórz zakładkę pliku i wybierz „Wczytaj ponownie” albo „Zostaw moje”, a
    potem zapisz.” (dla kilku plików „Pliki … zmieniły się na dysku”), a zakładka faktycznie ma te
    dwa przyciski.
48. Zamknij okno z niezapisanymi plikami z dwóch różnych projektów (np. okno główne z zakładkami
    obu projektów): lista w oknie pokazuje „<projekt>: <ścieżka>”. Z plikami jednego projektu lista
    ma same ścieżki.
49. Przy dostępnej aktualizacji z niezapisanym plikiem w oknie głównym: przed pobraniem pojawia się
    okno „Niezapisane zmiany”; po „Anuluj” aktualizacja jest wstrzymana, po „Zapisz” lub
    „Odrzuć zmiany” pobiera się (pasek postępu), a po pobraniu, przed instalacją, okno nie pyta o te
    same pliki; potem instalacja i ponowne uruchomienie.
50. Przy dostępnej aktualizacji z niezapisanym plikiem w oknie odłączonym (okno główne czyste):
    aktualizacja jest odrzucona z komunikatem „Masz niezapisane pliki w innym oknie. Zapisz je lub
    zamknij to okno i spróbuj ponownie.” Po zapisaniu lub zamknięciu odłączonego okna ponowna
    próba przechodzi. Zamknięcie odłączonego okna z niezapisanym plikiem przez „Odrzuć zmiany” też
    zdejmuje blokadę.
51. Odmowa po pobraniu i ponowienie: przy czystych oknach uruchom aktualizację, a w trakcie
    pobierania zmień plik w oknie odłączonym bez zapisu. Po pobraniu aktualizacja jest odrzucona
    komunikatem „Masz niezapisane pliki w innym oknie…”, nic nie zostaje zainstalowane (aplikacja
    działa dalej w starej wersji, po zamknięciu i ponownym uruchomieniu nadal jest stara wersja), a
    „Zaktualizuj” znowu działa. Zapisz plik w oknie odłączonym i kliknij „Zaktualizuj”: aktualizacja
    instaluje się bez ponownego pobierania (pasek postępu nie startuje od zera) i aplikacja
    uruchamia się ponownie. Na Windows (jeśli dostępny) powtórz: instalator startuje dopiero po
    kontrolach (wcześniej proces kończył się w trakcie instalacji, przed kontrolą).

## 7. Wydajność i stabilność

52. Podczas pracy z otwartym panelem plików obserwuj log diagnostyczny
    (`~/.local/share/pl.cyberstudio.abeoncode/logs/abeoncode.log`): brak linii `files:` z błędami
    obserwatora przy zwykłej pracy, brak samoczynnych zamknięć okna (patrz gotcha o głównym wątku).
53. Zamknij okno odłączone z rozwiniętym drzewem i otwartymi plikami: okno główne nie zacina się
    przy zamknięciu, a po powrocie do rozwiniętych katalogów drzewo dalej się odświeża.
