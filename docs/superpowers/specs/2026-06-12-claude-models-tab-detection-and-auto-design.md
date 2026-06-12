# Zakładka Modele — uniwersalna detekcja modeli Claude + opcja „Auto"

Data: 2026-06-12
Status: zaakceptowany projekt (przed planem implementacji)
Zakres: `DesktopApp/`

## Problem

Zakładka „Modele" w ustawieniach ma dwie wady dla providera Claude Code:

1. **Najnowsze modele się nie pobierają.** Mechanizm detekcji jest związany z trzema
   zaszytymi rodzinami i sztywnym formatem wersji, przez co każde nowe nazewnictwo jest
   niewidoczne.
2. **Brak opcji automatycznego wyboru.** Codex ma „Auto" (puste `codexModelId` → CLI
   decyduje), Claude zawsze wymusza konkretny model.

## Przyczyny (zweryfikowane w kodzie)

- `src-tauri/src/commands/models.rs`:
  - `FAMILIES = ["opus", "sonnet", "haiku"]` (linia 8) — whitelista rodzin.
  - `normalize_alias` (linie 40–51) wymaga formatu `claude-<family>-<major>-<minor>` z
    niezerowym `minor`.
  - Skutek: `claude-fable-5` odpada podwójnie (rodzina spoza listy + brak członu `minor`).
- `src/lib/models.ts`:
  - `detectUnknownModels` (linia 76) pokazuje tylko modele *nowsze* niż najnowszy
    `BUILTIN_MODELS` w danej rodzinie; `parseVersion` (linia 60) jest związany z trzema
    rodzinami i formatem `major-minor`.
  - `getCliModelString` (linia 32) zawsze zwraca konkretny string (fallback
    `claude-sonnet-4-6`), nigdy „brak modelu".
- Miejsce spawnu jest już gotowe na brak modelu: `src/components/terminal/TerminalView.tsx:159`
  dokłada klucz `model` tylko gdy `cliModel` jest prawdziwe; backend
  `build_claude_command` (`src-tauri/src/commands/pty.rs:36`) przy `model: None` pomija
  `--model`.

## Decyzje projektowe

1. Uniwersalny skaner (odporny na przyszłe rodziny) + odświeżenie listy wbudowanej.
2. „Auto" zostaje nowym domyślnym wyborem dla świeżych profili; istniejący użytkownicy z
   zapisanym wyborem zostają na nim (bez migracji nadpisującej).
3. Wykryte modele są auto-promowane na listę wybieralną (bez przycisku „Dodaj").

## Projekt

### A. Uniwersalny skaner modeli (Rust — `commands/models.rs`)

- Usunięcie `FAMILIES` jako filtra. `normalize_alias` przyjmuje dowolną alfabetyczną
  rodzinę, jeśli token zawiera co najmniej jeden numeryczny człon wersji.
- Obsługa dwóch schematów nazewnictwa:
  - `claude-opus-4-8` → rodzina `opus`, wersja `4.8`,
  - `claude-fable-5` → rodzina `fable`, wersja `5` (sam major, bez minora).
- Odrzucenie szumu: tokeny bez członu numerycznego (`claude-code`, `claude-cli`) oraz
  tokeny z numeryczną „rodziną" (stary schemat API `claude-3-5-sonnet` — celowo poza
  zakresem; to nie są aliasy `--model` Claude Code).
- Synteza wariantu `[1m]` pozostaje tylko dla rodziny `opus` (jedyna, o której wiadomo, że
  CLI dokleja `[1m]`); dla innych rodzin nie zgadujemy.
- Obcinanie sufiksów datowych / `-v1` / `-fast` bez zmian.
- `DetectedModel.family` pozostaje `String` (już generyczny).

### B. Składanie listy i auto-promocja (`src/lib/models.ts`)

- Uogólnienie `parseVersion`: `^claude-([a-z]+)-(\d+)(?:-(\d+))?` → rodzina, major,
  opcjonalny minor (minor domyślnie 0).
