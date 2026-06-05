# Session Attention Notifications — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Powiadamiać użytkownika (powiadomienie systemowe + ikona dzwonka w zakładce i na liście sesji), gdy sesja AI-CLI czeka na jego działanie — z konfigurowalnym triggerem i precyzyjnym sygnałem z hooka `Notification` Claude Code.

**Architecture:** Dwa źródła sygnału (heurystyka JSONL `WaitingUser`/`WaitingTool` z istniejącego `SessionWatchers` oraz hook `Notification` Claude Code piszący plik-marker, obserwowany przez nowy `AttentionWatcher`) emitują jedno globalne zdarzenie Tauri `session-attention`. Frontend nasłuchuje go raz globalnie w `AppShell`, stosuje politykę (ustawienie trybu + „czy patrzysz na tę sesję”) i decyduje o powiadomieniu systemowym (`tauri-plugin-notification`) oraz o zapaleniu dzwonka (`attentionSessions` w store).

**Tech Stack:** Rust (Tauri 2, `notify`, `serde_json`), React 19 + Zustand 5 + Tailwind 4, `@tauri-apps/plugin-notification`, Vitest, cargo test.

**Spec:** `docs/superpowers/specs/2026-06-05-session-attention-notifications-design.md`

---

## File structure

**Backend (nowe):**
- `src-tauri/src/notifications/mod.rs` — moduł: typ `AttentionEvent` + `emit_attention()`; reeksport submodułów.
- `src-tauri/src/notifications/marker.rs` — `AttentionWatcher` (obserwuje katalog markerów, parsuje + kasuje plik, emituje zdarzenie).
- `src-tauri/src/notifications/hook_installer.rs` — install/status/uninstall wpisu hooka w `~/.claude/settings.json` (merge, idempotentnie).
- `src-tauri/src/commands/notifications.rs` — komendy Tauri: `install_attention_hook`, `attention_hook_status`, `uninstall_attention_hook`, `notifications_dir`.

**Backend (modyfikacje):**
- `src-tauri/src/lib.rs` — `pub mod notifications;`, rejestracja pluginu, rejestracja komend, start `AttentionWatcher` w `.setup()`.
- `src-tauri/src/sessions/watcher.rs` — emisja `session-attention` przy zmianie stanu na `WaitingUser`/`WaitingTool`.
- `src-tauri/Cargo.toml` — `tauri-plugin-notification = "2"`.
- `src-tauri/capabilities/default.json` — uprawnienia notification + window show/unminimize.

**Frontend (nowe):**
- `src/lib/attention.ts` — czyste funkcje polityki (`triggerMatches`, `shouldNotify`) + typy.

**Frontend (modyfikacje):**
- `src/lib/tauri.ts` — wrappery zdarzenia i komend.
- `src/lib/activity.ts` — `ACTIVITY_ICON.waitingUser = 'bell'`.
- `src/components/shared/Icon.tsx` — ikona `bell`.
- `src/store/settingsSlice.ts` — `notificationsEnabled`, `notificationTrigger` + settery.
- `src/store/index.ts` — persistencja dwóch nowych kluczy.
- `src/store/sessionsSlice.ts` — `attentionSessions: Set<string>`, `markAttention`, `clearAttention`, czyszczenie w `patchActivity`.
- `src/components/sidebar/SessionItem.tsx` — dzwonek zamiast kropki gdy attention.
- `src/components/center/TabBar.tsx` — j.w. w `TabActivityDot`.
- `src/components/layout/AppShell.tsx` — globalny listener + polityka + powiadomienie + klik-fokus + czyszczenie na aktywację.
- `src/components/dialogs/SettingsDialog.tsx` — sekcja „Powiadomienia”.

---

## Task 1: Dodanie pluginu notification i uprawnień

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/src/lib.rs:27-31` (łańcuch `.plugin(...)`)
- Modify: `src-tauri/capabilities/default.json`
- Modify: `DesktopApp/package.json` (dependency frontendowa)

- [ ] **Step 1: Dodaj zależność Rust**

W `src-tauri/Cargo.toml`, w sekcji `[dependencies]` obok `tauri-plugin-fs = "2"` dodaj:

```toml
tauri-plugin-notification = "2"
```

- [ ] **Step 2: Zarejestruj plugin**

W `src-tauri/src/lib.rs` rozszerz łańcuch pluginów (po `.plugin(tauri_plugin_fs::init())`):

```rust
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_notification::init())
```

- [ ] **Step 3: Dodaj uprawnienia w capabilities**

W `src-tauri/capabilities/default.json` dodaj do tablicy `permissions` (po `"fs:allow-exists"`):

```json
    "fs:allow-exists",
    "notification:default",
    "core:window:allow-show",
    "core:window:allow-unminimize"
```

- [ ] **Step 4: Dodaj zależność frontendową**

Uruchom z katalogu `DesktopApp`:

Run: `npm install @tauri-apps/plugin-notification`
Expected: dopisana zależność w `package.json`, brak błędów.

- [ ] **Step 5: Zweryfikuj budowanie Rust**

Run: `npm run test:rust`
Expected: kompiluje się, testy przechodzą (PASS).

- [ ] **Step 6: Commit**

```bash
git add DesktopApp/src-tauri/Cargo.toml DesktopApp/src-tauri/Cargo.lock DesktopApp/src-tauri/src/lib.rs DesktopApp/src-tauri/capabilities/default.json DesktopApp/package.json DesktopApp/package-lock.json
git commit -m "feat(desktop): add notification plugin and capabilities for session attention"
```

---

## Task 2: Moduł `notifications` — typ zdarzenia i emiter

**Files:**
- Create: `src-tauri/src/notifications/mod.rs`
- Modify: `src-tauri/src/lib.rs:1-11` (deklaracja modułu)

- [ ] **Step 1: Utwórz moduł z typem zdarzenia**

Utwórz `src-tauri/src/notifications/mod.rs`:

```rust
pub mod marker;
pub mod hook_installer;

use serde::Serialize;
use tauri::{AppHandle, Emitter};

/// Global event name listened to once by the frontend (AppShell).
pub const ATTENTION_EVENT: &str = "session-attention";

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AttentionEvent {
    pub session_id: String,
    /// "hook" (Claude Notification hook) or "heuristic" (JSONL activity).
    pub reason: String,
    pub message: Option<String>,
}

