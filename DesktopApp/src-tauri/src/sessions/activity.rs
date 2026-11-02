use std::path::Path;
use crate::domain::SessionActivity;
use crate::domain::Provider;

const TAIL_BYTES: u64 = 8 * 1024;
const TAIL_WINDOWS: [u64; 4] = [TAIL_BYTES, 64 * 1024, 512 * 1024, 4 * 1024 * 1024];
const LIVE_WINDOW_MS: i64 = 5_000;
const TOOL_STALL_MS: i64 = 30_000;
const RUNNING_STALL_MS: i64 = 10 * 60 * 1000;
const WAITING_DECAY_MS: i64 = 4 * 60 * 60 * 1000;
const IDLE_HARD_CAP_MS: i64 = 24 * 60 * 60 * 1000;
const BACKGROUND_TASK_STALL_MS: i64 = 60 * 60 * 1000;
const BACKGROUND_TAIL_BYTES: u64 = 1024 * 1024;

pub fn compute_activity(path: &Path, now_ms: i64) -> SessionActivity {
    compute_activity_with(find_last_significant, read_tail_bytes, path, now_ms)
}

pub(crate) fn compute_activity_with(
    extractor: fn(&[String]) -> Option<LastEvent>,
    read_tail: fn(&Path, u64) -> Option<Vec<String>>,
    path: &Path,
    now_ms: i64,
) -> SessionActivity {
    let Some(age_ms) = file_age_ms(path, now_ms) else { return SessionActivity::Idle };

    if age_ms > IDLE_HARD_CAP_MS {
        return SessionActivity::Idle;
    }
    if age_ms < LIVE_WINDOW_MS {
        return SessionActivity::Running;
    }

    let Some(last) = find_in_growing_tail(extractor, read_tail, path) else { return SessionActivity::Idle };

    let waiting = match last {
        LastEvent::UserText | LastEvent::UserToolResult { is_error: false } => {
            if age_ms > RUNNING_STALL_MS {
                return SessionActivity::Idle;
            }
            return SessionActivity::Running;
        }
        LastEvent::SessionAway => return SessionActivity::Idle,
        LastEvent::AssistantToolUseUnresolved => {
            if age_ms < TOOL_STALL_MS {
                return SessionActivity::Running;
            }
            SessionActivity::WaitingTool
        }
        LastEvent::UserToolResult { is_error: true } => SessionActivity::WaitingUser,
        LastEvent::AssistantToolUseResolved => SessionActivity::WaitingUser,
        LastEvent::AssistantText => SessionActivity::WaitingUser,
    };

    if age_ms > WAITING_DECAY_MS {
        SessionActivity::Idle
    } else {
        waiting
    }
}

fn find_in_growing_tail(
    extractor: fn(&[String]) -> Option<LastEvent>,
    read_tail: fn(&Path, u64) -> Option<Vec<String>>,
    path: &Path,
) -> Option<LastEvent> {
    let len = path.metadata().ok()?.len();
    for window in TAIL_WINDOWS {
        if let Some(last) = extractor(&read_tail(path, window)?) {
            return Some(last);
        }
        if window >= len {
            break;
        }
    }
    None
}

fn file_age_ms(path: &Path, now_ms: i64) -> Option<i64> {
    let mtime_ms = path
        .metadata()
        .ok()?
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_millis() as i64;
    Some(now_ms - mtime_ms)
}

pub fn compute_activity_with_agents(path: &Path, running_agents: u32, now_ms: i64) -> SessionActivity {
    let Some(age_ms) = file_age_ms(path, now_ms) else { return SessionActivity::Idle };
    if running_agents > 0 && age_ms <= IDLE_HARD_CAP_MS {
        return SessionActivity::Running;
    }
    let activity = compute_activity(path, now_ms);
    if matches!(activity, SessionActivity::WaitingUser | SessionActivity::Idle)
        && age_ms <= BACKGROUND_TASK_STALL_MS
        && read_tail_bytes(path, BACKGROUND_TAIL_BYTES).is_some_and(|lines| has_pending_background_task(&lines))
    {
        return SessionActivity::Running;
    }
    activity
}

