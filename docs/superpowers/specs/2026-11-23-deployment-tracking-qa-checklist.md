# Śledzenie wdrożeń — lista kontrolna ręcznego QA

Data: 2026-11-23 · Aplikacja: `DesktopApp/` · Spec: `2026-11-23-deployment-tracking-design.md`
(sekcja „Implementation notes (2026-11)” opisuje, gdzie kod odbiega od tekstu specyfikacji)

Testy automatyczne nie uruchamiają pętli śledzenia w prawdziwej aplikacji (`DeployTracker::start`, pętla
budząca, ujście zdarzeń nie mają testu), nie widziały prawdziwego pipeline'u z pauzą ani prawdziwego
logu nieudanego kroku. Ta lista pokrywa to, co trzeba obejrzeć w uruchomionej aplikacji
(`npm run tauri dev` albo zainstalowana wersja). Przy każdym kroku zapisz wynik: OK / nie OK / nie
sprawdzono.

Kroki oznaczone **[PUSH]** wymagają prawdziwego pusha na gałąź produkcyjną projektu testowego,
**[PAUZA]** prawdziwego pipeline'u z ręcznym krokiem, a **[DISCORD]** połączonego Discorda agenta
sterującego. Przy każdym takim kroku jest zapisane, czego NIE robić.

Przygotowanie:

- Projekt testowy na Bitbucket i drugi na GitHubie, oba z działającym pipeline'em, namespace'em w
  klastrze i dostępnym `bkt`, `gh` i `kubectl`. Do pusha użyj gałęzi produkcyjnej projektu testowego,
  nie projektu produkcyjnego klienta.
- Projekt z kilkoma repozytoriami (folder z repozytoriami w środku).
- Zainstalowana nowa komenda `abeon-code` (krok 1) i skill `abeon-deploy`.
- Do kroków z Discordem: agent sterujący włączony, kanał Discord połączony.

## 1. Komenda, skill i ustawienia

1. Ustawienia → „Skill dla Claude Code” → „Zainstaluj skill” (albo „Komenda terminala” → „Zainstaluj
   komendę”). W terminalu: `grep wrapper_features "$(command -v abeon-code)"` pokazuje
   `wrapper_features="note flow deploy"`, a `ls ~/.claude/skills` zawiera `abeon-deploy`.
2. W katalogu projektu zarejestrowanego w aplikacji: `abeon-code flow show` wypisuje JSON z
   `repoPath`, `flow` i `proposal`, a `abeon-code deploy status` wypisuje najnowsze śledzenie albo
   `abeon-code: no deployment tracked for this repository`. W katalogu spoza projektów obie komendy
   kończą się komunikatem „is not inside a repository of an AbeonCode project” i kodem 2.
3. Sprawdzenie ze skilla: `grep -q 'wrapper_features=.*flow' "$(command -v abeon-code)" && grep -q
   'wrapper_features=.*deploy' "$(command -v abeon-code)" && echo ok` wypisuje `ok`. Jeśli przed
   krokiem 1 został stary wrapper, polecenie nic nie wypisuje, a agent z tym skillem ma kazać
   zainstalować komendę ponownie (nie wywołuje wtedy `abeon-code deploy`, które uruchomiłoby aplikację).
4. Ustawienia → Integracje → „Wdrożenia”: sekcja „Narzędzia” pokazuje `bkt`, `gh`, `kubectl` i
   `nmcli` (Linux) jako „Znaleziono” (z wersją) albo „Nie znaleziono”. Narzędzie, którego nie ma w
   systemie, ma status „Nie znaleziono”.
5. W „Nazwa połączenia w NetworkManagerze” wpisz nazwę połączenia VPN i wyjdź z pola: nazwa zostaje po
   ponownym otwarciu ustawień. Wpisz nazwę z niedozwolonym znakiem (np. `a;b`): pod polem pojawia się
   błąd i poprzednia nazwa zostaje zapisana.
6. Windows i macOS: aplikacja startuje, narzędzia są znajdowane, strona „Wdrożenia” nie ma pola VPN
   (jest tekst, że łączenie działa tylko na Linuksie).

## 2. Formularz przepływu i wykrywanie