pub fn emit_attention(app: &AppHandle, event: AttentionEvent) {
    let _ = app.emit(ATTENTION_EVENT, event);
}
```

- [ ] **Step 2: Zadeklaruj moduł**

W `src-tauri/src/lib.rs` dodaj po `pub mod sessions;`:

```rust
pub mod notifications;
```

- [ ] **Step 3: Zweryfikuj kompilację**

Run: `cargo build --manifest-path src-tauri/Cargo.toml`
Expected: kompiluje się (ostrzeżenia o nieużywanym `marker`/`hook_installer` są OK do następnych zadań — moduły są puste, więc na tym etapie utwórz też pliki-zaślepki, patrz krok 4).

- [ ] **Step 4: Utwórz puste pliki submodułów, by `mod` się kompilował**

Utwórz `src-tauri/src/notifications/marker.rs` z tymczasową treścią:

```rust
// Implemented in Task 3.
```

Utwórz `src-tauri/src/notifications/hook_installer.rs` z tymczasową treścią:

```rust
// Implemented in Task 4.
```

Run: `cargo build --manifest-path src-tauri/Cargo.toml`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/notifications/ src-tauri/src/lib.rs
git commit -m "feat(desktop): add notifications module with attention event type"
```

---

## Task 3: `AttentionWatcher` — obserwacja plików-markerów

Marker to plik JSON zrzucony przez hook Claude Code (stdin hooka: `session_id`, `transcript_path`, `message`). `AttentionWatcher` obserwuje katalog markerów, na zdarzeniu `Create` czyta + kasuje plik i emituje `AttentionEvent { reason: "hook" }`.

**Files:**
- Modify: `src-tauri/src/notifications/marker.rs`

- [ ] **Step 1: Napisz test parsowania markera**

Zastąp treść `src-tauri/src/notifications/marker.rs` testem (na razie tylko funkcja `parse_marker` + testy):

```rust
use std::path::{Path, PathBuf};
use std::sync::Arc;
use parking_lot::Mutex;
use notify::{RecommendedWatcher, RecursiveMode, Watcher as _, Event, EventKind};
use tauri::AppHandle;
use serde_json::Value;
use crate::notifications::{AttentionEvent, emit_attention};

/// Extract an AttentionEvent from raw Claude hook JSON. Returns None when the
/// payload has no usable `session_id`.
fn parse_marker(raw: &str) -> Option<AttentionEvent> {
    let v: Value = serde_json::from_str(raw).ok()?;
    let session_id = v.get("session_id").and_then(|s| s.as_str())?.to_string();
    if session_id.is_empty() {
        return None;
    }
    let message = v.get("message").and_then(|m| m.as_str()).map(String::from);
    Some(AttentionEvent { session_id, reason: "hook".to_string(), message })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_session_id_and_message() {
        let raw = r#"{"session_id":"abc-123","transcript_path":"/x.jsonl","message":"Claude needs your permission"}"#;
        let ev = parse_marker(raw).unwrap();
        assert_eq!(ev.session_id, "abc-123");
        assert_eq!(ev.reason, "hook");
        assert_eq!(ev.message.as_deref(), Some("Claude needs your permission"));
    }

    #[test]
    fn missing_session_id_returns_none() {
        let raw = r#"{"transcript_path":"/x.jsonl"}"#;
        assert!(parse_marker(raw).is_none());
    }

    #[test]
    fn empty_session_id_returns_none() {
        let raw = r#"{"session_id":""}"#;
        assert!(parse_marker(raw).is_none());
    }

    #[test]
    fn invalid_json_returns_none() {
        assert!(parse_marker("not json").is_none());
    }
}
```

- [ ] **Step 2: Uruchom testy — powinny przejść (czysta funkcja)**

Run: `cargo test --manifest-path src-tauri/Cargo.toml notifications::marker`
Expected: 4 testy PASS.

- [ ] **Step 3: Dodaj `AttentionWatcher` (struktura + start)**

Dopisz w `src-tauri/src/notifications/marker.rs` (nad blokiem `#[cfg(test)]`):

```rust
pub struct AttentionWatcher {
    dir: PathBuf,
    watcher: Mutex<Option<RecommendedWatcher>>,
}

impl AttentionWatcher {
    pub fn new(dir: PathBuf) -> Arc<Self> {
        Arc::new(Self { dir, watcher: Mutex::new(None) })
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// Start watching the marker directory. Creates it if missing.
    pub fn start(self: &Arc<Self>, app: AppHandle) {
        if std::fs::create_dir_all(&self.dir).is_err() {
            return;
        }
        let mut guard = self.watcher.lock();
        if guard.is_some() {
            return;
        }
        let self_clone = self.clone();
        let app_clone = app.clone();
        let watcher = notify::recommended_watcher(move |res: notify::Result<Event>| {
            if let Ok(ev) = res {
                if matches!(ev.kind, EventKind::Create(_) | EventKind::Modify(_)) {
                    for p in ev.paths {
                        self_clone.handle_marker(&app_clone, &p);
                    }
                }
            }
        });
        if let Ok(mut w) = watcher {
            if w.watch(&self.dir, RecursiveMode::NonRecursive).is_ok() {
                *guard = Some(w);
            }
        }
    }

    fn handle_marker(&self, app: &AppHandle, path: &Path) {
        if path.extension().map(|e| e != "json").unwrap_or(true) {
            return;
        }
        let raw = match std::fs::read_to_string(path) {
            Ok(s) => s,
            Err(_) => return,
        };
        let _ = std::fs::remove_file(path);
        if let Some(event) = parse_marker(&raw) {
            emit_attention(app, event);
        }
    }
}
```

- [ ] **Step 4: Zweryfikuj kompilację i testy**

Run: `cargo test --manifest-path src-tauri/Cargo.toml notifications::marker`
Expected: PASS, brak błędów kompilacji.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/notifications/marker.rs
git commit -m "feat(desktop): watch marker files and emit hook attention events"
```

---

## Task 4: Instalator hooka w `~/.claude/settings.json`

Wpis hooka identyfikujemy sentinelem w treści polecenia (`# abeoncode-attention`), żeby instalacja była idempotentna, a deinstalacja precyzyjna. Polecenie hooka zrzuca stdin do unikalnego pliku w katalogu markerów.

