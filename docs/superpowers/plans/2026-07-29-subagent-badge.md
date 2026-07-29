# Odznaka subagentów — plan wdrożenia

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pokazać przy sesji odznakę z liczbą pracujących subagentów, rozwijaną listę wszystkich agentów sesji oraz transcript pracy każdego z nich, a przy okazji przestać raportować sesję czekającą na własne agenty jako czekającą na użytkownika.

**Architecture:** Backend czyta katalog `~/.claude/projects/<encoded>/<sessionId>/subagents/` i rozstrzyga status agenta z trzech źródeł (plik `.meta.json`, znacznik `<task-notification>` w głównym logu, mtime pliku agenta). Liczniki jadą istniejącym pollingiem w `SessionMeta`; pełna lista i transcript pobierane są nowymi komendami dopiero po interakcji. Transcript renderuje się jako warstwa nad zamontowanym widokiem taba, żeby nie odmontować `TerminalView` i nie zabić PTY.

**Tech Stack:** Rust (Tauri 2, serde_json, ts-rs, notify, tempfile w testach), TypeScript (React 19, Zustand 5, react-virtuoso, Vitest + Testing Library).

**Spec:** `docs/superpowers/specs/2026-07-29-subagent-badge-design.md`

## Global Constraints

- Identyfikatory w kodzie wyłącznie po angielsku; teksty UI po polsku.
- Bez komentarzy w kodzie — jeśli coś wymaga wyjaśnienia, trafia do `docs/`.
- Commity w Conventional Commits 1.0.0, po polsku, bez trailera co-author.
- Każda komenda Rust ma odpowiadający typowany wrapper w `src/lib/tauri.ts`; komponenty nigdy nie wołają `invoke` bezpośrednio.
- Typy przechodzące przez IPC deklarowane w Rust z `#[derive(TS)]` i `#[ts(export, export_to = "../../src/types/")]`; struktury z ts-rs mieszkają w `src-tauri/src/domain/`.
- `ts-rs` generuje pliki `src/types/*.ts` podczas `cargo test`, **nie** `cargo build`. Każdy nowy typ trzeba dodatkowo ręcznie re-eksportować w `src/types/index.ts`.
- `npm run lint` (czyli `tsc -b --noEmit`) musi kończyć się zerem błędów.
- `AGENT_STALE_MS = 120_000` — próg uznania milczącego agenta za przerwanego.
- Nazwa narzędzia uruchamiającego agenta (`Agent`, historycznie `Task`) nie jest używana do detekcji — źródłem prawdy są pliki `.meta.json`.

## File Structure

**Rust — nowe:**
- `src-tauri/src/domain/subagent.rs` — `SubagentInfo`, `SubagentStatus` (ts-rs).
- `src-tauri/src/sessions/subagents.rs` — cała logika detekcji: ścieżki, parsowanie notyfikacji, skan katalogu, liczenie.

**Rust — modyfikowane:**
- `src-tauri/src/domain/mod.rs` — re-eksport nowych typów.
- `src-tauri/src/domain/session.rs` — `SessionMeta` + `running_agents`, `total_agents`.
- `src-tauri/src/sessions/mod.rs` — rejestracja modułu `subagents`.
- `src-tauri/src/sessions/activity.rs` — wariant wyliczania aktywności świadomy agentów.
- `src-tauri/src/sessions/reader.rs` — wypełnianie nowych pól, `read_history_at()`.
- `src-tauri/src/sessions/watcher.rs` — watch rekursywny + zdarzenie o zmianie agentów.
- `src-tauri/src/commands/sessions.rs` — `list_subagents`, `read_subagent_history`.
- `src-tauri/src/validation.rs` — `validate_agent_id`.
- `src-tauri/src/lib.rs` — rejestracja komend.

**Frontend — nowe:**
- `src/components/sidebar/SubagentBadge.tsx` — odznaka `🤖 N`.
- `src/components/sidebar/SubagentList.tsx` — rozwinięta lista agentów.
- `src/components/history/SubagentView.tsx` — transcript agenta.
- `src/components/history/SubagentHeader.tsx` — pasek powrotu.

**Frontend — modyfikowane:**
- `src/lib/tauri.ts`, `src/types/index.ts`, `src/store/sessionsSlice.ts`, `src/store/tabsSlice.ts`,
  `src/components/sidebar/SessionItem.tsx`, `src/components/sidebar/ActiveSessionsPanel.tsx`,
  `src/components/center/TabContent.tsx`.

Kolejność zadań jest kolejnością zależności: 1 → 2 → 3 → 4 → (5, 6) → 7. Zadania 5 i 6 są względem siebie niezależne.

---

### Task 1: Moduł detekcji subagentów

Czysta logika bez dotykania czegokolwiek istniejącego — moduł da się przetestować w izolacji, zanim ktokolwiek go zawoła.

**Files:**
- Create: `DesktopApp/src-tauri/src/domain/subagent.rs`
- Create: `DesktopApp/src-tauri/src/sessions/subagents.rs`
- Modify: `DesktopApp/src-tauri/src/domain/mod.rs`
- Modify: `DesktopApp/src-tauri/src/sessions/mod.rs`
- Test: w pliku `subagents.rs` (moduł `#[cfg(test)]`, zgodnie z konwencją projektu)

**Interfaces:**
- Produces:
  - `domain::SubagentStatus` = `Running | Completed | Stale`
  - `domain::SubagentInfo { agent_id: String, agent_type: String, description: String, status: SubagentStatus, started_at: i64, ended_at: Option<i64> }`
  - `sessions::subagents::AGENT_STALE_MS: i64`
  - `sessions::subagents::subagents_dir(session_path: &Path) -> PathBuf`
  - `sessions::subagents::collect_completed_ids(lines: &[String]) -> HashSet<String>`
  - `sessions::subagents::scan_dir(dir: &Path, completed: &HashSet<String>, now_ms: i64) -> Vec<SubagentInfo>`
  - `sessions::subagents::count_running(list: &[SubagentInfo]) -> u32`

- [ ] **Step 1: Utwórz typy domenowe**

Plik `DesktopApp/src-tauri/src/domain/subagent.rs`:

```rust
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/types/")]
#[serde(rename_all = "camelCase")]
pub enum SubagentStatus {
    Running,
    Completed,
    Stale,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/types/")]
#[serde(rename_all = "camelCase")]
pub struct SubagentInfo {
    pub agent_id: String,
    pub agent_type: String,
    pub description: String,
    pub status: SubagentStatus,
    #[ts(type = "number")]
    pub started_at: i64,
    #[ts(type = "number | null")]
    pub ended_at: Option<i64>,
}
```

W `DesktopApp/src-tauri/src/domain/mod.rs` dopisz w obu blokach, zgodnie z tamtejszym wzorcem (`pub mod` na górze, `pub use ...::*` niżej):

```rust
pub mod subagent;
```

```rust
pub use subagent::*;
```

- [ ] **Step 2: Napisz testy modułu detekcji**

