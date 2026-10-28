use std::io::{BufRead, Write};
use std::time::Duration;

use serde_json::{json, Value};

use crate::supervisor::ipc::{request_blocking, socket_path, IpcRequest, IpcResponse};
use crate::supervisor::tools::tool_definitions;

const TOOL_CALL_TIMEOUT: Duration = Duration::from_secs(60);
const DEFAULT_PROTOCOL_VERSION: &str = "2025-06-18";
const APP_UNAVAILABLE: &str = "AbeonCode nie działa — agent sterujący jest niedostępny.";
const CODE_PARSE_ERROR: i64 = -32700;
const CODE_METHOD_NOT_FOUND: i64 = -32601;
const CODE_INVALID_PARAMS: i64 = -32602;

pub fn run_stdio() {
    let path = socket_path();
    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    run_stdio_with(stdin.lock(), stdout.lock(), |request| {
        request_blocking(&path, request, TOOL_CALL_TIMEOUT)
    });
}

pub fn run_stdio_with<R, W, F>(reader: R, mut writer: W, mut client: F)
where
    R: BufRead,
    W: Write,
    F: FnMut(&IpcRequest) -> Option<IpcResponse>,
{
    for line in reader.lines() {
        let Ok(line) = line else { break };
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Some(reply) = handle_line(line, &mut client) else {
            continue;
        };
        if writeln!(writer, "{reply}").is_err() || writer.flush().is_err() {
            break;
        }
    }
}

fn handle_line<F>(line: &str, client: &mut F) -> Option<Value>
where
    F: FnMut(&IpcRequest) -> Option<IpcResponse>,
{
    let Ok(message) = serde_json::from_str::<Value>(line) else {
        return Some(error_reply(Value::Null, CODE_PARSE_ERROR, "Parse error"));
    };
    let id = message.get("id").cloned()?;
    let Some(method) = message.get("method").and_then(Value::as_str) else {
        return None;
    };
    let params = message.get("params").cloned().unwrap_or(Value::Null);
    let outcome = match method {
        "initialize" => Ok(initialize_result(&params)),
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({ "tools": tool_definitions() })),
        "tools/call" => call_tool(&params, client),
        _ => Err((CODE_METHOD_NOT_FOUND, format!("Method not found: {method}"))),
    };
    Some(match outcome {
        Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
        Err((code, message)) => error_reply(id, code, &message),
    })
}