**Files:**
- Modify: `src-tauri/src/notifications/hook_installer.rs`

- [ ] **Step 1: Napisz testy merge/idempotencji**

Zastąp treść `src-tauri/src/notifications/hook_installer.rs`:

```rust
use std::path::Path;
use serde_json::{json, Value};

const SENTINEL: &str = "# abeoncode-attention";

/// Build the hook command that dumps Claude's stdin JSON into a uniquely-named
/// marker file in `markers_dir`. The trailing sentinel comment lets us find and
/// remove exactly our entry later.
fn hook_command(markers_dir: &Path) -> String {
    let dir = markers_dir.display();
    format!(
        "mkdir -p '{dir}' && cat > \"{dir}/$(date +%s%N)-$$.json\" {SENTINEL}"
    )
}

fn our_entry(markers_dir: &Path) -> Value {
    json!({
        "hooks": [
            { "type": "command", "command": hook_command(markers_dir) }
        ]
    })
}

fn entry_is_ours(entry: &Value) -> bool {
    entry
        .get("hooks")
        .and_then(|h| h.as_array())
        .map(|arr| {
            arr.iter().any(|h| {
                h.get("command")
                    .and_then(|c| c.as_str())
                    .map(|c| c.contains(SENTINEL))
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false)
}

/// Merge our Notification hook into an existing settings JSON value, preserving
/// every other key and every non-ours Notification entry. Idempotent.
pub fn merge_install(mut settings: Value, markers_dir: &Path) -> Value {
    if !settings.is_object() {
        settings = json!({});
    }
    let obj = settings.as_object_mut().unwrap();
    let hooks = obj.entry("hooks").or_insert_with(|| json!({}));
    if !hooks.is_object() {
        *hooks = json!({});
    }
    let hooks_obj = hooks.as_object_mut().unwrap();
    let notif = hooks_obj.entry("Notification").or_insert_with(|| json!([]));
    if !notif.is_array() {
        *notif = json!([]);
    }
    let arr = notif.as_array_mut().unwrap();
    arr.retain(|e| !entry_is_ours(e));
    arr.push(our_entry(markers_dir));
    settings
}

/// Remove our Notification hook from a settings JSON value, preserving the rest.
pub fn merge_uninstall(mut settings: Value) -> Value {
    if let Some(arr) = settings
        .get_mut("hooks")
        .and_then(|h| h.get_mut("Notification"))
        .and_then(|n| n.as_array_mut())
    {
        arr.retain(|e| !entry_is_ours(e));
    }
    settings
}

pub fn is_installed(settings: &Value) -> bool {
    settings
        .get("hooks")
        .and_then(|h| h.get("Notification"))
        .and_then(|n| n.as_array())
        .map(|arr| arr.iter().any(entry_is_ours))
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn dir() -> PathBuf {
        PathBuf::from("/home/u/.local/share/abeoncode/notifications")
    }

    #[test]
    fn install_into_empty_settings_creates_structure() {
        let out = merge_install(json!({}), &dir());
        assert!(is_installed(&out));
    }

    #[test]
    fn install_preserves_other_keys_and_hooks() {
        let existing = json!({
            "model": "opus",
            "hooks": {
                "PreToolUse": [{ "hooks": [{ "type": "command", "command": "echo pre" }] }],
                "Notification": [{ "hooks": [{ "type": "command", "command": "echo other" }] }]
            }
        });
        let out = merge_install(existing, &dir());
        assert_eq!(out.get("model").unwrap().as_str(), Some("opus"));
        assert!(out.get("hooks").unwrap().get("PreToolUse").is_some());
        let notif = out["hooks"]["Notification"].as_array().unwrap();
        // the pre-existing "echo other" entry survives, ours is appended
        assert_eq!(notif.len(), 2);
        assert!(is_installed(&out));
    }

    #[test]
    fn install_is_idempotent() {
        let once = merge_install(json!({}), &dir());
        let twice = merge_install(once.clone(), &dir());
        let notif = twice["hooks"]["Notification"].as_array().unwrap();
        assert_eq!(notif.len(), 1);
    }

    #[test]
    fn uninstall_removes_only_ours() {
        let installed = merge_install(
            json!({ "hooks": { "Notification": [{ "hooks": [{ "type": "command", "command": "echo other" }] }] } }),
            &dir(),
        );
        let out = merge_uninstall(installed);
        let notif = out["hooks"]["Notification"].as_array().unwrap();
        assert_eq!(notif.len(), 1);
        assert!(!is_installed(&out));
        assert_eq!(notif[0]["hooks"][0]["command"].as_str(), Some("echo other"));
    }
}
```

- [ ] **Step 2: Uruchom testy**

Run: `cargo test --manifest-path src-tauri/Cargo.toml notifications::hook_installer`
Expected: 4 testy PASS.

- [ ] **Step 3: Dodaj I/O na poziomie pliku (czytanie/zapis atomowy)**

Dopisz w `src-tauri/src/notifications/hook_installer.rs` (nad blokiem `#[cfg(test)]`):

```rust
use crate::error::{AppError, AppResult};

fn settings_path() -> AppResult<std::path::PathBuf> {
    let home = dirs::home_dir().ok_or_else(|| AppError::Other("no home dir".into()))?;
    Ok(home.join(".claude").join("settings.json"))
}

fn read_settings(path: &Path) -> Value {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| json!({}))
}

fn write_settings(path: &Path, value: &Value) -> AppResult<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| AppError::Other(e.to_string()))?;
    }
    let tmp = path.with_extension("json.tmp");
    let text = serde_json::to_string_pretty(value).map_err(|e| AppError::Other(e.to_string()))?;
    std::fs::write(&tmp, text).map_err(|e| AppError::Other(e.to_string()))?;
    std::fs::rename(&tmp, path).map_err(|e| AppError::Other(e.to_string()))?;
    Ok(())
}

pub fn install(markers_dir: &Path) -> AppResult<()> {
    let path = settings_path()?;
    let merged = merge_install(read_settings(&path), markers_dir);
    write_settings(&path, &merged)
}

pub fn uninstall() -> AppResult<()> {
    let path = settings_path()?;
    let merged = merge_uninstall(read_settings(&path));
    write_settings(&path, &merged)
}

pub fn status() -> bool {
    settings_path().map(|p| is_installed(&read_settings(&p))).unwrap_or(false)
}
```

