# Powiadomienia o sesjach czekających na użytkownika

**Data:** 2026-06-05
**Status:** Zaakceptowany do planowania
**Zakres:** DesktopApp (Tauri 2 + React)

## Problem

Gdy sesja AI-CLI (Claude Code) kończy turę, prosi o zatwierdzenie narzędzia lub
zadaje pytanie, użytkownik często tego nie zauważa — zwłaszcza gdy pracuje w innej
zakładce lub innym oknie. Chcemy:

1. **Powiadomienie systemowe**, że sesja czeka na działanie; klik w powiadomienie
   przenosi fokus na tę sesję.
2. **Wyraźną ikonę** w zakładce i na liście sesji, że są pytania do odpowiedzenia.

## Co już istnieje (punkt wyjścia)

AbeonCode ma już częściową infrastrukturę — projekt ją **rozszerza**, nie buduje od zera:

- `sessions/activity.rs` — liczy `SessionActivity` (`Running` / `WaitingUser` /
  `WaitingTool` / `Idle`) z ogona pliku JSONL Claude Code + mtime.
- `sessions/watcher.rs` — `SessionWatchers` obserwuje pliki JSONL przez `notify`
  i emituje `session:{sid}:activity` przy każdej zmianie stanu (tylko dla sesji
  otwartych przez `open()`).
- `lib/activity.ts` — mapuje stany na kropki: `ACTIVITY_DOT` / `ACTIVITY_LABEL` /
  `ACTIVITY_ICON`. `waitingUser` → kropka akcentu, label „Czeka na Twoją odpowiedź".
  Renderowane w `TabBar` (`TabActivityDot`), `TabSwitcher`, `SessionItem`,
  `HistoryHeader`.
- `remote/cloud_client.rs::notify_permission()` — push do aplikacji mobilnej
  (osobny tor, poza zakresem tego projektu).

**Kluczowy fakt mapowania:** `session_file(&dir, &session_id)` pokazuje, że
AbeonCode `session_id` to nazwa pliku JSONL = Claude session uuid. Więc `session_id`
z hooka Claude Code jest identyczny z `session_id` w AbeonCode — mapowanie jest
trywialne i pewne (krzyżowo weryfikowalne przez `transcript_path`).

## Architektura

Dwa **źródła sygnału** wpadają do jednej **magistrali** w backendzie, która emituje
znormalizowane zdarzenie `session-attention`. Frontend stosuje **politykę** i decyduje
o powiadomieniu systemowym oraz o ikonie dzwonka. Rozdzielamy *wykrywanie* od
*polityki powiadamiania*.

```
[JSONL watcher] ──activity=waitingUser/waitingTool──┐
                                                    ├─► AttentionBus
[marker watcher] ◄─plik JSON─ [hook claude] ────────┘     │
   (<app_data>/notifications/*.json)                      │ emit "session-attention"
                                                          ▼   {sessionId, reason, message}
                                                      Frontend
                              policy(setting, focusedSession, reason)
                                  ├─► OS notification (klik → openSessionTab + focus okna)
                                  └─► bell icon (TabBar / SessionItem / TabSwitcher)
```

### Dwa źródła sygnału

- **Hook `Notification` Claude Code** (precyzyjny, natychmiastowy, `reason: "hook"`):
  odpala się dokładnie gdy Claude prosi o uprawnienie lub czeka na input. Niesie
  intencję wprost. Działa **niezależnie** od tego, czy sesja ma otwartą zakładkę.
  Pokrywa też sesje w tle.
- **Heurystyka JSONL** (`reason: "heuristic"`): istniejący `SessionWatchers` przy
  przejściu na `WaitingUser` emituje sygnał. Bez zmiany zasięgu (tylko sesje
  otwarte przez `open()`).

### Transport hooka: plik-marker + watcher

Hook `Notification` zapisuje mały plik JSON do `<app_data>/notifications/<uuid>.json`
z polami `{ sessionId, transcriptPath, message, ts }`. Nowy `MarkerWatcher`
(analogiczny do `SessionWatchers`, ten sam wzorzec `notify`) obserwuje katalog, na
zdarzeniu `Create` czyta + kasuje plik i emituje `session-attention`. **Brak nowej
powierzchni sieciowej** — spójne z istniejącymi wzorcami.

## Komponenty i pliki

### Backend (Rust)

- **`src-tauri/src/notifications/mod.rs`** (nowy) — `MarkerWatcher`: obserwuje
  `<app_data>/notifications/` przez `notify`; na `Create` czyta+kasuje JSON, mapuje
  `session_id`, emituje `session-attention { sessionId, reason: "hook", message }`.
- **`src-tauri/src/notifications/hook_installer.rs`** (nowy) —
  `install_attention_hook()` / `is_hook_installed()` / `uninstall_attention_hook()`:
  czytają `~/.claude/settings.json`, **merge** wpisu do `hooks.Notification`
  (zachowując istniejące hooki), zapis atomowy, idempotentnie. Polecenie hooka to
  inline shell zrzucający stdin do pliku-markera.