7. Edytuj projekt (Bitbucket): w oknie jest sekcja „Przepływ wdrożenia” z polami „Śledź wdrożenia”,
   „Zdalne repozytorium”, „Budowanie”, „Repozytorium (CI)”, „Gałąź produkcyjna”, „Dostarczenie”,
   „Namespace”, „Zasoby”, „Kontekst kubectl”. Kliknij „Wykryj z repozytorium”: formularz wypełnia się
   (Bitbucket Pipelines, `workspace/repo` z adresu remote, gałąź `main` lub `master`), namespace i
   zasoby zostają puste, nic nie zostaje zapisane do kliknięcia „Zapisz przepływ”.
8. To samo dla projektu na GitHubie: „Budowanie” = GitHub Actions, „Repozytorium (CI)” = `owner/repo`.
9. Uzupełnij namespace i zasoby, zapisz: pojawia się „Zapisano”. Zamknij i otwórz okno: wartości są
   zachowane. Wpisz namespace z niedozwolonym znakiem (`x;y`): zapis jest odrzucony z komunikatem przy
   polu.
10. Przełącz „Budowanie” na „brak”, a potem „Dostarczenie” na „brak” i zapisz: zapis przechodzi bez
    błędu o ukrytych polach (CI i namespace), a zmiany wracają po ponownym otwarciu.
11. „Usuń przepływ”: znika „Zapisano”, formularz wraca do pustego stanu, a status w sidebarze znika.
12. Zmień przepływ w drugim oknie albo przez komendę (`flow propose` i zatwierdzenie), mając otwarty
    formularz: pod formularzem pojawia się „Przepływ zmienił się poza formularzem.”.
13. Projekt z kilkoma repozytoriami: na górze sekcji jest wybór „Repozytorium”, każde repozytorium ma
    własny przepływ, a repozytorium wspólne dla dwóch projektów pokazuje ten sam przepływ w obu.
    Projekt bez repozytorium Git pokazuje „Ten projekt nie zawiera repozytorium Git.”.

## 3. Prawdziwy push do „Wdrożono” [PUSH]

Nie wypychaj na gałąź produkcyjną projektu klienta, żeby sprawdzić śledzenie: użyj projektu testowego
z pipeline'em, który się szybko kończy.

14. **[PUSH]** Ustaw przepływ projektu testowego (build + obraz + namespace) i zapisz. Po kilku
    sekundach, zanim cokolwiek wypchniesz, w sidebarze nie ma statusu. Wypchnij commit na gałąź
    produkcyjną z terminala poza aplikacją. W ciągu kilku sekund w wierszu projektu pojawia się
    kropka statusu (w nagłówku z etykietą „Czekam na pipeline”, potem „Budowanie”; w wierszu
    sidebaru etykieta jest w podpowiedzi po najechaniu).
15. **[PUSH]** Kliknij status: „Status wdrożenia” pokazuje repozytorium, skrócony commit, gałąź, etap
    „Budowanie” z godziną rozpoczęcia i przycisk „Otwórz pipeline” (otwiera stronę w przeglądarce).
16. **[PUSH]** Po zakończeniu pipeline'u status zmienia się na „Wdrażanie na klaster”; po wymianie
    obrazu i gotowych podach na „Wdrożono”. Pojawia się jedno ciche powiadomienie „Wdrożono: <nazwa
    katalogu repozytorium>” (nie nazwa projektu), bez wiadomości na Discordzie. Okno szczegółów pokazuje oba etapy z czasami, a gdy w tagu obrazu jest
    numer builda, wiersz „Obraz zawiera numer builda …”.
17. **[PUSH]** Wypchnij drugi commit tuż po pierwszym, gdy pierwsze śledzenie jeszcze trwa: pierwsze
    przechodzi w „Zastąpione”, a śledzone jest drugie. Znane ograniczenie: przy dwóch pushach w krótkim
    odstępie obraz pierwszego może zostać uznany za wdrożenie drugiego; nie traktuj tego jako błędu
    nowego, tylko zapisz, co zobaczyłeś.
18. **[PUSH]** Wypchnij na inną gałąź niż produkcyjna: nic się nie dzieje. Wykonaj `git fetch` po
    zmianie na zdalnym repozytorium: nic się nie dzieje (fetch nie jest pushem).
19. **[PUSH]** Zamknij aplikację, wypchnij commit, uruchom aplikację: ten push nie jest śledzony
    (świadome ograniczenie). Kolejny push po starcie jest śledzony.
