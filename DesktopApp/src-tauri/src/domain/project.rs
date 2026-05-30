use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/types/")]
#[serde(rename_all = "camelCase")]
pub struct Project {
    #[ts(type = "number")]
    pub id: i64,
    pub name: String,
    pub path: String,
    pub claude_dir: String,
    pub color: Option<String>,
    #[ts(type = "number")]
    pub sort_order: i64,
    #[ts(type = "number")]
    pub created_at: i64,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export, export_to = "../../src/types/")]
#[serde(rename_all = "camelCase")]
pub struct ProjectPatch {
    pub name: Option<String>,
    pub color: Option<String>,
}