- **Rozszerzenie `sessions/watcher.rs`** — w miejscu emisji `session:{sid}:activity`,
  gdy nowy stan to `WaitingUser`/`WaitingTool`, dorzucenie emisji `session-attention
  { reason: "heuristic" }` na tę samą magistralę.
- **Nowe komendy** (`commands/notifications.rs`, rejestracja w `lib.rs`):
  `install_attention_hook`, `attention_hook_status`, `uninstall_attention_hook`.
- **`Cargo.toml`** — dodanie `tauri-plugin-notification` + rejestracja pluginu;
  uprawnienie w `capabilities`.

### Frontend (TS/React)

- **`src/lib/tauri.ts`** — wrappery: `onSessionAttention(cb)`, `installAttentionHook()`,
  `attentionHookStatus()`, `uninstallAttentionHook()`; sygnał systemowy przez
  `@tauri-apps/plugin-notification`.
- **`src/lib/activity.ts`** — `ACTIVITY_ICON.waitingUser = 'bell'` (odrębna ikona
  zamiast `dot`); dodanie ikony `bell` do `Icon`.
- **`src/store/sessionsSlice.ts`** — `attentionSessions: Set<string>` + akcje
  `markAttention(sessionId)` / `clearAttention(sessionId)`. Czyszczone gdy użytkownik
  aktywuje zakładkę tej sesji albo stan wróci do `running`.
- **`src/store/settingsSlice.ts`** (+ `PERSISTED_KEYS` w `store/index.ts`):
  `notificationsEnabled: boolean`, `notificationTrigger: 'turnEnd' | 'questionsOnly' | 'both'`.
- **`src/components/dialogs/SettingsDialog.tsx`** — sekcja „Powiadomienia": włącznik,
  wybór trybu, przycisk „Zainstaluj hook pytań Claude Code" z `ConfirmDialog`
  wyjaśniającym modyfikację `~/.claude/settings.json`, status hooka.
- **`src/components/layout/AppShell.tsx`** — globalny listener `onSessionAttention`:
  stosuje politykę, odpala `sendNotification` + `markAttention`.
- **`TabBar.tsx` / `SessionItem.tsx` / `TabSwitcher.tsx`** — gdy
  `attentionSessions.has(sid)` renderują dzwonek zamiast kropki.
- **Klik w powiadomienie** → `openSessionTab(projectId, sessionId, title)` +
  `getCurrentWindow().unminimize()/show()/setFocus()`.

## Przepływ danych

- **Ścieżka hooka:** Claude wywołuje hook `Notification` → polecenie zrzuca stdin
  JSON do `<app_data>/notifications/<uuid>.json` → `MarkerWatcher` czyta+kasuje,
  mapuje `session_id` → emituje `session-attention { sessionId, reason:"hook", message }`.
- **Ścieżka heurystyki:** `SessionWatchers` przy zmianie na `WaitingUser` emituje
  `session-attention { reason:"heuristic" }`.
- **Polityka (frontend):** `notificationsEnabled` && tryb pasuje do `reason`
  (`turnEnd`→heuristic, `questionsOnly`→hook, `both`→oba) && sesja **nie jest**
  aktywną zakładką w sfokusowanym oknie → powiadomienie systemowe + `markAttention`.
  Dzwonek (`markAttention`) zapala się **zawsze**, niezależnie od `notificationsEnabled`.

## Decyzje

1. **Klik w powiadomienie na Linuksie (Pop!_OS):** callbacki akcji powiadomień przez
   libnotify bywają zawodne między środowiskami. Główne zachowanie = klik fokusuje
   sesję; **fallback** = dzwonek w UI i tak prowadzi do sesji. **Zaakceptowane.**
2. **Niezależność dzwonka:** dzwonek w UI zapala się zawsze (lekki), a
   `notificationsEnabled` steruje tylko **powiadomieniem systemowym**. **Zaakceptowane.**
3. **Anty-spam:** jedno powiadomienie na „epizod czekania" — watcher emituje tylko
   przy zmianie stanu; dla hooka de-dup po `sessionId` dopóki nie wyczyszczone.
   **Zaakceptowane.**

## Testy

- **Rust:** `hook_installer` (merge nie niszczy istniejących hooków; idempotencja
  instalacji/deinstalacji); `MarkerWatcher` (parsuje + kasuje marker, emituje
  poprawne zdarzenie; ignoruje niepoprawny JSON).
- **TS:** polityka powiadomień (macierz `tryb × reason × focus`);
  `markAttention/clearAttention` (czyszczenie przy aktywacji zakładki i powrocie do
  `running`); render dzwonka gdy `attentionSessions.has(sid)`.

## Poza zakresem (YAGNI)

Globalny licznik na pasku tytułu, badge na docku, dźwięki powiadomień, push do
aplikacji mobilnej (istnieje osobno przez `notify_permission`). Możliwe do dodania
później.