- [ ] **Step 4: Zweryfikuj kompilację i testy**

Run: `cargo test --manifest-path src-tauri/Cargo.toml notifications::hook_installer`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/notifications/hook_installer.rs
git commit -m "feat(desktop): install/uninstall Claude notification hook with merge"
```

---

## Task 5: Komendy Tauri i start watchera w setupie

`notifications_dir` to `<app_data_dir>/notifications`. Komendy operują na tym katalogu i na `~/.claude/settings.json`.

**Files:**
- Create: `src-tauri/src/commands/notifications.rs`
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/lib.rs` (rejestracja komend + start watchera w `.setup()`)

- [ ] **Step 1: Utwórz plik komend**

Utwórz `src-tauri/src/commands/notifications.rs`:

```rust
use tauri::{AppHandle, Manager};
use crate::error::{AppError, AppResult};
use crate::notifications::hook_installer;

/// `<app_data_dir>/notifications` — where the Claude hook drops marker files.
pub fn markers_dir(app: &AppHandle) -> AppResult<std::path::PathBuf> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Other(format!("app_data_dir: {e}")))?;
    Ok(base.join("notifications"))
}

#[tauri::command]
pub fn install_attention_hook(app: AppHandle) -> AppResult<()> {
    let dir = markers_dir(&app)?;
    hook_installer::install(&dir)
}

#[tauri::command]
pub fn uninstall_attention_hook() -> AppResult<()> {
    hook_installer::uninstall()
}

#[tauri::command]
pub fn attention_hook_status() -> bool {
    hook_installer::status()
}
```

- [ ] **Step 2: Zadeklaruj moduł komend**

W `src-tauri/src/commands/mod.rs` dodaj (zachowując porządek alfabetyczny istniejących `pub mod`):

```rust
pub mod notifications;
```

- [ ] **Step 3: Zarejestruj komendy i wystartuj watcher**

W `src-tauri/src/lib.rs` w `.setup(|app| { ... })` dodaj start watchera (po `init_remote_bridge`):

```rust
        .setup(|app| {
            crate::remote::startup::init_remote_bridge(app.handle().clone());
            if let Ok(dir) = crate::commands::notifications::markers_dir(app.handle()) {
                let watcher = crate::notifications::marker::AttentionWatcher::new(dir);
                watcher.start(app.handle().clone());
                app.manage(watcher);
            }
            Ok(())
        })
```

W `tauri::generate_handler![...]` dodaj (po `commands::remote::remote_pair_start,`):

```rust
            commands::notifications::install_attention_hook,
            commands::notifications::uninstall_attention_hook,
            commands::notifications::attention_hook_status,
```

- [ ] **Step 4: Zweryfikuj budowanie i testy backendu**

Run: `npm run test:rust`
Expected: kompiluje się, wszystkie testy PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands/notifications.rs src-tauri/src/commands/mod.rs src-tauri/src/lib.rs
git commit -m "feat(desktop): expose attention hook commands and start marker watcher"
```

---

## Task 6: Emisja sygnału heurystycznego z `SessionWatchers`

Gdy stan sesji zmienia się na `WaitingUser`/`WaitingTool`, oprócz istniejącego `session:{sid}:activity` emitujemy globalne `session-attention { reason: "heuristic" }`.

**Files:**
- Modify: `src-tauri/src/sessions/watcher.rs:142-155`

- [ ] **Step 1: Dodaj emisję w pętli zmian aktywności**

W `src-tauri/src/sessions/watcher.rs`, w bloku `for (sid, path) in activity_inputs { ... }` (obecnie linie ~143-154), wewnątrz `if changed_state { ... }` po istniejącym `app.emit(&format!("session:{sid}:activity"), ...)` dodaj:

```rust
            if changed_state {
                last.insert(sid.clone(), new_activity);
                let activity_json = serde_json::json!({ "activity": new_activity });
                let _ = app.emit(&format!("session:{sid}:activity"), &activity_json);
                if matches!(new_activity, SessionActivity::WaitingUser | SessionActivity::WaitingTool) {
                    crate::notifications::emit_attention(app, crate::notifications::AttentionEvent {
                        session_id: sid.clone(),
                        reason: "heuristic".to_string(),
                        message: None,
                    });
                }
                if let Some(b) = &bus {
                    b.publish(SessionBusEvent::Activity { session_id: sid.clone(), activity: new_activity });
                }
            }
```

(`SessionActivity` jest już importowane na górze pliku — `use crate::domain::{HistoryBlock, SessionActivity};`.)

- [ ] **Step 2: Zweryfikuj budowanie i testy**

Run: `npm run test:rust`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/sessions/watcher.rs
git commit -m "feat(desktop): emit heuristic attention event on waiting-state change"
```

---

## Task 7: Wrappery IPC i typy w `tauri.ts`

**Files:**
- Modify: `src/lib/tauri.ts`

- [ ] **Step 1: Dodaj typy zdarzenia attention**

W `src/lib/tauri.ts` dodaj po definicji `PairCode` (linia ~9):

```ts
export type AttentionReason = 'hook' | 'heuristic';
export type AttentionEvent = { sessionId: string; reason: AttentionReason; message: string | null };
```

- [ ] **Step 2: Dodaj wrappery do obiektu `tauri`**

W `src/lib/tauri.ts` w obiekcie `tauri` dodaj (po `remotePairStart: ...,`, przed zamykającym `}`):

```ts
  onSessionAttention: (cb: (e: AttentionEvent) => void): Promise<UnlistenFn> =>
    listen<AttentionEvent>('session-attention', e => cb(e.payload)),
  installAttentionHook: () => invoke<void>('install_attention_hook'),
  uninstallAttentionHook: () => invoke<void>('uninstall_attention_hook'),
  attentionHookStatus: () => invoke<boolean>('attention_hook_status'),
```

- [ ] **Step 3: Zweryfikuj typy**

Run: `npm run lint`
Expected: 0 błędów.

- [ ] **Step 4: Commit**

```bash
git add src/lib/tauri.ts
git commit -m "feat(desktop): add IPC wrappers for session attention"
```

---