20. Przepływ z „Budowanie” = brak i „Dostarczenie” = brak oraz przepływ z wyłączonym „Śledź wdrożenia”
    nic nie śledzą: po pushu w sidebarze nie pojawia się status, a `abeon-code deploy wait` kończy się
    kodem 3 z komunikatem, że nie ma czego śledzić albo śledzenie jest wyłączone.

## 4. Wstrzymany pipeline w `hs-training` [PAUZA]

Nie uruchamiaj produkcyjnego pipeline'u tylko po to, żeby sprawdzić pauzę. Użyj pipeline'u, który i
tak miał pójść na produkcję (krok „Approve production release”), albo takiego, który już czeka. Nie
zatwierdzaj ręcznego kroku z aplikacji ani z terminala w czasie testu: aplikacja tylko linkuje do
pipeline'u. Jeśli nie ma wstrzymanego pipeline'u w `hs-training`, zapisz „nie sprawdzono”.

21. **[PAUZA]** Gdy pipeline staje na ręcznym kroku, status w sidebarze zmienia się w wypełnioną
    akcentową pigułkę z dzwonkiem (bez etykiety; podpowiedź „<repozytorium>: Pipeline czeka na Ciebie”),
    wyraźniejszą niż sesja czekająca na wejście. Potwierdza to pierwsze prawdziwe sprawdzenie
    mapowania pauzy Bitbucketa (`state.stage.name` `PAUSED`) na „Approve production release”.
22. **[PAUZA]** W nagłówku okna projektu widać pasek „Pipeline czeka na Twoją akceptację” z przyciskiem
    „Otwórz pipeline”. Chip statusu obok paska jest płaską kropką bez etykiety i bez pigułki.
23. **[PAUZA]** Przyszło powiadomienie na pulpicie; kliknięcie go otwiera stronę pipeline'u w
    przeglądarce. Na Linuksie (COSMIC/Wayland) sprawdź też, że kliknięcie wychodzi z aplikacji do
    przeglądarki, a nie tylko podnosi okno.
24. **[PAUZA][DISCORD]** Na Discordzie jest wiadomość z przyciskiem „Otwórz pipeline” prowadzącym do
    tego samego pipeline'u. Przy włączonym „wycisz, gdy jestem przy komputerze” i obecności użytkownika
    wiadomość nie idzie na Discord (zostaje powiadomienie na pulpicie). Przy wyłączonym agencie
    sterującym wiadomości nie ma, a w logu aplikacji jest wiersz `deploy: Paused notice …: sent to the
    desktop, not to Discord (…)`.
25. **[PAUZA]** Zatwierdź ręczny krok w przeglądarce (to Twoja decyzja, nie test aplikacji): oznaczenie,
    pasek i pigułka znikają, a status przechodzi w „Wdrażanie na klaster”.
26. **[PAUZA]** Wstrzymany pipeline przy niedostępnym klastrze (VPN wyłączony, bez nazwy połączenia w
    ustawieniach): pigułka w sidebarze i pasek w nagłówku zostają, a chip w nagłówku to płaska kropka
    obok paska. Szczegóły pokazują „Klaster niedostępny” z przyciskiem „Spróbuj ponownie”.

## 5. Nieudany pipeline i „Wyślij do sesji” [PUSH]

Nie psuj pipeline'u projektu klienta, żeby sprawdzić błąd. W projekcie testowym wypchnij commit z
celowo nieprzechodzącym krokiem (np. `exit 1` w skrypcie testowym) albo użyj już nieudanego runu.

27. **[PUSH]** Po nieudanym kroku status zmienia się na „Wdrożenie nie powiodło się”, projekt dostaje
    czerwoną kropkę statusu (ton `problem`), a nie oznaczenie sesji wymagającej uwagi, a powiadomienie
    na pulpicie jest bez treści logu.
    Szczegóły pokazują „Niepowodzenie na etapie budowanie: …” i fragment logu (najwyżej 60 ostatnich
    linii, sekrety zamaskowane). To pierwsze prawdziwe sprawdzenie pobrania logu nieudanego kroku.
