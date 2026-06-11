use std::collections::VecDeque;
use std::io::BufRead;
use std::path::Path;
use serde_json::Value;
use crate::sessions::activity::LastEvent;
use super::reader::is_meta_codex_text;

const TAIL_LINES: usize = 60;

pub(crate) fn read_tail_lines_codex(path: &Path) -> Option<Vec<String>> {
    if !path.extension().map(|e| e == "zst").unwrap_or(false) {
        return crate::sessions::activity::read_tail_lines(path);
    }
    let reader = super::reader::open_lines(path).ok()?;
    let mut tail: VecDeque<String> = VecDeque::with_capacity(TAIL_LINES);
    for line in reader.lines().map_while(Result::ok) {
        if tail.len() == TAIL_LINES {
            tail.pop_front();
        }
        tail.push_back(line);
    }
    Some(tail.into_iter().collect())
}

fn payload<'a>(v: &'a Value) -> Option<&'a Value> {
    if v.get("type").and_then(|t| t.as_str()) != Some("response_item") {
        return None;
    }
    v.get("payload")
}

fn output_exit_error(p: &Value) -> bool {
    match p.get("output") {
        Some(Value::String(s)) => serde_json::from_str::<Value>(s)
            .ok()
            .and_then(|inner| {
                inner
                    .get("metadata")
                    .and_then(|m| m.get("exit_code"))
                    .and_then(|c| c.as_i64())
            })
            .map(|code| code != 0)
            .unwrap_or(false),
        _ => false,
    }
}

pub(crate) fn find_last_significant_codex(lines: &[String]) -> Option<LastEvent> {
    let mut resolved_ids: std::collections::HashSet<String> = std::collections::HashSet::new();
    for line in lines {
        let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
        let Some(p) = payload(&v) else { continue };
        if matches!(
            p.get("type").and_then(|t| t.as_str()),
            Some("function_call_output") | Some("custom_tool_call_output")
        ) {
            if let Some(id) = p.get("call_id").and_then(|s| s.as_str()) {
                resolved_ids.insert(id.to_string());
            }
        }
    }

    for line in lines.iter().rev() {
        let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
        let Some(p) = payload(&v) else { continue };
        match p.get("type").and_then(|t| t.as_str()).unwrap_or("") {
            "message" => {
                let role = p.get("role").and_then(|r| r.as_str()).unwrap_or("");
                if role != "user" && role != "assistant" { continue; }
                let Some(arr) = p.get("content").and_then(|c| c.as_array()) else {
                    continue
                };
                let has_real_text = arr.iter().any(|i| {
                    let text = i.get("text").and_then(|t| t.as_str()).unwrap_or("");
                    !text.is_empty() && (role != "user" || !is_meta_codex_text(text))
                });
                if !has_real_text {
                    continue;
                }
                return Some(match role {
                    "user" => LastEvent::UserText,
                    _ => LastEvent::AssistantText,
                });
            }
            "function_call" | "custom_tool_call" | "local_shell_call" => {
                let id = p.get("call_id").and_then(|s| s.as_str()).unwrap_or("");
                if resolved_ids.contains(id) {
                    return Some(LastEvent::AssistantToolUseResolved);
                }
                return Some(LastEvent::AssistantToolUseUnresolved);
            }
            "function_call_output" | "custom_tool_call_output" => {
                return Some(LastEvent::UserToolResult {
                    is_error: output_exit_error(p),
                });
            }
            _ => continue,
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sessions::activity::LastEvent;

    fn last(lines: &[&str]) -> Option<LastEvent> {
        let owned: Vec<String> = lines.iter().map(|s| s.to_string()).collect();
        find_last_significant_codex(&owned)
    }

    #[test]
    fn user_message_means_running() {
        let lines = [r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"do it"}]}}"#];
        assert_eq!(last(&lines), Some(LastEvent::UserText));
    }

    #[test]
    fn meta_user_message_skipped() {
        let lines = [
            r#"{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"done"}]}}"#,
            r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<environment_context>x</environment_context>"}]}}"#,
        ];
        assert_eq!(last(&lines), Some(LastEvent::AssistantText));
    }

    #[test]
    fn unresolved_function_call() {
        let lines = [r#"{"type":"response_item","payload":{"type":"function_call","name":"shell","arguments":"{}","call_id":"c1"}}"#];
        assert_eq!(last(&lines), Some(LastEvent::AssistantToolUseUnresolved));
    }

    #[test]
    fn resolved_output_is_tool_result() {
        let lines = [
            r#"{"type":"response_item","payload":{"type":"function_call","name":"shell","arguments":"{}","call_id":"c1"}}"#,
            r#"{"type":"response_item","payload":{"type":"function_call_output","call_id":"c1","output":"{\"output\":\"ok\",\"metadata\":{\"exit_code\":0}}"}}"#,
        ];
        assert_eq!(
            last(&lines),
            Some(LastEvent::UserToolResult { is_error: false })
        );
    }

    #[test]
    fn failed_output_is_error_result() {
        let lines = [r#"{"type":"response_item","payload":{"type":"function_call_output","call_id":"c1","output":"{\"output\":\"boom\",\"metadata\":{\"exit_code\":2}}"}}"#];
        assert_eq!(
            last(&lines),
            Some(LastEvent::UserToolResult { is_error: true })
        );
    }

    #[test]
    fn empty_is_none() {
        assert_eq!(last(&[]), None);
    }

    #[test]
    fn developer_message_is_not_significant() {
        let lines = [r#"{"type":"response_item","payload":{"type":"message","role":"developer","content":[{"type":"input_text","text":"<permissions instructions>rules"}]}}"#];
        assert_eq!(last(&lines), None);
    }

    #[test]
    fn developer_message_after_assistant_does_not_mask_it() {
        let lines = [
            r#"{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"done"}]}}"#,
            r#"{"type":"response_item","payload":{"type":"message","role":"developer","content":[{"type":"input_text","text":"injected"}]}}"#,
        ];
        assert_eq!(last(&lines), Some(LastEvent::AssistantText));
    }

    #[test]
    fn tail_reads_zst_rollout() {
        use std::io::Write;
        let td = tempfile::TempDir::new().unwrap();
        let mut raw = String::new();
        for i in 0..100 {
            raw.push_str(&format!("{{\"type\":\"response_item\",\"payload\":{{\"type\":\"message\",\"role\":\"user\",\"content\":[{{\"type\":\"input_text\",\"text\":\"msg {i}\"}}]}}}}\n"));
        }
        let compressed = zstd::stream::encode_all(raw.as_bytes(), 0).unwrap();
        let p = td.path().join("rollout-x.jsonl.zst");
        std::fs::File::create(&p).unwrap().write_all(&compressed).unwrap();
        let lines = read_tail_lines_codex(&p).unwrap();
        assert_eq!(lines.len(), 60);
        assert!(lines.last().unwrap().contains("msg 99"));
    }

    #[test]
    fn tail_plain_file_delegates() {
        let td = tempfile::TempDir::new().unwrap();
        let p = td.path().join("rollout-y.jsonl");
        std::fs::write(&p, "line1\nline2\n").unwrap();
        let lines = read_tail_lines_codex(&p).unwrap();
        assert_eq!(lines, vec!["line1", "line2"]);
    }
}