## Task 8: Ikona dzwonka i mapowanie aktywności

**Files:**
- Modify: `src/components/shared/Icon.tsx:3-36`
- Modify: `src/lib/activity.ts:18-23`

- [ ] **Step 1: Dodaj ikonę `bell`**

W `src/components/shared/Icon.tsx` dodaj do obiektu `paths` (np. po `code:`):

```ts
  bell:     <g><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></g>,
```

- [ ] **Step 2: Zmień ikonę aktywności dla `waitingUser`**

W `src/lib/activity.ts` zmień mapowanie:

```ts
export const ACTIVITY_ICON: Record<SessionActivity, IconName> = {
  running:     'spinner',
  waitingUser: 'bell',
  waitingTool: 'pause',
  idle:        'dot',
};
```

- [ ] **Step 3: Zweryfikuj typy**

Run: `npm run lint`
Expected: 0 błędów (`'bell'` jest teraz poprawnym `IconName`).

- [ ] **Step 4: Commit**

```bash
git add src/components/shared/Icon.tsx src/lib/activity.ts
git commit -m "feat(desktop): add bell icon for waiting-user activity"
```

---

## Task 9: Stan `attentionSessions` w store sesji

**Files:**
- Modify: `src/store/sessionsSlice.ts`

- [ ] **Step 1: Rozszerz typ slice'u**

W `src/store/sessionsSlice.ts` w `export type SessionsSlice = { ... }` dodaj:

```ts
  attentionSessions: Set<string>;
  markAttention: (sessionId: string) => void;
  clearAttention: (sessionId: string) => void;
```

- [ ] **Step 2: Zainicjalizuj stan i akcje**

W `createSessionsSlice` dodaj inicjalizację (po `sessionsByProject: {},`):

```ts
  attentionSessions: new Set<string>(),
  markAttention: (sessionId) => {
    const cur = get().attentionSessions;
    if (cur.has(sessionId)) return;
    const next = new Set(cur);
    next.add(sessionId);
    set({ attentionSessions: next });
  },
  clearAttention: (sessionId) => {
    const cur = get().attentionSessions;
    if (!cur.has(sessionId)) return;
    const next = new Set(cur);
    next.delete(sessionId);
    set({ attentionSessions: next });
  },
```

- [ ] **Step 3: Wyczyść dzwonek, gdy sesja wraca do pracy**

W `patchActivity`, gdy `activity === 'running'`, wyczyść attention. Na początku ciała `patchActivity` (przed `const current = ...`) dodaj:

```ts
  patchActivity: (sessionId, activity) => {
    if (activity === 'running') get().clearAttention(sessionId);
    const current = get().sessionsByProject;
```

- [ ] **Step 4: Zweryfikuj typy**

Run: `npm run lint`
Expected: 0 błędów.

- [ ] **Step 5: Commit**

```bash
git add src/store/sessionsSlice.ts
git commit -m "feat(desktop): track sessions awaiting user attention in store"
```

---

## Task 10: Polityka powiadomień (czysta funkcja + testy)

**Files:**
- Create: `src/lib/attention.ts`
- Create: `src/lib/attention.test.ts`

- [ ] **Step 1: Napisz test polityki**

Utwórz `src/lib/attention.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { triggerMatches, shouldNotify } from './attention';

describe('triggerMatches', () => {
  it('turnEnd matches heuristic only', () => {
    expect(triggerMatches('turnEnd', 'heuristic')).toBe(true);
    expect(triggerMatches('turnEnd', 'hook')).toBe(false);
  });
  it('questionsOnly matches hook only', () => {
    expect(triggerMatches('questionsOnly', 'hook')).toBe(true);
    expect(triggerMatches('questionsOnly', 'heuristic')).toBe(false);
  });
  it('both matches either', () => {
    expect(triggerMatches('both', 'hook')).toBe(true);
    expect(triggerMatches('both', 'heuristic')).toBe(true);
  });
});

describe('shouldNotify', () => {
  it('suppressed when notifications disabled', () => {
    expect(shouldNotify({ enabled: false, trigger: 'both', reason: 'hook', isActiveFocused: false })).toBe(false);
  });
  it('suppressed when looking at the session', () => {
    expect(shouldNotify({ enabled: true, trigger: 'both', reason: 'hook', isActiveFocused: true })).toBe(false);
  });
  it('suppressed when trigger does not match reason', () => {
    expect(shouldNotify({ enabled: true, trigger: 'questionsOnly', reason: 'heuristic', isActiveFocused: false })).toBe(false);
  });
  it('fires when enabled, not looking, trigger matches', () => {
    expect(shouldNotify({ enabled: true, trigger: 'both', reason: 'heuristic', isActiveFocused: false })).toBe(true);
  });
});
```

- [ ] **Step 2: Uruchom test — powinien się nie skompilować/failować (brak modułu)**

Run: `npm test -- attention`
Expected: FAIL ("Cannot find module './attention'").

- [ ] **Step 3: Zaimplementuj politykę**

Utwórz `src/lib/attention.ts`:

```ts
import type { AttentionReason } from './tauri';

export type NotificationTrigger = 'turnEnd' | 'questionsOnly' | 'both';

export function triggerMatches(trigger: NotificationTrigger, reason: AttentionReason): boolean {
  if (trigger === 'both') return true;
  if (trigger === 'turnEnd') return reason === 'heuristic';
  return reason === 'hook';
}

export function shouldNotify(args: {
  enabled: boolean;
  trigger: NotificationTrigger;
  reason: AttentionReason;
  isActiveFocused: boolean;
}): boolean {
  const { enabled, trigger, reason, isActiveFocused } = args;
  if (!enabled) return false;
  if (isActiveFocused) return false;
  return triggerMatches(trigger, reason);
}
```

- [ ] **Step 4: Uruchom test**

Run: `npm test -- attention`
Expected: wszystkie testy PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/attention.ts src/lib/attention.test.ts
git commit -m "feat(desktop): add notification policy helpers with tests"
```

---

## Task 11: Ustawienia powiadomień w store i persistencji

**Files:**
- Modify: `src/store/settingsSlice.ts`
- Modify: `src/store/index.ts`

- [ ] **Step 1: Dodaj pola i settery do slice'u**

W `src/store/settingsSlice.ts`:

a) Dodaj import typu na górze:

```ts
import type { NotificationTrigger } from '../lib/attention';
```

b) W `export type SettingsSlice = { ... }` dodaj (po `historyViewMode: HistoryViewMode;`):

```ts
  notificationsEnabled: boolean;
  notificationTrigger: NotificationTrigger;
