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

## Weryfikacja manualna

1. **Zimny start (CLI):** aplikacja zamknięta → `abeon-code /ścieżka/do/projektu`
   → aplikacja startuje, projekt zaznaczony, otwarta nowa sesja.
2. **Ciepły start (CLI):** aplikacja otwarta → `abeon-code /inny/projekt`
   → okno wraca na wierzch, nowa sesja w drugim projekcie.
3. **Nowy projekt:** wskaż katalog bez projektu → projekt tworzony z nazwą = basename.
4. **Deep-link (ciepły):** `xdg-open 'abeon-code://open?path=/ścieżka'` (Linux) lub
   `open 'abeon-code://open?path=/ścieżka'` (macOS) → nowa sesja.
5. **Błąd:** `abeon-code /nie/istnieje` → aplikacja zgłasza błąd, nie tworzy projektu.
