use std::path::Path;
use crate::domain::SessionActivity;

const TAIL_BYTES: u64 = 8 * 1024;
const LIVE_WINDOW_MS: i64 = 5_000;
const TOOL_STALL_MS: i64 = 30_000;
const IDLE_HARD_CAP_MS: i64 = 24 * 60 * 60 * 1000;

pub fn compute_activity(_path: &Path, _now_ms: i64) -> SessionActivity {
    SessionActivity::Idle
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
}