Plik `DesktopApp/src-tauri/src/sessions/subagents.rs` — na razie tylko testy plus nagłówek importów:

```rust
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use crate::domain::{SubagentInfo, SubagentStatus};

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn write_agent(dir: &Path, id: &str, agent_type: &str, description: &str) -> i64 {
        std::fs::create_dir_all(dir).unwrap();
        let meta = dir.join(format!("agent-{id}.meta.json"));
        std::fs::write(
            &meta,
            format!(
                r#"{{"agentType":"{agent_type}","description":"{description}","toolUseId":"toolu_x","spawnDepth":1}}"#
            ),
        )
        .unwrap();
        std::fs::write(dir.join(format!("agent-{id}.jsonl")), "{\"type\":\"user\"}\n").unwrap();
        meta.metadata()
            .unwrap()
            .modified()
            .unwrap()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64
    }

    #[test]
    fn subagents_dir_is_sibling_directory_of_session_file() {
        let p = Path::new("/home/u/.claude/projects/enc/abc-123.jsonl");
        assert_eq!(
            subagents_dir(p),
            Path::new("/home/u/.claude/projects/enc/abc-123/subagents")
        );
    }

    #[test]
    fn collects_task_id_from_notification_line() {
        let lines = vec![
            r#"{"type":"user","message":{"content":"<task-notification>\n<task-id>af01e388</task-id>\n<tool-use-id>toolu_1</tool-use-id>\n</task-notification>"}}"#.to_string(),
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"ok"}]}}"#.to_string(),
        ];
        let ids = collect_completed_ids(&lines);
        assert!(ids.contains("af01e388"));
        assert_eq!(ids.len(), 1);
    }

    #[test]
    fn ignores_notification_shaped_text_from_assistant() {
        let lines = vec![
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"<task-notification><task-id>fake</task-id></task-notification>"}]}}"#.to_string(),
        ];
        assert!(collect_completed_ids(&lines).is_empty());
    }

    #[test]
    fn agent_without_notification_and_fresh_log_is_running() {
        let td = TempDir::new().unwrap();
        let dir = td.path().join("subagents");
        let started = write_agent(&dir, "a1", "Explore", "Znajdz skroty");
        let list = scan_dir(&dir, &HashSet::new(), started + 1_000);
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].status, SubagentStatus::Running);
        assert_eq!(list[0].agent_type, "Explore");
        assert_eq!(list[0].description, "Znajdz skroty");
        assert_eq!(list[0].ended_at, None);
    }

    #[test]
    fn agent_with_notification_is_completed() {
        let td = TempDir::new().unwrap();
        let dir = td.path().join("subagents");
        let started = write_agent(&dir, "a1", "Explore", "x");
        let completed: HashSet<String> = ["a1".to_string()].into_iter().collect();
        let list = scan_dir(&dir, &completed, started + 1_000);
        assert_eq!(list[0].status, SubagentStatus::Completed);
        assert!(list[0].ended_at.is_some());
    }

    #[test]
    fn silent_agent_past_threshold_is_stale() {
        let td = TempDir::new().unwrap();
        let dir = td.path().join("subagents");
        let started = write_agent(&dir, "a1", "Explore", "x");
        let list = scan_dir(&dir, &HashSet::new(), started + AGENT_STALE_MS + 1_000);
        assert_eq!(list[0].status, SubagentStatus::Stale);
    }

    #[test]
    fn missing_directory_yields_empty_list() {
        let td = TempDir::new().unwrap();
        let list = scan_dir(&td.path().join("nope"), &HashSet::new(), 0);
        assert!(list.is_empty());
    }

    #[test]
    fn counts_only_running_agents() {
        let td = TempDir::new().unwrap();
        let dir = td.path().join("subagents");
        let started = write_agent(&dir, "a1", "Explore", "x");
        write_agent(&dir, "a2", "claude", "y");
        let completed: HashSet<String> = ["a2".to_string()].into_iter().collect();
        let list = scan_dir(&dir, &completed, started + 1_000);
        assert_eq!(list.len(), 2);
        assert_eq!(count_running(&list), 1);
    }
}
```

- [ ] **Step 3: Uruchom testy i potwierdź, że nie kompilują się z braku implementacji**

```bash
cd DesktopApp/src-tauri && cargo test subagents
```

Oczekiwane: błędy kompilacji `cannot find function subagents_dir` / `scan_dir` / `collect_completed_ids` / `count_running`.

- [ ] **Step 4: Zaimplementuj moduł**

W `DesktopApp/src-tauri/src/sessions/subagents.rs`, nad modułem testów:

```rust
pub const AGENT_STALE_MS: i64 = 120_000;

pub fn subagents_dir(session_path: &Path) -> PathBuf {
    let parent = session_path.parent().unwrap_or(Path::new(""));
    let stem = session_path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
    parent.join(stem).join("subagents")
}

fn mtime_ms(path: &Path) -> Option<i64> {
    path.metadata()
        .ok()?
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .map(|d| d.as_millis() as i64)
}

fn extract_task_id(s: &str) -> Option<String> {
    let start = s.find("<task-id>")? + "<task-id>".len();
    let rest = &s[start..];
    let end = rest.find("</task-id>")?;
    Some(rest[..end].trim().to_string())
}

pub fn collect_completed_ids(lines: &[String]) -> HashSet<String> {
    let mut out = HashSet::new();
    for line in lines {
        if !line.contains("<task-notification>") {
            continue;
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else { continue };
        if v.get("type").and_then(|t| t.as_str()) != Some("user") {
            continue;
        }
        let Some(text) = v.get("message").and_then(|m| m.get("content")).and_then(|c| c.as_str()) else { continue };
        if let Some(id) = extract_task_id(text) {
            out.insert(id);
        }
    }
    out
}

pub fn scan_dir(dir: &Path, completed: &HashSet<String>, now_ms: i64) -> Vec<SubagentInfo> {
    let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut out = Vec::new();
    for entry in entries.filter_map(|e| e.ok()) {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|s| s.to_str()) else { continue };
        let Some(agent_id) = name.strip_prefix("agent-").and_then(|s| s.strip_suffix(".meta.json")) else { continue };
        let Ok(text) = std::fs::read_to_string(&path) else { continue };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else { continue };

        let started_at = mtime_ms(&path).unwrap_or(0);
        let log_mtime = mtime_ms(&dir.join(format!("agent-{agent_id}.jsonl")));
        let last_seen = log_mtime.unwrap_or(started_at);

        let status = if completed.contains(agent_id) {
            SubagentStatus::Completed
        } else if now_ms - last_seen > AGENT_STALE_MS {
            SubagentStatus::Stale
        } else {
            SubagentStatus::Running
        };

        out.push(SubagentInfo {
            agent_id: agent_id.to_string(),
            agent_type: v.get("agentType").and_then(|x| x.as_str()).unwrap_or("agent").to_string(),
            description: v.get("description").and_then(|x| x.as_str()).unwrap_or("").to_string(),
            status,
            started_at,
            ended_at: match status {
                SubagentStatus::Running => None,
                _ => log_mtime,
            },
        });
    }
    out.sort_by_key(|s| s.started_at);
    out
}

pub fn count_running(list: &[SubagentInfo]) -> u32 {
    list.iter().filter(|s| s.status == SubagentStatus::Running).count() as u32
}
```

