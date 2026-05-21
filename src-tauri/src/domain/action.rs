use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/types/")]
#[serde(rename_all = "camelCase")]
pub struct Action {
    pub id: i64,
    pub project_id: i64,
    pub label: String,
    pub command: String,
    pub working_dir: Option<String>,
    pub source: Option<String>,
    pub sort_order: i64,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export, export_to = "../../src/types/")]
#[serde(rename_all = "camelCase")]
pub struct ActionInput {
    pub project_id: i64,
    pub label: String,
    pub command: String,
    pub working_dir: Option<String>,
    pub source: Option<String>,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export, export_to = "../../src/types/")]
#[serde(rename_all = "camelCase")]
pub struct ActionPatch {
    pub label: Option<String>,
    pub command: Option<String>,
    pub working_dir: Option<String>,
}
