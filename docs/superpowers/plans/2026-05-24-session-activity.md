# Session Activity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a derived `SessionActivity` state (running / waitingUser / waitingTool / idle) for every Claude Code session, surface it in the sidebar dot, tab bar dot, and the existing HistoryHeader badge.

**Architecture:** Pure backend derivation. A new `sessions::activity::compute_activity(path, now_ms)` reads the last ~8 KiB of a session's JSONL file and combines it with mtime to produce one of four states. `list_sessions` enriches every `SessionMeta` returned. The existing file watcher emits a diff-only `session:{sid}:activity` event for open tabs. Frontend uses a 10s focus-gated polling timer for sidebar freshness; a single per-tab listener patches the store for push updates.

**Tech Stack:** Rust (Tauri 2, `tempfile`, existing `serde_json`/`chrono`), TypeScript (React 19, Zustand 5, Vitest + @testing-library/react), ts-rs for cross-IPC types.

**Reference spec:** `docs/superpowers/specs/2026-05-24-session-activity-design.md`

---

## File Structure

### Created
- `src-tauri/src/sessions/activity.rs` — pure detection logic + unit tests
- `src/lib/activity.ts` — state → color / icon / label maps
- `src/lib/activity.test.ts` — exhaustiveness smoke test

### Modified
- `src-tauri/src/sessions/mod.rs` — register new `activity` module
- `src-tauri/src/domain/session.rs` — `SessionActivity` enum + `activity` field on `SessionMeta`
- `src-tauri/src/sessions/reader.rs` — wire `compute_activity` into both readers
- `src-tauri/src/sessions/watcher.rs` — diff-only `:activity` emission
- `src/lib/tauri.ts` — `onSessionActivity` subscription helper
- `src/store/sessionsSlice.ts` — `patchActivity`, `selectSessionActivity`, `refreshActivity`, `start/stopActivityPolling`
- `src/components/history/HistoryView.tsx` — attach activity listener alongside `onSessionAppend`
- `src/components/sidebar/SessionItem.tsx` — dot driven by `session.activity`
- `src/components/center/TabBar.tsx` — dot for session-kind tabs
- `src/components/history/HistoryHeader.tsx` — replace hardcoded "aktywna" badge
- `src/components/layout/AppShell.tsx` — mount polling lifecycle once

---

## Phase A — Backend types

### Task 1: Add SessionActivity enum and field to SessionMeta

**Files:**
- Modify: `src-tauri/src/domain/session.rs`
- Modify: `src-tauri/src/sessions/reader.rs` (set `activity: SessionActivity::Idle` as a placeholder so it compiles — real wiring happens in Task 6)

- [ ] **Step 1: Edit `src-tauri/src/domain/session.rs`**

Add the enum at the top of the file (after the imports) and the field on `SessionMeta`:

```rust
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/types/")]
#[serde(rename_all = "camelCase")]
pub enum SessionActivity {
    Running,
    WaitingUser,
    WaitingTool,
    Idle,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/types/")]
#[serde(rename_all = "camelCase")]
pub struct SessionMeta {
    pub id: String,
    #[ts(type = "number")]
    pub project_id: i64,
    pub title: String,
    #[ts(type = "number")]
    pub message_count: usize,
    #[ts(type = "number")]
    pub last_modified: i64,
    pub git_branch: Option<String>,
    pub cwd: Option<String>,
    pub activity: SessionActivity,
}
```

The rest of the file (`HistoryBlock`, `SessionHistory`) stays unchanged.

- [ ] **Step 2: Update both `SessionMeta` constructors in `reader.rs` to set Idle placeholder**

`src-tauri/src/sessions/reader.rs` constructs `SessionMeta` in two places — `meta_for_file_fast` (around line 128) and `read_history` (around line 218). Add `activity: SessionActivity::Idle,` to each. Also add the import at the top.

In `reader.rs`, change line 4 from:

```rust
use crate::domain::{HistoryBlock, SessionHistory, SessionMeta};
```

to:

```rust
use crate::domain::{HistoryBlock, SessionActivity, SessionHistory, SessionMeta};
```

In `meta_for_file_fast`, change the returned struct (around line 128) from:

```rust
    Ok(SessionMeta {
        id, project_id, title,
        message_count: approx_messages,
        last_modified, git_branch, cwd,
    })
```

to:

```rust
    Ok(SessionMeta {
        id, project_id, title,
        message_count: approx_messages,
        last_modified, git_branch, cwd,
        activity: SessionActivity::Idle,
    })
```

In `read_history`, change the constructed `meta` (around line 218) from:

```rust
    let meta = SessionMeta {
        id, project_id, title,
        message_count: line_count,
        last_modified, git_branch, cwd,
    };
```

to:

```rust
    let meta = SessionMeta {
        id, project_id, title,
        message_count: line_count,
        last_modified, git_branch, cwd,
        activity: SessionActivity::Idle,
    };
```

- [ ] **Step 3: Run cargo build + run existing tests**

```bash
cd src-tauri && cargo build && cargo test --lib
```

Expected: build succeeds; all existing tests in `sessions::parser` and `sessions::reader` continue to pass.

- [ ] **Step 4: Verify ts-rs export was regenerated**

```bash
cat src/types/SessionActivity.ts
cat src/types/SessionMeta.ts
```

Expected:

```ts
// SessionActivity.ts
export type SessionActivity = "running" | "waitingUser" | "waitingTool" | "idle";
```

And `SessionMeta.ts` should now include the new field `activity: SessionActivity`. If the files weren't regenerated, run the existing test target that triggers ts-rs export (typically `cargo test --lib export_bindings` or whatever the project uses) — `cargo test --lib` should do it because ts-rs emits during test runs.

If `SessionMeta.ts` is missing the `activity` field, also update `src/types/index.ts` to re-export `SessionActivity`. Check that file first:

```bash
grep SessionActivity src/types/index.ts
```

If absent, append:

```ts
export type { SessionActivity } from './SessionActivity';
```

- [ ] **Step 5: Update `lib/tauri.ts` if `SessionActivity` import is needed**

Verify `src/lib/tauri.ts` still type-checks:

```bash
npm run lint
```

Expected: passes. No changes needed in `tauri.ts` for this task — `SessionMeta` import already covers the new field.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/domain/session.rs src-tauri/src/sessions/reader.rs src/types/SessionActivity.ts src/types/SessionMeta.ts src/types/index.ts
git commit -m "feat(sessions): add SessionActivity enum and activity field"
```

---

### Task 2: Create activity.rs stub and register module

**Files:**
- Create: `src-tauri/src/sessions/activity.rs`
- Modify: `src-tauri/src/sessions/mod.rs`

- [ ] **Step 1: Write a failing test for the stub behavior**

Create `src-tauri/src/sessions/activity.rs` with only the stub + first two tests:

```rust
use std::path::Path;
use crate::domain::SessionActivity;

const TAIL_BYTES: u64 = 8 * 1024;
const LIVE_WINDOW_MS: i64 = 5_000;
const TOOL_STALL_MS: i64 = 30_000;
const IDLE_HARD_CAP_MS: i64 = 24 * 60 * 60 * 1000;

pub fn compute_activity(_path: &Path, _now_ms: i64) -> SessionActivity {
    SessionActivity::Idle
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use tempfile::TempDir;

    #[test]
    fn missing_file_returns_idle() {
        let td = TempDir::new().unwrap();
        let p: PathBuf = td.path().join("does-not-exist.jsonl");
        assert_eq!(compute_activity(&p, 0), SessionActivity::Idle);
    }

    #[test]
    fn empty_file_returns_idle() {
        let td = TempDir::new().unwrap();
        let p = td.path().join("empty.jsonl");
        std::fs::write(&p, "").unwrap();
        assert_eq!(compute_activity(&p, 0), SessionActivity::Idle);
    }
}
```

- [ ] **Step 2: Register the module in `src-tauri/src/sessions/mod.rs`**

Read current `mod.rs`:

```bash
cat src-tauri/src/sessions/mod.rs
```

Append `pub mod activity;` to the existing module list (keep all other lines unchanged).

- [ ] **Step 3: Run the tests**

```bash
cd src-tauri && cargo test --lib sessions::activity
```

Expected: both tests pass (the stub returns Idle, which is correct for both placeholder scenarios).

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/sessions/activity.rs src-tauri/src/sessions/mod.rs
git commit -m "feat(sessions): scaffold activity module with constants and idle stub"
```