W `DesktopApp/src-tauri/src/sessions/mod.rs` dopisz `pub mod subagents;` obok istniejących deklaracji modułów.

- [ ] **Step 5: Uruchom testy i potwierdź, że przechodzą**

```bash
cd DesktopApp/src-tauri && cargo test subagents
```

Oczekiwane: wszystkie testy z `sessions::subagents::tests` na zielono.

- [ ] **Step 6: Commit**

```bash
git add DesktopApp/src-tauri/src/domain/subagent.rs DesktopApp/src-tauri/src/domain/mod.rs \
        DesktopApp/src-tauri/src/sessions/subagents.rs DesktopApp/src-tauri/src/sessions/mod.rs
git commit -m "feat(desktop): wykrywanie subagentów sesji z katalogu subagents"
```

---

### Task 2: Liczniki w `SessionMeta` i naprawa aktywności

**Files:**
- Modify: `DesktopApp/src-tauri/src/domain/session.rs:18-31`
- Modify: `DesktopApp/src-tauri/src/sessions/activity.rs:12-64`
- Modify: `DesktopApp/src-tauri/src/sessions/reader.rs:147-153, 244-250`
- Modify: `DesktopApp/src/store/sessionsSlice.test.ts`, `DesktopApp/src/lib/activeSessions.test.ts`, `DesktopApp/src/components/sidebar/SessionItem.test.tsx` (helpery budujące `SessionMeta`)
- Test: `DesktopApp/src-tauri/src/sessions/activity.rs` (istniejący moduł testów)

**Interfaces:**
- Consumes: `subagents::{subagents_dir, collect_completed_ids, scan_dir, count_running}` z Task 1.
- Produces:
  - `SessionMeta.running_agents: u32`, `SessionMeta.total_agents: u32` (w TS: `runningAgents`, `totalAgents`)
  - `activity::compute_activity_with_agents(path: &Path, running_agents: u32, now_ms: i64) -> SessionActivity`
  - `reader::session_agent_counts(path: &Path, now_ms: i64) -> (u32, u32)`

- [ ] **Step 1: Napisz testy aktywności**

Dopisz w module testów `DesktopApp/src-tauri/src/sessions/activity.rs`:

```rust
    #[test]
    fn live_agents_force_running_despite_assistant_text() {
        let td = TempDir::new().unwrap();
        let (p, mtime) = write_with_mtime(&td, "s.jsonl",
            r#"{"type":"user","uuid":"u1","message":{"content":[{"type":"text","text":"hi"}]}}
{"type":"assistant","uuid":"a1","message":{"content":[{"type":"text","text":"uruchomilem agenty"}]}}"#);
        assert_eq!(compute_activity_with_agents(&p, 0, mtime + 60_000), SessionActivity::WaitingUser);
        assert_eq!(compute_activity_with_agents(&p, 2, mtime + 60_000), SessionActivity::Running);
    }

    #[test]
    fn live_agents_do_not_resurrect_a_day_old_session() {
        let td = TempDir::new().unwrap();
        let (p, mtime) = write_with_mtime(&td, "s.jsonl",
            r#"{"type":"assistant","uuid":"a1","message":{"content":[{"type":"text","text":"hi"}]}}"#);
        let twenty_five_hours = 25 * 60 * 60 * 1000;
        assert_eq!(compute_activity_with_agents(&p, 1, mtime + twenty_five_hours), SessionActivity::Idle);
    }
```

Drugi test pilnuje, żeby żywe agenty nie omijały twardego limitu `IDLE_HARD_CAP_MS` — inaczej zombie w katalogu trzymałby starą sesję w stanie „pracuje" na zawsze.

- [ ] **Step 2: Uruchom testy i potwierdź, że nie kompilują się**

```bash
cd DesktopApp/src-tauri && cargo test activity
```

Oczekiwane: `cannot find function compute_activity_with_agents`.

- [ ] **Step 3: Zaimplementuj wariant świadomy agentów**

W `DesktopApp/src-tauri/src/sessions/activity.rs` dopisz obok `compute_activity`:

```rust
pub fn compute_activity_with_agents(path: &Path, running_agents: u32, now_ms: i64) -> SessionActivity {
    let base = compute_activity(path, now_ms);
    if running_agents > 0 && base != SessionActivity::Idle {
        return SessionActivity::Running;
    }
    base
}
```

- [ ] **Step 4: Uruchom testy i potwierdź, że przechodzą**

```bash
cd DesktopApp/src-tauri && cargo test activity
```

Oczekiwane: PASS, w tym wszystkie dotychczasowe testy `compute_activity` bez zmian w asercjach.

- [ ] **Step 5: Rozszerz `SessionMeta`**

W `DesktopApp/src-tauri/src/domain/session.rs`, w strukturze `SessionMeta` po polu `provider`:

```rust
    #[ts(type = "number")]
    pub running_agents: u32,
    #[ts(type = "number")]
    pub total_agents: u32,
```

- [ ] **Step 6: Podłącz liczniki w readerze**

W `DesktopApp/src-tauri/src/sessions/reader.rs` dopisz funkcję pomocniczą:

```rust
pub fn session_agent_counts(path: &Path, now_ms: i64) -> (u32, u32) {
    let dir = crate::sessions::subagents::subagents_dir(path);
    if !dir.exists() {
        return (0, 0);
    }
    let lines = crate::sessions::activity::read_tail_lines(path).unwrap_or_default();
    let completed = crate::sessions::subagents::collect_completed_ids(&lines);
    let list = crate::sessions::subagents::scan_dir(&dir, &completed, now_ms);
    (crate::sessions::subagents::count_running(&list), list.len() as u32)
}
```

`read_tail_lines` jest dziś `pub(crate)` — to wystarczy, bo wywołanie jest w tej samej skrzyni.

Następnie w obu miejscach budujących `SessionMeta` (`reader.rs:147` i `reader.rs:244`) zamień blok tworzenia struktury tak, żeby liczył czas raz i użył go dwukrotnie. Dla `meta_for_file_fast`:

```rust
    let now = now_ms();
    let (running_agents, total_agents) = session_agent_counts(path, now);

    Ok(SessionMeta {
        id, project_id, title,
        message_count: approx_messages,
        last_modified, git_branch, cwd,
        activity: compute_activity_with_agents(path, running_agents, now),
        provider: Provider::Claude,
        running_agents,
        total_agents,
    })
```

Analogicznie w `read_history` (tam ścieżka nazywa się `path` i jest przekazywana przez referencję: `&path`). Zaktualizuj import na górze pliku, żeby obejmował `compute_activity_with_agents`.

- [ ] **Step 7: Uzupełnij konstruktory `SessionMeta` w Codeksie**

```bash
cd DesktopApp/src-tauri && cargo build 2>&1 | grep -A 3 "missing field"
```