fn has_pending_background_task(lines: &[String]) -> bool {
    let mut started: Vec<String> = Vec::new();
    let mut finished: std::collections::HashSet<&str> = std::collections::HashSet::new();
    for line in lines {
        if line.contains("<task-notification>") {
            finished.extend(notified_task_ids(line));
        }
        if !line.contains("\"backgroundTaskId\"") { continue; }
        let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
        if v.get("type").and_then(|t| t.as_str()) != Some("user") { continue; }
        if let Some(id) = v.get("toolUseResult").and_then(|r| r.get("backgroundTaskId")).and_then(|id| id.as_str()) {
            started.push(id.to_string());
        }
    }
    started.iter().any(|id| !finished.contains(id.as_str()))
}

fn notified_task_ids(line: &str) -> impl Iterator<Item = &str> {
    line.split("<task-id>").skip(1).filter_map(|rest| rest.split_once("</task-id>").map(|(id, _)| id.trim()))
}

pub fn compute_activity_for(provider: Provider, path: &Path, now_ms: i64) -> SessionActivity {
    match provider {
        Provider::Claude => compute_activity_with(find_last_significant, read_tail_bytes, path, now_ms),
        Provider::Codex => compute_activity_with(
            crate::sessions::codex::activity::find_last_significant_codex,
            crate::sessions::codex::activity::read_tail_lines_codex,
            path,
            now_ms,
        ),
        Provider::Opencode => SessionActivity::Idle,
    }
}

pub(crate) fn read_tail_lines(path: &Path) -> Option<Vec<String>> {
    read_tail_bytes(path, TAIL_BYTES)
}

pub(crate) fn read_tail_bytes(path: &Path, max_bytes: u64) -> Option<Vec<String>> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = std::fs::File::open(path).ok()?;
    let len = f.metadata().ok()?.len();
    let start = len.saturating_sub(max_bytes);
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

#[derive(Debug, PartialEq)]
pub(crate) enum LastEvent {
    UserText,
    UserToolResult { is_error: bool },
    AssistantText,
    AssistantToolUseUnresolved,
    AssistantToolUseResolved,
    SessionAway,
}

use serde_json::Value;
use crate::sessions::parser::is_meta_user_content;

