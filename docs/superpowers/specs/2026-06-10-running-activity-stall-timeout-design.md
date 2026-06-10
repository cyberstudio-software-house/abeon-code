# Wygaszanie statusu "Running" przerwanych sesji

## Problem

Sesja przerwana w trakcie pracy (np. zamknięcie aplikacji / zabicie procesu Claude,
gdy "piłka była po stronie Claude") świeci w sidebarze na zielono (`Running`) przez
~24 h, mimo że proces dawno nie żyje. Przykład z obserwacji: sesja z ostatnią
aktywnością 23 h temu nadal pokazuje zieloną kropkę.

## Przyczyna

Status aktywności nie jest trzymany w stanie — jest wyliczany na bieżąco w Rust przez
`compute_activity` (`DesktopApp/src-tauri/src/sessions/activity.rs`) na podstawie `mtime`
pliku `.jsonl` sesji oraz treści ostatniego znaczącego zdarzenia. Frontend odpytuje co
10 s (`sessionsSlice.ts`, tylko gdy okno ma fokus); kolor kropki to czysta funkcja
`activity` (`lib/activity.ts`).

Funkcja stosuje "rozpad" stanów oczekiwania (`WAITING_DECAY_MS = 4 h` zamienia
`WaitingUser`/`WaitingTool` na `Idle`). Jednak dwie gałęzie omijają rozpad przez wczesny
`return`:

- `LastEvent::UserText` → `return Running`
- `LastEvent::UserToolResult { is_error: false }` → `return Running`

Oba reprezentują "turę oddaną Claude". Nie sprawdzają jednak, czy plik faktycznie był
ostatnio zapisywany. Żywy Claude dopisuje do `.jsonl` co kilka sekund, więc brak zapisu
przez dłuższy czas oznacza, że proces już nie pracuje. Jedynym ogranicznikiem jest twardy
limit `IDLE_HARD_CAP_MS = 24 h`, stąd ~24 h zielonej kropki.

## Rozwiązanie

Wprowadzić próg świeżości dla "wnioskowanego Running". Gdy od ostatniego zapisu minęło
więcej niż 10 minut, te dwa stany przechodzą w `Idle` (szara kropka — sesja
bezczynna/porzucona).

### Zmiana logiki

W `DesktopApp/src-tauri/src/sessions/activity.rs`:

```rust
const RUNNING_STALL_MS: i64 = 10 * 60 * 1000; // 10 min
```

W `compute_activity`, w gałęzi `match last`, dwie pozycje przestają być bezwarunkowym
`return Running` i zyskują bramkę świeżości:

- `LastEvent::UserText` → `if age_ms > RUNNING_STALL_MS { Idle } else { Running }`
- `LastEvent::UserToolResult { is_error: false }` → to samo

Pozostałe gałęzie oraz kolejność progów bez zmian:
`IDLE_HARD_CAP_MS (24 h)` → `LIVE_WINDOW_MS (5 s)` → `TOOL_STALL_MS (30 s)` →
`WAITING_DECAY_MS (4 h)`. Nowy próg mieści się między `LIVE_WINDOW_MS` a `WAITING_DECAY_MS`.

Próg jest stałą w kodzie (jak `TOOL_STALL_MS` / `WAITING_DECAY_MS`) — bez nowego UI ani
klucza konfiguracji.

### Efekt

- Sesja przerwana w trakcie (ostatnia linia = prompt usera lub udany wynik narzędzia)
  przestaje świecić na zielono po 10 min braku zapisu — kropka robi się szara (`Idle`).
- Świeżo pracujący Claude (zapis < 5 s temu przez `LIVE_WINDOW_MS`, lub ciągłe
  dopisywanie do pliku) nadal `Running`.
- Świeże wywołanie narzędzia (`AssistantToolUseUnresolved` < `TOOL_STALL_MS`) niezmienione.

## Testy

W sekcji `#[cfg(test)]` pliku `activity.rs`:

Nowe:
- `user_text_after_11min_returns_idle` — ostatnia linia `UserText`, `age = 11 min` → `Idle`.
- `user_tool_result_ok_after_11min_returns_idle` — ostatnia linia udany `tool_result`,
  `age = 11 min` → `Idle`.
- regresja świeżości: `UserText` z `age < 10 min` → nadal `Running`
  (istniejący `last_event_user_text_returns_running` używa `+60_000` ms = 1 min, więc
  pokrywa ten przypadek; nie wymaga dodatkowego testu).

Do zmiany:
- `user_text_after_5h_returns_running_not_decayed` — zakłada obecne (problematyczne)
  zachowanie. Po zmianie 5 h > 10 min, więc oczekiwanym wynikiem jest `Idle`. Test i jego
  nazwa wymagają aktualizacji (np. `user_text_after_5h_returns_idle_via_running_stall`).

## Zakres

Zmiana jest lokalna: jedna funkcja w jednym pliku Rust plus jej testy. Frontend, IPC,
store i typy bez zmian. Bez nowych ustawień.
