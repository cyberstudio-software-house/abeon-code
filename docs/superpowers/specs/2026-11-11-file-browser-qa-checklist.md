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
8. Otwórz panel Notatki, gdy panel plików jest otwarty (i odwrotnie): jeden zamyka drugi, a gdy
   zapis notatki się nie uda, panel plików zostaje.
9. Zamknij ostatnią zakładkę: panel plików zamyka się sam. Przełącz się na zakładkę innego
   projektu przy otwartym panelu: drzewo przełącza się na ten projekt.

## 2. Duże repozytorium

10. Otwórz projekt z dużym `node_modules` i rozwiń go w drzewie. Okno nie zacina się, po
    rozwinięciu widać najwyżej 2000 pozycji i napis „pokazano pierwsze 2000”.
11. Przy rozwiniętym `node_modules` wpisz nazwę pliku w wyszukiwarce: wyniki pojawiają się bez
    zawieszenia aplikacji, a dla bardzo częstej nazwy pojawia się „pokazano pierwsze 200”.
12. Zwiń `node_modules` i sprawdź, że aplikacja dalej reaguje na zmiany w innych katalogach (np.
    `touch nowy.txt` w katalogu głównym pojawia się w drzewie w ciągu ułamka sekundy).

## 3. Zakładka pliku, edytor i Markdown

13. Otwórz plik tekstowy: otwiera się w nowej zakładce w trybie edycji, z numerami linii i
    kolorowaniem składni. Ponowne kliknięcie tego pliku w drzewie aktywuje istniejącą zakładkę.
14. Zmień treść: w zakładce pojawia się „●”, pasek pokazuje „Niezapisane zmiany”, a „Zapisz”
    się aktywuje. Zapisz przyciskiem i `Ctrl/Cmd+S`: „●” znika, na chwilę widać „Zapisano”.
15. Otwórz plik `.md`: otwiera się jako podgląd, „Edytuj” przełącza na źródło, „Podgląd” wraca,
    a niezapisane zmiany są widoczne w podglądzie. Po powrocie do edycji historia cofania jest
    pusta (znane ograniczenie).
16. Otwórz obraz (png/svg), plik binarny i plik większy niż 1 MiB: obraz jest dopasowany do
    okna, pozostałe dwa pokazują komunikat z rozmiarem, bez treści.
17. Otwórz plik z końcówkami CRLF i plik z BOM, zmień jedną linię i zapisz: końcówki i BOM
    zostają (`file nazwa`, `xxd | head`).
18. Przy fokusie w edytorze naciśnij `Ctrl/Cmd+W`: zakładka zamyka się (z pytaniem, gdy plik jest
    zmieniony), a nie jest przechwycona przez edytor. Naciśnij `Ctrl/Cmd+K`: fokus trafia do
    wyszukiwarki w lewej kolumnie. `Ctrl/Cmd+F` w edytorze otwiera panel wyszukiwania w pliku.
19. Sprawdź kolory edytora i panelu wyszukiwania w pliku (`Ctrl/Cmd+F`) w motywie ciemnym i
    jasnym: tło, numery linii, zaznaczenie, pola tekstowe i przyciski mają kolory aplikacji, a
    przełączenie motywu przy otwartym edytorze od razu zmienia kolory.
20. Otwórz plik `.env` (podświetlanie `KEY=value`) oraz pliki JSON, YAML, PHP, Rust i
    TypeScript: składnia jest kolorowana, a nieznane rozszerzenie otwiera się jako zwykły tekst.

## 4. Zmiany na dysku

21. Otwórz niezmieniony plik, który agent (albo `echo >> plik` w terminalu) dopisze. Zawartość
    odświeża się po chwili, bez paska.
22. Otwórz długi plik, przewiń go w dół i ustaw kursor, a potem zmień ostatnią linię z
    zewnątrz: po odświeżeniu pozycja przewinięcia i kursor się nie przesuwają. Naciśnij `Ctrl+Z`:
    nic się nie cofa (historia jest czyszczona przy odświeżeniu z dysku).
23. Zmień plik w edytorze (bez zapisu), a potem zmień go z zewnątrz: pojawia się pasek „Plik
    zmienił się na dysku” z „Wczytaj ponownie” i „Zostaw moje”. „Zostaw moje” zostawia edycje,
    a kolejny zapis znowu wykrywa konflikt.
24. Przy tym samym ustawieniu naciśnij „Zapisz”: pojawia się okno „Plik zmienił się na dysku” z
    „Nadpisz” / „Wczytaj ponownie” / „Anuluj”. „Nadpisz” zapisuje moją wersję, „Anuluj” zamyka
    okno i fokus wraca do edytora.
25. Sprawdź, że własny zapis nie wywołuje paska „Plik zmienił się na dysku” (zapisz kilka razy
    pod rząd, także szybko po sobie).
26. Edytuj `.env` w aplikacji, gdy sesja agenta zapisuje pliki w projekcie: po zmianie pliku przez
    agenta pojawia się pasek „Plik zmienił się na dysku”, a zapis kończy się oknem konfliktu
    zamiast po cichu nadpisać wersję agenta.
27. Usuń otwarty plik z zewnątrz (`rm`): pojawia się pasek „Plik został usunięty”, treść zostaje, a
    „Zapisz” tworzy plik ponownie. Zakładka z usuniętym plikiem pyta o zapis przy zamknięciu.
