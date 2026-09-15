use crate::domain::HistoryBlock;
use crate::sessions::parser::summarize_input;
use serde_json::Value;

pub fn parse_part(
    _message_id: &str,
    role: &str,
    message_created_at: i64,
    part_id: &str,
    part_created_at: i64,
    data: &Value,
) -> Vec<HistoryBlock> {
    let uuid = format!("oc-{part_id}");
    let timestamp = if part_created_at > 0 {
        part_created_at
    } else {
        message_created_at
    };

    match data.get("type").and_then(Value::as_str).unwrap_or("") {
        "text" => {
            let text = data
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            if text.is_empty() {
                return Vec::new();
            }
            match role {
                "user" => vec![HistoryBlock::UserText {
                    uuid,
                    timestamp,
                    text,
                }],
                "assistant" => vec![HistoryBlock::AssistantText {
                    uuid,
                    timestamp,
                    text,
                }],
                _ => Vec::new(),
            }
        }
        "reasoning" if role == "assistant" => {
            let text = data
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            if text.is_empty() {
                Vec::new()
            } else {
                vec![HistoryBlock::AssistantThinking {
                    uuid,
                    timestamp,
                    text,
                }]
            }
        }
        "tool" if role == "assistant" => parse_tool(data, uuid, timestamp),
        "file" => {
            let attachment_kind = data
                .get("mime")
                .and_then(Value::as_str)
                .unwrap_or("file")
                .to_string();
            let name = data
                .get("filename")
                .and_then(Value::as_str)
                .or_else(|| data.get("name").and_then(Value::as_str))
                .unwrap_or("(unnamed)")
                .to_string();
            vec![HistoryBlock::Attachment {
                uuid,
                timestamp,
                attachment_kind,
                name,
            }]
        }
        _ => Vec::new(),
    }
}

fn parse_tool(data: &Value, uuid: String, fallback_timestamp: i64) -> Vec<HistoryBlock> {
    let state = data.get("state").unwrap_or(&Value::Null);
    let raw_input = state.get("input").cloned().unwrap_or(Value::Null);
    let started_at = state
        .get("time")
        .and_then(|time| time.get("start"))
        .and_then(Value::as_i64)
        .unwrap_or(fallback_timestamp);
    let name = data
        .get("tool")
        .and_then(Value::as_str)
        .unwrap_or("tool")
        .to_string();
    let mut blocks = vec![HistoryBlock::ToolUse {
        uuid: uuid.clone(),
        timestamp: started_at,
        name,
        input_summary: summarize_input(&raw_input),
        raw_input,
    }];

    let status = state
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("pending");
    if matches!(status, "completed" | "error" | "failed") {
        let is_error = matches!(status, "error" | "failed");
        let result = if is_error {
            state.get("error").or_else(|| state.get("output"))
        } else {
            state.get("output").or_else(|| state.get("error"))
        };
        let content = match result {
            Some(Value::String(value)) => value.clone(),
            Some(value) => value.to_string(),
            None => String::new(),
        };
        let ended_at = state
            .get("time")
            .and_then(|time| time.get("end"))
            .and_then(Value::as_i64)
            .unwrap_or(fallback_timestamp);
        blocks.push(HistoryBlock::ToolResult {
            uuid: format!("{uuid}-result"),
            timestamp: ended_at,
            content,
            is_error,
        });
    }

    blocks
}

#[cfg(test)]
mod tests {
    use super::parse_part;
    use crate::domain::HistoryBlock;

    #[test]
    fn parses_user_and_assistant_text() {
        let data = serde_json::json!({"type": "text", "text": "Hello"});
        let user = parse_part("msg_u", "user", 10, "prt_u", 11, &data);
        let assistant = parse_part("msg_a", "assistant", 20, "prt_a", 21, &data);
        assert!(
            matches!(&user[0], HistoryBlock::UserText { uuid, text, timestamp } if uuid == "oc-prt_u" && text == "Hello" && timestamp == &11)
        );
        assert!(
            matches!(&assistant[0], HistoryBlock::AssistantText { uuid, text, timestamp } if uuid == "oc-prt_a" && text == "Hello" && timestamp == &21)
        );
    }

    #[test]
    fn parses_reasoning_and_ignores_user_reasoning() {
        let data = serde_json::json!({"type": "reasoning", "text": "Think"});
        let assistant = parse_part("msg_a", "assistant", 20, "prt_r", 21, &data);
        let user = parse_part("msg_u", "user", 20, "prt_r", 21, &data);
        assert!(
            matches!(&assistant[0], HistoryBlock::AssistantThinking { uuid, text, .. } if uuid == "oc-prt_r" && text == "Think")
        );
        assert!(user.is_empty());
    }

    #[test]
    fn pending_tool_emits_only_use() {
        let data = serde_json::json!({
            "type": "tool",
            "tool": "bash",
            "state": {"status": "pending", "input": {"command": "pwd"}, "time": {"start": 100}}
        });
        let blocks = parse_part("msg_1", "assistant", 90, "prt_tool", 95, &data);
        assert_eq!(blocks.len(), 1);
        assert!(
            matches!(&blocks[0], HistoryBlock::ToolUse { uuid, name, timestamp, raw_input, .. } if uuid == "oc-prt_tool" && name == "bash" && timestamp == &100 && raw_input["command"] == "pwd")
        );
    }

    #[test]
    fn completed_tool_emits_use_and_result() {
        let data = serde_json::json!({
            "type": "tool",
            "tool": "bash",
            "state": {
                "status": "completed",
                "input": {"command": "pwd"},
                "output": "/tmp/project",
                "time": {"start": 100, "end": 120}
            }
        });
        let blocks = parse_part("msg_1", "assistant", 90, "prt_tool", 95, &data);
        assert!(
            matches!(&blocks[0], HistoryBlock::ToolUse { uuid, name, .. } if uuid == "oc-prt_tool" && name == "bash")
        );
        assert!(
            matches!(&blocks[1], HistoryBlock::ToolResult { uuid, content, timestamp, is_error: false } if uuid == "oc-prt_tool-result" && content == "/tmp/project" && timestamp == &120)
        );
    }

    #[test]
    fn failed_tool_prefers_error_and_marks_result() {
        let data = serde_json::json!({
            "type": "tool",
            "tool": "bash",
            "state": {"status": "error", "input": {}, "error": "denied"}
        });
        let blocks = parse_part("msg_1", "assistant", 90, "prt_tool", 95, &data);
        assert!(
            matches!(&blocks[1], HistoryBlock::ToolResult { content, is_error: true, .. } if content == "denied")
        );
    }

    #[test]
    fn parses_file_and_ignores_unknown_part() {
        let file = serde_json::json!({"type": "file", "mime": "image/png", "filename": "shot.png"});
        let unknown = serde_json::json!({"type": "step-start"});
        let blocks = parse_part("msg_1", "user", 90, "prt_file", 95, &file);
        assert!(
            matches!(&blocks[0], HistoryBlock::Attachment { uuid, attachment_kind, name, .. } if uuid == "oc-prt_file" && attachment_kind == "image/png" && name == "shot.png")
        );
        assert!(parse_part("msg_1", "assistant", 90, "prt_x", 95, &unknown).is_empty());
    }
}