28. **[PUSH][DISCORD]** Na Discordzie jest wiadomość o niepowodzeniu bez treści logu.
29. **[PUSH]** „Wyślij do sesji” przy otwartej sesji agenta w tym projekcie: podsumowanie
    (jednowierszowe, z końcówką logu) wpisuje się w pole wpisywania sesji i NIE jest wysyłane (bez
    Enter). Bez otwartej sesji przycisk jest wyłączony z podpowiedzią
    „Brak otwartej sesji agenta w tym projekcie”.
30. „Ukryj” przy zakończonym śledzeniu usuwa status z wiersza projektu i nagłówka.
31. Brak ciągu dalszego (np. brak runu pipeline'u przez ponad 5 minut po pushu, jeśli da się to
    wywołać w projekcie testowym) kończy śledzenie stanem „Nie widać dalszego ciągu”, pokazanym jako
    problem (powiadomienie i oznaczenie), ale innym tekstem niż niepowodzenie.

## 6. VPN i niedostępny klaster [PUSH]

Nie wyłączaj VPN-u w czasie, gdy ktoś inny z niego korzysta, i nie wpisuj w ustawieniach połączenia,
którego nie chcesz podnosić. Test dotyczy tylko Linuksa.

32. **[PUSH]** VPN wyłączony w chwili pusha, **bez** nazwy połączenia w ustawieniach: śledzenie nie kończy
    się niepowodzeniem. Po zakończeniu budowania status pokazuje „Klaster niedostępny” z przyciskiem
    „Spróbuj ponownie”, a aplikacja nadal próbuje wolniej. Włącz VPN ręcznie: po chwili (albo po
    „Spróbuj ponownie”) śledzenie rusza dalej i kończy się „Wdrożono”.
33. **[PUSH]** VPN wyłączony, **z** nazwą połączenia w ustawieniach: aplikacja sama podnosi połączenie
    (`nmcli connection up id <nazwa>`, widać to w `nmcli connection show --active`), robi to raz na
    każdą przerwę w dostępie do klastra (nie raz na śledzenie, zob. krok 56), zostawia VPN włączony, a
    śledzenie kończy się „Wdrożono”. Z błędną nazwą połączenia
    status zostaje „Klaster niedostępny” i nie jest to niepowodzenie wdrożenia.
34. Brak jednego z narzędzi (`bkt` albo `gh`) przy aktywnym śledzeniu: status pokazuje „Nie mogę
    sprawdzić” z powodem, nigdy „Wdrożenie nie powiodło się”.

## 7. Restart aplikacji w trakcie śledzenia [PUSH]

Nie zamykaj aplikacji w trakcie wdrożenia projektu klienta i nie przerywaj ani nie uruchamiaj ponownie
pipeline'u, żeby sprawdzić wznowienie: użyj projektu testowego z pipeline'em, który i tak się zakończy.
Nie usuwaj bazy ani wierszy śledzeń w czasie, gdy aplikacja jest zamknięta.

35. **[PUSH]** Wypchnij commit i w trakcie budowania zamknij aplikację, odczekaj do końca pipeline'u i
    uruchom ją ponownie: otwarte śledzenie wznawia się z bazy i kończy prawidłowo (stan zależy od
    tego, co zaszło w klastrze), bez duplikatu śledzenia.
36. Śledzenie zakończone przed restartem pokazuje się po starcie jako ostatni wynik repozytorium
    (do ukrycia przez „Ukryj”). W oknie szczegółów śledzenie z wcześniejszego dnia ma datę.

## 8. Okno szczegółów

37. Szczegóły pokazują tylko te etapy, które miał przepływ w chwili pusha: śledzenie bez budowania
    (build = brak) nie ma wiersza „Budowanie”, śledzenie bez dostarczenia nie ma „Wdrażanie na klaster”.
38. Projekt z kilkoma repozytoriami i dwoma trwającymi śledzeniami: wiersz pokazuje to, które
    najbardziej wymaga uwagi, oraz licznik `+1`; okno szczegółów wymienia oba.

## 9. `abeon-code deploy wait` z sesji [PUSH]

Kod 8 sprawdzasz tylko w kroku 40, krótkim `--timeout 5`; w pozostałych krokach nie skracaj limitu, żeby
agent doczekał prawdziwego wyniku. Nie próbuj zatwierdzać wstrzymanego pipeline'u żadną komendą.

