use serde_json::Value;
use crate::domain::HistoryBlock;

/// Converts ISO8601 string to unix ms. Fallback: 0.
fn ts_ms(v: &Value) -> i64 {
    v.as_str()
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .map(|d| d.timestamp_millis())
        .unwrap_or(0)
}

fn uuid_of(v: &Value) -> String {
    v.get("uuid").and_then(|u| u.as_str()).unwrap_or("").to_string()
}

/// Parses one JSONL line into zero or more `HistoryBlock`s.
/// Returns `Ok(vec![])` for infrastructure records (queue-operation, last-prompt).
pub fn parse_line(line: &str) -> Result<Vec<HistoryBlock>, serde_json::Error> {
    let v: Value = serde_json::from_str(line)?;
    let kind = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
    let ts = ts_ms(v.get("timestamp").unwrap_or(&Value::Null));
    let uuid = uuid_of(&v);

    Ok(match kind {
        "queue-operation" | "last-prompt" => vec![],
        "user" => parse_user(&v, &uuid, ts),
        "assistant" => parse_assistant(&v, &uuid, ts),
        "attachment" => parse_attachment(&v, &uuid, ts),
        "system" => {
            let subtype = v.get("subtype").and_then(|s| s.as_str()).unwrap_or("").to_string();
            let message = if subtype.is_empty() { "system event".to_string() } else { subtype.clone() };
            vec![HistoryBlock::System { uuid, timestamp: ts, subtype, message }]
        }
        _ => vec![],
    })
}

fn content_array<'a>(v: &'a Value) -> Option<&'a Vec<Value>> {
    v.get("message")
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_array())
}

fn parse_user(v: &Value, uuid: &str, ts: i64) -> Vec<HistoryBlock> {
    let Some(arr) = content_array(v) else { return vec![] };
    let mut out = Vec::new();
    for item in arr {
        let t = item.get("type").and_then(|x| x.as_str()).unwrap_or("");
        match t {
            "text" => {
                let text = item.get("text").and_then(|x| x.as_str()).unwrap_or("").to_string();
                if !text.is_empty() {
                    out.push(HistoryBlock::UserText { uuid: uuid.into(), timestamp: ts, text });
                }
            }
            "tool_result" => {
                let content = render_tool_result(item.get("content"));
                let is_error = item.get("is_error").and_then(|x| x.as_bool()).unwrap_or(false);
                out.push(HistoryBlock::ToolResult { uuid: uuid.into(), timestamp: ts, content, is_error });
            }
            _ => {}
        }
    }
    out
}

fn parse_assistant(v: &Value, uuid: &str, ts: i64) -> Vec<HistoryBlock> {
    let Some(arr) = content_array(v) else { return vec![] };
    let mut out = Vec::new();
    for item in arr {
        let t = item.get("type").and_then(|x| x.as_str()).unwrap_or("");
        match t {
            "thinking" => {
                let text = item.get("thinking").and_then(|x| x.as_str()).unwrap_or("").to_string();
                out.push(HistoryBlock::AssistantThinking { uuid: uuid.into(), timestamp: ts, text });
            }
            "text" => {
                let text = item.get("text").and_then(|x| x.as_str()).unwrap_or("").to_string();
                if !text.is_empty() {
                    out.push(HistoryBlock::AssistantText { uuid: uuid.into(), timestamp: ts, text });
                }
            }
            "tool_use" => {
                let name = item.get("name").and_then(|x| x.as_str()).unwrap_or("").to_string();
                let raw_input = item.get("input").cloned().unwrap_or(Value::Null);
                let input_summary = summarize_input(&raw_input);
                out.push(HistoryBlock::ToolUse {
                    uuid: uuid.into(), timestamp: ts, name, input_summary, raw_input,
                });
            }
            _ => {}
        }
    }
    out
}

fn parse_attachment(v: &Value, uuid: &str, ts: i64) -> Vec<HistoryBlock> {
    let Some(att) = v.get("attachment") else { return vec![] };
    let attachment_kind = att.get("kind").and_then(|x| x.as_str()).unwrap_or("file").to_string();
    let name = att.get("name").and_then(|x| x.as_str()).unwrap_or("(unnamed)").to_string();
    vec![HistoryBlock::Attachment { uuid: uuid.into(), timestamp: ts, attachment_kind, name }]
}

fn render_tool_result(v: Option<&Value>) -> String {
    match v {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(arr)) => arr.iter()
            .filter_map(|x| x.get("text").and_then(|t| t.as_str()))
            .collect::<Vec<_>>()
            .join("\n"),
        Some(other) => other.to_string(),
        None => String::new(),
    }
}

fn summarize_input(v: &Value) -> String {
    match v {
        Value::Object(map) => {
            let mut parts = Vec::new();
            for (k, val) in map.iter().take(3) {
                let short = match val {
                    Value::String(s) if s.len() > 40 => format!("\"{}…\"", &s[..40]),
                    other => other.to_string(),
                };
                parts.push(format!("{k}: {short}"));
            }
            parts.join(", ")
        }
        _ => v.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::HistoryBlock;

    fn lines() -> Vec<String> {
        let s = include_str!("../../tests/fixtures/sample.jsonl");
        s.lines().filter(|l| !l.trim().is_empty()).map(String::from).collect()
    }

    #[test]
    fn skips_infrastructure_records() {
        let blocks = parse_line(&lines()[0]).unwrap();
        assert!(blocks.is_empty());
    }

    #[test]
    fn parses_user_text() {
        let blocks = parse_line(&lines()[1]).unwrap();
        assert_eq!(blocks.len(), 1);
        assert!(matches!(&blocks[0], HistoryBlock::UserText { text, .. } if text == "Hello"));
    }

    #[test]
    fn parses_assistant_with_thinking_text_and_tool_use() {
        let blocks = parse_line(&lines()[2]).unwrap();
        assert_eq!(blocks.len(), 3);
        assert!(matches!(&blocks[0], HistoryBlock::AssistantThinking { .. }));
        assert!(matches!(&blocks[1], HistoryBlock::AssistantText { .. }));
        assert!(matches!(&blocks[2], HistoryBlock::ToolUse { name, .. } if name == "read_file"));
    }

    #[test]
    fn parses_tool_result() {
        let blocks = parse_line(&lines()[3]).unwrap();
        assert_eq!(blocks.len(), 1);
        assert!(matches!(&blocks[0], HistoryBlock::ToolResult { content, .. } if content == "file contents"));
    }

    #[test]
    fn parses_attachment() {
        let blocks = parse_line(&lines()[4]).unwrap();
        assert_eq!(blocks.len(), 1);
        assert!(matches!(&blocks[0], HistoryBlock::Attachment { name, .. } if name == "screenshot.png"));
    }

    #[test]
    fn parses_system() {
        let blocks = parse_line(&lines()[5]).unwrap();
        assert_eq!(blocks.len(), 1);
        assert!(matches!(&blocks[0], HistoryBlock::System { .. }));
    }
}