28. Przełączenie gałęzi (`git checkout inna-galaz`), w której otwarty plik nie istnieje, a potem
    powrót (`git checkout -`): zakładka z niezmienionym buforem po powrocie wczytuje plik po
    cichu, bez paska. Powtórz z zakładką z niezapisanymi zmianami: tekst zostaje, a pojawia się pasek
    „Plik zmienił się na dysku”.
29. Zapisz usunięty plik, który w międzyczasie pojawił się ponownie z inną treścią: zakładka
    zostaje zmieniona, pojawia się okno konfliktu, a „Nadpisz” zapisuje.

## 5. Pliki specjalne i zapis w miejscu

30. Zapisz plik `.env` podmontowany jako pojedynczy plik do kontenera (`docker run -v
    $PWD/.env:/app/.env ...`): zapis się udaje, a kontener widzi nową treść (zapis w miejscu
    zachowuje i-węzeł).
31. Zapisz plik z twardym dowiązaniem (`ln .env .env.link`): obie nazwy pokazują nową treść
    (`stat -c %i` daje ten sam numer przed i po).
32. Zapisz plik tylko do odczytu (`chmod 444`): zapis kończy się komunikatem błędu w pasku,
    plik nie zostaje zastąpiony, bufor zostaje zmieniony. To samo po „Nadpisz”.
33. Zapisz plik w katalogu bez prawa zapisu (`chmod 555 katalog`): zapis się udaje w miejscu,
    gdy sam plik jest zapisywalny. Uprawnienia pliku po zapisie są takie jak przed.
34. Utwórz kolejkę FIFO (`mkfifo kolejka`) w projekcie i spróbuj ją otworzyć z drzewa: aplikacja
    nie zawiesza się, zakładka pokazuje błąd z „Spróbuj ponownie”.

## 6. Okna odłączone i ochrona niezapisanych plików

35. Odłącz grupę projektu do osobnego okna, gdy ma otwarty plik z zapisaną treścią: plik otwiera
    się w nowym oknie, wczytany z dysku.
36. Zdarzenia zmiany katalogu mają trafiać tylko do okna, które go obserwuje. Rozwiń ten sam
    katalog w oknie głównym i w odłączonym (panel plików w obu), dodaj plik z zewnątrz: drzewo
    odświeża się w obu oknach, a otwarty w jednym z nich plik tego katalogu reaguje na zmianę na
    dysku tylko w swoim oknie. Zamknij jedno okno: drugie dalej odświeża drzewo.
37. Zamknij zakładkę z niezapisanym plikiem (X, środkowy przycisk, `Ctrl/Cmd+W`): okno
    „Niezapisane zmiany” z listą plików. „Zapisz” zapisuje i zamyka, „Odrzuć zmiany” zamyka bez
    zapisu, „Anuluj” (i Esc) zostawia zakładkę.
38. Odłącz grupę projektu z niezapisanym plikiem: najpierw pojawia się to samo okno, a „Anuluj”
    przerywa odłączanie.
39. Zamknij okno główne z niezapisanym plikiem: okno pyta o zapis przed pytaniami o notatki i o
    działające sesje. To samo dla okna odłączonego.
40. Sprawdź błąd zapisu w oknie „Niezapisane zmiany” (np. plik tylko do odczytu): okno zostaje
    otwarte, pokazuje „Nie udało się zapisać wszystkich plików.”, a „Odrzuć zmiany” nadal działa.
41. Przy dostępnej aktualizacji z niezapisanym plikiem w oknie głównym: przed pobraniem pojawia się
    okno „Niezapisane zmiany”; po „Anuluj” aktualizacja jest wstrzymana, po „Zapisz” lub
    „Odrzuć zmiany” przebiega dalej i przed ponownym uruchomieniem okno nie pyta o te same
    pliki.
42. Przy dostępnej aktualizacji z niezapisanym plikiem w oknie odłączonym (okno główne czyste):
    aktualizacja jest odrzucona z komunikatem „Masz niezapisane pliki w innym oknie. Zapisz je lub
    zamknij to okno i spróbuj ponownie.” Po zapisaniu lub zamknięciu odłączonego okna ponowna
    próba przechodzi. Zamknięcie odłączonego okna z niezapisanym plikiem przez „Odrzuć zmiany” też
    zdejmuje blokadę.
43. Na Windows (jeśli dostępny): zaktualizuj z niezapisanym plikiem w oknie odłączonym. Updater
    kończy proces wewnątrz instalacji, więc kontrola przed ponownym uruchomieniem się nie
    wykonuje (znane ograniczenie).

## 7. Wydajność i stabilność

44. Podczas pracy z otwartym panelem plików obserwuj log diagnostyczny
    (`~/.local/share/pl.cyberstudio.abeoncode/logs/abeoncode.log`): brak linii `files:` z błędami
    obserwatora przy zwykłej pracy, brak samoczynnych zamknięć okna (patrz gotcha o głównym wątku).
45. Zamknij okno odłączone z rozwiniętym drzewem i otwartymi plikami: okno główne nie zacina się
    przy zamknięciu, a po powrocie do rozwiniętych katalogów drzewo dalej się odświeża.