39. **[PUSH]** W sesji agenta w projekcie testowym (z zainstalowanym skillem `abeon-deploy`) poproś o
    wypchnięcie zmiany i sprawdzenie wdrożenia. Agent uruchamia `abeon-code deploy wait` (z limitem
    narzędzia 600000 ms albo krótszym `--timeout`), a nie pętlę `sleep` z `bkt`/`gh`. Kończy z kodem 0 i
    jednym zdaniem o wdrożeniu.
40. `abeon-code deploy wait --timeout 5` w trakcie trwającego śledzenia: po 5 s kod 8 i komunikat, że
    wdrożenie trwa, aby uruchomić komendę ponownie.
41. **[PAUZA]** Przy wstrzymanym pipeline'ie kod 4, w wyniku `state: paused`, link `pipeline:` i zdanie, że
    agent ma nie zatwierdzać i poinformować użytkownika. Agent zgłasza to i kończy turę, nie próbuje
    zatwierdzać.
42. **[PUSH]** Przy nieudanym pipeline'ie kod 1, w wyniku `failure:` i fragment logu; agent naprawia
    przyczynę zamiast pytać o logi.
43. W repozytorium bez przepływu: kod 3 i na stdout `abeon-code: no tracking: this repository has no
    deployment flow`. W repozytorium ze starym pushem (starszym niż 60 minut, śledzenie zakończone
    ponad 10 minut temu) kod 3 i komunikat `no new push to <remote>/<gałąź>: the newest push is …`. W
    folderze z kilkoma repozytoriami `deploy wait` kończy się kodem 2 z prośbą o uruchomienie w jednym z
    nich, a `deploy status` wypisuje blok na każde repozytorium.
44. Przy zamkniętej aplikacji i świeżym pushu bez śledzenia `deploy wait` po około 30 s kończy się
    kodem 3 z komunikatem `no tracking started (… or AbeonCode is not running)`. Przy śledzeniu
    otwartym tuż przed zamknięciem aplikacji kończy się kodem 8 z uwagą, że aplikacja musi działać.

## 10. Propozycja przepływu od agenta

Nie zatwierdzaj propozycji komendą ani edycją bazy: zatwierdza użytkownik w aplikacji albo na
Discordzie.