fn error_reply(id: Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

fn initialize_result(params: &Value) -> Value {
    let version = params
        .get("protocolVersion")
        .and_then(Value::as_str)
        .unwrap_or(DEFAULT_PROTOCOL_VERSION);
    json!({
        "protocolVersion": version,
        "capabilities": { "tools": {} },
        "serverInfo": { "name": "abeoncode", "version": env!("CARGO_PKG_VERSION") },
    })
}

fn call_tool<F>(params: &Value, client: &mut F) -> Result<Value, (i64, String)>
where
    F: FnMut(&IpcRequest) -> Option<IpcResponse>,
{
    let name = params
        .get("name")
        .and_then(Value::as_str)
        .ok_or((CODE_INVALID_PARAMS, "Missing tool name".to_string()))?;
    let args = match params.get("arguments") {
        None | Some(Value::Null) => json!({}),
        Some(value) => value.clone(),
    };
    let request = IpcRequest::Tool {
        name: name.to_string(),
        args,
    };
    Ok(match client(&request) {
        Some(IpcResponse::Tool { ok, result }) => tool_result(&render_result(&result), !ok),
        _ => tool_result(APP_UNAVAILABLE, true),
    })
}

fn render_result(result: &Value) -> String {
    match result {
        Value::String(text) => text.clone(),
        other => serde_json::to_string_pretty(other).unwrap_or_else(|_| other.to_string()),
    }
}

fn tool_result(text: &str, is_error: bool) -> Value {
    json!({ "content": [{ "type": "text", "text": text }], "isError": is_error })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn run(
        lines: &[&str],
        mut client: impl FnMut(&IpcRequest) -> Option<IpcResponse>,
    ) -> Vec<Value> {
        let input = lines.join("\n") + "\n";
        let mut output = Vec::new();
        run_stdio_with(Cursor::new(input), &mut output, &mut client);
        String::from_utf8(output)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    fn app_down(_: &IpcRequest) -> Option<IpcResponse> {
        None
    }

    #[test]
    fn mcp_initialize_and_list() {
        let replies = run(
            &[
                r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26"}}"#,
                r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#,
                r#"{"jsonrpc":"2.0","id":2,"method":"ping"}"#,
                r#"{"jsonrpc":"2.0","id":"x","method":"tools/list"}"#,
            ],
            app_down,
        );
        assert_eq!(replies.len(), 3);
        assert_eq!(replies[0]["id"], 1);
        assert_eq!(replies[0]["result"]["protocolVersion"], "2025-03-26");
        assert_eq!(replies[0]["result"]["capabilities"], json!({ "tools": {} }));
        assert_eq!(replies[0]["result"]["serverInfo"]["name"], "abeoncode");
        assert_eq!(replies[1]["result"], json!({}));
        assert_eq!(replies[2]["id"], "x");
        let tools = replies[2]["result"]["tools"].as_array().unwrap();
        assert_eq!(tools.len(), tool_definitions().as_array().unwrap().len());
        assert!(tools.iter().any(|tool| tool["name"] == "list_sessions"));
    }

    #[test]
    fn mcp_tool_call_forwards_to_client() {
        let mut seen = Vec::new();
        let replies = run(
            &[
                r#"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"list_sessions","arguments":{"a":1}}}"#,
                r#"{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"send_to_session"}}"#,
            ],
            |request| {
                seen.push(request.clone());
                Some(IpcResponse::Tool {
                    ok: seen.len() == 1,
                    result: if seen.len() == 1 {
                        json!({ "sessions": [] })
                    } else {
                        json!("Nieznana sesja")
                    },
                })
            },
        );
        assert_eq!(
            seen[0],
            IpcRequest::Tool {
                name: "list_sessions".to_string(),
                args: json!({ "a": 1 })
            }
        );
        assert_eq!(
            seen[1],
            IpcRequest::Tool {
                name: "send_to_session".to_string(),
                args: json!({})
            }
        );
        assert_eq!(replies[0]["result"]["isError"], false);
        let text = replies[0]["result"]["content"][0]["text"].as_str().unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(text).unwrap(),
            json!({ "sessions": [] })
        );
        assert_eq!(replies[1]["result"]["isError"], true);
        assert_eq!(replies[1]["result"]["content"][0]["text"], "Nieznana sesja");
    }

    #[test]
    fn mcp_tool_call_without_app_reports_unavailable() {
        let replies = run(
            &[
                r#"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"list_sessions","arguments":{}}}"#,
            ],
            app_down,
        );
        assert_eq!(replies[0]["result"]["isError"], true);
        assert_eq!(
            replies[0]["result"]["content"][0]["text"],
            "AbeonCode nie działa — agent sterujący jest niedostępny."
        );
    }

    #[test]
    fn mcp_unknown_method_errors() {
        let replies = run(
            &[
                r#"{"jsonrpc":"2.0","id":7,"method":"resources/list"}"#,
                r#"{"jsonrpc":"2.0","method":"notifications/whatever"}"#,
                r#"{"jsonrpc":"2.0","id":8,"method":"tools/call","params":{}}"#,
                "garbage",
            ],
            app_down,
        );
        assert_eq!(replies.len(), 3);
        assert_eq!(replies[0]["id"], 7);
        assert_eq!(replies[0]["error"]["code"], -32601);
        assert_eq!(replies[1]["error"]["code"], -32602);
        assert_eq!(replies[2]["error"]["code"], -32700);
        assert_eq!(replies[2]["id"], Value::Null);
    }
}
