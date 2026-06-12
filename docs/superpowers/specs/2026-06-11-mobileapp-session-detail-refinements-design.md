# MobileApp — dopracowanie szczegółów sesji (design)

Data: 2026-06-11
Status: zaakceptowany kierunek, gotowy do planu implementacji

## Kontekst

Aplikacja mobilna (Expo SDK 56, `centrifuge` + REST do CloudService) zdalnie steruje
sesjami AI-CLI działającymi na desktopie, przez relay Centrifugo. MVP jest
feature-complete; testy na realnym urządzeniu ujawniły pięć braków do dopracowania.

Architektura komunikacji (potwierdzona w kodzie):

- Kanały: `abeon-cloud-cmd:<deviceId>` (mobile→desktop, przez REST `/v1/command`),
  `abeon-cloud-dev:<deviceId>` (desktop→mobile, acki + roster),
  `abeon-cloud-sess:<sessionId>` (desktop→mobile, zdarzenia sesji).
- Typy kontraktu są własnością Rusta (`crates/abeon-remote-core`) i generowane do
  `MobileApp/src/types/` oraz `DesktopApp/src/types/` przez ts-rs. Nie edytować ręcznie.
- Stan aktywności sesji desktop wyznacza **wyłącznie heurystyką na pliku JSONL**
  (`DesktopApp/src-tauri/src/sessions/activity.rs`), nie z bufora terminala. Treść
  promptu uprawnień / menu opcji istnieje tylko w buforze PTY (xterm na froncie),
  nie ma jej w JSONL i nie ma parsera ekranu po stronie Rusta.

## Cele (5 punktów)

1. Po wejściu w szczegóły sesji wyświetla się historia konwersacji i odświeża na żywo.
2. Gdy Claude zadaje pytanie, można z aplikacji odpowiedzieć tekstem.
3. Gdy jest prośba o uprawnienia, można je nadać/odrzucić.
4. Nagłówek ekranu szczegółów nie nachodzi na pasek statusu telefonu.
5. Lista projektów posortowana spójnie z desktopem.

## Kluczowe ustalenia, które kształtują projekt

- **Brak backfillu historii.** Watcher startuje od aktualnego końca pliku
  (`sessions/watcher.rs`) i publikuje tylko nowe bloki. Pełna rozmowa nigdy nie trafia
  na kanał sesji, więc `sub.history()` na mobile zwraca pustkę (a retencja namespace'a
  nie jest skonfigurowana). To jest przyczyna „historia się w ogóle nie wyświetla".
- **Mapowanie stanów jest dziś odwrócone względem intencji.** W `activity.rs`:
  nierozwiązany `tool_use` (moment prośby o zgodę) → `Running` (<30 s) / `WaitingTool`
  (≥30 s), **nigdy** `WaitingUser`. Natomiast `WaitingUser` wynika z `AssistantText`
  (Claude napisał i czeka na odpowiedź). Obecny `PermissionPrompt` jest pokazywany na
  `waitingUser`, czyli odpala się przy pytaniu tekstowym, a nie przy prośbie o zgodę.
- **Z JSONL nie da się pewnie odróżnić „narzędzie się wykonuje" od „czeka na zgodę"** —
  oba to nierozwiązany `tool_use`. Przyjmujemy pragmatyczny kompromis: stan `waitingTool`
  traktujemy jako prawdopodobną prośbę o zgodę. Treść menu i jego opcje są **założone**
  (standardowy układ Claude), nie odczytane z ekranu.

## Zmiany w protokole

Dodajemy dwa warianty do `RemoteCommand` w `crates/abeon-remote-core/src/protocol.rs`:

- `RequestHistory { session_id: String }` — żądanie pełnej historii sesji (ścieżka
  nie-PTY, wzorowana na istniejącym `RequestRoster`).
- `ApproveAlwaysPermission { session_id: String }` — zatwierdzenie z „nie pytaj ponownie".

Po zmianie regenerować typy:
`cargo test --manifest-path crates/abeon-remote-core/Cargo.toml`
i potwierdzić, że `git status DesktopApp/src/types` jest czysty (gotcha ts-rs).

## Projekt per punkt

### 1. Historia — backfill na żądanie

**Desktop.** W obsłudze komend bridge'a dodać gałąź dla `RequestHistory` (analogicznie do
`RequestRoster` — nie pisze do PTY, tylko publikuje). Po odebraniu:

- odczytać pełny plik JSONL sesji istniejącym readerem (ten sam, co `read_session_history`
  w `commands/sessions.rs` — wydzielić/wykorzystać funkcję czytającą bloki),
- opublikować bloki jako `SessionEvent::SessionAppend { session_id, blocks }` na
  `session_channel(session_id)` w **porcjach** (np. po N bloków), by nie przekroczyć
  limitu rozmiaru wiadomości Centrifugo,
- porcje publikować w kolejności chronologicznej.

**Mobile.** W `app/session/[id].tsx`, w `useEffect` montującym subskrypcję, po
zasubskrybowaniu wysłać `dispatchCommand(phoneToken, { type: 'requestHistory', sessionId: id })`.
Bloki dochodzą przez istniejący handler `publication` → `applySessionEvent`; deduplikacja
po `uuid` w `sessionsSlice` już to obsługuje. Live-append z watchera działa bez zmian, więc
backfill + live dają komplet.

