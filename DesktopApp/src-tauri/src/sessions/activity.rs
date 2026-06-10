use std::path::Path;
use crate::domain::SessionActivity;

const TAIL_BYTES: u64 = 8 * 1024;
const LIVE_WINDOW_MS: i64 = 5_000;
const TOOL_STALL_MS: i64 = 30_000;
const RUNNING_STALL_MS: i64 = 10 * 60 * 1000;
const WAITING_DECAY_MS: i64 = 4 * 60 * 60 * 1000;
const IDLE_HARD_CAP_MS: i64 = 24 * 60 * 60 * 1000;

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

#[derive(Debug, PartialEq)]
enum LastEvent {
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
    fn huge_assistant_text_truncates_correctly() {
        let td = TempDir::new().unwrap();
        let huge: String = "a".repeat(20_000);
        let body = format!(
            r#"{{"type":"user","uuid":"u1","message":{{"content":[{{"type":"text","text":"hi"}}]}}}}
{{"type":"assistant","uuid":"a1","message":{{"content":[{{"type":"text","text":"{huge}"}}]}}}}"#
        );
        let (p, mtime) = write_with_mtime(&td, "s.jsonl", &body);
        let result = compute_activity(&p, mtime + 60_000);
        assert!(
            matches!(result, SessionActivity::WaitingUser | SessionActivity::Idle),
            "got {result:?}"
        );
    }
}