Codex buduje własne `SessionMeta` w `sessions/codex/reader.rs`. Uzupełnij tam `running_agents: 0, total_agents: 0` — Codex nie ma subagentów i celowo zostaje poza zakresem.

- [ ] **Step 8: Wygeneruj typy TS i uzupełnij barrel**

```bash
cd DesktopApp/src-tauri && cargo test
```

Sprawdź, że powstały `DesktopApp/src/types/SubagentInfo.ts` i `SubagentStatus.ts` oraz że `SessionMeta.ts` ma nowe pola. Potem w `DesktopApp/src/types/index.ts` dopisz:

```ts
export type { SubagentInfo } from './SubagentInfo';
export type { SubagentStatus } from './SubagentStatus';
```

- [ ] **Step 9: Napraw fixtures w testach frontendu**

Trzy pliki budują literały `SessionMeta` i przestaną się kompilować. W każdym dopisz do obiektu `runningAgents: 0, totalAgents: 0`:
- `DesktopApp/src/store/sessionsSlice.test.ts`
- `DesktopApp/src/lib/activeSessions.test.ts`
- `DesktopApp/src/components/sidebar/SessionItem.test.tsx`

- [ ] **Step 10: Uruchom pełną weryfikację**

```bash
cd DesktopApp && npm run lint && npm test && npm run test:rust
```

Oczekiwane: zero błędów typów, testy frontendu i Rusta na zielono.

- [ ] **Step 11: Commit**

```bash
git add DesktopApp/src-tauri/src DesktopApp/src/types DesktopApp/src/store/sessionsSlice.test.ts \
        DesktopApp/src/lib/activeSessions.test.ts DesktopApp/src/components/sidebar/SessionItem.test.tsx
git commit -m "feat(desktop): liczniki subagentów w metadanych sesji i aktywność świadoma agentów"
```

---

### Task 3: Komendy IPC

**Files:**
- Modify: `DesktopApp/src-tauri/src/validation.rs`
- Modify: `DesktopApp/src-tauri/src/sessions/reader.rs:162-253`
- Modify: `DesktopApp/src-tauri/src/commands/sessions.rs`
- Modify: `DesktopApp/src-tauri/src/lib.rs`
- Test: `DesktopApp/src-tauri/src/validation.rs` (istniejący moduł testów)

**Interfaces:**
- Consumes: `subagents::{subagents_dir, collect_completed_ids, scan_dir}`, `reader::session_agent_counts`.
- Produces:
  - komenda `list_subagents(project_id: i64, session_id: String) -> Vec<SubagentInfo>`
  - komenda `read_subagent_history(project_id: i64, session_id: String, agent_id: String, limit: Option<usize>, before_uuid: Option<String>) -> SessionHistory`
  - `reader::read_history_at(project_id: i64, path: &Path, limit: Option<usize>, before_uuid: Option<&str>) -> AppResult<SessionHistory>`
  - `validation::validate_agent_id(id: &str) -> AppResult<()>`

- [ ] **Step 1: Napisz test walidacji identyfikatora agenta**

W module testów `DesktopApp/src-tauri/src/validation.rs`:

```rust
    #[test]
    fn rejects_agent_id_with_path_separators() {
        assert!(validate_agent_id("../../etc/passwd").is_err());
        assert!(validate_agent_id("a/b").is_err());
        assert!(validate_agent_id("af01e3886643f8b67").is_ok());
    }
```

- [ ] **Step 2: Uruchom test i potwierdź, że nie kompiluje się**

```bash
cd DesktopApp/src-tauri && cargo test validation
```

Oczekiwane: `cannot find function validate_agent_id`.

- [ ] **Step 3: Dodaj walidator**

W `DesktopApp/src-tauri/src/validation.rs`:

```rust
pub fn validate_agent_id(id: &str) -> AppResult<()> {
    adapt(abeon_remote_core::validation::validate_session_id(id))
}
```

Reguła jest ta sama co dla identyfikatora sesji (allowlist `[A-Za-z0-9_-]`, zakaz wiodącego `-`), a osobna nazwa trzyma intencję w miejscu wywołania.

- [ ] **Step 4: Uruchom test i potwierdź, że przechodzi**

```bash
cd DesktopApp/src-tauri && cargo test validation
```

- [ ] **Step 5: Wydziel `read_history_at`**

W `DesktopApp/src-tauri/src/sessions/reader.rs` zmień `read_history` tak, żeby całe ciało (od `let limit = ...` w dół) przeniosło się do nowej funkcji przyjmującej gotową ścieżkę, a `read_history` tylko rozwiązywało ścieżkę i delegowało:

```rust
pub fn read_history(
    project_id: i64,
    claude_dir: &Path,
    session_id: &str,
    limit: Option<usize>,
    before_uuid: Option<&str>,
) -> AppResult<SessionHistory> {
    let path = session_file(claude_dir, session_id)?;
    read_history_at(project_id, &path, limit, before_uuid)
}

pub fn read_history_at(
    project_id: i64,
    path: &Path,
    limit: Option<usize>,
    before_uuid: Option<&str>,
) -> AppResult<SessionHistory> {
    // dotychczasowe ciało read_history, z `&path` zamienionym na `path`
}
```

Uwaga: w `read_history_at` zostaje wyliczanie `SessionMeta` z Task 2. Dla pliku agenta liczniki wyjdą zerowe (agent nie ma własnego katalogu `subagents/`) i to jest poprawne.

- [ ] **Step 6: Dodaj obie komendy**

W `DesktopApp/src-tauri/src/commands/sessions.rs`, obok `read_session_history`:

```rust
#[tauri::command]
pub fn list_subagents(
    state: State<AppState>,
    project_id: i64,
    session_id: String,
) -> AppResult<Vec<crate::domain::SubagentInfo>> {
    crate::validation::validate_session_id(&session_id)?;
    let c = state.db.get()?;
    let proj = projects_repo::get(&c, project_id)?;
    let dir = session_dir(&proj)?;
    let path = session_file(&dir, &session_id)?;
    let now = crate::sessions::reader::now_ms();
    catch(move || {
        let agents_dir = crate::sessions::subagents::subagents_dir(&path);
        let file = std::fs::File::open(&path)?;
        let lines: Vec<String> = std::io::BufReader::new(file)
            .lines()
            .map_while(Result::ok)
            .filter(|l| l.contains("<task-notification>"))
            .collect();
        let completed = crate::sessions::subagents::collect_completed_ids(&lines);
        Ok(crate::sessions::subagents::scan_dir(&agents_dir, &completed, now))
    })
}

#[tauri::command]
pub fn read_subagent_history(
    state: State<AppState>,
    project_id: i64,
    session_id: String,
    agent_id: String,
    limit: Option<usize>,
    before_uuid: Option<String>,
) -> AppResult<SessionHistory> {
    crate::validation::validate_session_id(&session_id)?;
    crate::validation::validate_agent_id(&agent_id)?;
    let c = state.db.get()?;
    let proj = projects_repo::get(&c, project_id)?;
    let dir = session_dir(&proj)?;
    let session_path = session_file(&dir, &session_id)?;
    let agent_path = crate::sessions::subagents::subagents_dir(&session_path)
        .join(format!("agent-{agent_id}.jsonl"));
    if !agent_path.exists() {
        return Err(AppError::NotFound(agent_path.display().to_string()));
    }
    catch(move || {
        crate::sessions::reader::read_history_at(project_id, &agent_path, limit, before_uuid.as_deref())
    })
}
```

