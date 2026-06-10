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
    /// Mobile asks the desktop to publish a full SessionRoster snapshot.
    RequestRoster,
    /// Mobile asks the desktop to publish a full SessionAppend backfill for one
    /// session to its session channel (no Centrifugo retention required).
    RequestHistory {
        session_id: String,
    },
    /// Approve a permission prompt with "and don't ask again" — selects the
    /// second menu option (down arrow + Enter) instead of the default.
    ApproveAlwaysPermission {
        session_id: String,
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

    #[test]
    fn request_history_round_trips() {
        let cmd = RemoteCommand::RequestHistory { session_id: "s1".into() };
        let json = serde_json::to_string(&cmd).unwrap();
        assert_eq!(json, r#"{"type":"requestHistory","sessionId":"s1"}"#);
        let back: RemoteCommand = serde_json::from_str(&json).unwrap();
        assert_eq!(back, cmd);
    }

    #[test]
    fn approve_always_round_trips() {
        let cmd = RemoteCommand::ApproveAlwaysPermission { session_id: "s1".into() };
        let json = serde_json::to_string(&cmd).unwrap();
        assert_eq!(json, r#"{"type":"approveAlwaysPermission","sessionId":"s1"}"#);
        let back: RemoteCommand = serde_json::from_str(&json).unwrap();
        assert_eq!(back, cmd);
    }

    #[test]
    fn export_contract_to_mobile_app() {
        use ts_rs::TS;

        // The MobileApp must consume the SAME contract types as the desktop bridge,
        // with Rust as the single source of truth. We cannot use `export_all_to` here:
        // ts-rs derives each type's `output_path()` from its `#[ts(export_to = ...)]`
        // attribute (which points at DesktopApp), and `export_all_to` *joins* the given
        // dir with that attribute path. The leading `../` in the attribute path cancels
        // the out_dir, so the files land back in the DesktopApp target (or a stray dir),
        // never in MobileApp. Instead we render each type with `export_to_string()` —
        // which produces the exact same bytes ts-rs writes for the desktop, including the
        // "do not edit" header and the `./RemoteCommand` import — and write it ourselves.
        //
        // The output dir is resolved relative to the crate manifest dir
        // (`crates/abeon-remote-core/`), which is the cwd under `cargo test`; `../../`
        // reaches the repo root. RemoteEnvelope depends on RemoteCommand, so we export
        // all three: RemoteCommand, RemoteEnvelope, RemoteEvent.
        let out_dir = std::path::Path::new("../../MobileApp/src/types");
        std::fs::create_dir_all(out_dir).unwrap();

        for (file_name, contents) in [
            (RemoteCommand::ident(), RemoteCommand::export_to_string().unwrap()),
            (RemoteEnvelope::ident(), RemoteEnvelope::export_to_string().unwrap()),
            (RemoteEvent::ident(), RemoteEvent::export_to_string().unwrap()),
        ] {
            let path = out_dir.join(format!("{file_name}.ts"));
            std::fs::write(&path, contents).unwrap();
        }
    }
}