- Zastąpienie `detectUnknownModels` funkcją budującą pełną listę wybieralną:
  `BUILTIN_MODELS` ∪ `customModels` ∪ wykryte (deduplikacja po `modelId`). Wykryte trafiają
  od razu jako wybieralne pozycje oznaczone `source: 'detected'`.
- Filtr anti-clutter dla wykrytych: pokazujemy te, których rodzina nie istnieje w
  `BUILTIN_MODELS`, lub które są nowsze-bądź-równe najnowszemu builtinowi w swojej rodzinie.
  Stare modele z sesji nie wskrzeszają się jako osobne pozycje.
- Generowanie etykiet generycznie (kapitalizacja rodziny + wersja + `(1M)` dla wariantu
  `[1m]`), bez ręcznego mapowania nieznanych rodzin.

### C. Opcja „Auto" dla Claude

- `getCliModelString` zwraca `string | null`: dla `defaultModelId === ''` → `null` (CLI bez
  `--model`); fallback na Sonnet tylko dla niepustego, nieznanego id.
- `getModelDisplayLabel('')` → `"Auto"`.
- `DEFAULT_MODEL_ID = ''` (Auto). Spawn w `TerminalView.tsx` bez zmian — istniejący guard na
  `cliModel` obsługuje brak modelu. Persystencja bez zmian: strażnik `if (p.defaultModelId)`
  w `store/index.ts:174` powoduje, że pusty string spada do domyślnej wartości slice'a, więc
  całość jest spójna bez migracji.
- UI (`ClaudeModelsSection` w `components/dialogs/SettingsDialog.tsx`): radio
  „Auto (domyślny model Claude)" jako pierwsza pozycja, wzorowane na `CodexModelsSection`.
  Selektor effort ukryty, gdy wybrane Auto. `SidebarFooter` pokazuje „Auto".

### D. Odświeżenie listy wbudowanej

- Dodanie `Claude Fable 5` (`claude-fable-5`, bez effort, bez `[1m]`) do `BUILTIN_MODELS`.
  Pozostałe pozycje (Opus 4.6–4.8, Sonnet 4.6, Haiku 4.5) bez zmian. Nowsze modele dochodzą
  przez skaner.

### E. Testy

- Rust (`commands/models.rs`):
  - akceptacja `claude-fable-5` (rodzina spoza dotychczasowej listy, sam major),
  - akceptacja przyszłej nowej rodziny,
  - odrzucenie `claude-code` (brak wersji) i `claude-3-5-sonnet` (numeryczna rodzina),
  - `[1m]` syntetyzowany tylko dla `opus`.
- TS (`src/lib/models.test.ts`):
  - `getCliModelString('') === null`, fallback dla niepustego nieznanego id zachowany,
  - `getModelDisplayLabel('') === 'Auto'`,
  - `parseVersion` dla schematu single-major (`claude-fable-5`),
  - budowanie listy z auto-promocją + filtr anti-clutter (nowa rodzina widoczna, stary model
    z sesji pominięty).

## Poza zakresem

- Modele do generowania tytułów (zakładka CLI: `titleGenModelId` / `codexTitleGenModelId`) —
  bez zmian.
- Codex — bez zmian, poza ewentualnym współdzieleniem uogólnionej funkcji etykietującej.
- Migracja nadpisująca wybór istniejących użytkowników — świadomie pominięta.

## Pliki do zmiany

- `DesktopApp/src-tauri/src/commands/models.rs` — skaner.
- `DesktopApp/src/lib/models.ts` — lista, parser wersji, `getCliModelString`,
  `getModelDisplayLabel`, `DEFAULT_MODEL_ID`.
- `DesktopApp/src/components/dialogs/SettingsDialog.tsx` — `ClaudeModelsSection` (Auto +
  auto-promocja + ukrycie effort).
- `DesktopApp/src/lib/models.test.ts` oraz testy w `models.rs` — pokrycie.