Wymagany import `use std::io::BufRead;` na górze pliku, jeśli go tam jeszcze nie ma. `now_ms()` w `reader.rs` jest prywatne — zmień je na `pub(crate) fn now_ms()`.

Filtr `contains("<task-notification>")` przy wczytywaniu linii sprawia, że do pamięci trafia garść linii zamiast całego logu.

- [ ] **Step 7: Zarejestruj komendy**

W `DesktopApp/src-tauri/src/lib.rs` dopisz `list_subagents` i `read_subagent_history` do listy w `generate_handler!`, obok `read_session_history`.

- [ ] **Step 8: Zbuduj i uruchom testy Rusta**

```bash
cd DesktopApp && npm run test:rust && cd src-tauri && cargo build
```

Oczekiwane: kompilacja bez błędów, testy na zielono.

- [ ] **Step 9: Commit**

```bash
git add DesktopApp/src-tauri/src
git commit -m "feat(desktop): komendy listy subagentów i historii subagenta"
```

---

### Task 4: Wrappery IPC i warstwa store

**Files:**
- Modify: `DesktopApp/src/lib/tauri.ts:42-50`
- Modify: `DesktopApp/src/store/sessionsSlice.ts`
- Modify: `DesktopApp/src/store/tabsSlice.ts:8-12`
- Test: `DesktopApp/src/store/sessionsSlice.test.ts`

**Interfaces:**
- Consumes: komendy `list_subagents`, `read_subagent_history` z Task 3.
- Produces:
  - `tauri.listSubagents(projectId, sessionId): Promise<SubagentInfo[]>`
  - `tauri.readSubagentHistory(projectId, sessionId, agentId, limit?, beforeUuid?): Promise<SessionHistory>`
  - `sessionsSlice.subagentsBySession: Record<string, SubagentInfo[]>`
  - `sessionsSlice.loadSubagents(projectId: number, sessionId: string): Promise<void>`
  - `tabsSlice`: pole `viewingSubagentId?: string` na tabie `session` + `viewSubagent(tabId: string, agentId: string | null): void`

- [ ] **Step 1: Dodaj wrappery IPC**

W `DesktopApp/src/lib/tauri.ts`, obok `readSessionHistory`:

```ts
  listSubagents: (projectId: number, sessionId: string) =>
    invoke<SubagentInfo[]>('list_subagents', { projectId, sessionId }),
  readSubagentHistory: (projectId: number, sessionId: string, agentId: string, limit?: number, beforeUuid?: string) =>
    invoke<SessionHistory>('read_subagent_history', { projectId, sessionId, agentId, limit, beforeUuid }),
```

Dopisz `SubagentInfo` do importu typów na górze pliku.

- [ ] **Step 2: Napisz test store'a**

W `DesktopApp/src/store/sessionsSlice.test.ts` dopisz (dopasuj sposób mockowania `tauri` do tego, który plik już stosuje):

```ts
  it('loadSubagents zapisuje listę pod identyfikatorem sesji', async () => {
    const agents = [{
      agentId: 'a1', agentType: 'Explore', description: 'x',
      status: 'running' as const, startedAt: 1, endedAt: null,
    }];
    vi.spyOn(tauri, 'listSubagents').mockResolvedValue(agents);

    await useStore.getState().loadSubagents(1, 'sess-1');

    expect(useStore.getState().subagentsBySession['sess-1']).toEqual(agents);
  });
```

- [ ] **Step 3: Uruchom test i potwierdź, że nie przechodzi**

```bash
cd DesktopApp && npm test -- sessionsSlice
```

Oczekiwane: błąd typu / `loadSubagents is not a function`.

- [ ] **Step 4: Rozszerz `sessionsSlice`**

W typie `SessionsSlice`:

```ts
  subagentsBySession: Record<string, SubagentInfo[]>;
  loadSubagents: (projectId: number, sessionId: string) => Promise<void>;
```

W implementacji slice'a:

```ts
  subagentsBySession: {},
  loadSubagents: async (projectId, sessionId) => {
    const agents = await tauri.listSubagents(projectId, sessionId);
    set({ subagentsBySession: { ...get().subagentsBySession, [sessionId]: agents } });
  },
```

Dopisz `SubagentInfo` do importu typów.

- [ ] **Step 5: Rozszerz `tabsSlice`**

W typie `Tab`, w wariancie `session`, dopisz `viewingSubagentId?: string`. W typie `TabsSlice`:

```ts
  viewSubagent: (tabId: string, agentId: string | null) => void;
```

W implementacji:

```ts
  viewSubagent: (tabId, agentId) => {
    set({
      tabs: get().tabs.map(t =>
        t.id === tabId && t.kind === 'session'
          ? (agentId ? { ...t, viewingSubagentId: agentId } : (() => {
              const { viewingSubagentId: _drop, ...rest } = t;
              return rest;
            })())
          : t,
      ),
    });
  },
```

Usuwanie pola zamiast ustawiania `undefined` trzyma serializację taba czystą — grupy zakładek jadą do okien wydzielonych jako base64 JSON.

- [ ] **Step 6: Uruchom testy**

```bash
cd DesktopApp && npm run lint && npm test
```

Oczekiwane: PASS.

- [ ] **Step 7: Commit**

```bash
git add DesktopApp/src/lib/tauri.ts DesktopApp/src/store
git commit -m "feat(desktop): store i wrappery IPC dla subagentów"
```

---

### Task 5: Odznaka i rozwijana lista w sidebarze

**Files:**
- Create: `DesktopApp/src/components/sidebar/SubagentBadge.tsx`
- Create: `DesktopApp/src/components/sidebar/SubagentList.tsx`
- Create: `DesktopApp/src/components/sidebar/SubagentBadge.test.tsx`
- Create: `DesktopApp/src/components/sidebar/SubagentList.test.tsx`
- Modify: `DesktopApp/src/components/sidebar/SessionItem.tsx`
- Modify: `DesktopApp/src/components/sidebar/ActiveSessionsPanel.tsx`
- Modify: `DesktopApp/src/store/tabsSlice.ts:38` (eksport `sessionTabId`)

**Interfaces:**
- Consumes: `SessionMeta.runningAgents`/`totalAgents` (Task 2), `loadSubagents` i `subagentsBySession` (Task 4).
- Produces:
  - `<SubagentBadge running={number} total={number} expanded={boolean} onToggle={() => void} />`
  - `<SubagentList agents={SubagentInfo[]} onPick={(agentId: string) => void} />`