---

## Phase B — Detection algorithm

### Task 3: Implement tail reader

The tail reader returns the last ≤8 KiB of a file as a list of complete lines (drops a partial first line if the seek landed mid-line).

**Files:**
- Modify: `src-tauri/src/sessions/activity.rs`

- [ ] **Step 1: Write failing tests for the tail helper**

Append to `src-tauri/src/sessions/activity.rs`, inside the existing `mod tests` block:

```rust
    #[test]
    fn tail_small_file_returns_all_lines() {
        let td = TempDir::new().unwrap();
        let p = td.path().join("small.jsonl");
        std::fs::write(&p, "line1\nline2\nline3\n").unwrap();
        let lines = read_tail_lines(&p).unwrap();
        assert_eq!(lines, vec!["line1", "line2", "line3"]);
    }

    #[test]
    fn tail_large_file_drops_partial_first_line() {
        let td = TempDir::new().unwrap();
        let p = td.path().join("large.jsonl");
        let big_first: String = "x".repeat(10_000);
        let content = format!("{big_first}\nsecond\nthird\n");
        std::fs::write(&p, content).unwrap();
        let lines = read_tail_lines(&p).unwrap();
        assert!(!lines.iter().any(|l| l.starts_with("x")), "partial first line not dropped");
        assert_eq!(lines.last().map(String::as_str), Some("third"));
    }

    #[test]
    fn tail_no_trailing_newline_still_returns_last_line() {
        let td = TempDir::new().unwrap();
        let p = td.path().join("no-newline.jsonl");
        std::fs::write(&p, "only-line").unwrap();
        let lines = read_tail_lines(&p).unwrap();
        assert_eq!(lines, vec!["only-line"]);
    }
```

- [ ] **Step 2: Run tests — they should fail to compile**

```bash
cd src-tauri && cargo test --lib sessions::activity
```

Expected: compilation fails with `cannot find function read_tail_lines`.

- [ ] **Step 3: Implement `read_tail_lines`**

Add this function to `src-tauri/src/sessions/activity.rs` (between `compute_activity` and the `#[cfg(test)] mod tests` block):

```rust
fn read_tail_lines(path: &Path) -> Option<Vec<String>> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = std::fs::File::open(path).ok()?;
    let len = f.metadata().ok()?.len();
    let start = len.saturating_sub(TAIL_BYTES);
    f.seek(SeekFrom::Start(start)).ok()?;
    let mut buf = Vec::with_capacity((len - start) as usize);
    f.read_to_end(&mut buf).ok()?;
    let text = String::from_utf8_lossy(&buf).to_string();
    let mut lines: Vec<String> = text.lines().map(String::from).collect();
    // If we seeked into the middle of a file, the first line is partial — drop it.
    if start > 0 && !lines.is_empty() {
        lines.remove(0);
    }
    Some(lines)
}
```

- [ ] **Step 4: Run tests**

```bash
cd src-tauri && cargo test --lib sessions::activity
```

Expected: all five tests pass (two stubs + three tail tests).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/sessions/activity.rs
git commit -m "feat(sessions): add tail reader for activity detection"
```

---

### Task 4: Implement "find last significant event"

This helper walks parsed JSONL lines from the end, skipping infrastructure / meta records, and returns a typed enum describing the last meaningful event.

**Files:**
- Modify: `src-tauri/src/sessions/activity.rs`

- [ ] **Step 1: Add the private enum + failing tests**

Append to `src-tauri/src/sessions/activity.rs` (above the test module):

```rust
#[derive(Debug, PartialEq)]
enum LastEvent {
    UserText,
    UserToolResult { is_error: bool },
    AssistantText,
    AssistantToolUseUnresolved,
    AssistantToolUseResolved,
}
```

Append tests in the existing `mod tests`:

```rust
    fn last_event_from_lines(lines: &[&str]) -> Option<LastEvent> {
        let owned: Vec<String> = lines.iter().map(|s| s.to_string()).collect();
        find_last_significant(&owned)
    }

    #[test]
    fn ignores_queue_operation_last_prompt_system() {
        let lines = vec![
            r#"{"type":"user","uuid":"u1","message":{"content":[{"type":"text","text":"hello"}]}}"#,
            r#"{"type":"queue-operation"}"#,
            r#"{"type":"last-prompt"}"#,
            r#"{"type":"system","subtype":"hook"}"#,
        ];
        assert_eq!(last_event_from_lines(&lines), Some(LastEvent::UserText));
    }

    #[test]
    fn ignores_meta_user_content() {
        let lines = vec![
            r#"{"type":"user","uuid":"u1","message":{"content":[{"type":"text","text":"real prompt"}]}}"#,
            r#"{"type":"user","uuid":"u2","message":{"content":"<command-name>foo</command-name>"}}"#,
            r#"{"type":"user","uuid":"u3","message":{"content":""}}"#,
        ];
        assert_eq!(last_event_from_lines(&lines), Some(LastEvent::UserText));
    }

    #[test]
    fn returns_assistant_text() {
        let lines = vec![
            r#"{"type":"user","uuid":"u1","message":{"content":[{"type":"text","text":"hi"}]}}"#,
            r#"{"type":"assistant","uuid":"a1","message":{"content":[{"type":"text","text":"hello"}]}}"#,
        ];
        assert_eq!(last_event_from_lines(&lines), Some(LastEvent::AssistantText));
    }

    #[test]
    fn returns_user_tool_result_ok() {
        let lines = vec![
            r#"{"type":"user","uuid":"u1","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"ok","is_error":false}]}}"#,
        ];
        assert_eq!(
            last_event_from_lines(&lines),
            Some(LastEvent::UserToolResult { is_error: false })
        );
    }

    #[test]
    fn returns_user_tool_result_error() {
        let lines = vec![
            r#"{"type":"user","uuid":"u1","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"boom","is_error":true}]}}"#,
        ];
        assert_eq!(
            last_event_from_lines(&lines),
            Some(LastEvent::UserToolResult { is_error: true })
        );
    }

    #[test]
    fn tool_use_unresolved_when_no_matching_result() {
        let lines = vec![
            r#"{"type":"assistant","uuid":"a1","message":{"content":[{"type":"tool_use","id":"t1","name":"read","input":{}}]}}"#,
        ];
        assert_eq!(
            last_event_from_lines(&lines),
            Some(LastEvent::AssistantToolUseUnresolved)
        );
    }

    #[test]
    fn tool_use_resolved_when_matching_result_present_later() {
        let lines = vec![
            r#"{"type":"assistant","uuid":"a1","message":{"content":[{"type":"tool_use","id":"t1","name":"read","input":{}}]}}"#,
            r#"{"type":"user","uuid":"u2","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"ok","is_error":false}]}}"#,
        ];
        // last significant event is the tool_result, but for our detection
        // assistant tool_use with paired result is also a possible classification
        // when assistant message is the LAST one. Here last is the tool_result,
        // so we expect UserToolResult.
        assert_eq!(
            last_event_from_lines(&lines),
            Some(LastEvent::UserToolResult { is_error: false })
        );
    }

    #[test]
    fn empty_returns_none() {
        let lines: Vec<&str> = vec![];
        assert_eq!(last_event_from_lines(&lines), None);
    }
```

- [ ] **Step 2: Run tests — they should fail to compile**

```bash
cd src-tauri && cargo test --lib sessions::activity
```

Expected: compilation fails with `cannot find function find_last_significant`.

- [ ] **Step 3: Implement `find_last_significant`**

Append to `src-tauri/src/sessions/activity.rs`, above the `#[cfg(test)]` block:

