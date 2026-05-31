use serde::{Deserialize, Serialize};
use ts_rs::TS;
use crate::domain::session::SessionActivity;

/// One row of the mobile session list = SessionMeta essentials + project name.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/types/")]
#[serde(rename_all = "camelCase")]
pub struct RosterEntry {
    pub session_id: String,
    #[ts(type = "number")]
    pub project_id: i64,
    pub project_name: String,
    pub title: String,
    pub activity: SessionActivity,
    #[ts(type = "number")]
    pub last_modified: i64,
}