- [ ] **Step 1: Napisz testy odznaki**

Plik `DesktopApp/src/components/sidebar/SubagentBadge.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { SubagentBadge } from './SubagentBadge';

describe('SubagentBadge', () => {
  it('nie renderuje się gdy sesja nie ma agentów', () => {
    const { container } = render(
      <SubagentBadge running={0} total={0} expanded={false} onToggle={() => {}} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('pokazuje liczbę pracujących agentów w kolorze akcentu', () => {
    const { getByRole } = render(
      <SubagentBadge running={2} total={3} expanded={false} onToggle={() => {}} />,
    );
    const btn = getByRole('button');
    expect(btn.textContent).toContain('2');
    expect(btn.getAttribute('class') ?? '').toContain('text-accent');
  });

  it('pokazuje liczbę wszystkich agentów na wyszarzeniu gdy nic nie pracuje', () => {
    const { getByRole } = render(
      <SubagentBadge running={0} total={3} expanded={false} onToggle={() => {}} />,
    );
    const btn = getByRole('button');
    expect(btn.textContent).toContain('3');
    expect(btn.getAttribute('class') ?? '').toContain('text-muted');
  });

  it('woła onToggle i nie propaguje kliknięcia do rodzica', () => {
    const onToggle = vi.fn();
    const onParent = vi.fn();
    const { getByRole } = render(
      <li onClick={onParent}>
        <SubagentBadge running={1} total={1} expanded={false} onToggle={onToggle} />
      </li>,
    );
    fireEvent.click(getByRole('button'));
    expect(onToggle).toHaveBeenCalledOnce();
    expect(onParent).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Uruchom testy i potwierdź, że nie przechodzą**

```bash
cd DesktopApp && npm test -- SubagentBadge
```

Oczekiwane: `Failed to resolve import './SubagentBadge'`.

- [ ] **Step 3: Zaimplementuj odznakę**

Plik `DesktopApp/src/components/sidebar/SubagentBadge.tsx`:

```tsx
type Props = {
  running: number;
  total: number;
  expanded: boolean;
  onToggle: () => void;
};

export function SubagentBadge({ running, total, expanded, onToggle }: Props) {
  if (total === 0) return null;
  const tone = running > 0 ? 'text-accent' : 'text-muted';
  const label = running > 0
    ? `Pracuje ${running} z ${total} agentów`
    : `${total} zakończonych agentów`;

  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-expanded={expanded}
      onClick={e => { e.stopPropagation(); onToggle(); }}
      className={`shrink-0 font-mono text-[10px] px-1 rounded hover:bg-bg-elev ${tone}`}
    >
      🤖 {running > 0 ? running : total}
    </button>
  );
}
```

- [ ] **Step 4: Uruchom testy i potwierdź, że przechodzą**

```bash
cd DesktopApp && npm test -- SubagentBadge
```

- [ ] **Step 5: Zaimplementuj listę agentów**

Plik `DesktopApp/src/components/sidebar/SubagentList.tsx`:

```tsx
import type { SubagentInfo } from '../../types';

const STATUS_MARK: Record<SubagentInfo['status'], string> = {
  running: '●',
  completed: '✓',
  stale: '⚠',
};

const STATUS_TONE: Record<SubagentInfo['status'], string> = {
  running: 'text-accent',
  completed: 'text-muted',
  stale: 'text-warn',
};

const STATUS_LABEL: Record<SubagentInfo['status'], string> = {
  running: 'Pracuje',
  completed: 'Zakończony',
  stale: 'Przerwany',
};