```rust
use serde_json::Value;
use crate::sessions::parser::is_meta_user_content;

fn find_last_significant(lines: &[String]) -> Option<LastEvent> {
    // Pass 1: collect all resolved tool_use_ids by scanning forward
    // for tool_result records (in `user` content arrays).
    let mut resolved_ids: std::collections::HashSet<String> = std::collections::HashSet::new();
    for line in lines {
        let Ok(v) = serde_json::from_str::<Value>(line) else { continue; };
        if v.get("type").and_then(|t| t.as_str()) != Some("user") { continue; }
        let Some(arr) = v.get("message").and_then(|m| m.get("content")).and_then(|c| c.as_array()) else { continue; };
        for item in arr {
            if item.get("type").and_then(|t| t.as_str()) == Some("tool_result") {
                if let Some(id) = item.get("tool_use_id").and_then(|s| s.as_str()) {
                    resolved_ids.insert(id.to_string());
                }
            }
        }
    }

    // Pass 2: walk from the end, return the first non-skipped event.
    for line in lines.iter().rev() {
        let Ok(v) = serde_json::from_str::<Value>(line) else { continue; };
        let kind = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
        match kind {
            "queue-operation" | "last-prompt" | "system" | "attachment" => continue,
            "user" => {
                if let Some(s) = v.get("message").and_then(|m| m.get("content")).and_then(|c| c.as_str()) {
                    if s.is_empty() || is_meta_user_content(s) { continue; }
                    return Some(LastEvent::UserText);
                }
                let Some(arr) = v.get("message").and_then(|m| m.get("content")).and_then(|c| c.as_array()) else { continue; };
                let has_text = arr.iter().any(|i|
                    i.get("type").and_then(|t| t.as_str()) == Some("text")
                    && i.get("text").and_then(|t| t.as_str()).map(|s| !s.is_empty()).unwrap_or(false)
                );
                let tool_result = arr.iter().find(|i| i.get("type").and_then(|t| t.as_str()) == Some("tool_result"));
                if has_text {
                    return Some(LastEvent::UserText);
                }
                if let Some(tr) = tool_result {
                    let is_error = tr.get("is_error").and_then(|x| x.as_bool()).unwrap_or(false);
                    return Some(LastEvent::UserToolResult { is_error });
                }
                continue;
            }
            "assistant" => {
                let Some(arr) = v.get("message").and_then(|m| m.get("content")).and_then(|c| c.as_array()) else { continue; };
                let has_text = arr.iter().any(|i|
                    i.get("type").and_then(|t| t.as_str()) == Some("text")
                    && i.get("text").and_then(|t| t.as_str()).map(|s| !s.is_empty()).unwrap_or(false)
                );
                let unresolved_tool = arr.iter().any(|i| {
                    if i.get("type").and_then(|t| t.as_str()) != Some("tool_use") { return false; }
                    let id = i.get("id").and_then(|s| s.as_str()).unwrap_or("");
                    !resolved_ids.contains(id)
                });
                if unresolved_tool {
                    return Some(LastEvent::AssistantToolUseUnresolved);
                }
                let has_any_tool_use = arr.iter().any(|i| i.get("type").and_then(|t| t.as_str()) == Some("tool_use"));
                if has_any_tool_use {
                    return Some(LastEvent::AssistantToolUseResolved);
                }
                if has_text {
                    return Some(LastEvent::AssistantText);
                }
                continue;
            }
            _ => continue,
        }
    }
    None
}
```

- [ ] **Step 4: Run tests**

```bash
cd src-tauri && cargo test --lib sessions::activity
```