45. W sesji agenta w projekcie testowym poproś: „ustaw przepływ wdrożenia”. Agent czyta `flow show` i
    `flow detect`, pyta o namespace i zasoby (szuka namespace'u narzędziami Bandziora, jeśli ma), wysyła
    `flow propose` i mówi, że propozycja czeka na „Zatwierdź”. NIE twierdzi, że przepływ działa.
46. W aplikacji pojawia się karta „Agent proponuje przepływ wdrożenia: <repozytorium>” z różnicą wartości
    i przyciskami „Odrzuć” i „Zatwierdź”. Przed zatwierdzeniem `abeon-code flow show` nadal pokazuje
    `proposal` i stary `flow`. „Zatwierdź”: karta znika, formularz w edycji projektu ma nowe wartości,
    `flow show` pokazuje nowy `flow` i `proposal: null`.
47. Druga propozycja zatwierdzona **na Discordzie** **[DISCORD]**: wiadomość ma przyciski „Zatwierdź” i
    „Odrzuć”, a po kliknięciu przepływ w aplikacji się zmienia. Ta sama propozycja wysłana dwa razy (to
    samo JSON) daje jedną wiadomość i tę samą propozycję.
48. Propozycja odrzucona w aplikacji, a potem kliknięty przycisk na Discordzie: odpowiedź „Odrzucono w
    aplikacji”. To samo przy zatwierdzeniu w aplikacji: „Zatwierdzono w aplikacji”. **[DISCORD]**
49. Propozycja po zmianie przepływu: wyślij propozycję, zmień przepływ ręcznie w oknie edycji projektu i
    zapisz. Karta w aplikacji przelicza listę zmian względem nowego przepływu i pokazuje szarą uwagę
    „Przepływ zmienił się od czasu propozycji — lista zmian jest aktualna.”; „Zatwierdź” na karcie
    zapisuje to, co karta pokazuje. Tylko przycisk „Zatwierdź” na Discordzie **[DISCORD]** odmawia przy
    zmienionym przepływie: „Przepływ zmienił się po propozycji — sprawdź w aplikacji”, a przepływ zostaje
    ten z ustawień. Czerwony komunikat na karcie pojawia się tylko wtedy, gdy zatwierdzenie z karty
    zostało faktycznie odrzucone (przepływ zapisany w drugim oknie między wyświetleniem karty a
    kliknięciem).
50. Propozycja identyczna z bieżącym przepływem: `flow propose` kończy się kodem 2 z komunikatem, że
    przepływ ma już te wartości. Niepoprawna wartość (np. `"namespace": "x;y"`) i nieznane pole dają kod 2
    z listą powodów. Propozycja z folderu z kilkoma repozytoriami bez `repoPath` kończy się kodem 2 z listą
    repozytoriów.
51. Propozycja wysłana przy zamkniętej aplikacji (`flow propose` działa bez aplikacji): po uruchomieniu
    karta jest widoczna, ale na Discordzie nie pojawia się później. **[DISCORD]**

## 11. Motywy

52. Jasny i ciemny motyw: chip statusu w sidebarze, pigułka akcentowa (kontrast tekstu na akcencie),
    pasek w nagłówku, okno szczegółów z blokiem logu, karta propozycji i formularz przepływu są czytelne
    i bez „wypalonych” kolorów w obu motywach.

## 12. Zmiany w trakcie śledzenia: przepływ, projekt, VPN [PUSH]

Wszystko na projekcie testowym. Nie usuwaj z aplikacji projektu klienta, nie zmieniaj przepływu projektu
klienta w trakcie jego wdrożenia i nie wyłączaj VPN-u, z którego ktoś akurat korzysta. Nie zatwierdzaj
wstrzymanego kroku z aplikacji ani z terminala: tylko w przeglądarce, jako własna decyzja.

53. **[PUSH]** Przepływ z pustymi „Zasobami” (wszystkie Deploymenty namespace'u). Wypchnij commit i w
    trakcie budowania zmień „Zasoby” na jeden z nich (albo zmień namespace) i zapisz. Po zakończeniu
    pipeline'u status zostaje „Wdrażanie na klaster” aż do faktycznej wymiany obrazu; nie ma
    natychmiastowego „Wdrożono” ani powiadomienia. `abeon-code deploy wait` w tym czasie nie kończy się
    kodem 0.
54. **[PUSH]** Przy wyłączonym VPN-ie i pustej nazwie połączenia w ustawieniach (szczegóły pokazują
    „Klaster niedostępny”) przełącz w trakcie budowania „Dostarczenie” na „brak” i zapisz: blokada
    klastra znika, a po zakończeniu pipeline'u śledzenie kończy się „Wdrożono” bez etapu „Wdrażanie na
    klaster” w szczegółach.
55. **[PUSH]** W trakcie śledzenia usuń projekt testowy z aplikacji. Wypchnij kolejny commit i poczekaj
    do końca jego pipeline'u: nie przychodzi żadne powiadomienie o wdrożeniu. Dodaj projekt ponownie:
    sekcja „Przepływ wdrożenia” ma dawne wartości, commit wypchnięty w czasie, gdy projektu nie było,
    nie jest śledzony, a następny push już jest.
56. **[PUSH][PAUZA]** Z nazwą połączenia w ustawieniach i włączonym VPN-em: gdy pipeline czeka na ręczny
    krok, wyłącz VPN. W ciągu około minuty aplikacja sama go podnosi, także w czasie pauzy. Zatwierdź krok
    w przeglądarce: wdrożenie kończy się „Wdrożono”. Wyłącz VPN drugi raz przed końcem wdrożenia:
    aplikacja podnosi go ponownie (jedna próba na każdą przerwę w dostępie do klastra, nie jedna na całe
    śledzenie). Bez pipeline'u z pauzą sprawdź to samo dwoma wyłączeniami VPN-u w jednym śledzeniu.
57. **[PUSH]** VPN wyłączony, nazwa połączenia pusta: po „Klaster niedostępny” wpisz nazwę w ustawieniach.
    Przy następnym sprawdzeniu (najwyżej po minucie) aplikacja podnosi VPN z tą nazwą. „Spróbuj ponownie”
    w szczegółach pokazuje komunikat „Sprawdzam ponownie…”, od razu sprawdza klaster i, jeśli nadal jest
    niedostępny, jeszcze raz próbuje podnieść VPN.
