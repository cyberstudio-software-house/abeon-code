# Backlog pomysłów

Pomysły z przeglądu aplikacji i sposobu pracy z 2026-11-23, odłożone na później. Żaden nie ma
jeszcze specyfikacji. Kolejność w pliku nie oznacza priorytetu.

Stan na 2026-11-24: śledzenie wdrożenia po pushu jest zaimplementowane na lokalnym `main`
(specyfikacja `specs/2026-11-23-deployment-tracking-design.md`, lista QA
`specs/2026-11-23-deployment-tracking-qa-checklist.md`); jego pozostałości są w sekcji na końcu
tego pliku. Polityki zgód per projekt czekają na własną specyfikację.

Dane z historii promptów (60 dni przed 2026-11-23), na których opiera się uzasadnienie: mediana
7 projektów dziennie, 21 przełączeń między projektami dziennie, 393 sesje z medianą 4 promptów,
ok. 250 promptów o kliencie i mailach, 106 o czasie, 72 o ClickUp, 4 o testowaniu na żywo.

## Zamknięcie długu QA

Problem: funkcje wychodzą szybciej, niż są sprawdzane. W pamięci projektu 17 wpisów kończy się na
„QA zaległe”, wyniki checklist nie są nigdzie zapisywane, w projekcie nie ma testów e2e.

Część A, rejestr QA:
- ustalony format checklisty: krok, oczekiwany wynik, znacznik „automatyczny / ręczny”;
- panel w aplikacji z zaległościami per wydanie i per funkcja, z wynikiem kroku (OK / nie OK /
  nie sprawdzono) i datą;
- krok „nie OK” otwiera sesję z opisem kroku i miejscem na zrzut ekranu;
- działa dla każdego projektu, a skill piszący plan dopisuje checklistę w tym formacie.

Część B, agent QA:
- AbeonCode uruchamiany w trybie testowym z czystym profilem, sterowany przez WebDriver, ze
  zrzutami ekranu; agent przechodzi kroki i wpisuje wyniki do rejestru;
- projekty webowe: Playwright i Chrome DevTools MCP są już podpięte, brakuje wpięcia w rejestr;
- kroki zależne od systemu (COSMIC, macOS, Windows) zostają ręczne.

Otwarte: sterowanie oknem Tauri na WebKitGTK wymaga próby technicznej przed planowaniem.

## Pętla zadanie → sesja → czas

Stan na 2026-11-23: aplikacja umie powiązać zadania ClickUp z projektem, zapisać treść zadania do
`.abeon/clickup/<id>.md`, wygenerować i wysłać komentarz, oszacować czas i zapisać wpis czasu. To
osobne ręczne kroki z poziomu jednej sesji.

Brakuje:
- startu z zadania: przycisk „Rozpocznij pracę”, nowa sesja z treścią zadania, status „w toku”,
  trwałe przypisanie sesji do zadania;
- zbierania czasu aktywnego i kosztu AI po zadaniu, ze wszystkich jego sesji;
- zamknięcia jednym ruchem po wdrożeniu: wpis czasu, komentarz, zmiana statusu, wycena punktowa
  (także z Discorda);
- wyceny punktowej według modelu `P = (godziny + koszt AI / cena punktu) × ryzyko`;
- widoku rozliczeniowego per klient i miesiąc: zadania, czas, koszt AI, punkty.

Otwarte:
- czy ClickUp jest źródłem prawdy dla każdej pracy klienckiej, czy część zleceń żyje tylko w
  mailach;
- w AbeonCode obowiązuje reguła „nie rejestrujemy czasu w ClickUp”, więc funkcja musi być
  włączana per projekt.

Wspólne z „Skrzynką wejściową”: pojęcie zadania jako bytu trwalszego niż sesja. Dziś aplikacja zna
tylko projekty i sesje.

## Skrzynka wejściowa od klienta

Problem: praca zaczyna się od ręcznego promptu „zapoznaj się z mailem o tytule…”. Poczta jest
dostępna dla sesji przez MCP Mailspring, ale aplikacja jej nie widzi.

Pomysł:
- reguły przypisania per projekt: domeny i adresy klienta, lista ClickUp;
- sekcja „Przychodzące” przy projekcie i widok zbiorczy, z licznikiem w sidebarze;
- streszczenie i klasyfikacja pozycji (błąd, zmiana, pytanie, informacja) tanim modelem w tle;
- akcje: „przygotuj plan”, „utwórz zadanie ClickUp”, „odpowiedz” (szkic do akceptacji, bez
  automatycznej wysyłki), „odłóż”;
