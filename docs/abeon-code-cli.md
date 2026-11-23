# Komenda `abeon-code`

Otwiera aplikację AbeonCode i uruchamia nową sesję w projekcie dla wskazanego
katalogu (tworząc projekt, jeśli nie istnieje).

## Instalacja

Ustawienia → CLI → „Zainstaluj komendę". Zapisuje wrapper do `~/.local/bin/abeon-code`.
Upewnij się, że `~/.local/bin` jest w `PATH`.

## Użycie

    abeon-code            # bieżący katalog
    abeon-code .          # bieżący katalog
    abeon-code ~/proj     # wskazany katalog

Plik jako argument → błąd (akceptowane są tylko katalogi).

## Podkomendy

Podkomendy `note`, `flow` i `deploy` działają w katalogu, z którego je wywołujesz (wrapper dopisuje
`--cwd "$(pwd -P)"`). Wyniki trafiają na stdout, użycie i prawdziwe błędy na stderr z kodem wyjścia 2.

### Przepływ wdrożenia: `abeon-code flow`

Przepływ opisuje, co dzieje się po pushu na gałąź produkcyjną jednego repozytorium: który CI buduje
kod, do którego namespace'u trafia wdrożenie i które zasoby go dostają. Można go ustawić w
oknie edycji projektu („Przepływ wdrożenia”), wykryć z repozytorium albo zaproponować przez agenta.

    abeon-code flow show      # bieżący przepływ i oczekująca propozycja (JSON)
    abeon-code flow detect    # to, co widać w repozytorium: plik pipeline'u, remote, gałąź (JSON)
    abeon-code flow propose <<'ABEON_FLOW'
    {
      "remote": "origin",
      "build": "bitbucket",
      "buildRepo": "workspace/repozytorium",
      "productionBranch": "master",
      "delivery": "image",
      "namespace": "cs-app-przyklad",
      "workloads": ["app"]
    }
    ABEON_FLOW

Pola JSON (nieznane pola są odrzucane, limit 64 KiB): `remote`, `productionBranch`, `build`
(`bitbucket` / `github` / `none`) i `delivery` (`image` / `kubemeter` / `none`) są wymagane;
`buildRepo` (`właściciel/nazwa`) jest wymagane, gdy `build` nie jest `none`; `namespace` jest wymagany,
gdy `delivery` nie jest `none`; `workloads` (najwyżej 20 nazw Deployment lub StatefulSet, puste =
wszystkie Deployment w namespace), `kubeContext` (nazwa kontekstu albo `null`), `enabled`
(domyślnie `true`) i `repoPath` (opcjonalne; wymagane w folderze z kilkoma repozytoriami) są opcjonalne.

`propose` niczego nie zmienia: zapisuje propozycję, która czeka na „Zatwierdź” w aplikacji (karta w
oknie) albo na Discordzie (przyciski, gdy kanał Discord agenta sterującego jest włączony). Propozycja
wygasa po 24 godzinach, nowsza dla tego samego repozytorium zastępuje starszą, a identyczna z bieżącym
przepływem jest odrzucana. Zatwierdzenie jest odrzucane jako nieaktualne, jeśli przepływ zmienił się po
propozycji. Nie ma komendy `flow approve`. Komenda odrzuca repozytorium, które nie jest korzeniem
repozytorium zarejestrowanego projektu.

### Śledzenie wdrożenia: `abeon-code deploy`

    abeon-code deploy status                  # najnowsze śledzenie repozytorium, bez czekania
    abeon-code deploy wait [--timeout <s>]    # czeka na koniec albo na użytkownika (domyślnie 540 s, max 3600 s)

Kody wyjścia `deploy wait`:

| Kod | Znaczenie |
|-----|-----------|
| 0 | wdrożone |
| 1 | wdrożenie nie powiodło się albo utknęło (w wyniku przyczyna i fragment logu) |
| 2 | błąd użycia lub inny prawdziwy błąd (stderr) |
| 3 | brak śledzenia: brak przepływu, śledzenie wyłączone, nic do śledzenia, aplikacja nie działa albo `no new push to <remote>/<gałąź>` (ostatni push jest stary, `git push` nic nie wysłał lub poszedł gdzie indziej) |
| 4 | potrzebny użytkownik: pipeline wstrzymany (ręczny krok czeka na akceptację) albo blokada dłuższa niż 120 s (klaster niedostępny, brak narzędzia) |
| 8 | wdrożenie wciąż trwa po upływie limitu, trzeba wywołać komendę ponownie |

Agent uruchamia `deploy wait` zamiast pętli `sleep` + `bkt`/`gh`. Narzędzie powłoki agenta zabija
polecenie po własnym limicie (w Claude Code domyślnie 120 s), więc trzeba ustawić limit narzędzia na
600000 ms albo podać krótszy `--timeout` i ponowić przy kodzie 8. Śledzenie postępuje tylko przy
uruchomionej aplikacji. Śledzone są wyłącznie pushe na gałąź produkcyjną przepływu; wykrywa je reflog
gałęzi zdalnej, więc nie są śledzone repozytoria z `core.logAllRefUpdates=false`, klony
jednogałęziowe niemapujące gałęzi produkcyjnej i repozytoria reftable, ani pushe wykonane przy
zamkniętej aplikacji.

### Skille dla agenta

Ustawienia → „Skill dla Claude Code” → „Zainstaluj skill” instaluje w `~/.claude/skills` skille
`abeon-open-session`, `abeon-notes` i `abeon-deploy` oraz odświeża wrapper.

### Ponowna instalacja komendy

Wrapper z wersji sprzed śledzenia wdrożeń nie zna `flow` ani `deploy` (uruchomiłby aplikację zamiast
komendy). Po aktualizacji aplikacji zainstaluj komendę ponownie: Ustawienia → CLI → „Zainstaluj
komendę”. Nowy wrapper ma w nagłówku `wrapper_features="note flow deploy"`; skille sprawdzają ten
znacznik przed pierwszym wywołaniem i każą zainstalować komendę ponownie, gdy go brak. Sprawdzenie:

    grep wrapper_features "$(command -v abeon-code)"

## Weryfikacja manualna

1. **Zimny start (CLI):** aplikacja zamknięta → `abeon-code /ścieżka/do/projektu`
   → aplikacja startuje, projekt zaznaczony, otwarta nowa sesja.
2. **Ciepły start (CLI):** aplikacja otwarta → `abeon-code /inny/projekt`
   → okno wraca na wierzch, nowa sesja w drugim projekcie.
3. **Nowy projekt:** wskaż katalog bez projektu → projekt tworzony z nazwą = basename.
4. **Deep-link (ciepły):** `xdg-open 'abeon-code://open?path=/ścieżka'` (Linux) lub
   `open 'abeon-code://open?path=/ścieżka'` (macOS) → nowa sesja.
5. **Błąd:** `abeon-code /nie/istnieje` → aplikacja zgłasza błąd, nie tworzy projektu.
