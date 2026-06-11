use serde_json::Value;
use crate::domain::HistoryBlock;
use super::reader::is_meta_codex_text;

fn ts_ms(v: Option<&Value>) -> i64 {
    v.and_then(|x| x.as_str())
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .map(|d| d.timestamp_millis())
        .unwrap_or(0)
}

/// Parses one rollout line into zero or more `HistoryBlock`s. Codex response
/// items carry no per-item uuid, so blocks get a stable synthetic `cx-<line_no>-<block_idx>`
/// id (rollouts are append-only, so line numbers never shift, and block_idx within
/// a line ensures uniqueness across multi-content messages).
pub fn parse_codex_line(line_no: usize, line: &str) -> Result<Vec<HistoryBlock>, serde_json::Error> {
    let v: Value = serde_json::from_str(line)?;
    if v.get("type").and_then(|t| t.as_str()) != Some("response_item") {
        return Ok(vec![]);
    }
    let ts = ts_ms(v.get("timestamp"));
    let uuid_base = format!("cx-{line_no}");
    let Some(p) = v.get("payload") else { return Ok(vec![]) };
    let item_type = p.get("type").and_then(|t| t.as_str()).unwrap_or("");

    Ok(match item_type {
        "message" => parse_message(p, &uuid_base, ts),
        "reasoning" => parse_reasoning(p, &uuid_base, ts),
        "function_call" | "custom_tool_call" => parse_tool_call(p, &uuid_base, ts),
        "local_shell_call" => parse_local_shell_call(p, &uuid_base, ts),
        "function_call_output" | "custom_tool_call_output" => parse_tool_output(p, &uuid_base, ts),
        _ => vec![],
    })
}

fn parse_message(p: &Value, uuid_base: &str, ts: i64) -> Vec<HistoryBlock> {
    let role = p.get("role").and_then(|r| r.as_str()).unwrap_or("");
    let Some(arr) = p.get("content").and_then(|c| c.as_array()) else { return vec![] };
    let mut out = Vec::new();
    for item in arr {
        let text = item.get("text").and_then(|t| t.as_str()).unwrap_or("");
        if text.is_empty() { continue; }
        let uuid = format!("{uuid_base}-{}", out.len());
        match role {
            "user" => {
                if !is_meta_codex_text(text) {
                    out.push(HistoryBlock::UserText { uuid, timestamp: ts, text: text.to_string() });
                }
            }
            "assistant" => out.push(HistoryBlock::AssistantText { uuid, timestamp: ts, text: text.to_string() }),
            _ => {}
        }
    }
    out
}

fn parse_reasoning(p: &Value, uuid_base: &str, ts: i64) -> Vec<HistoryBlock> {
    let Some(arr) = p.get("summary").and_then(|s| s.as_array()) else { return vec![] };
    let text: String = arr.iter()
        .filter_map(|i| i.get("text").and_then(|t| t.as_str()))
        .collect::<Vec<_>>()
        .join("\n");
    if text.is_empty() { return vec![] }
    vec![HistoryBlock::AssistantThinking { uuid: format!("{uuid_base}-0"), timestamp: ts, text }]
}

fn parse_tool_call(p: &Value, uuid_base: &str, ts: i64) -> Vec<HistoryBlock> {
    let name = p.get("name").and_then(|n| n.as_str()).unwrap_or("tool").to_string();
    let raw_input = p.get("arguments")
        .or_else(|| p.get("input"))
        .map(|a| match a {
            Value::String(s) => serde_json::from_str::<Value>(s).unwrap_or(Value::String(s.clone())),
            other => other.clone(),
        })
        .unwrap_or(Value::Null);
    let input_summary = crate::sessions::parser::summarize_input(&raw_input);
    vec![HistoryBlock::ToolUse { uuid: format!("{uuid_base}-0"), timestamp: ts, name, input_summary, raw_input }]
}

fn parse_local_shell_call(p: &Value, uuid_base: &str, ts: i64) -> Vec<HistoryBlock> {
    let raw_input = p.get("action").cloned().unwrap_or(Value::Null);
    let input_summary = crate::sessions::parser::summarize_input(&raw_input);
    vec![HistoryBlock::ToolUse { uuid: format!("{uuid_base}-0"), timestamp: ts, name: "shell".into(), input_summary, raw_input }]
}