Expected: all tests pass (stubs + tail + 8 last-event tests).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/sessions/activity.rs
git commit -m "feat(sessions): detect last significant event from JSONL tail"
```

---

### Task 5: Implement decision logic

Wire `read_tail_lines` + `find_last_significant` + mtime into the real `compute_activity`. Replace the stub.

**Files:**
- Modify: `src-tauri/src/sessions/activity.rs`

- [ ] **Step 1: Add failing tests for the full decision tree**

Append to `mod tests`:

```rust
    fn write_with_mtime(td: &TempDir, name: &str, body: &str) -> (PathBuf, i64) {
        let p = td.path().join(name);
        std::fs::write(&p, body).unwrap();
        let mtime = p.metadata().unwrap().modified().unwrap()
            .duration_since(std::time::UNIX_EPOCH).unwrap()
            .as_millis() as i64;
        (p, mtime)
    }

    #[test]
    fn file_modified_now_returns_running_regardless_of_content() {
        let td = TempDir::new().unwrap();
        let (p, mtime) = write_with_mtime(&td, "s.jsonl",
            r#"{"type":"assistant","uuid":"a1","message":{"content":[{"type":"text","text":"done"}]}}"#);
        // now_ms within the 5s live window
        assert_eq!(compute_activity(&p, mtime + 1_000), SessionActivity::Running);
    }

    #[test]
    fn file_modified_25h_ago_returns_idle() {
        let td = TempDir::new().unwrap();
        let (p, mtime) = write_with_mtime(&td, "s.jsonl",
            r#"{"type":"assistant","uuid":"a1","message":{"content":[{"type":"text","text":"hi"}]}}"#);
        let twenty_five_hours = 25 * 60 * 60 * 1000;
        assert_eq!(compute_activity(&p, mtime + twenty_five_hours), SessionActivity::Idle);
    }

    #[test]
    fn last_event_assistant_text_returns_waiting_user() {
        let td = TempDir::new().unwrap();
        let (p, mtime) = write_with_mtime(&td, "s.jsonl",
            r#"{"type":"user","uuid":"u1","message":{"content":[{"type":"text","text":"hi"}]}}
{"type":"assistant","uuid":"a1","message":{"content":[{"type":"text","text":"hello"}]}}"#);
        // outside live window
        assert_eq!(compute_activity(&p, mtime + 60_000), SessionActivity::WaitingUser);
    }

    #[test]
    fn last_event_user_text_returns_running() {
        let td = TempDir::new().unwrap();
        let (p, mtime) = write_with_mtime(&td, "s.jsonl",
            r#"{"type":"user","uuid":"u1","message":{"content":[{"type":"text","text":"do it"}]}}"#);
        assert_eq!(compute_activity(&p, mtime + 60_000), SessionActivity::Running);
    }

    #[test]
    fn user_tool_result_ok_returns_running() {
        let td = TempDir::new().unwrap();
        let (p, mtime) = write_with_mtime(&td, "s.jsonl",
            r#"{"type":"user","uuid":"u1","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"ok","is_error":false}]}}"#);
        assert_eq!(compute_activity(&p, mtime + 60_000), SessionActivity::Running);
    }

    #[test]
    fn user_tool_result_error_returns_waiting_user() {
        let td = TempDir::new().unwrap();
        let (p, mtime) = write_with_mtime(&td, "s.jsonl",
            r#"{"type":"user","uuid":"u1","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"err","is_error":true}]}}"#);
        assert_eq!(compute_activity(&p, mtime + 60_000), SessionActivity::WaitingUser);
    }

    #[test]
    fn tool_use_fresh_returns_running() {
        let td = TempDir::new().unwrap();
        let (p, mtime) = write_with_mtime(&td, "s.jsonl",
            r#"{"type":"assistant","uuid":"a1","message":{"content":[{"type":"tool_use","id":"t1","name":"read","input":{}}]}}"#);
        // outside live window (>5s) but inside tool stall (<30s)
        assert_eq!(compute_activity(&p, mtime + 10_000), SessionActivity::Running);
    }

    #[test]
    fn tool_use_stale_returns_waiting_tool() {
        let td = TempDir::new().unwrap();
        let (p, mtime) = write_with_mtime(&td, "s.jsonl",
            r#"{"type":"assistant","uuid":"a1","message":{"content":[{"type":"tool_use","id":"t1","name":"read","input":{}}]}}"#);
        // outside tool stall threshold
        assert_eq!(compute_activity(&p, mtime + 60_000), SessionActivity::WaitingTool);
    }

    #[test]
    fn tool_use_paired_with_result_treated_as_done_then_followed_by_assistant_text() {
        let td = TempDir::new().unwrap();
        let body = r#"{"type":"assistant","uuid":"a1","message":{"content":[{"type":"tool_use","id":"t1","name":"read","input":{}}]}}
{"type":"user","uuid":"u2","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"ok","is_error":false}]}}
{"type":"assistant","uuid":"a2","message":{"content":[{"type":"text","text":"done"}]}}"#;
        let (p, mtime) = write_with_mtime(&td, "s.jsonl", body);
        assert_eq!(compute_activity(&p, mtime + 60_000), SessionActivity::WaitingUser);
    }

    #[test]
    fn only_meta_user_records_returns_idle() {
        let td = TempDir::new().unwrap();
        let (p, mtime) = write_with_mtime(&td, "s.jsonl",
            r#"{"type":"user","uuid":"u1","message":{"content":"<command-name>x</command-name>"}}
{"type":"user","uuid":"u2","message":{"content":""}}"#);
        assert_eq!(compute_activity(&p, mtime + 60_000), SessionActivity::Idle);
    }

    #[test]
    fn only_system_records_returns_idle() {
        let td = TempDir::new().unwrap();
        let (p, mtime) = write_with_mtime(&td, "s.jsonl",
            r#"{"type":"system","subtype":"hook"}
{"type":"queue-operation"}"#);
        assert_eq!(compute_activity(&p, mtime + 60_000), SessionActivity::Idle);
    }

    #[test]
    fn huge_assistant_text_truncates_correctly() {
        let td = TempDir::new().unwrap();
        let huge: String = "a".repeat(20_000);
        let body = format!(
            r#"{{"type":"user","uuid":"u1","message":{{"content":[{{"type":"text","text":"hi"}}]}}}}
{{"type":"assistant","uuid":"a1","message":{{"content":[{{"type":"text","text":"{huge}"}}]}}}}"#
        );
        let (p, mtime) = write_with_mtime(&td, "s.jsonl", &body);
        // The 8 KiB tail will land in the middle of the giant assistant line.
        // After dropping partial first line the tail may be empty → Idle.
        // This is the accepted tradeoff documented in the spec; assert it stays
        // either WaitingUser or Idle (never panics, never WaitingTool).
        let result = compute_activity(&p, mtime + 60_000);
        assert!(
            matches!(result, SessionActivity::WaitingUser | SessionActivity::Idle),
            "got {result:?}"
        );
    }
```

- [ ] **Step 2: Run tests — they should fail**

```bash
cd src-tauri && cargo test --lib sessions::activity
```

Expected: most new tests fail because the stub always returns Idle.

- [ ] **Step 3: Replace the stub with the real implementation**

In `src-tauri/src/sessions/activity.rs`, replace:

```rust
pub fn compute_activity(_path: &Path, _now_ms: i64) -> SessionActivity {
    SessionActivity::Idle
}
```

with:

```rust
pub fn compute_activity(path: &Path, now_ms: i64) -> SessionActivity {
    let Ok(meta) = path.metadata() else { return SessionActivity::Idle };
    let Ok(mtime_st) = meta.modified() else { return SessionActivity::Idle };
    let mtime_ms = match mtime_st.duration_since(std::time::UNIX_EPOCH) {
        Ok(d) => d.as_millis() as i64,
        Err(_) => return SessionActivity::Idle,
    };
    let age_ms = now_ms - mtime_ms;

    if age_ms > IDLE_HARD_CAP_MS {
        return SessionActivity::Idle;
    }
    if age_ms < LIVE_WINDOW_MS {
        return SessionActivity::Running;
    }

    let Some(lines) = read_tail_lines(path) else { return SessionActivity::Idle };
    let Some(last) = find_last_significant(&lines) else { return SessionActivity::Idle };

    match last {
        LastEvent::UserText => SessionActivity::Running,
        LastEvent::UserToolResult { is_error: false } => SessionActivity::Running,
        LastEvent::UserToolResult { is_error: true } => SessionActivity::WaitingUser,
        LastEvent::AssistantToolUseUnresolved => {
            if age_ms < TOOL_STALL_MS {
                SessionActivity::Running
            } else {
                SessionActivity::WaitingTool
            }
        }
        LastEvent::AssistantToolUseResolved => SessionActivity::WaitingUser,
        LastEvent::AssistantText => SessionActivity::WaitingUser,
    }
}
```

- [ ] **Step 4: Run tests**

```bash
cd src-tauri && cargo test --lib sessions::activity
```

Expected: all tests pass (stubs + tail + last-event + decision).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/sessions/activity.rs
git commit -m "feat(sessions): compute_activity decision tree with mtime windows"
```

---

## Phase C — Backend integration

### Task 6: Wire compute_activity into reader

`list_sessions` (and `read_session_history`) must return real activity values, not the Idle placeholder from Task 1.

**Files:**
- Modify: `src-tauri/src/sessions/reader.rs`

- [ ] **Step 1: Add an integration test**

Append to the existing `#[cfg(test)] mod tests` block in `src-tauri/src/sessions/reader.rs`:

```rust
    use crate::domain::SessionActivity;

    #[test]
    fn list_sessions_includes_activity() {
        let td = TempDir::new().unwrap();
        // A session with a single user prompt — activity should be Running.
        let content = r#"{"type":"user","uuid":"u1","timestamp":"2026-05-21T12:00:00Z","sessionId":"s1","cwd":"/x","gitBranch":"main","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}"#;
        setup(td.path(), "sess-active", content);

        let list = list_sessions(1, td.path(), 10, 0).unwrap();
        let s = list.iter().find(|m| m.id == "sess-active").unwrap();
        // mtime is fresh (just written) → Running by the live-window rule.
        assert_eq!(s.activity, SessionActivity::Running);
    }
```

- [ ] **Step 2: Run the test — it should fail**

```bash
cd src-tauri && cargo test --lib sessions::reader::tests::list_sessions_includes_activity
```

Expected: assertion fails because `meta_for_file_fast` still sets `SessionActivity::Idle`.

- [ ] **Step 3: Wire compute_activity into the two constructors**

In `src-tauri/src/sessions/reader.rs`, change line 4 from:

```rust
use crate::domain::{HistoryBlock, SessionActivity, SessionHistory, SessionMeta};
```

(already done in Task 1) — leave as-is.

Add the import for the activity module at the top:

```rust
use super::activity::compute_activity;
```

Add a small helper near the top (after imports):

```rust
fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
```

In `meta_for_file_fast`, change the placeholder assignment:

```rust
        activity: SessionActivity::Idle,
```

to:

```rust
        activity: compute_activity(path, now_ms()),
```

In `read_history`, change the same line:

```rust
        activity: SessionActivity::Idle,
```

to:

```rust
        activity: compute_activity(&path, now_ms()),
```

- [ ] **Step 4: Run all reader tests**

```bash
cd src-tauri && cargo test --lib sessions::reader
```

Expected: existing tests (`list_orders_by_mtime_desc`, `read_history_pagination`) pass; the new integration test passes.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/sessions/reader.rs
git commit -m "feat(sessions): include computed activity in list_sessions and read_history"
```

---

### Task 7: Diff-only activity emission in watcher

When an open session's file changes, the watcher already emits `session:{sid}:append`. Add a parallel `session:{sid}:activity` emission that fires **only when the computed state differs from the last emitted state for that sid**.

**Files:**
- Modify: `src-tauri/src/sessions/watcher.rs`

- [ ] **Step 1: Read current `watcher.rs` to confirm structure**

Already known from spec exploration. Modifications:
1. Add `last_activity: Mutex<HashMap<String, SessionActivity>>` field to `SessionWatchers`.
2. Initialize it in `SessionWatchers::new`.
3. Clean up on `close()`.
4. In `handle_change`, compute new activity per modified session, compare to `last_activity[sid]`, emit `:activity` only on change.

- [ ] **Step 2: Apply the edits**

In `src-tauri/src/sessions/watcher.rs`:

Change the imports block (lines 1-10) from:

```rust
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use parking_lot::Mutex;
use notify::{RecommendedWatcher, RecursiveMode, Watcher as _, Event, EventKind};
use tauri::{AppHandle, Emitter};
use crate::domain::HistoryBlock;
use crate::error::AppResult;
use crate::sessions::parser::parse_line;
```

to:

```rust
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use parking_lot::Mutex;
use notify::{RecommendedWatcher, RecursiveMode, Watcher as _, Event, EventKind};
use tauri::{AppHandle, Emitter};
use crate::domain::{HistoryBlock, SessionActivity};
use crate::error::AppResult;
use crate::sessions::parser::parse_line;
use crate::sessions::activity::compute_activity;
```

Change the `SessionWatchers` struct (lines 17-20) from:

```rust
pub struct SessionWatchers {
    sessions: Mutex<HashMap<String, OpenSession>>,
    watcher: Mutex<Option<RecommendedWatcher>>,
}
```

to:

```rust
pub struct SessionWatchers {
    sessions: Mutex<HashMap<String, OpenSession>>,
    watcher: Mutex<Option<RecommendedWatcher>>,
    last_activity: Mutex<HashMap<String, SessionActivity>>,
}
```

Change `SessionWatchers::new` (lines 23-28) from:

```rust
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            sessions: Mutex::new(HashMap::new()),
            watcher: Mutex::new(None),
        })
    }
```

to:

```rust
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            sessions: Mutex::new(HashMap::new()),
            watcher: Mutex::new(None),
            last_activity: Mutex::new(HashMap::new()),
        })
    }
```

Change `close` (lines 58-60) from:

```rust
    pub fn close(&self, session_id: &str) {
        self.sessions.lock().remove(session_id);
    }
```

to:

```rust
    pub fn close(&self, session_id: &str) {
        self.sessions.lock().remove(session_id);
        self.last_activity.lock().remove(session_id);
    }
```

Change `handle_change` (lines 62-85) from:

```rust
    fn handle_change(&self, app: &AppHandle, changed: &Path) {
        let mut sessions = self.sessions.lock();
        let mut updates: Vec<(String, Vec<HistoryBlock>)> = Vec::new();

        for (sid, sess) in sessions.iter_mut() {
            if sess.path != changed { continue; }
            let new_size = match std::fs::metadata(&sess.path) {
                Ok(m) => m.len(),
                Err(_) => continue,
            };
            if new_size <= sess.last_offset { continue; }
            let blocks = read_tail(&sess.path, sess.last_offset, new_size);
            sess.last_offset = new_size;
            if !blocks.is_empty() {
                updates.push((sid.clone(), blocks));
            }
        }
        drop(sessions);

        for (sid, blocks) in updates {
            let _ = app.emit(&format!("session:{sid}:append"), serde_json::json!({ "blocks": blocks }));
        }
        std::thread::sleep(Duration::from_millis(50));
    }
```

to:

```rust
    fn handle_change(&self, app: &AppHandle, changed: &Path) {
        let mut sessions = self.sessions.lock();
        let mut block_updates: Vec<(String, Vec<HistoryBlock>)> = Vec::new();
        let mut activity_inputs: Vec<(String, PathBuf)> = Vec::new();

        for (sid, sess) in sessions.iter_mut() {
            if sess.path != changed { continue; }
            let new_size = match std::fs::metadata(&sess.path) {
                Ok(m) => m.len(),
                Err(_) => continue,
            };
            if new_size <= sess.last_offset {
                // file changed but didn't grow (e.g. mtime touch) — still
                // recompute activity, no blocks to append.
                activity_inputs.push((sid.clone(), sess.path.clone()));
                continue;
            }
            let blocks = read_tail(&sess.path, sess.last_offset, new_size);
            sess.last_offset = new_size;
            if !blocks.is_empty() {
                block_updates.push((sid.clone(), blocks));
            }
            activity_inputs.push((sid.clone(), sess.path.clone()));
        }
        drop(sessions);

        for (sid, blocks) in block_updates {
            let _ = app.emit(&format!("session:{sid}:append"), serde_json::json!({ "blocks": blocks }));
        }

        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        let mut last = self.last_activity.lock();
        for (sid, path) in activity_inputs {
            let new_activity = compute_activity(&path, now);
            let changed_state = last.get(&sid).copied() != Some(new_activity);
            if changed_state {
                last.insert(sid.clone(), new_activity);
                let _ = app.emit(
                    &format!("session:{sid}:activity"),
                    serde_json::json!({ "activity": new_activity }),
                );
            }
        }
        drop(last);

        std::thread::sleep(Duration::from_millis(50));
    }
```

- [ ] **Step 3: Run cargo test to verify no regression**

```bash
cd src-tauri && cargo test --lib
```

Expected: all existing tests still pass. The watcher itself has no unit tests today (it's wired through notify) — we rely on the manual smoke test in Task 16 and the compute_activity unit tests for correctness.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/sessions/watcher.rs
git commit -m "feat(sessions): emit diff-only session:{sid}:activity from watcher"
```

---

## Phase D — Frontend types & helpers

### Task 8: Create `src/lib/activity.ts` with state→UI maps

**Files:**
- Create: `src/lib/activity.ts`
- Create: `src/lib/activity.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/activity.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { ACTIVITY_DOT, ACTIVITY_LABEL, ACTIVITY_ICON } from './activity';
import type { SessionActivity } from '../types';

const ALL_STATES: SessionActivity[] = ['running', 'waitingUser', 'waitingTool', 'idle'];

describe('activity maps', () => {
  it('ACTIVITY_DOT covers every state', () => {
    for (const s of ALL_STATES) {
      expect(ACTIVITY_DOT[s]).toMatch(/^bg-/);
    }
  });

  it('ACTIVITY_LABEL covers every state with a non-empty Polish label', () => {
    for (const s of ALL_STATES) {
      expect(ACTIVITY_LABEL[s].length).toBeGreaterThan(0);
    }
  });

  it('ACTIVITY_ICON covers every state', () => {
    for (const s of ALL_STATES) {
      expect(ACTIVITY_ICON[s]).toBeDefined();
    }
  });
});
```

- [ ] **Step 2: Run the test — it should fail**

```bash
npx vitest run src/lib/activity.test.ts
```

Expected: fail with "Cannot find module './activity'".

- [ ] **Step 3: Implement `src/lib/activity.ts`**

```ts
import type { SessionActivity } from '../types';
import type { IconName } from '../components/shared/Icon';

export const ACTIVITY_DOT: Record<SessionActivity, string> = {
  running:     'bg-success',
  waitingUser: 'bg-accent',
  waitingTool: 'bg-warn',
  idle:        'bg-muted',
};

export const ACTIVITY_LABEL: Record<SessionActivity, string> = {
  running:     'Aktywna — Claude pracuje',
  waitingUser: 'Czeka na Twoją odpowiedź',
  waitingTool: 'Czeka na zatwierdzenie narzędzia',
  idle:        'Bezczynna',
};

export const ACTIVITY_ICON: Record<SessionActivity, IconName> = {
  running:     'spinner',
  waitingUser: 'dot',
  waitingTool: 'pause',
  idle:        'dot',
};
```

If `IconName` is not yet exported from `src/components/shared/Icon.tsx`, verify with:

```bash
grep "export type IconName" src/components/shared/Icon.tsx
```

It is exported (line 29 in the existing file).

- [ ] **Step 4: Run the test**

```bash
npx vitest run src/lib/activity.test.ts
```

Expected: all three tests pass.

- [ ] **Step 5: Run typecheck + full test suite**

```bash
npm run lint && npm test
```

Expected: both succeed.

- [ ] **Step 6: Commit**

```bash
git add src/lib/activity.ts src/lib/activity.test.ts
git commit -m "feat(ui): add activity state→color/icon/label maps"
```

---

## Phase E — Frontend store

### Task 9: Add `patchActivity` and `selectSessionActivity` to sessionsSlice

`patchActivity(sid, activity)` patches the matching session in any project bucket; no-op if missing. `selectSessionActivity(sid)` looks up across all projects.

**Files:**
- Modify: `src/store/sessionsSlice.ts`
- Create: `src/store/sessionsSlice.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/store/sessionsSlice.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from './index';
import type { SessionMeta } from '../types';

function fakeMeta(id: string, projectId: number, activity: SessionMeta['activity'] = 'idle'): SessionMeta {
  return {
    id,
    projectId,
    title: `Session ${id}`,
    messageCount: 1,
    lastModified: 0,
    gitBranch: null,
    cwd: null,
    activity,
  };
}

describe('sessionsSlice activity', () => {
  beforeEach(() => {
    useStore.setState({ sessionsByProject: {} });
  });

  it('patchActivity updates a session in its project bucket', () => {
    useStore.setState({
      sessionsByProject: {
        1: { items: [fakeMeta('a', 1, 'idle'), fakeMeta('b', 1, 'idle')], hasMore: false },
      },
    });
    useStore.getState().patchActivity('b', 'waitingUser');
    const items = useStore.getState().sessionsByProject[1].items;
    expect(items.find(i => i.id === 'a')?.activity).toBe('idle');
    expect(items.find(i => i.id === 'b')?.activity).toBe('waitingUser');
  });

  it('patchActivity finds session across multiple project buckets', () => {
    useStore.setState({
      sessionsByProject: {
        1: { items: [fakeMeta('a', 1, 'idle')], hasMore: false },
        2: { items: [fakeMeta('b', 2, 'idle')], hasMore: false },
      },
    });
    useStore.getState().patchActivity('b', 'running');
    expect(useStore.getState().sessionsByProject[2].items[0].activity).toBe('running');
    expect(useStore.getState().sessionsByProject[1].items[0].activity).toBe('idle');
  });

  it('patchActivity is a no-op for unknown sid', () => {
    useStore.setState({
      sessionsByProject: {
        1: { items: [fakeMeta('a', 1, 'idle')], hasMore: false },
      },
    });
    useStore.getState().patchActivity('zzz', 'running');
    expect(useStore.getState().sessionsByProject[1].items[0].activity).toBe('idle');
  });
});
```

- [ ] **Step 2: Run the test — it should fail**

```bash
npx vitest run src/store/sessionsSlice.test.ts
```

Expected: type error — `patchActivity` does not exist on the store.

- [ ] **Step 3: Add `patchActivity` and `selectSessionActivity` to the slice**

In `src/store/sessionsSlice.ts`, change the imports / types and append the new methods:

Replace the existing file contents with:

```ts
import type { StateCreator } from 'zustand';
import { tauri } from '../lib/tauri';
import type { SessionActivity, SessionMeta } from '../types';
import type { TabsSlice } from './tabsSlice';
import type { AppState } from './index';

const PAGE = 5;

export type SessionsSlice = {
  sessionsByProject: Record<number, { items: SessionMeta[]; hasMore: boolean }>;
  loadInitialSessions: (projectId: number) => Promise<void>;
  loadMoreSessions: (projectId: number) => Promise<void>;
  renameSession: (projectId: number, sessionId: string, title: string) => Promise<void>;
  patchActivity: (sessionId: string, activity: SessionActivity) => void;
};

export const selectSessionActivity =
  (sid: string) => (s: AppState): SessionActivity => {
    for (const proj of Object.values(s.sessionsByProject)) {
      const found = proj.items.find(x => x.id === sid);
      if (found) return found.activity;
    }
    return 'idle';
  };

export const createSessionsSlice: StateCreator<SessionsSlice & TabsSlice, [], [], SessionsSlice> = (set, get) => ({
  sessionsByProject: {},
  loadInitialSessions: async (projectId) => {
    const items = await tauri.listSessions(projectId, PAGE, 0);
    set({ sessionsByProject: {
      ...get().sessionsByProject,
      [projectId]: { items, hasMore: items.length === PAGE },
    }});
  },
  loadMoreSessions: async (projectId) => {
    const current = get().sessionsByProject[projectId];
    if (!current) return;
    const more = await tauri.listSessions(projectId, PAGE, current.items.length);
    set({ sessionsByProject: {
      ...get().sessionsByProject,
      [projectId]: {
        items: [...current.items, ...more],
        hasMore: more.length === PAGE,
      },
    }});
  },
  renameSession: async (projectId, sessionId, title) => {
    await tauri.renameSession(projectId, sessionId, title);
    const current = get().sessionsByProject[projectId];
    if (current) {
      set({ sessionsByProject: {
        ...get().sessionsByProject,
        [projectId]: {
          ...current,
          items: current.items.map(s => s.id === sessionId ? { ...s, title } : s),
        },
      }});
    }
    get().renameTab(`session:${sessionId}`, title);
  },
  patchActivity: (sessionId, activity) => {
    const current = get().sessionsByProject;
    let changed = false;
    const next: typeof current = {};
    for (const [pid, bucket] of Object.entries(current)) {
      const idx = bucket.items.findIndex(s => s.id === sessionId);
      if (idx >= 0) {
        const existing = bucket.items[idx];
        if (existing.activity !== activity) {
          const items = bucket.items.slice();
          items[idx] = { ...existing, activity };
          next[Number(pid)] = { ...bucket, items };
          changed = true;
          continue;
        }
      }
      next[Number(pid)] = bucket;
    }
    if (changed) set({ sessionsByProject: next });
  },
});
```

- [ ] **Step 4: Run the tests**

```bash
npx vitest run src/store/sessionsSlice.test.ts
```

Expected: all three tests pass.

- [ ] **Step 5: Run typecheck**

```bash
npm run lint
```

Expected: passes. (The import of `AppState` may create a circular type reference — Zustand allows this because the module-level type doesn't get evaluated at runtime.)

- [ ] **Step 6: Commit**

```bash
git add src/store/sessionsSlice.ts src/store/sessionsSlice.test.ts
git commit -m "feat(store): patchActivity and selectSessionActivity for sessions"
```

---

### Task 10: Add `onSessionActivity` IPC wrapper + attach in HistoryView

The backend emits `session:{sid}:activity` when watching open sessions. Subscribe alongside the existing `onSessionAppend` in `HistoryView`.

**Files:**
- Modify: `src/lib/tauri.ts`
- Modify: `src/components/history/HistoryView.tsx`

- [ ] **Step 1: Add wrapper in `src/lib/tauri.ts`**

In `src/lib/tauri.ts`, change the imports line at the top from:

```ts
import type { Project, SessionMeta, SessionHistory, HistoryBlock, Action, ActionInput, ActionPatch, DetectedScript, GitStatus, GitUser } from '../types';
```

to:

```ts
import type { Project, SessionMeta, SessionActivity, SessionHistory, HistoryBlock, Action, ActionInput, ActionPatch, DetectedScript, GitStatus, GitUser } from '../types';
```

Below the existing `onSessionAppend` definition (around line 29-30), add:

```ts
  onSessionActivity: (sessionId: string, cb: (activity: SessionActivity) => void): Promise<UnlistenFn> =>
    listen<{ activity: SessionActivity }>(`session:${sessionId}:activity`, e => cb(e.payload.activity)),
```

- [ ] **Step 2: Wire it in `HistoryView.tsx`**

In `src/components/history/HistoryView.tsx`, change the useEffect at lines 26-36 from:

```tsx
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    tauri.openSessionWatch(projectId, sessionId).catch(() => {});
    tauri.onSessionAppend(sessionId, (blocks) => {
      setData(prev => prev ? ({ ...prev, blocks: [...prev.blocks, ...blocks] }) : prev);
    }).then(fn => { unlisten = fn; });
    return () => {
      if (unlisten) unlisten();
      tauri.closeSessionWatch(sessionId).catch(() => {});
    };
  }, [projectId, sessionId]);
```

to:

```tsx
  const patchActivity = useStore(s => s.patchActivity);

  useEffect(() => {
    let unlistenAppend: (() => void) | null = null;
    let unlistenActivity: (() => void) | null = null;
    tauri.openSessionWatch(projectId, sessionId).catch(() => {});
    tauri.onSessionAppend(sessionId, (blocks) => {
      setData(prev => prev ? ({ ...prev, blocks: [...prev.blocks, ...blocks] }) : prev);
    }).then(fn => { unlistenAppend = fn; });
    tauri.onSessionActivity(sessionId, (activity) => {
      patchActivity(sessionId, activity);
    }).then(fn => { unlistenActivity = fn; });
    return () => {
      if (unlistenAppend) unlistenAppend();
      if (unlistenActivity) unlistenActivity();
      tauri.closeSessionWatch(sessionId).catch(() => {});
    };
  }, [projectId, sessionId, patchActivity]);
```

- [ ] **Step 3: Run lint + tests**

```bash
npm run lint && npm test
```

Expected: both pass.

- [ ] **Step 4: Commit**

```bash
git add src/lib/tauri.ts src/components/history/HistoryView.tsx
git commit -m "feat(sessions): wire onSessionActivity listener into HistoryView"
```

---

### Task 11: Add `refreshActivity(projectId)`

Re-fetches the *currently visible* count of sessions for a project and patches only the `activity` field of existing entries — never overwrites `title`, `messageCount`, etc.

**Files:**
- Modify: `src/store/sessionsSlice.ts`
- Modify: `src/store/sessionsSlice.test.ts`

- [ ] **Step 1: Add failing test**

Append to `src/store/sessionsSlice.test.ts`:

```ts
import { vi } from 'vitest';
import { tauri } from '../lib/tauri';

describe('refreshActivity', () => {
  beforeEach(() => {
    useStore.setState({ sessionsByProject: {} });
    vi.restoreAllMocks();
  });

  it('patches activity but preserves title', async () => {
    useStore.setState({
      sessionsByProject: {
        1: { items: [{ ...fakeMeta('a', 1, 'idle'), title: 'My Rename' }], hasMore: false },
      },
    });
    vi.spyOn(tauri, 'listSessions').mockResolvedValue([
      { ...fakeMeta('a', 1, 'running'), title: 'WHATEVER-FROM-BACKEND' },
    ]);
    await useStore.getState().refreshActivity(1);
    const item = useStore.getState().sessionsByProject[1].items[0];
    expect(item.activity).toBe('running');
    expect(item.title).toBe('My Rename');
  });

  it('does nothing when project bucket is missing', async () => {
    const spy = vi.spyOn(tauri, 'listSessions');
    await useStore.getState().refreshActivity(42);
    expect(spy).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run — expect type error**

```bash
npx vitest run src/store/sessionsSlice.test.ts
```

Expected: TypeScript error — `refreshActivity` is not on the store.

- [ ] **Step 3: Implement `refreshActivity`**

In `src/store/sessionsSlice.ts`:

Add to the `SessionsSlice` type:

```ts
  refreshActivity: (projectId: number) => Promise<void>;
```

Implement inside `createSessionsSlice`:

```ts
  refreshActivity: async (projectId) => {
    const current = get().sessionsByProject[projectId];
    if (!current) return;
    const fresh = await tauri.listSessions(projectId, current.items.length || PAGE, 0);
    const byId = new Map(fresh.map(s => [s.id, s.activity]));
    const items = current.items.map(s =>
      byId.has(s.id) ? { ...s, activity: byId.get(s.id)! } : s
    );
    set({ sessionsByProject: {
      ...get().sessionsByProject,
      [projectId]: { ...current, items },
    }});
  },
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run src/store/sessionsSlice.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/store/sessionsSlice.ts src/store/sessionsSlice.test.ts
git commit -m "feat(store): refreshActivity preserves session fields except activity"
```

---

### Task 12: Polling lifecycle (`startActivityPolling`, `stopActivityPolling`) + AppShell wiring

`startActivityPolling` starts a focus-gated 10s `setInterval`. `stopActivityPolling` clears everything. Lifecycle is mounted once in `AppShell.tsx`.

**Files:**
- Modify: `src/store/sessionsSlice.ts`
- Modify: `src/components/layout/AppShell.tsx`

- [ ] **Step 1: Add the polling lifecycle to the slice**

In `src/store/sessionsSlice.ts`, add a module-level closure (NOT inside the slice — these are side-effecting timers we don't want serialized in state). Place these above `createSessionsSlice`:

```ts
let pollIntervalId: ReturnType<typeof setInterval> | null = null;
let focusHandler: (() => void) | null = null;
let blurHandler: (() => void) | null = null;

const POLL_INTERVAL_MS = 10_000;

function clearPoll() {
  if (pollIntervalId !== null) {
    clearInterval(pollIntervalId);
    pollIntervalId = null;
  }
}
```

Add to the `SessionsSlice` type:

```ts
  startActivityPolling: () => void;
  stopActivityPolling: () => void;
```

Implement inside `createSessionsSlice`:

```ts
  startActivityPolling: () => {
    const tick = () => {
      const projectIds = Object.keys(get().sessionsByProject).map(Number);
      for (const pid of projectIds) {
        get().refreshActivity(pid).catch(() => {});
      }
    };
    focusHandler = () => {
      clearPoll();
      tick();
      pollIntervalId = setInterval(tick, POLL_INTERVAL_MS);
    };
    blurHandler = () => clearPoll();
    window.addEventListener('focus', focusHandler);
    window.addEventListener('blur', blurHandler);
    if (document.hasFocus()) focusHandler();
  },
  stopActivityPolling: () => {
    clearPoll();
    if (focusHandler) window.removeEventListener('focus', focusHandler);
    if (blurHandler) window.removeEventListener('blur', blurHandler);
    focusHandler = null;
    blurHandler = null;
  },
```

The store has no concept of a single "active project" — `projectsSlice` only tracks `expandedProjectIds: Set<number>`. The polling tick iterates over every project bucket present in `sessionsByProject` (typically ≤10 projects ever loaded, each with ≤50 sessions ≤8 KiB tail-reads), which is well below any cost threshold.

- [ ] **Step 2: Wire lifecycle in AppShell**

Read `src/components/layout/AppShell.tsx` to find an appropriate place for a single `useEffect`. Add:

```tsx
import { useEffect } from 'react';
import { useStore } from '../../store';

// ...inside the AppShell component, near other useEffects:
const start = useStore(s => s.startActivityPolling);
const stop = useStore(s => s.stopActivityPolling);
useEffect(() => {
  start();
  return () => stop();
}, [start, stop]);
```

(If `AppShell.tsx` doesn't import `useEffect` yet, add it; if it doesn't import `useStore`, add that too. Use the existing import style for the file.)

- [ ] **Step 3: Run lint + tests**

```bash
npm run lint && npm test
```

Expected: passes. Lifecycle is not unit-tested (setInterval timing in jsdom is brittle per spec §10).

- [ ] **Step 4: Commit**

```bash
git add src/store/sessionsSlice.ts src/components/layout/AppShell.tsx
git commit -m "feat(sessions): focus-gated 10s activity polling lifecycle"
```

---

## Phase F — UI

### Task 13: SessionItem dot driven by activity

**Files:**
- Modify: `src/components/sidebar/SessionItem.tsx`
- Create: `src/components/sidebar/SessionItem.test.tsx`

- [ ] **Step 1: Add a failing test**

Create `src/components/sidebar/SessionItem.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { SessionItem } from './SessionItem';
import type { SessionMeta } from '../../types';

function meta(activity: SessionMeta['activity']): SessionMeta {
  return {
    id: 'abc12345',
    projectId: 1,
    title: 'Test session',
    messageCount: 1,
    lastModified: Date.now(),
    gitBranch: null,
    cwd: null,
    activity,
  };
}

describe('SessionItem dot', () => {
  it('uses bg-success class when running', () => {
    const { container } = render(<SessionItem session={meta('running')} onClick={() => {}} />);
    const dot = container.querySelector('span.rounded-full');
    expect(dot?.className).toMatch(/bg-success/);
  });

  it('uses bg-accent class when waitingUser', () => {
    const { container } = render(<SessionItem session={meta('waitingUser')} onClick={() => {}} />);
    const dot = container.querySelector('span.rounded-full');
    expect(dot?.className).toMatch(/bg-accent/);
  });

  it('uses bg-warn class when waitingTool', () => {
    const { container } = render(<SessionItem session={meta('waitingTool')} onClick={() => {}} />);
    const dot = container.querySelector('span.rounded-full');
    expect(dot?.className).toMatch(/bg-warn/);
  });

  it('uses bg-muted class when idle', () => {
    const { container } = render(<SessionItem session={meta('idle')} onClick={() => {}} />);
    const dot = container.querySelector('span.rounded-full');
    expect(dot?.className).toMatch(/bg-muted/);
  });
});
```

- [ ] **Step 2: Run the test — it should fail**

```bash
npx vitest run src/components/sidebar/SessionItem.test.tsx
```

Expected: tests fail because the dot is always `bg-muted`.

- [ ] **Step 3: Update `SessionItem.tsx`**

In `src/components/sidebar/SessionItem.tsx`, change the imports to add:

```tsx
import { ACTIVITY_DOT, ACTIVITY_LABEL } from '../../lib/activity';
```

Change the dot span (line 27) from:

```tsx
      <span className={`w-[5px] h-[5px] rounded-full shrink-0 ${active ? 'bg-muted' : 'bg-muted'}`} />
```

to:

```tsx
      <span
        className={`w-[5px] h-[5px] rounded-full shrink-0 ${ACTIVITY_DOT[session.activity]}`}
        title={ACTIVITY_LABEL[session.activity]}
      />
```

- [ ] **Step 4: Run the test**

```bash
npx vitest run src/components/sidebar/SessionItem.test.tsx
```

Expected: all four tests pass.

- [ ] **Step 5: Run full lint + test suite**

```bash
npm run lint && npm test
```

Expected: passes.

- [ ] **Step 6: Commit**

```bash
git add src/components/sidebar/SessionItem.tsx src/components/sidebar/SessionItem.test.tsx
git commit -m "feat(ui): drive SessionItem dot color from activity"
```

---

### Task 14: TabBar dot for session tabs

**Files:**
- Modify: `src/components/center/TabBar.tsx`

- [ ] **Step 1: Inspect TabBar dot insertion site**

The tab title span is at lines 76-78 of `src/components/center/TabBar.tsx`:

```tsx
            <span className="mr-1.5 text-muted">
              <TabIcon tab={t} />
            </span>
```

The new activity dot will go **before** the icon span — only when `t.kind === 'session'`.

- [ ] **Step 2: Add imports and the dot**

In `src/components/center/TabBar.tsx`, add at the top imports:

```tsx
import { useStore } from '../../store';
import { ACTIVITY_DOT, ACTIVITY_LABEL } from '../../lib/activity';
import { selectSessionActivity } from '../../store/sessionsSlice';
```

(if `useStore` is already imported, don't duplicate)

Create a helper component just above `TabIcon`:

```tsx
function TabActivityDot({ sessionId }: { sessionId: string }) {
  const activity = useStore(selectSessionActivity(sessionId));
  return (
    <span
      className={`mr-1.5 w-[5px] h-[5px] rounded-full ${ACTIVITY_DOT[activity]}`}
      title={ACTIVITY_LABEL[activity]}
    />
  );
}
```

Then inside the `tabs.map(t => ...)` render, immediately after the opening `<div ...>` for each tab (and before the existing `<span className="mr-1.5 text-muted"><TabIcon tab={t} /></span>`), add:

```tsx
            {t.kind === 'session' && <TabActivityDot sessionId={t.sessionId} />}
```

Verify the field name on the tab is `sessionId` by reading `src/store/tabsSlice.ts`. (Tab kinds: `session`, `action`, `terminal`. The session kind has `sessionId`, per the spec context.)

- [ ] **Step 3: Type-check and run tests**

```bash
npm run lint && npm test
```

Expected: passes. There's no unit test for `TabBar` today; a smoke test would require store + tab fixtures — covered by the manual Task 16.

- [ ] **Step 4: Commit**

```bash
git add src/components/center/TabBar.tsx
git commit -m "feat(ui): activity dot on session tabs in TabBar"
```

---

### Task 15: HistoryHeader badge driven by activity

Replace the hardcoded `<span ...><span className="...bg-accent" /> aktywna</span>` at `HistoryHeader.tsx:95-98` with a dynamic version. Sourced from the store (matches the existing `storeTitle` override pattern in `HistoryView`).

**Files:**
- Modify: `src/components/history/HistoryView.tsx` — pass activity to header
- Modify: `src/components/history/HistoryHeader.tsx` — render dynamic badge

- [ ] **Step 1: Override `meta.activity` from store in HistoryView**

Open `src/components/history/HistoryView.tsx`. Find the `meta` `useMemo` (currently around lines 54-60):

```tsx
  const meta = useMemo(() => {
    if (!data) return null;
    if (storeTitle && storeTitle !== data.meta.title) {
      return { ...data.meta, title: storeTitle };
    }
    return data.meta;
  }, [data, storeTitle]);
```

Add another selector that pulls activity from the store, just above the `meta` memo. Use the helper from sessionsSlice:

```tsx
  const storeActivity = useStore(s => {
    const items = s.sessionsByProject[projectId]?.items;
    return items?.find(i => i.id === sessionId)?.activity;
  });
```

Then update `meta` to merge `storeActivity` when present:

```tsx
  const meta = useMemo(() => {
    if (!data) return null;
    const patched = { ...data.meta };
    if (storeTitle && storeTitle !== data.meta.title) patched.title = storeTitle;
    if (storeActivity && storeActivity !== data.meta.activity) patched.activity = storeActivity;
    return patched;
  }, [data, storeTitle, storeActivity]);
```

- [ ] **Step 2: Replace the placeholder badge in `HistoryHeader.tsx`**

In `src/components/history/HistoryHeader.tsx`, add at the imports:

```tsx
import { ACTIVITY_DOT, ACTIVITY_LABEL, ACTIVITY_ICON } from '../../lib/activity';
import { Icon } from '../shared/Icon';
```

Replace lines 95-98:

```tsx
        <span className="inline-flex items-center gap-1.5 text-[10px] font-mono text-accent bg-bg-elev-2 px-[7px] py-0.5 rounded-full">
          <span className="w-1 h-1 rounded-full bg-accent" />
          aktywna
        </span>
```

with:

```tsx
        <span
          className={`inline-flex items-center gap-1.5 text-[10px] font-mono ${ACTIVITY_DOT[meta.activity]} text-bg px-[7px] py-0.5 rounded-full`}
          title={ACTIVITY_LABEL[meta.activity]}
        >
          <Icon
            name={ACTIVITY_ICON[meta.activity]}
            className={`w-3 h-3 ${meta.activity === 'running' ? 'animate-spin' : ''}`}
          />
          {ACTIVITY_LABEL[meta.activity]}
        </span>
```

- [ ] **Step 3: Run lint + tests**

```bash
npm run lint && npm test
```

Expected: passes.

- [ ] **Step 4: Commit**

```bash
git add src/components/history/HistoryView.tsx src/components/history/HistoryHeader.tsx
git commit -m "feat(ui): drive HistoryHeader badge from session activity"
```

---

## Phase G — Validation

### Task 16: Manual smoke test in dev

Verify end-to-end behavior in the real app. This catches anything jsdom can't test (Tauri IPC, watcher debouncing, polling under focus events).

- [ ] **Step 1: Start the dev app**

```bash
npm run tauri dev
```

Wait for the window to open and a project with existing Claude Code sessions to be selected.

- [ ] **Step 2: Verify sidebar dots**

- Sidebar should show colored dots next to session titles:
  - Recently active session → green (`bg-success`).
  - Session left mid-conversation (assistant text last) → blue (`bg-accent`).
  - Stale session (>24h) → grey (`bg-muted`).
- Hover any dot — the tooltip should show the Polish label (e.g. "Bezczynna").

- [ ] **Step 3: Verify TabBar dot**

- Open a session in history mode (single click).
- The TabBar entry for that session should display a dot of the same color as in the sidebar, before the existing tab icon (`◇`).

- [ ] **Step 4: Verify HistoryHeader badge**

- Inside the open history tab, the header badge (formerly always "aktywna") should now show the dynamic state with the appropriate icon (spinner for `running`, etc.) and label.

- [ ] **Step 5: Verify push events**

- With the same session open in history mode, in another terminal run `claude --resume <session-id>` in the project directory and send a quick prompt.
- The sidebar dot, TabBar dot, and HistoryHeader badge should change to `running` (green/spinner) within a couple of seconds of the JSONL file being appended — without waiting for the 10s poll.

- [ ] **Step 6: Verify polling**

- Stop the external `claude` process. Wait ~10–15s and observe the dot transitioning back to `waitingUser` or similar (depending on what the last event was). This confirms the focus-gated 10s polling.

- [ ] **Step 7: Verify focus gating**

- Click out of the app (defocus the window). The 10s polling should stop. There's no externally visible signal — verify by leaving the app blurred for a minute, then refocusing; the dots should refresh on focus.

- [ ] **Step 8: Final commit (only if Steps 2-7 surfaced no issues)**

No code change. If a regression was found, fix it in the relevant earlier task with a new commit before declaring done.

```bash
git log --oneline -20
```

Expected: 15 task commits + the two earlier spec commits. Sanity check that none are missing.

---

## Summary

This plan delivers session activity detection as a fully self-contained feature:

- **Backend**: a single new module (`sessions::activity`) that's a pure function over file path + clock, fully covered by unit tests. Integration into `reader` and `watcher` is small and surgical.
- **Frontend**: one new helper file, four store additions (`patchActivity`, `selectSessionActivity`, `refreshActivity`, polling lifecycle), three UI sites updated.
- **No schema changes, no settings changes, no PERSISTED_KEYS changes.** Pure derived state.
- **TDD throughout** — every code-changing step has a corresponding failing test first.
- **Frequent commits** — one per task, Conventional Commits style, no co-author.

Total: 16 tasks (15 implementation + 1 manual smoke).
