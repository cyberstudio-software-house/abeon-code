use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/types/")]
#[serde(rename_all = "camelCase")]
pub struct Note {
    #[ts(type = "number")]
    pub id: i64,
    #[ts(type = "number | null")]
    pub project_id: Option<i64>,
    pub content: String,
    #[ts(type = "number")]
    pub created_at: i64,
    #[ts(type = "number")]
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/types/")]
#[serde(rename_all = "camelCase")]
pub struct NotesChangedEvent {
    #[ts(type = "number | null")]
    pub created_note_id: Option<i64>,
    pub external: bool,
    pub source_window: Option<String>,
}

pub const NOTES_CHANGED_EVENT: &str = "notes://changed";