fn parse_tool_output(p: &Value, uuid_base: &str, ts: i64) -> Vec<HistoryBlock> {
    let raw = p.get("output");
    let (content, is_error) = match raw {
        Some(Value::String(s)) => match serde_json::from_str::<Value>(s) {
            Ok(inner) => {
                let text = inner.get("output").and_then(|o| o.as_str()).unwrap_or(s).to_string();
                let exit = inner.get("metadata").and_then(|m| m.get("exit_code")).and_then(|c| c.as_i64()).unwrap_or(0);
                (text, exit != 0)
            }
            Err(_) => (s.clone(), false),
        },
        Some(other) => (other.to_string(), false),
        None => (String::new(), false),
    };
    vec![HistoryBlock::ToolResult { uuid: format!("{uuid_base}-0"), timestamp: ts, content, is_error }]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::HistoryBlock;

    fn lines() -> Vec<String> {
        let s = include_str!("../../../tests/fixtures/codex-rollout.jsonl");
        s.lines().filter(|l| !l.trim().is_empty()).map(String::from).collect()
    }

    #[test]
    fn skips_session_meta_and_event_msg() {
        assert!(parse_codex_line(0, &lines()[0]).unwrap().is_empty());
        assert!(parse_codex_line(7, &lines()[7]).unwrap().is_empty());
    }

    #[test]
    fn skips_meta_user_instructions() {
        assert!(parse_codex_line(1, &lines()[1]).unwrap().is_empty());
    }

    #[test]
    fn parses_user_text_with_stable_uuid() {
        let blocks = parse_codex_line(2, &lines()[2]).unwrap();
        assert_eq!(blocks.len(), 1);
        assert!(matches!(&blocks[0], HistoryBlock::UserText { text, uuid, .. } if text == "Hello" && uuid == "cx-2-0"));
    }

    #[test]
    fn parses_reasoning_as_thinking() {
        let blocks = parse_codex_line(3, &lines()[3]).unwrap();
        assert!(matches!(&blocks[0], HistoryBlock::AssistantThinking { text, .. } if text == "Thinking about it"));
    }

    #[test]
    fn parses_function_call_as_tool_use() {
        let blocks = parse_codex_line(4, &lines()[4]).unwrap();
        assert!(matches!(&blocks[0], HistoryBlock::ToolUse { name, .. } if name == "shell"));
    }

    #[test]
    fn parses_function_call_output_as_tool_result() {
        let blocks = parse_codex_line(5, &lines()[5]).unwrap();
        assert!(matches!(&blocks[0], HistoryBlock::ToolResult { content, is_error: false, .. } if content.contains("file.txt")));
    }

    #[test]
    fn parses_assistant_text() {
        let blocks = parse_codex_line(6, &lines()[6]).unwrap();
        assert!(matches!(&blocks[0], HistoryBlock::AssistantText { text, .. } if text == "Done."));
    }

    #[test]
    fn nonzero_exit_code_marks_error() {
        let line = r#"{"timestamp":"2026-06-11T10:00:05.000Z","type":"response_item","payload":{"type":"function_call_output","call_id":"c","output":"{\"output\":\"boom\",\"metadata\":{\"exit_code\":1}}"}}"#;
        let blocks = parse_codex_line(0, line).unwrap();
        assert!(matches!(&blocks[0], HistoryBlock::ToolResult { is_error: true, .. }));
    }

    #[test]
    fn parses_local_shell_call_as_shell_tool_use() {
        let line = r#"{"timestamp":"2026-06-11T10:00:04.000Z","type":"response_item","payload":{"type":"local_shell_call","call_id":"c2","action":{"command":["cat","x"]}}}"#;
        let blocks = parse_codex_line(9, line).unwrap();
        assert_eq!(blocks.len(), 1);
        assert!(matches!(&blocks[0], HistoryBlock::ToolUse { name, uuid, .. } if name == "shell" && uuid == "cx-9-0"));
    }

    #[test]
    fn parses_custom_tool_call_output_as_tool_result() {
        let line = r#"{"timestamp":"2026-06-11T10:00:05.000Z","type":"response_item","payload":{"type":"custom_tool_call_output","call_id":"c3","output":"plain text result"}}"#;
        let blocks = parse_codex_line(10, line).unwrap();
        assert!(matches!(&blocks[0], HistoryBlock::ToolResult { content, is_error: false, .. } if content == "plain text result"));
    }

    #[test]
    fn multi_item_message_gets_unique_uuids() {
        let line = r#"{"timestamp":"2026-06-11T10:00:06.000Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"part one"},{"type":"output_text","text":"part two"}]}}"#;
        let blocks = parse_codex_line(11, line).unwrap();
        assert_eq!(blocks.len(), 2);
        assert!(matches!(&blocks[0], HistoryBlock::AssistantText { uuid, .. } if uuid == "cx-11-0"));
        assert!(matches!(&blocks[1], HistoryBlock::AssistantText { uuid, .. } if uuid == "cx-11-1"));
    }
}
