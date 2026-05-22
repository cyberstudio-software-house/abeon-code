use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/types/")]
#[serde(rename_all = "camelCase")]
pub struct SessionMeta {
    pub id: String,
    #[ts(type = "number")]
    pub project_id: i64,
    pub title: String,
    #[ts(type = "number")]
    pub message_count: usize,
    #[ts(type = "number")]
    pub last_modified: i64,
    pub git_branch: Option<String>,
    pub cwd: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/types/")]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum HistoryBlock {
    UserText {
        uuid: String,
        #[ts(type = "number")]
        timestamp: i64,
        text: String,
    },
    AssistantText {
        uuid: String,
        #[ts(type = "number")]
        timestamp: i64,
        text: String,
    },
    AssistantThinking {
        uuid: String,
        #[ts(type = "number")]
        timestamp: i64,
        text: String,
    },
    ToolUse {
        uuid: String,
        #[ts(type = "number")]
        timestamp: i64,
        name: String,
        input_summary: String,
        #[ts(type = "unknown")]
        raw_input: serde_json::Value,
    },
    ToolResult {
        uuid: String,
        #[ts(type = "number")]
        timestamp: i64,
        content: String,
        is_error: bool,
    },
    Attachment {
        uuid: String,
        #[ts(type = "number")]
        timestamp: i64,
        #[serde(rename = "attachmentKind")]
        attachment_kind: String,
        name: String,
    },
    System {
        uuid: String,
        #[ts(type = "number")]
        timestamp: i64,
        subtype: String,
        message: String,
    },
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export, export_to = "../../src/types/")]
#[serde(rename_all = "camelCase")]
pub struct SessionHistory {
    pub meta: SessionMeta,
    pub blocks: Vec<HistoryBlock>,
    pub has_more_before: bool,
}