```

c) W tym samym typie dodaj settery (po `setHistoryViewMode: ...;`):

```ts
  setNotificationsEnabled: (v: boolean) => void;
  setNotificationTrigger: (t: NotificationTrigger) => void;
```

d) W `createSettingsSlice` dodaj wartości domyślne (po `historyViewMode: 'full',`):

```ts
  notificationsEnabled: true,
  notificationTrigger: 'both',
```

e) Dodaj implementacje setterów (po `setHistoryViewMode: ...,`):

```ts
  setNotificationsEnabled: (notificationsEnabled) => set({ notificationsEnabled }),
  setNotificationTrigger: (notificationTrigger) => set({ notificationTrigger }),
```

- [ ] **Step 2: Dodaj persistencję dwóch kluczy**

W `src/store/index.ts`:

a) W typie `Persisted` dodaj (po `historyViewMode?: ...;`):

```ts
  notificationsEnabled?: boolean;
  notificationTrigger?: 'turnEnd' | 'questionsOnly' | 'both';
```

b) W `PERSISTED_KEYS` dodaj (po `'historyViewMode',`):

```ts
  'notificationsEnabled',
  'notificationTrigger',
```

c) W `pickPersistedFields` dodaj (po `historyViewMode: state.historyViewMode,`):

```ts
    notificationsEnabled: state.notificationsEnabled,
    notificationTrigger: state.notificationTrigger,
```

d) W `serializeValue`, w `case` dla booleanów dopisz `notificationsEnabled`:

```ts
    case 'skipPermissions':
    case 'remoteBridgeEnabled':
    case 'allowRemoteSpawn':
    case 'notificationsEnabled':
      return value ? 'true' : 'false';
```

e) W `deserializeValue`, analogicznie:

```ts
    case 'skipPermissions':
    case 'remoteBridgeEnabled':
    case 'allowRemoteSpawn':
    case 'notificationsEnabled':
      return raw === 'true';
```

f) W `applyPersistedToState` dodaj (po bloku `historyViewMode`):

```ts
  if (p.notificationsEnabled !== undefined) patch.notificationsEnabled = p.notificationsEnabled;
  if (p.notificationTrigger === 'turnEnd' || p.notificationTrigger === 'questionsOnly' || p.notificationTrigger === 'both') {
    patch.notificationTrigger = p.notificationTrigger;
  }
```

- [ ] **Step 3: Zweryfikuj typy i testy**

Run: `npm run lint && npm test -- store`
Expected: 0 błędów lint; testy store PASS.

- [ ] **Step 4: Commit**

```bash
git add src/store/settingsSlice.ts src/store/index.ts
git commit -m "feat(desktop): persist notification settings"
```

---

## Task 12: Render dzwonka w zakładce i na liście sesji

**Files:**
- Modify: `src/components/center/TabBar.tsx:17-25`
- Modify: `src/components/sidebar/SessionItem.tsx:1-31`

- [ ] **Step 1: Dzwonek w `TabActivityDot`**

W `src/components/center/TabBar.tsx` dodaj import `Icon` na górze (po istniejących importach komponentów):

```ts
import { Icon } from '../shared/Icon';
```

Zastąp `TabActivityDot` (linie 17-25):

```tsx
export function TabActivityDot({ tabId, sessionId }: { tabId: string; sessionId: string }) {
  const activity = useStore(selectSessionActivity(tabId, sessionId));
  const attention = useStore(s => {
    const tab = s.tabs.find(t => t.id === tabId);
    const realId = (tab?.kind === 'session' && tab.linkedSessionId) || sessionId;
    return s.attentionSessions.has(realId);
  });
  if (attention) {
    return <Icon name="bell" className="mr-1.5 w-3 h-3 text-accent" title="Czeka na Twoją odpowiedź" />;
  }
  return (
    <span
      className={`mr-1.5 w-[5px] h-[5px] rounded-full ${ACTIVITY_DOT[activity]}`}
      title={ACTIVITY_LABEL[activity]}
    />
  );
}
```

(`Icon` przyjmuje `...rest` przekazywane do `<svg>`, więc `title` zadziała jako atrybut SVG.)

- [ ] **Step 2: Dzwonek w `SessionItem`**

W `src/components/sidebar/SessionItem.tsx` dodaj import `Icon`:

```ts
import { Icon } from '../shared/Icon';
```

Zastąp znacznik kropki (linie 28-31) warunkiem:

```tsx
      {useStore(s => s.attentionSessions.has(session.id)) ? (
        <Icon name="bell" className="w-3 h-3 shrink-0 text-accent" title="Czeka na Twoją odpowiedź" />
      ) : (
        <span
          className={`w-[5px] h-[5px] rounded-full shrink-0 ${ACTIVITY_DOT[session.activity]}`}
          title={ACTIVITY_LABEL[session.activity]}
        />
      )}