fn find_last_significant(lines: &[String]) -> Option<LastEvent> {
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

    for line in lines.iter().rev() {
        let Ok(v) = serde_json::from_str::<Value>(line) else { continue; };
        let kind = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
        match kind {
            "queue-operation" | "last-prompt" | "attachment" => continue,
            "system" => {
                let subtype = v.get("subtype").and_then(|s| s.as_str()).unwrap_or("");
                if subtype == "away_summary" {
                    return Some(LastEvent::SessionAway);
                }
                continue;
            }
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
        let mtime = p.metadata().unwrap().modified().unwrap()
            .duration_since(std::time::UNIX_EPOCH).unwrap()
            .as_millis() as i64;
        assert_eq!(compute_activity(&p, mtime + 60_000), SessionActivity::Idle);
    }

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
        assert_eq!(compute_activity(&p, mtime + 10_000), SessionActivity::Running);
    }

    #[test]
    fn tool_use_stale_returns_waiting_tool() {
        let td = TempDir::new().unwrap();
        let (p, mtime) = write_with_mtime(&td, "s.jsonl",
            r#"{"type":"assistant","uuid":"a1","message":{"content":[{"type":"tool_use","id":"t1","name":"read","input":{}}]}}"#);
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
    fn assistant_text_after_5h_returns_idle_via_waiting_decay() {
        let td = TempDir::new().unwrap();
        let (p, mtime) = write_with_mtime(&td, "s.jsonl",
            r#"{"type":"user","uuid":"u1","message":{"content":[{"type":"text","text":"hi"}]}}
{"type":"assistant","uuid":"a1","message":{"content":[{"type":"text","text":"hello"}]}}"#);
        let five_hours = 5 * 60 * 60 * 1000;
        assert_eq!(compute_activity(&p, mtime + five_hours), SessionActivity::Idle);
    }

    #[test]
    fn assistant_text_after_2h_still_waiting_user() {
        let td = TempDir::new().unwrap();
        let (p, mtime) = write_with_mtime(&td, "s.jsonl",
            r#"{"type":"user","uuid":"u1","message":{"content":[{"type":"text","text":"hi"}]}}
{"type":"assistant","uuid":"a1","message":{"content":[{"type":"text","text":"hello"}]}}"#);
        let two_hours = 2 * 60 * 60 * 1000;
        assert_eq!(compute_activity(&p, mtime + two_hours), SessionActivity::WaitingUser);
    }

    #[test]
    fn waiting_tool_after_5h_returns_idle_via_waiting_decay() {
        let td = TempDir::new().unwrap();
        let (p, mtime) = write_with_mtime(&td, "s.jsonl",
            r#"{"type":"assistant","uuid":"a1","message":{"content":[{"type":"tool_use","id":"t1","name":"read","input":{}}]}}"#);
        let five_hours = 5 * 60 * 60 * 1000;
        assert_eq!(compute_activity(&p, mtime + five_hours), SessionActivity::Idle);
    }

    #[test]
    fn tool_result_error_after_5h_returns_idle_via_waiting_decay() {
        let td = TempDir::new().unwrap();
        let (p, mtime) = write_with_mtime(&td, "s.jsonl",
            r#"{"type":"user","uuid":"u1","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"boom","is_error":true}]}}"#);
        let five_hours = 5 * 60 * 60 * 1000;
        assert_eq!(compute_activity(&p, mtime + five_hours), SessionActivity::Idle);
    }

    #[test]
    fn user_text_after_5h_returns_idle_via_running_stall() {
        let td = TempDir::new().unwrap();
        let (p, mtime) = write_with_mtime(&td, "s.jsonl",
            r#"{"type":"user","uuid":"u1","message":{"content":[{"type":"text","text":"do it"}]}}"#);
        let five_hours = 5 * 60 * 60 * 1000;
        assert_eq!(compute_activity(&p, mtime + five_hours), SessionActivity::Idle);
    }

    #[test]
    fn user_text_after_11min_returns_idle() {
        let td = TempDir::new().unwrap();
        let (p, mtime) = write_with_mtime(&td, "s.jsonl",
            r#"{"type":"user","uuid":"u1","message":{"content":[{"type":"text","text":"do it"}]}}"#);
        let eleven_min = 11 * 60 * 1000;
        assert_eq!(compute_activity(&p, mtime + eleven_min), SessionActivity::Idle);
    }

    #[test]
    fn user_text_at_exactly_stall_threshold_returns_running() {
        let td = TempDir::new().unwrap();
        let (p, mtime) = write_with_mtime(&td, "s.jsonl",
            r#"{"type":"user","uuid":"u1","message":{"content":[{"type":"text","text":"do it"}]}}"#);
        assert_eq!(compute_activity(&p, mtime + RUNNING_STALL_MS), SessionActivity::Running);
    }

    #[test]
    fn user_tool_result_ok_after_11min_returns_idle() {
        let td = TempDir::new().unwrap();
        let (p, mtime) = write_with_mtime(&td, "s.jsonl",
            r#"{"type":"user","uuid":"u1","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"ok","is_error":false}]}}"#);
        let eleven_min = 11 * 60 * 1000;
        assert_eq!(compute_activity(&p, mtime + eleven_min), SessionActivity::Idle);
    }

    #[test]
    fn away_summary_after_assistant_text_returns_idle() {
        let td = TempDir::new().unwrap();
        let body = r#"{"type":"user","uuid":"u1","message":{"content":[{"type":"text","text":"hi"}]}}
{"type":"assistant","uuid":"a1","message":{"content":[{"type":"text","text":"done"}]}}
{"type":"system","uuid":"s1","subtype":"stop_hook_summary"}
{"type":"system","uuid":"s2","subtype":"turn_duration","durationMs":1234,"messageCount":2}
{"type":"system","uuid":"s3","subtype":"away_summary","content":"recap of work"}"#;
        let (p, mtime) = write_with_mtime(&td, "s.jsonl", body);
        assert_eq!(compute_activity(&p, mtime + 60_000), SessionActivity::Idle);
    }

    #[test]
    fn user_text_after_away_summary_returns_running() {
        let td = TempDir::new().unwrap();
        let body = r#"{"type":"assistant","uuid":"a1","message":{"content":[{"type":"text","text":"done"}]}}
{"type":"system","uuid":"s1","subtype":"away_summary","content":"recap"}
{"type":"user","uuid":"u2","message":{"content":[{"type":"text","text":"i'm back"}]}}"#;
        let (p, mtime) = write_with_mtime(&td, "s.jsonl", body);
        assert_eq!(compute_activity(&p, mtime + 60_000), SessionActivity::Running);
    }

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
    fn live_agents_survive_the_running_stall_window() {
        let td = TempDir::new().unwrap();
        let (p, mtime) = write_with_mtime(&td, "s.jsonl",
            r#"{"type":"user","uuid":"u1","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"ok","is_error":false}]}}"#);
        let twelve_min = 12 * 60 * 1000;
        assert_eq!(compute_activity(&p, mtime + twelve_min), SessionActivity::Idle);
        assert_eq!(compute_activity_with_agents(&p, 2, mtime + twelve_min), SessionActivity::Running);
    }

    #[test]
    fn live_agents_do_not_resurrect_a_day_old_session() {
        let td = TempDir::new().unwrap();
        let (p, mtime) = write_with_mtime(&td, "s.jsonl",
            r#"{"type":"assistant","uuid":"a1","message":{"content":[{"type":"text","text":"hi"}]}}"#);
        let twenty_five_hours = 25 * 60 * 60 * 1000;
        assert_eq!(compute_activity_with_agents(&p, 1, mtime + twenty_five_hours), SessionActivity::Idle);
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
        assert_eq!(compute_activity(&p, mtime + 60_000), SessionActivity::WaitingUser);
    }

    fn bulky_trailer() -> String {
        let pad = "p".repeat(4_000);
        [
            format!(r#"{{"type":"attachment","attachment":{{"type":"skill_listing","content":"{pad}"}}}}"#),
            format!(r#"{{"type":"api-request-blob","message":{{"content":[{{"type":"thinking","thinking":"{pad}"}}]}}}}"#),
            format!(r#"{{"type":"api-request","request":"{pad}"}}"#),
            r#"{"type":"last-prompt","lastPrompt":"OK"}"#.to_string(),
            r#"{"type":"ai-title","aiTitle":"Title"}"#.to_string(),
            r#"{"type":"mode","mode":"normal"}"#.to_string(),
            r#"{"type":"permission-mode","permissionMode":"bypassPermissions"}"#.to_string(),
            r#"{"type":"atis-latch","value":false}"#.to_string(),
            r#"{"type":"bridge-session","sessionId":"b1"}"#.to_string(),
        ]
        .join("\n")
    }

    #[test]
    fn user_text_followed_by_bulky_metadata_returns_running() {
        let td = TempDir::new().unwrap();
        let body = format!(
            "{}\n{}",
            r#"{"type":"user","uuid":"u1","message":{"content":[{"type":"text","text":"OK, dzialaj"}]}}"#,
            bulky_trailer(),
        );
        let (p, mtime) = write_with_mtime(&td, "s.jsonl", &body);
        assert_eq!(compute_activity(&p, mtime + 60_000), SessionActivity::Running);
    }

    #[test]
    fn assistant_text_followed_by_bulky_metadata_returns_waiting_user() {
        let td = TempDir::new().unwrap();
        let body = format!(
            "{}\n{}\n{}",
            r#"{"type":"user","uuid":"u1","message":{"content":[{"type":"text","text":"hi"}]}}"#,
            r#"{"type":"assistant","uuid":"a1","message":{"content":[{"type":"text","text":"done"}]}}"#,
            bulky_trailer(),
        );
        let (p, mtime) = write_with_mtime(&td, "s.jsonl", &body);
        assert_eq!(compute_activity(&p, mtime + 60_000), SessionActivity::WaitingUser);
    }

    #[test]
    fn metadata_only_file_larger_than_every_window_returns_idle() {
        let td = TempDir::new().unwrap();
        let line = format!(r#"{{"type":"attachment","content":"{}"}}"#, "p".repeat(64 * 1024));
        let body = vec![line; 80].join("\n");
        let (p, mtime) = write_with_mtime(&td, "s.jsonl", &body);
        assert_eq!(compute_activity(&p, mtime + 60_000), SessionActivity::Idle);
    }

    const USER_PROMPT: &str = r#"{"type":"user","uuid":"u0","message":{"content":[{"type":"text","text":"wydaj wersje"}]}}"#;
    const AWAY_SUMMARY: &str = r#"{"type":"system","uuid":"s9","subtype":"away_summary","content":"recap"}"#;

    fn background_start(task_id: &str) -> String {
        format!(
            r#"{{"type":"assistant","uuid":"a-{task_id}","message":{{"content":[{{"type":"tool_use","id":"t-{task_id}","name":"Bash","input":{{"command":"gh run watch 1","run_in_background":true}}}}]}}}}
{{"type":"user","uuid":"u-{task_id}","message":{{"content":[{{"tool_use_id":"t-{task_id}","type":"tool_result","content":"Command running in background with ID: {task_id}.","is_error":false}}]}},"toolUseResult":{{"stdout":"","stderr":"","interrupted":false,"backgroundTaskId":"{task_id}"}}}}"#
        )
    }

    fn turn_end(text: &str) -> String {
        format!(
            r#"{{"type":"assistant","uuid":"a-end","message":{{"content":[{{"type":"text","text":"{text}"}}]}}}}
{{"type":"system","uuid":"s1","subtype":"stop_hook_summary"}}
{{"type":"system","uuid":"s2","subtype":"turn_duration","durationMs":1234}}"#
        )
    }

    fn notification(task_id: &str) -> String {
        format!(r#"<task-notification>\n<task-id>{task_id}</task-id>\n<status>completed</status>\n</task-notification>"#)
    }

    fn delivered_when_idle(task_id: &str) -> String {
        let text = notification(task_id);
        format!(
            r#"{{"type":"queue-operation","operation":"enqueue","content":"{text}"}}
{{"type":"queue-operation","operation":"dequeue"}}
{{"type":"user","uuid":"u-n-{task_id}","message":{{"role":"user","content":"{text}"}}}}"#
        )
    }

    fn delivered_mid_turn(task_id: &str) -> String {
        let text = notification(task_id);
        format!(
            r#"{{"type":"queue-operation","operation":"enqueue","content":"{text}"}}
{{"type":"queue-operation","operation":"remove","content":"{text}"}}
{{"type":"attachment","attachment":{{"type":"queued_command","prompt":"{text}"}}}}"#
        )
    }

    fn session(parts: &[&str]) -> (TempDir, PathBuf, i64) {
        let td = TempDir::new().unwrap();
        let (p, mtime) = write_with_mtime(&td, "s.jsonl", &parts.join("\n"));
        (td, p, mtime)
    }

    #[test]
    fn pending_background_task_keeps_a_finished_turn_running() {
        let (_td, p, mtime) = session(&[USER_PROMPT, &background_start("b1"), &turn_end("Czekam na wynik buildu.")]);
        assert_eq!(compute_activity(&p, mtime + 60_000), SessionActivity::WaitingUser);
        assert_eq!(compute_activity_with_agents(&p, 0, mtime + 60_000), SessionActivity::Running);
    }

    #[test]
    fn pending_background_task_outlasts_the_away_summary() {
        let (_td, p, mtime) = session(&[USER_PROMPT, &background_start("b1"), &turn_end("Czekam."), AWAY_SUMMARY]);
        assert_eq!(compute_activity(&p, mtime + 60_000), SessionActivity::Idle);
        assert_eq!(compute_activity_with_agents(&p, 0, mtime + 60_000), SessionActivity::Running);
    }

    #[test]
    fn background_task_finished_while_idle_releases_the_session() {
        let (_td, p, mtime) = session(&[
            USER_PROMPT, &background_start("b1"), &turn_end("Czekam."), AWAY_SUMMARY,
            &delivered_when_idle("b1"), &turn_end("Build przeszedł."),
        ]);
        assert_eq!(compute_activity_with_agents(&p, 0, mtime + 60_000), SessionActivity::WaitingUser);
    }

    #[test]
    fn background_task_counts_as_finished_from_the_moment_it_is_enqueued() {
        let enqueued = format!(r#"{{"type":"queue-operation","operation":"enqueue","content":"{}"}}"#, notification("b1"));
        let (_td, p, mtime) = session(&[USER_PROMPT, &background_start("b1"), &turn_end("Czekam."), &enqueued]);
        assert_eq!(compute_activity_with_agents(&p, 0, mtime + 60_000), SessionActivity::WaitingUser);
    }

    #[test]
    fn background_task_finished_mid_turn_releases_the_session() {
        let (_td, p, mtime) = session(&[
            USER_PROMPT, &background_start("b1"), &delivered_mid_turn("b1"), &turn_end("Gotowe."),
        ]);
        assert_eq!(compute_activity_with_agents(&p, 0, mtime + 60_000), SessionActivity::WaitingUser);
    }

    #[test]
    fn one_unfinished_background_task_is_enough_to_keep_running() {
        let (_td, p, mtime) = session(&[
            USER_PROMPT, &background_start("b1"), &background_start("b2"),
            &delivered_mid_turn("b1"), &turn_end("Czekam na drugi."),
        ]);
        assert_eq!(compute_activity_with_agents(&p, 0, mtime + 60_000), SessionActivity::Running);
    }

    #[test]
    fn background_task_silent_past_the_stall_window_stops_forcing_running() {
        let (_td, p, mtime) = session(&[USER_PROMPT, &background_start("b1"), &turn_end("Serwer działa.")]);
        let past = mtime + BACKGROUND_TASK_STALL_MS + 60_000;
        assert_eq!(compute_activity_with_agents(&p, 0, past), SessionActivity::WaitingUser);
    }

    #[test]
    fn pending_background_task_does_not_hide_a_permission_prompt() {
        let prompt = r#"{"type":"assistant","uuid":"a-perm","message":{"content":[{"type":"tool_use","id":"t-perm","name":"Bash","input":{"command":"git push"}}]}}"#;
        let (_td, p, mtime) = session(&[USER_PROMPT, &background_start("b1"), prompt]);
        assert_eq!(compute_activity_with_agents(&p, 0, mtime + 60_000), SessionActivity::WaitingTool);
    }

    #[test]
    fn background_task_started_far_back_in_the_file_is_still_found() {
        let trailer = bulky_trailer();
        let filler: Vec<&str> = std::iter::repeat_n(trailer.as_str(), 30).collect();
        let mut parts = vec![USER_PROMPT];
        let start = background_start("b1");
        parts.push(&start);
        parts.extend(filler);
        let end = turn_end("Czekam.");
        parts.push(&end);
        let (_td, p, mtime) = session(&parts);
        assert!(p.metadata().unwrap().len() > 256 * 1024);
        assert_eq!(compute_activity_with_agents(&p, 0, mtime + 60_000), SessionActivity::Running);
    }
}
