use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../DesktopApp/src/types/")]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase", tag = "type")]
pub enum RemoteCommand {
    SendPrompt {
        session_id: String,
        text: String,
    },
    ApprovePermission {
        session_id: String,
    },
    DenyPermission {
        session_id: String,
    },
    StopSession {
        session_id: String,
    },
    ResumeSession {
        session_id: String,
        #[ts(type = "number")]
        project_id: i64,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../DesktopApp/src/types/")]
#[serde(rename_all = "camelCase")]
pub struct RemoteEnvelope {
    pub command_id: String,
    pub command: RemoteCommand,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../DesktopApp/src/types/")]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase", tag = "type")]
pub enum RemoteEvent {
    CmdResult {
        command_id: String,
        ok: bool,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        error: Option<String>,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn send_prompt_round_trips_with_type_tag() {
        let cmd = RemoteCommand::SendPrompt {
            session_id: "s1".into(),
            text: "hello".into(),
        };
        let json = serde_json::to_string(&cmd).unwrap();
        assert_eq!(json, r#"{"type":"sendPrompt","sessionId":"s1","text":"hello"}"#);
        let back: RemoteCommand = serde_json::from_str(&json).unwrap();
        assert_eq!(back, cmd);
    }

    #[test]
    fn envelope_round_trips() {
        let env = RemoteEnvelope {
            command_id: "c1".into(),
            command: RemoteCommand::StopSession { session_id: "s1".into() },
        };
        let json = serde_json::to_string(&env).unwrap();
        let back: RemoteEnvelope = serde_json::from_str(&json).unwrap();
        assert_eq!(back, env);
        assert!(json.contains(r#""commandId":"c1""#));
        assert!(json.contains(r#""type":"stopSession""#));
    }

    #[test]
    fn cmd_result_omits_error_when_none() {
        let ev = RemoteEvent::CmdResult { command_id: "c1".into(), ok: true, error: None };
        let json = serde_json::to_string(&ev).unwrap();
        assert_eq!(json, r#"{"type":"cmdResult","commandId":"c1","ok":true}"#);
    }

    #[test]
    fn resume_session_carries_project_id() {
        let cmd = RemoteCommand::ResumeSession { session_id: "s1".into(), project_id: 7 };
        let json = serde_json::to_string(&cmd).unwrap();
        assert!(json.contains(r#""type":"resumeSession""#));
        assert!(json.contains(r#""projectId":7"#));
    }
}
