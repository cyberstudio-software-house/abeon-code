use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/types/")]
#[serde(rename_all = "camelCase")]
pub enum ClickUpConnectionStatus {
    Configured,
    Invalid,
    Absent,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/types/")]
#[serde(rename_all = "camelCase")]
pub struct ClickUpWorkspace {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/types/")]
#[serde(rename_all = "camelCase")]
pub struct ClickUpSpace {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/types/")]
#[serde(rename_all = "camelCase")]
pub struct ClickUpList {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/types/")]
#[serde(rename_all = "camelCase")]
pub struct ClickUpTaskRef {
    pub id: String,
    pub custom_id: Option<String>,
    pub name: String,
    pub status: Option<String>,
    pub url: String,
    pub list_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/types/")]
#[serde(rename_all = "camelCase")]
pub struct ClickUpAttachment {
    pub id: String,
    pub title: String,
    pub url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/types/")]
#[serde(rename_all = "camelCase")]
pub struct ClickUpComment {
    pub id: String,
    pub user: String,
    pub text: String,
    #[ts(type = "number")]
    pub date: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/types/")]
#[serde(rename_all = "camelCase")]
pub struct ClickUpTaskDetail {
    pub id: String,
    pub custom_id: Option<String>,
    pub name: String,
    pub description: String,
    pub status: Option<String>,
    pub url: String,
    pub attachments: Vec<ClickUpAttachment>,
    pub comments: Vec<ClickUpComment>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/types/")]
#[serde(rename_all = "camelCase")]
pub struct ClickUpLink {
    #[ts(type = "number")]
    pub project_id: i64,
    pub task_id: String,
    pub custom_id: Option<String>,
    pub name: String,
    pub status: Option<String>,
    pub url: String,
    #[ts(type = "number")]
    pub linked_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/types/")]
#[serde(rename_all = "camelCase")]
pub struct ClickUpProjectConfig {
    #[ts(type = "number")]
    pub project_id: i64,
    pub workspace_id: String,
    pub space_id: Option<String>,
    pub list_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/types/")]
#[serde(rename_all = "camelCase")]
pub struct TimeEstimate {
    #[ts(type = "number")]
    pub session_ms: i64,
    #[ts(type = "number")]
    pub dev_estimate_ms: i64,
}
