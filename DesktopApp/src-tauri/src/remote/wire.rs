use serde::Deserialize;

/// Encode a single Centrifugo command frame: `{"id":<id>,"<key>":<payload>}`.
pub fn encode_command(id: u32, key: &str, payload: serde_json::Value) -> String {
    format!(
        r#"{{"id":{},"{}":{}}}"#,
        id,
        key,
        payload
    )
}

/// Encode several commands into one newline-delimited frame.
pub fn encode_batch(commands: &[(u32, &str, serde_json::Value)]) -> String {
    commands
        .iter()
        .map(|(id, key, payload)| encode_command(*id, key, payload.clone()))
        .collect::<Vec<_>>()
        .join("\n")
}

/// Pong reply to a server ping — an empty JSON object.
pub const PONG: &str = "{}";

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct WireError {
    pub code: u32,
    pub message: String,
    #[serde(default)]
    pub temporary: bool,
}

/// A decoded inbound line from a Centrifugo frame.
#[derive(Debug, Clone, PartialEq)]
pub enum Frame {
    /// Server keepalive ping (empty `{}`); reply with `PONG`.
    Ping,
    /// A publication on a subscribed channel.
    Publication { channel: String, data: serde_json::Value },
    /// A reply to a command we sent, identified by `id`. `error` set on failure.
    Ack { id: u32, error: Option<WireError> },
    /// Any other push/reply we don't act on (join/leave/disconnect/connect result, etc.).
    Other,
}

#[derive(Deserialize)]
struct RawReply {
    #[serde(default)]
    id: u32,
    #[serde(default)]
    error: Option<WireError>,
    #[serde(default)]
    push: Option<RawPush>,
}

#[derive(Deserialize)]
struct RawPush {
    #[serde(default)]
    channel: String,
    #[serde(default, rename = "pub")]
    publication: Option<RawPublication>,
}

#[derive(Deserialize)]
struct RawPublication {
    data: serde_json::Value,
}

/// Parse a WebSocket text frame (newline-delimited JSON) into classified frames.
/// Unparseable lines are skipped.
pub fn parse_frame(text: &str) -> Vec<Frame> {
    text.trim()
        .split('\n')
        .filter(|line| !line.trim().is_empty())
        .filter_map(classify_line)
        .collect()
}

fn classify_line(line: &str) -> Option<Frame> {
    let reply: RawReply = serde_json::from_str(line).ok()?;
    if let Some(push) = reply.push {
        return match push.publication {
            Some(p) => Some(Frame::Publication { channel: push.channel, data: p.data }),
            None => Some(Frame::Other),
        };
    }
    if reply.id != 0 {
        return Some(Frame::Ack { id: reply.id, error: reply.error });
    }
    if reply.error.is_none() {
        return Some(Frame::Ping);
    }
    Some(Frame::Other)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn encodes_command_with_id_and_key() {
        assert_eq!(
            encode_command(1, "connect", json!({ "token": "JWT" })),
            r#"{"id":1,"connect":{"token":"JWT"}}"#
        );
    }

    #[test]
    fn encodes_batch_newline_delimited() {
        let frame = encode_batch(&[
            (1, "subscribe", json!({ "channel": "cmd:dev-1" })),
            (2, "subscribe", json!({ "channel": "sess:xyz" })),
        ]);
        assert_eq!(
            frame,
            "{\"id\":1,\"subscribe\":{\"channel\":\"cmd:dev-1\"}}\n{\"id\":2,\"subscribe\":{\"channel\":\"sess:xyz\"}}"
        );
    }

    #[test]
    fn pong_constant_is_empty_object() {
        assert_eq!(PONG, "{}");
    }

    #[test]
    fn parses_empty_frame_as_ping() {
        assert_eq!(parse_frame("{}"), vec![Frame::Ping]);
    }

    #[test]
    fn parses_publication_push() {
        let text = r#"{"push":{"channel":"cmd:dev-1","pub":{"data":{"commandId":"c1","command":{"type":"stopSession","sessionId":"s1"}},"offset":44}}}"#;
        assert_eq!(
            parse_frame(text),
            vec![Frame::Publication {
                channel: "cmd:dev-1".into(),
                data: serde_json::json!({
                    "commandId": "c1",
                    "command": { "type": "stopSession", "sessionId": "s1" }
                }),
            }]
        );
    }

    #[test]
    fn parses_publish_ack_success() {
        assert_eq!(
            parse_frame(r#"{"id":3,"publish":{}}"#),
            vec![Frame::Ack { id: 3, error: None }]
        );
    }

    #[test]
    fn parses_error_reply() {
        let text = r#"{"id":3,"error":{"code":103,"message":"permission denied","temporary":false}}"#;
        assert_eq!(
            parse_frame(text),
            vec![Frame::Ack {
                id: 3,
                error: Some(WireError { code: 103, message: "permission denied".into(), temporary: false }),
            }]
        );
    }

    #[test]
    fn parses_multiple_newline_delimited_frames() {
        let text = "{}\n{\"id\":1,\"connect\":{\"client\":\"abc\"}}";
        let frames = parse_frame(text);
        assert_eq!(frames.len(), 2);
        assert_eq!(frames[0], Frame::Ping);
        assert_eq!(frames[1], Frame::Ack { id: 1, error: None });
    }
}