**Ograniczenia.** Wymaga online desktopa (presence gate; komenda offline → 409, łykane jak
przy `requestRoster`). Bez zależności od retencji Centrifugo.

### 2. Odpowiadanie na pytania

Stan `waitingUser` (ostatni blok = `AssistantText`) = Claude czeka na odpowiedź tekstową.

**Mobile.** W `app/session/[id].tsx`:
- gdy `activity === 'waitingUser'`, wyróżnić, że Claude czeka na odpowiedź (np. nagłówek
  „Czeka na Twoją odpowiedź" — już jest tekst aktywności) i zostawić `CommandBar`
  (`sendPrompt`) jako kanał odpowiedzi,
- domknąć UX wprowadzania (patrz pkt 4: `KeyboardAvoidingView`, by pole było widoczne).

Nie wymaga zmian protokołu — `sendPrompt` już istnieje i jest podpięty.

### 3. Nadawanie uprawnień

Stan `waitingTool` (nierozwiązany `tool_use`) = prawdopodobna prośba o zgodę.

**Mobile.** W `app/session/[id].tsx`:
- pokazywać `PermissionPrompt` również przy `activity === 'waitingTool'` (dziś tylko
  `waitingUser`),
- treść promptu wyprowadzić z historii: znaleźć ostatni blok `toolUse` i pokazać
  `name` + `input_summary` („Claude chce użyć: Bash · rm -rf …"). Jeśli bloku brak —
  fallback do dotychczasowego tekstu generycznego.

`PermissionPrompt` rozszerzyć o trzeci przycisk i przekazać treść:
- **Zatwierdź** → `approvePermission` → `\r` (Enter; opcja domyślna) — robust.
- **Zatwierdź i nie pytaj** → `approveAlwaysPermission` → `\x1b[B\r` (down + Enter).
- **Odrzuć** → `denyPermission` → `\x1b` (Escape) — robust.

**Desktop.** W `remote/dispatch.rs` dodać mapowanie `ApproveAlwaysPermission` na sekwencję
klawiszy (stała obok `APPROVE_KEYS`/`DENY_KEYS`, np. `APPROVE_ALWAYS_KEYS = "\x1b[B\r"`).

**Ryzyko (do weryfikacji na urządzeniu).** „Zatwierdź i nie pytaj" zakłada standardowy
3-opcyjny layout menu Claude (opcja 2 = „don't ask again"). Na promptach bez tej opcji
down+Enter może wybrać „Nie". Enter (Zatwierdź) i Escape (Odrzuć) są bezpieczne niezależnie
od layoutu; trzeci przycisk jest best-effort. Kompromis przyjęty świadomie. Sekwencję
klawiszy zweryfikować empirycznie na realnym prompcie przed uznaniem za gotowe.

### 4. SafeArea nagłówka + klawiatura

Ekran `app/session/[id].tsx` jest siostrzanym ekranem Stacka, poza layoutem `(tabs)`, więc
nie dziedziczy `SafeAreaView`. Owinąć zawartość w `SafeAreaView edges={['top']}`
(`react-native-safe-area-context`). Dodać `KeyboardAvoidingView` wokół listy + `CommandBar`,
by pole odpowiedzi nie było zasłaniane klawiaturą (wspiera pkt 2).

### 5. Sortowanie projektów wg aktywności

W `src/lib/roster.ts`, w `groupByProject`, zmienić finalne sortowanie sekcji: zamiast
`a.title.localeCompare(b.title)` sortować malejąco wg najświeższej aktywności w projekcie
(max `lastEventAt` spośród sesji sekcji). Sortowanie sesji w obrębie projektu (malejąco po
`lastEventAt`) zostaje bez zmian. Odpowiada to trybowi `activity` desktopa.

## Zakres per warstwa

- Czysto mobile: pkt 2 (UX), pkt 4, pkt 5, oraz mobilna część pkt 3 (UI promptu).
- Rust + mobile: pkt 1 (komenda `RequestHistory` + publikacja + wywołanie z mobile),
  pkt 3 (komenda/klawisz `ApproveAlwaysPermission`).

## Weryfikacja

- `RemoteCommand` rozszerzone, typy zregenerowane, `git status DesktopApp/src/types` czysty.
- Testy Rust (`activity`/dispatch/bridge dla nowych komend) zielone:
  `npm run test:rust` lub `cargo test`.
- Mobile: `npm run lint` (= `tsc --noEmit`) i `npm test` zielone (Node 22, `jest-expo/web`).
- Na realnym urządzeniu (po EAS build / dev): (1) historia ładuje się po wejściu w sesję,
  (2) odpowiedź tekstowa dociera do sesji, (3) prompt zgody pokazuje treść narzędzia i
  Zatwierdź/Odrzuć działają — a „Zatwierdź i nie pytaj" robi to, co oczekiwane na realnym
  menu, (4) nagłówek nie nachodzi na pasek statusu, (5) kolejność projektów zgodna z
  desktopem w trybie aktywności.

## Świadomie poza zakresem (YAGNI)

- Parser ekranu terminala (vt100 w Rust lub bufor xterm na froncie) dla dosłownego
  odczytu treści promptu i opcji — większy, kruchy projekt; pominięty na rzecz wariantu
  pragmatycznego.
- Konfiguracja retencji historii w Centrifugo — backfill na żądanie jej nie wymaga.
- Obsługa push (Plan 3) — odrębny wątek.