- rozbicie jednego maila na kilka zadań, każde z własną sesją i wyceną.

Ryzyko: treść maila trafia do sesji z uprawnieniami do repo i wdrożeń. Mail jest danymi, nie
poleceniem, a plan zawsze przechodzi przez akceptację.

## Kolejka zadań bez nadzoru

Lista promptów per projekt, którą agent sterujący wykonuje pod nieobecność użytkownika (przerwa
między blokami pracy 9–15 i 21–23), z budżetem i politykami zgód. Wyniki do przejrzenia po
powrocie. Ma sens dopiero po politykach zgód i śledzeniu wdrożeń.

## Pulpit „gdzie skończyłem”

Jeden widok przekrojowy: niewypchnięte commity, czerwone pipeline'y, czekające sesje, otwarte
pytania, zaległe QA. Do tego krótkie streszczenie przy powrocie do projektu („co się wydarzyło od
ostatniej wizyty”).

## Profile sesji i zdrowie kontekstu

Presety startu sesji (model, effort, tryb pracy subagentami) zamiast ręcznego `/model`, plus
wskaźnik zapełnienia kontekstu z propozycją przekazania pracy do nowej sesji. Uzasadnienie:
`/model` 88 razy, `/clear` 79, `/resume` 75, `/compact` 74 w całej historii.

## Kontrola środowiska przed startem

Lampki per projekt: VPN, kontekst kubectl, DDEV, autoryzacja MCP. Sesja dostaje informację o
braku, zanim polecenie się wywali.

## Usunięcie zdalnego sterowania z telefonu

Decyzja 13 ze specyfikacji agenta sterującego (2026-10-28): telefon nie jest kanałem, a funkcja
zdalnego sterowania (`remote/`, MobileApp) ma zostać usunięta jako osobny projekt. Rolę kanału
zdalnego pełni Discord.

## Śledzenie wdrożeń — pozostałości po implementacji

Rzeczy znalezione w recenzjach i świadomie niepoprawione przed wydaniem (2026-11-24).

Do sprawdzenia na żywo, bo nie dało się tego zweryfikować testami:
- start pętli śledzenia w działającej aplikacji (nie ma testu automatycznego i nie była uruchomiona);
- rozpoznanie wstrzymanego pipeline'u Bitbucketa (stan `PAUSED`) i pobranie logu nieudanego kroku,
  na prawdziwym przebiegu w `hs-training`;
- kliknięcie powiadomienia i przycisk z linkiem na Discordzie; wygląd w obu motywach;
- budowanie i działanie na Windowsie i macOS.

Zachowanie do poprawy w kolejnej iteracji:
- `abeon-code flow` i `deploy wait` nie działają w worktree gita;
- pipeline Bitbucketa zatrzymany ręcznie (`STOPPED`) jest pokazywany jako nieudany;
- na GitHubie liczą się też przebiegi innych zdarzeń niż push (harmonogram, ręczne uruchomienie);
- okno edycji projektu ma dwa przyciski zapisu, a główny „Zapisz” gubi niezapisane zmiany przepływu;
- śledzenie z trwałą przeszkodą (zła nazwa zasobu, wylogowane `bkt`) nie zamyka się samo;
- środowisko powłoki pętli śledzenia jest wczytywane raz, przy starcie;
- druga uruchomiona instancja aplikacji podwaja powiadomienia;
- przy dwóch szybkich pushach łańcuch z obrazem może zgłosić „Wdrożono” dla drugiego, gdy na
  klastrze jest obraz pierwszego (aplikacja nie wylicza oczekiwanego tagu);
- propozycja przepływu złożona przy zamkniętej aplikacji albo przy obecnym użytkowniku nie trafia
  później na Discord;
- czas startu śledzenia jest brany przed odczytem reflogu, co w rzadkim przypadku daje fałszywe
  „brak śledzenia” w `deploy wait`;
- wykrywanie pushy nie działa dla repozytoriów z `core.logAllRefUpdates=false`, klonów jednej
  gałęzi i formatu reftable, a interfejs tego nie sygnalizuje;
- lista sesji w „Wyślij do sesji” obejmuje tylko zakładki bieżącego okna.

Porządki w kodzie: zależność cykliczna `deploy/notify` ↔ `supervisor/runtime` oraz
`deploy/proposals` ↔ `supervisor/discord`; kodowanie base64 w komponencie zamiast w `lib/tauri.ts`;
test `spellings_of` zostawia dowiązania w `/tmp`; wersja przepływu to znacznik czasu, nie licznik.