function duration(a: SubagentInfo): string {
  const end = a.endedAt ?? Date.now();
  const seconds = Math.max(0, Math.round((end - a.startedAt) / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s`;
}

type Props = { agents: SubagentInfo[]; onPick: (agentId: string) => void };

export function SubagentList({ agents, onPick }: Props) {
  if (agents.length === 0) {
    return <li className="pl-7 py-1 text-[11px] text-muted">Brak agentów</li>;
  }

  return (
    <>
      {agents.map(a => (
        <li
          key={a.agentId}
          onClick={e => { e.stopPropagation(); onPick(a.agentId); }}
          title={`${STATUS_LABEL[a.status]} · ${a.description}`}
          className="pl-7 pr-2 py-1 text-[11px] cursor-pointer flex items-center gap-2 text-fg hover:bg-bg-elev"
        >
          <span className={`shrink-0 ${STATUS_TONE[a.status]}`}>{STATUS_MARK[a.status]}</span>
          <span className="shrink-0 text-muted">{a.agentType}</span>
          <span className="truncate flex-1 min-w-0">{a.description}</span>
          <span className="font-mono text-[10px] text-muted shrink-0">{duration(a)}</span>
        </li>
      ))}
    </>
  );
}
```

- [ ] **Step 6: Napisz i uruchom test listy agentów**

Plik `DesktopApp/src/components/sidebar/SubagentList.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { SubagentList } from './SubagentList';
import type { SubagentInfo } from '../../types';

function agent(over: Partial<SubagentInfo> = {}): SubagentInfo {
  return {
    agentId: 'a1', agentType: 'Explore', description: 'Znajdź skróty',
    status: 'running', startedAt: 1000, endedAt: null, ...over,
  };
}

describe('SubagentList', () => {
  it('woła onPick z identyfikatorem agenta i nie propaguje kliknięcia', () => {
    const onPick = vi.fn();
    const onParent = vi.fn();
    const { getByTitle } = render(
      <ul onClick={onParent}>
        <SubagentList agents={[agent()]} onPick={onPick} />
      </ul>,
    );
    fireEvent.click(getByTitle(/Pracuje/));
    expect(onPick).toHaveBeenCalledWith('a1');
    expect(onParent).not.toHaveBeenCalled();
  });

  it('oznacza status znacznikiem i tonacją', () => {
    const { container } = render(
      <ul>
        <SubagentList
          agents={[agent({ agentId: 'a1' }), agent({ agentId: 'a2', status: 'stale', endedAt: 2000 })]}
          onPick={() => {}}
        />
      </ul>,
    );
    expect(container.textContent).toContain('●');
    expect(container.textContent).toContain('⚠');
  });

  it('informuje, gdy sesja nie ma agentów', () => {
    const { container } = render(<ul><SubagentList agents={[]} onPick={() => {}} /></ul>);
    expect(container.textContent).toContain('Brak agentów');
  });
});
```

```bash
cd DesktopApp && npm test -- SubagentList
```

Oczekiwane: PASS.

- [ ] **Step 7: Wyeksportuj identyfikator taba sesji**

`sessionTabId` w `DesktopApp/src/store/tabsSlice.ts:38` jest dziś prywatną stałą modułu. Dopisz `export`:

```ts
export const sessionTabId = (sessionId: string) => `session:${sessionId}`;
```

Bez tego `SessionItem` musiałby skleić `session:${id}` ręcznie i rozjechać się przy każdej zmianie schematu identyfikatorów.

- [ ] **Step 8: Podłącz odznakę i listę w `SessionItem`**

W `DesktopApp/src/components/sidebar/SessionItem.tsx`:
- dodaj `const [expanded, setExpanded] = useState(false);`
- dodaj `const agents = useStore(s => s.subagentsBySession[session.id]);` oraz `const loadSubagents = useStore(s => s.loadSubagents);`
- dodaj `const openTab = useStore(s => s.openSessionTab);` i `const viewSubagent = useStore(s => s.viewSubagent);`
- wstaw `<SubagentBadge ... />` tuż przed znacznikiem czasu (`formatRelative`), z `onToggle`:

```tsx
  const toggleAgents = () => {
    const next = !expanded;
    setExpanded(next);
    if (next) loadSubagents(session.projectId, session.id).catch(() => {});
  };
```

- ponieważ `SessionItem` zwraca dziś pojedynczy `<li>`, opakuj wynik we fragment i dopisz listę po `</li>`:

```tsx
      {expanded && <SubagentList agents={agents ?? []} onPick={pickAgent} />}
```

gdzie:

```tsx
  const pickAgent = (agentId: string) => {
    openTab(session.projectId, session.id, session.title, session.provider);
    viewSubagent(sessionTabId(session.id), agentId);
  };
```

z importem `import { sessionTabId } from '../../store/tabsSlice';` (wyeksportowanym w kroku 7).

- [ ] **Step 9: Podłącz odznakę w `ActiveSessionsPanel`**

`ActiveSession` (osobny typ od `SessionMeta`) nie niesie liczników. Odczytaj je ze store'a po `sessionId`:

```tsx
const counts = useStore(s => {
  const items = s.sessionsByProject[row.projectId]?.items;
  const m = items?.find(i => i.id === row.sessionId);
  return m ? { running: m.runningAgents, total: m.totalAgents } : { running: 0, total: 0 };
}, shallow);
```

Użyj `useShallow` z `zustand/react/shallow` — selektor zwraca nowy obiekt przy każdym wywołaniu i bez tego wpadniesz w pętlę renderów (ten sam błąd naprawiał commit `1bd2d64`). Panel pokazuje samą odznakę bez rozwijania: `expanded={false}` i `onToggle` przełączające na projekt nie jest wymagane — przekaż `onToggle={() => {}}`.

- [ ] **Step 10: Uruchom pełną weryfikację**

```bash
cd DesktopApp && npm run lint && npm test
```

- [ ] **Step 11: Commit**

```bash
git add DesktopApp/src/components/sidebar DesktopApp/src/store/tabsSlice.ts
git commit -m "feat(desktop): odznaka i lista subagentów w sidebarze"
```

---

### Task 6: Transcript subagenta w tabie sesji

**Files:**
- Create: `DesktopApp/src/components/history/SubagentHeader.tsx`
- Create: `DesktopApp/src/components/history/SubagentView.tsx`
- Create: `DesktopApp/src/components/center/TabContent.test.tsx`
- Modify: `DesktopApp/src/components/center/TabContent.tsx:15-35`

**Interfaces:**
- Consumes: `tauri.readSubagentHistory` i `viewSubagent` (Task 4).
- Produces: `<SubagentView projectId={number} sessionId={string} agentId={string} tabId={string} />`

- [ ] **Step 1: Napisz test montażu**

Plik `DesktopApp/src/components/center/TabContent.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import type { Tab } from '../../store/tabsSlice';

vi.mock('../terminal/TerminalView', () => ({
  TerminalView: () => <div data-testid="terminal" />,
}));
vi.mock('../history/SubagentView', () => ({
  SubagentView: () => <div data-testid="subagent" />,
}));

import { useStore } from '../../store';
import { TabContent } from './TabContent';

const sessionTab: Extract<Tab, { kind: 'session' }> = {
  kind: 'session',
  id: 'session:s1',
  projectId: 1,
  sessionId: 's1',
  title: 'Sesja',
  mode: 'terminal',
};

describe('TabContent a widok subagenta', () => {
  it('trzyma TerminalView zamontowany, gdy pokazywany jest subagent', () => {
    useStore.setState({ tabs: [sessionTab], activeTabId: 'session:s1' });
    const { getByTestId } = render(<TabContent />);
    expect(getByTestId('terminal')).toBeTruthy();

    useStore.setState({ tabs: [{ ...sessionTab, viewingSubagentId: 'a1' }] });

    expect(getByTestId('subagent')).toBeTruthy();
    expect(getByTestId('terminal')).toBeTruthy();
  });
});
```

`TabContent` (`TabContent.tsx:63`) przyjmuje tylko opcjonalne `{ detached }` i czyta zakładki ze store'a — stąd sterowanie przez `useStore.setState`. Zustand przerenderuje komponent po zmianie stanu, bez `rerender()`.

Ten test jest sednem zadania: gdyby widok subagenta podmieniał tryb taba zamiast go przykrywać, `TerminalView` zostałby odmontowany, a jego cleanup zabiłby PTY żywej sesji.

- [ ] **Step 2: Uruchom test i potwierdź, że nie przechodzi**

```bash
cd DesktopApp && npm test -- TabContent
```

Oczekiwane: brak elementu `subagent`.

- [ ] **Step 3: Zaimplementuj pasek powrotu**

Plik `DesktopApp/src/components/history/SubagentHeader.tsx`:

```tsx
import { Icon } from '../shared/Icon';

type Props = { agentType: string; description: string; onBack: () => void };

export function SubagentHeader({ agentType, description, onBack }: Props) {
  return (
    <div className="flex items-center gap-2 px-3 py-2 border-b border-border text-[12px] shrink-0">
      <button
        type="button"
        onClick={onBack}
        className="inline-flex items-center gap-1 text-muted hover:text-fg"
      >
        <Icon name="arrow" className="w-3 h-3" />
        Wróć do sesji
      </button>
      <span className="text-muted">·</span>
      <span className="font-medium shrink-0">{agentType}</span>
      <span className="truncate text-muted">{description}</span>
    </div>
  );
}
```

Sprawdź w `components/shared/Icon.tsx`, czy nazwa `arrow-left` istnieje; jeśli nie, użyj tej, która jest w zestawie.

- [ ] **Step 4: Zaimplementuj widok transcriptu**

Plik `DesktopApp/src/components/history/SubagentView.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { tauri } from '../../lib/tauri';
import { formatTauriError } from '../../lib/errors';
import { useStore } from '../../store';
import type { SessionHistory } from '../../types';
import { HistoryStream } from './HistoryStream';
import { SubagentHeader } from './SubagentHeader';

type Props = { projectId: number; sessionId: string; agentId: string; tabId: string };

export function SubagentView({ projectId, sessionId, agentId, tabId }: Props) {
  const [data, setData] = useState<SessionHistory | null>(null);
  const [error, setError] = useState<string | null>(null);
  const viewSubagent = useStore(s => s.viewSubagent);
  const info = useStore(s => s.subagentsBySession[sessionId]?.find(a => a.agentId === agentId));

  useEffect(() => {
    setData(null);
    setError(null);
    tauri.readSubagentHistory(projectId, sessionId, agentId)
      .then(setData)
      .catch(e => setError(formatTauriError(e)));
  }, [projectId, sessionId, agentId]);

  const back = () => viewSubagent(tabId, null);

  return (
    <div className="flex flex-col h-full">
      <SubagentHeader
        agentType={info?.agentType ?? 'Agent'}
        description={info?.description ?? ''}
        onBack={back}
      />
      {error && <div className="p-3 text-[12px] text-danger">{error}</div>}
      {!error && !data && <div className="p-3 text-[12px] text-muted">Wczytywanie…</div>}
      {data && <HistoryStream blocks={data.blocks} hasMore={false} />}
    </div>
  );
}
```

Nazwę klasy błędu (`text-danger`) sprawdź w innych widokach — użyj tej, której projekt faktycznie używa.

- [ ] **Step 5: Wepnij gałąź w `TabContent`**

W `DesktopApp/src/components/center/TabContent.tsx`, wewnątrz `TabPanel`, **przed** rozgałęzieniem na `tab.mode`:

```tsx
  if (tab.kind === 'session' && tab.viewingSubagentId) {
    const sid = tab.linkedSessionId ?? tab.sessionId;
    return (
      <>
        {renderSessionBody(tab, false)}
        <div className={`absolute inset-0 ${visible ? '' : 'invisible pointer-events-none'}`}>
          <SubagentView projectId={tab.projectId} sessionId={sid} agentId={tab.viewingSubagentId} tabId={tab.id} />
        </div>
      </>
    );
  }
```

gdzie `renderSessionBody(tab, visible)` to wydzielone z obecnych gałęzi `mode === 'history'` i `mode === 'terminal'` ciało — dzięki temu dotychczasowy widok renderuje się nadal, tylko z `visible=false`, a `TerminalView` pozostaje zamontowany i dalej buforuje wyjście w `pendingWrites`.

- [ ] **Step 6: Uruchom test i potwierdź, że przechodzi**

```bash
cd DesktopApp && npm test -- TabContent
```

- [ ] **Step 7: Uruchom pełną weryfikację**

```bash
cd DesktopApp && npm run lint && npm test
```

- [ ] **Step 8: Commit**

```bash
git add DesktopApp/src/components/history DesktopApp/src/components/center
git commit -m "feat(desktop): widok transcriptu subagenta w tabie sesji"
```

---

### Task 7: Odświeżanie na żywo z watchera

**Files:**
- Modify: `DesktopApp/src-tauri/src/sessions/watcher.rs:91-94, 107-123`
- Modify: `DesktopApp/src/lib/tauri.ts`
- Modify: `DesktopApp/src/components/history/SubagentView.tsx`

**Interfaces:**
- Consumes: `subagents::subagents_dir` (Task 1), `SubagentView` (Task 6).
- Produces:
  - zdarzenie `session:<sessionId>:agents` (payload pusty)
  - `tauri.onSubagentsChanged(sessionId, cb): Promise<UnlistenFn>`

- [ ] **Step 1: Rozszerz watch na podkatalogi**

W `DesktopApp/src-tauri/src/sessions/watcher.rs:93` zamień tryb:

```rust
            let _ = watcher.watch(&dir, RecursiveMode::Recursive);
```

- [ ] **Step 2: Rozpoznaj zmiany plików agentów**

W `handle_change`, przed pętlą po sesjach, dodaj rozpoznanie ścieżki agenta i wczesne wyjście — plik agenta nie jest logiem sesji i nie może przejść przez logikę offsetów:

```rust
        if changed.extension().and_then(|e| e.to_str()) == Some("jsonl")
            && changed.parent().and_then(|p| p.file_name()).and_then(|n| n.to_str()) == Some("subagents")
        {
            let owner = changed
                .parent()
                .and_then(|p| p.parent())
                .and_then(|p| p.file_name())
                .and_then(|n| n.to_str())
                .map(|s| s.to_string());
            if let Some(sid) = owner {
                if self.sessions.lock().contains_key(&sid) {
                    let _ = app.emit(&format!("session:{sid}:agents"), serde_json::json!({}));
                }
            }
            return;
        }
```

Zdarzenie leci tylko dla sesji faktycznie obserwowanych, więc rekursywny watch nie zaczyna rozgłaszać zmian z całego drzewa projektu.

- [ ] **Step 3: Sprawdź, że nic się nie zepsuło po stronie Rusta**

```bash
cd DesktopApp && npm run test:rust
```

Oczekiwane: PASS.

- [ ] **Step 4: Dodaj nasłuch po stronie frontendu**

W `DesktopApp/src/lib/tauri.ts`, obok pozostałych `onSession*`:

```ts
  onSubagentsChanged: (sessionId: string, cb: () => void): Promise<UnlistenFn> =>
    listen(`session:${sessionId}:agents`, () => cb()),
```

- [ ] **Step 5: Przeładuj transcript przy zmianie**

W `SubagentView` dopisz drugi efekt:

```tsx
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    tauri.onSubagentsChanged(sessionId, () => {
      tauri.readSubagentHistory(projectId, sessionId, agentId).then(setData).catch(() => {});
    }).then(fn => { unlisten = fn; });
    return () => { if (unlisten) unlisten(); };
  }, [projectId, sessionId, agentId]);
```

- [ ] **Step 6: Uruchom pełną weryfikację**

```bash
cd DesktopApp && npm run lint && npm test && npm run test:rust
```

- [ ] **Step 7: Commit**

```bash
git add DesktopApp/src-tauri/src/sessions/watcher.rs DesktopApp/src/lib/tauri.ts DesktopApp/src/components/history/SubagentView.tsx
git commit -m "feat(desktop): odświeżanie transcriptu subagenta na żywo"
```

---

## Weryfikacja na żywej aplikacji

Testy jednostkowe nie dotkną prawdziwego katalogu Claude Code. Po Task 7:

1. `cd DesktopApp && npm run tauri dev`
2. W sesji Claude Code w dowolnym projekcie uruchom dwa subagenty naraz.
3. Sprawdź: odznaka `🤖 2` w kolorze akcentu, sesja opisana jako pracująca (nie „czeka na Ciebie"), rozwinięta lista z dwoma wpisami `●`.
4. Kliknij agenta — transcript otwiera się w tabie sesji, a zakładka nie zmienia trybu. Jeśli sesja była w trybie terminala, wróć i sprawdź, że PTY żyje (terminal nadal reaguje).
5. Po zakończeniu agentów: znaczniki zmieniają się na `✓`, odznaka szarzeje, licznik pokazuje sumę.
6. Ubij CLI w trakcie pracy agenta i odczekaj ponad dwie minuty — wpis ma dostać `⚠`, a sesja przestać być raportowana jako pracująca.

Punkt 6 kalibruje `AGENT_STALE_MS`. Jeśli w normalnej pracy agenty bywają uznawane za przerwane (np. przy długim biegu testów wewnątrz agenta), podnieś próg i odnotuj nową wartość w specyfikacji.
