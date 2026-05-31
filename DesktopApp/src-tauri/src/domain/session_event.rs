use serde::{Deserialize, Serialize};
use ts_rs::TS;
use crate::domain::session::{HistoryBlock, SessionActivity};
use crate::domain::usage::UsageSummary;

/// The per-session mirror events the bridge publishes to `abeon-cloud-sess:<id>`.
/// Typed so the mobile app consumes them safely. Wire format is camelCase, `type`-tagged.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/types/")]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum SessionEvent {
    SessionAppend { session_id: String, blocks: Vec<HistoryBlock> },
    SessionActivity { session_id: String, activity: SessionActivity },
    SessionTitle { session_id: String, title: String },
    SessionUsage { session_id: String, summary: UsageSummary },
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn session_append_wire_is_flat_blocks() {
        let ev = SessionEvent::SessionAppend {
            session_id: "s1".into(),
            blocks: vec![HistoryBlock::UserText { uuid: "u1".into(), timestamp: 1, text: "hi".into() }],
        };
        let json = serde_json::to_value(&ev).unwrap();
        assert_eq!(json["type"], "sessionAppend");
        assert_eq!(json["sessionId"], "s1");
        assert!(json["blocks"].is_array(), "blocks must be a flat array, not double-wrapped");
        assert_eq!(json["blocks"][0]["kind"], "userText");
    }
    #[test]
    fn activity_wire_is_scalar_string() {
        let ev = SessionEvent::SessionActivity { session_id: "s1".into(), activity: SessionActivity::WaitingUser };
        let json = serde_json::to_value(&ev).unwrap();
        assert_eq!(json["type"], "sessionActivity");
        assert_eq!(json["activity"], "waitingUser");
    }

    #[test]
    fn export_session_event_to_mobile_app() {
        use ts_rs::TS;
        use crate::domain::session::{HistoryBlock, SessionActivity};
        use crate::domain::usage::{UsageSummary, TokenTotals, ModelUsage};
        let dir = std::path::Path::new("../../MobileApp/src/types");
        std::fs::create_dir_all(dir).unwrap();
        for (name, body) in [
            ("SessionEvent", SessionEvent::export_to_string().unwrap()),
            ("HistoryBlock", HistoryBlock::export_to_string().unwrap()),
            ("SessionActivity", SessionActivity::export_to_string().unwrap()),
            ("UsageSummary", UsageSummary::export_to_string().unwrap()),
            ("TokenTotals", TokenTotals::export_to_string().unwrap()),
            ("ModelUsage", ModelUsage::export_to_string().unwrap()),
        ] {
            std::fs::write(dir.join(format!("{name}.ts")), body).unwrap();
        }
    }
}