```

- [ ] **Step 3: Zweryfikuj typy i testy**

Run: `npm run lint && npm test -- SessionItem`
Expected: 0 błędów lint; istniejące testy `SessionItem` PASS.

- [ ] **Step 4: Commit**

```bash
git add src/components/center/TabBar.tsx src/components/sidebar/SessionItem.tsx
git commit -m "feat(desktop): show bell icon for sessions awaiting attention"
```

---

## Task 13: Globalny listener + powiadomienie + klik-fokus + czyszczenie

`AppShell` montuje się raz w głównym oknie. Tu podpinamy globalny nasłuch `session-attention`, stosujemy politykę, wysyłamy powiadomienie systemowe i obsługujemy klik (fokus okna + otwarcie zakładki sesji). Dodatkowo czyścimy dzwonek, gdy użytkownik aktywuje zakładkę danej sesji w sfokusowanym oknie.

**Files:**
- Modify: `src/components/layout/AppShell.tsx`

- [ ] **Step 1: Dodaj importy**

W `src/components/layout/AppShell.tsx` dodaj na górze:

```ts
import { getCurrentWindow } from '@tauri-apps/api/window';
import { isPermissionGranted, requestPermission, sendNotification, onAction } from '@tauri-apps/plugin-notification';
import { shouldNotify } from '../../lib/attention';
import type { AttentionEvent } from '../../lib/tauri';
```

- [ ] **Step 2: Dodaj efekt nasłuchu attention**

W komponencie `AppShell`, obok istniejących `useEffect`, dodaj nowy efekt. Helper `resolveSession` szuka sesji w `sessionsByProject` po realnym id; zwraca dane potrzebne do otwarcia zakładki.

```tsx
  useEffect(() => {
    let unlistenEvent: (() => void) | null = null;
    let unlistenAction: (() => void) | null = null;
    // Most-recently notified session, used by the (Linux-flaky) click handler.
    let lastNotified: { sessionId: string; projectId: number; title: string } | null = null;

    const resolveSession = (sessionId: string) => {
      const state = useStore.getState();
      for (const bucket of Object.values(state.sessionsByProject)) {
        const found = bucket.items.find(s => s.id === sessionId);
        if (found) return { projectId: found.projectId, title: found.title };
      }
      return null;
    };

    const focusSession = (target: { sessionId: string; projectId: number; title: string }) => {
      const win = getCurrentWindow();
      void win.unminimize().then(() => win.show()).then(() => win.setFocus());
      useStore.getState().openSessionTab(target.projectId, target.sessionId, target.title);
      useStore.getState().clearAttention(target.sessionId);
    };

    const handle = (e: AttentionEvent) => {
      const state = useStore.getState();
      const activeTab = state.tabs.find(t => t.id === state.activeTabId);
      const activeSessionId = activeTab?.kind === 'session'
        ? (activeTab.linkedSessionId ?? activeTab.sessionId)
        : null;
      const isActiveFocused = document.hasFocus() && activeSessionId === e.sessionId;

      // Looking right at it → nothing to flag.
      if (isActiveFocused) return;

      state.markAttention(e.sessionId);

      if (!shouldNotify({
        enabled: state.notificationsEnabled,
        trigger: state.notificationTrigger,
        reason: e.reason,
        isActiveFocused,
      })) return;

      const resolved = resolveSession(e.sessionId);
      const title = resolved?.title ?? 'Sesja';
      if (resolved) lastNotified = { sessionId: e.sessionId, projectId: resolved.projectId, title };

      void (async () => {
        let granted = await isPermissionGranted();
        if (!granted) granted = (await requestPermission()) === 'granted';
        if (!granted) return;
        sendNotification({
          title: 'AbeonCode — sesja czeka',
          body: e.message ?? `„${title}” czeka na Twoją odpowiedź`,
        });
      })();
    };

    tauri.onSessionAttention(handle).then(fn => { unlistenEvent = fn; });
    onAction(() => { if (lastNotified) focusSession(lastNotified); })
      .then(fn => { unlistenAction = fn; })
      .catch(() => { /* onAction unsupported on this platform — bell icon is the fallback */ });

    return () => {
      if (unlistenEvent) unlistenEvent();
      if (unlistenAction) unlistenAction();
    };
  }, []);
```

- [ ] **Step 3: Czyść dzwonek przy aktywacji zakładki w sfokusowanym oknie**

Dodaj kolejny efekt zależny od `activeTabId`:

```tsx
  useEffect(() => {
    if (!document.hasFocus()) return;
    const state = useStore.getState();
    const activeTab = state.tabs.find(t => t.id === state.activeTabId);
    if (activeTab?.kind === 'session') {
      state.clearAttention(activeTab.linkedSessionId ?? activeTab.sessionId);
    }
  }, [activeTabId]);
```

(`activeTabId` jest już pobierane w komponencie przez `useStore(s => s.activeTabId)`.)

- [ ] **Step 4: Zweryfikuj typy**

Run: `npm run lint`
Expected: 0 błędów.

- [ ] **Step 5: Commit**

```bash
git add src/components/layout/AppShell.tsx
git commit -m "feat(desktop): notify and focus on session attention events"
```

---

## Task 14: Sekcja „Powiadomienia” w ustawieniach

**Files:**
- Modify: `src/components/dialogs/SettingsDialog.tsx`

- [ ] **Step 1: Dodaj komponent sekcji**

W `src/components/dialogs/SettingsDialog.tsx` dodaj nowy komponent (np. nad `function GeneralTab()`), korzystający z istniejącego stylu pól. Przycisk instalacji hooka ma `ConfirmDialog`-podobne potwierdzenie; tu używamy prostego `window.confirm` zastąpionego inline stanem — ale dla spójności z resztą aplikacji użyjemy istniejącego `ConfirmDialog`.

Dodaj import na górze pliku:

```ts
import { ConfirmDialog } from './ConfirmDialog';
import type { NotificationTrigger } from '../../lib/attention';
```

Dodaj komponent:

```tsx
const TRIGGER_OPTIONS: { value: NotificationTrigger; label: string }[] = [
  { value: 'turnEnd', label: 'Każde zakończenie tury' },
  { value: 'questionsOnly', label: 'Tylko pytania / prośby o uprawnienie' },
  { value: 'both', label: 'Oba' },
];

