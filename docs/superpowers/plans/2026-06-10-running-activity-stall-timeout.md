# Wygaszanie statusu "Running" przerwanych sesji — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sesja przerwana w trakcie pracy przestaje świecić na zielono (`Running`) po 10 min braku zapisu do pliku `.jsonl` — przechodzi w `Idle`.

**Architecture:** Status aktywności jest czystą funkcją Rust `compute_activity(path, now_ms) -> SessionActivity` w `sessions/activity.rs`. Dwa stany "wnioskowanego Running" (`UserText`, udany `UserToolResult`) dziś zwracają `Running` bezwarunkowo aż do twardego limitu 24 h. Dodajemy stałą `RUNNING_STALL_MS = 10 min` i bramkę świeżości na obu gałęziach. Brak zmian w froncie/IPC — kolor kropki i polling już działają na bazie tej funkcji.

**Tech Stack:** Rust (Tauri 2 backend), testy `cargo` przez `npm run test:rust`.

---

### Task 1: Bramka świeżości dla wnioskowanego Running

**Files:**
- Modify: `DesktopApp/src-tauri/src/sessions/activity.rs:6-8` (dodanie stałej)
- Modify: `DesktopApp/src-tauri/src/sessions/activity.rs:29-42` (gałęzie `match last`)
- Test: `DesktopApp/src-tauri/src/sessions/activity.rs` (sekcja `#[cfg(test)]`)

- [ ] **Step 1: Dodaj/zmień testy (faza RED)**

W sekcji `#[cfg(test)]` dodaj dwa nowe testy (umieść obok `last_event_user_text_returns_running`, ok. linii 338):

```rust
    #[test]
    fn user_text_after_11min_returns_idle() {
        let td = TempDir::new().unwrap();
        let (p, mtime) = write_with_mtime(&td, "s.jsonl",
            r#"{"type":"user","uuid":"u1","message":{"content":[{"type":"text","text":"do it"}]}}"#);
        let eleven_min = 11 * 60 * 1000;
        assert_eq!(compute_activity(&p, mtime + eleven_min), SessionActivity::Idle);
    }

    #[test]
    fn user_tool_result_ok_after_11min_returns_idle() {
        let td = TempDir::new().unwrap();
        let (p, mtime) = write_with_mtime(&td, "s.jsonl",
            r#"{"type":"user","uuid":"u1","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"ok","is_error":false}]}}"#);
        let eleven_min = 11 * 60 * 1000;
        assert_eq!(compute_activity(&p, mtime + eleven_min), SessionActivity::Idle);
    }
```

Zmień istniejący test `user_text_after_5h_returns_running_not_decayed` (ok. linii 438-445) — po zmianie 5 h > 10 min, więc oczekiwany wynik to `Idle`. Zastąp całe ciało nową nazwą i asercją:

```rust
    #[test]
    fn user_text_after_5h_returns_idle_via_running_stall() {
        let td = TempDir::new().unwrap();
        let (p, mtime) = write_with_mtime(&td, "s.jsonl",
            r#"{"type":"user","uuid":"u1","message":{"content":[{"type":"text","text":"do it"}]}}"#);
        let five_hours = 5 * 60 * 60 * 1000;
        assert_eq!(compute_activity(&p, mtime + five_hours), SessionActivity::Idle);
    }
```

Pozostaw bez zmian `last_event_user_text_returns_running` i `user_tool_result_ok_returns_running` (używają `+60_000` ms = 1 min < 10 min) — pełnią rolę regresji świeżości.

- [ ] **Step 2: Uruchom testy — potwierdź RED**

Run: `cd DesktopApp && npm run test:rust -- sessions::activity`
Expected: FAIL — `user_text_after_11min_returns_idle`, `user_tool_result_ok_after_11min_returns_idle` oraz `user_text_after_5h_returns_idle_via_running_stall` zwracają `Running` zamiast `Idle` (bo bramka jeszcze nie istnieje).

- [ ] **Step 3: Dodaj stałą `RUNNING_STALL_MS`**

Po linii `const TOOL_STALL_MS: i64 = 30_000;` (linia 6), dodaj:

```rust
const RUNNING_STALL_MS: i64 = 10 * 60 * 1000;
```

- [ ] **Step 4: Dodaj bramkę świeżości w `match last`**

W `compute_activity`, w bloku `let waiting = match last { ... }` (linie 29-42), zamień dwie pierwsze gałęzie:

Z:
```rust
        LastEvent::UserText => return SessionActivity::Running,
        LastEvent::UserToolResult { is_error: false } => return SessionActivity::Running,
```

Na:
```rust
        LastEvent::UserText | LastEvent::UserToolResult { is_error: false } => {
            if age_ms > RUNNING_STALL_MS {
                return SessionActivity::Idle;
            }
            return SessionActivity::Running;
        }
```

Pozostałe gałęzie (`SessionAway`, `AssistantToolUseUnresolved`, `UserToolResult { is_error: true }`, `AssistantToolUseResolved`, `AssistantText`) bez zmian.

- [ ] **Step 5: Uruchom testy — potwierdź GREEN**

Run: `cd DesktopApp && npm run test:rust -- sessions::activity`
Expected: PASS — wszystkie testy `sessions::activity`, w tym trzy z kroku 1.

- [ ] **Step 6: Pełny build + lint backendu**

Run: `cd DesktopApp && npm run test:rust`
Expected: PASS — cały zestaw testów Rust bez regresji.

- [ ] **Step 7: Commit**

```bash
git add DesktopApp/src-tauri/src/sessions/activity.rs
git commit -m "fix(sessions): stall inferred Running to idle after 10 min of no writes"
```

---

## Notatki

- Frontend, IPC, store i typy bez zmian — `lib/activity.ts` mapuje `Idle` na `bg-muted` (szara kropka), a `sessionsSlice.ts` odświeża status co 10 s przy fokusie okna. Po wdrożeniu sesja z ekranu (23 h, ostatnia linia = prompt/wynik narzędzia) pokaże szarą kropkę przy najbliższym odświeżeniu.
- Próg 10 min mieści się między `LIVE_WINDOW_MS` (5 s) a `WAITING_DECAY_MS` (4 h); kolejność i pozostałe progi (`IDLE_HARD_CAP_MS` 24 h, `TOOL_STALL_MS` 30 s) niezmienione.