function NotificationsSection() {
  const enabled = useStore(s => s.notificationsEnabled);
  const setEnabled = useStore(s => s.setNotificationsEnabled);
  const trigger = useStore(s => s.notificationTrigger);
  const setTrigger = useStore(s => s.setNotificationTrigger);
  const [hookInstalled, setHookInstalled] = useState<boolean | null>(null);
  const [confirmInstall, setConfirmInstall] = useState(false);

  useEffect(() => {
    tauri.attentionHookStatus().then(setHookInstalled).catch(() => setHookInstalled(null));
  }, []);

  const doInstall = () => {
    tauri.installAttentionHook()
      .then(() => setHookInstalled(true))
      .catch(err => console.error('[notifications] install hook failed', err))
      .finally(() => setConfirmInstall(false));
  };

  const doUninstall = () => {
    tauri.uninstallAttentionHook()
      .then(() => setHookInstalled(false))
      .catch(err => console.error('[notifications] uninstall hook failed', err));
  };

  return (
    <div className="space-y-3">
      <h3 className="text-[12px] font-semibold text-fg">Powiadomienia</h3>

      <label className="flex items-center gap-2 text-[12px] cursor-pointer">
        <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} />
        Powiadomienia systemowe, gdy sesja czeka na Ciebie
      </label>

      <div className="flex items-center gap-2 text-[12px]">
        <span className="text-muted">Wyzwalaj na:</span>
        <select
          value={trigger}
          onChange={e => setTrigger(e.target.value as NotificationTrigger)}
          disabled={!enabled}
          className="bg-bg border border-border rounded px-2 py-1 text-[12px]"
        >
          {TRIGGER_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </div>

      <div className="flex items-center gap-2 text-[12px]">
        <span className="text-muted">Hook pytań Claude Code:</span>
        {hookInstalled === null && <span className="text-muted">—</span>}
        {hookInstalled === true && (
          <>
            <span className="text-success">zainstalowany</span>
            <button onClick={doUninstall} className="text-muted hover:text-danger underline">usuń</button>
          </>
        )}
        {hookInstalled === false && (
          <button onClick={() => setConfirmInstall(true)} className="text-accent underline">
            Zainstaluj
          </button>
        )}
      </div>
      <p className="text-[11px] text-muted">
        Tryb „tylko pytania” wymaga hooka. Instalacja dopisuje wpis do
        <code className="mx-1">~/.claude/settings.json</code> (Twoje istniejące hooki zostają nienaruszone).
      </p>

      {confirmInstall && (
        <ConfirmDialog
          title="Zainstalować hook Claude Code?"
          message="AbeonCode dopisze wpis hooka Notification do ~/.claude/settings.json. Istniejące hooki nie zostaną zmienione."
          onCancel={() => setConfirmInstall(false)}
          onConfirm={doInstall}
        />
      )}
    </div>
  );
}
```

- [ ] **Step 2: Osadź sekcję w zakładce „Ogólne”**

W `GeneralTab` (w `SettingsDialog.tsx`) dodaj `<NotificationsSection />` w sensownym miejscu listy sekcji (np. po sekcji motywu/displayName, przed sekcją remote). Wstaw jako osobny blok:

```tsx
      <NotificationsSection />
```

- [ ] **Step 3: Zweryfikuj typy i testy**

Run: `npm run lint && npm test`
Expected: 0 błędów lint; wszystkie testy PASS.

- [ ] **Step 4: Commit**

```bash
git add src/components/dialogs/SettingsDialog.tsx
git commit -m "feat(desktop): add notifications section to settings"
```

---

## Task 15: Weryfikacja end-to-end (ręczna) i finalne sprawdzenie

**Files:** brak zmian — weryfikacja.

- [ ] **Step 1: Pełny lint + testy**

Run: `npm run lint && npm test && npm run test:rust`
Expected: wszystko PASS, 0 błędów.

- [ ] **Step 2: Uruchom aplikację i przejdź scenariusz heurystyczny**

Run: `npm run tauri dev`

Scenariusz:
1. Otwórz sesję Claude (tab terminala). Zadaj polecenie i poczekaj aż Claude skończy turę.
2. Przełącz się na inną zakładkę / odznacz fokus okna.
3. Oczekiwane: powiadomienie systemowe „sesja czeka”, dzwonek w zakładce i na liście sesji.
4. Kliknięcie powiadomienia (jeśli DE wspiera) lub kliknięcie zakładki → fokus sesji, dzwonek znika.

- [ ] **Step 3: Przejdź scenariusz hooka**

1. W Ustawieniach → Ogólne → Powiadomienia kliknij „Zainstaluj”, potwierdź. Status → „zainstalowany”.
2. Ustaw tryb „Tylko pytania / prośby o uprawnienie”.
3. W sesji Claude wywołaj akcję wymagającą zgody (np. polecenie spoza allowlisty), tak by pojawił się prompt uprawnień.
4. Oczekiwane: marker pojawia się w `<app_data>/notifications/`, znika po odczycie; powiadomienie + dzwonek na właściwej sesji.
5. Sprawdź `~/.claude/settings.json` — wpis hooka obecny, pozostałe klucze nienaruszone. Kliknij „usuń” → wpis znika.

- [ ] **Step 4: Commit (jeśli były poprawki)**

```bash
git add -A
git commit -m "fix(desktop): polish session attention notifications after e2e"
```

---

## Self-review

**Spec coverage:**
- Dwa źródła sygnału → Task 3 (hook/marker) + Task 6 (heurystyka). ✓
- Transport plik-marker + watcher → Task 3 + Task 5. ✓
- Auto-instalacja hooka z merge + zgodą → Task 4 + Task 14. ✓
- Konfigurowalny trigger (`turnEnd`/`questionsOnly`/`both`) → Task 10 + Task 11 + Task 14. ✓
- Powiadomienie systemowe + klik-fokus → Task 1 (plugin) + Task 13. ✓
- Odrębna ikona dzwonka w zakładce i na liście → Task 8 + Task 12. ✓
- Dzwonek zawsze, powiadomienie sterowane ustawieniem → Task 13 (`markAttention` przed bramką `shouldNotify`). ✓
- Anty-spam (emisja tylko na zmianę stanu + de-dup po sessionId) → Task 6 (`changed_state`) + Task 9 (`markAttention` no-op gdy już jest). ✓
- Fallback kliku na Linuksie → Task 13 (`onAction().catch(...)`, dzwonek jako fallback). ✓
- Czyszczenie dzwonka (aktywacja zakładki / powrót do running) → Task 9 (running) + Task 13 (aktywacja). ✓

**Type consistency:**
- `AttentionEvent` (Rust camelCase) ↔ `AttentionEvent` (TS `sessionId/reason/message`). ✓
- `reason` wartości `"hook"`/`"heuristic"` spójne backend↔`AttentionReason`. ✓
- `NotificationTrigger` zdefiniowany w `lib/attention.ts`, używany w settings/store/UI. ✓
- `markAttention`/`clearAttention`/`attentionSessions` spójne w Task 9/12/13. ✓
- `installAttentionHook`/`uninstallAttentionHook`/`attentionHookStatus` spójne w tauri.ts (Task 7) ↔ komendy Rust (Task 5) ↔ UI (Task 14). ✓

**Placeholder scan:** brak TBD/TODO; każdy krok kodu zawiera pełną treść.
