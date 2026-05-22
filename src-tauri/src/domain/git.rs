use serde::Serialize;
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export, export_to = "../../src/types/")]
#[serde(rename_all = "camelCase")]
pub struct GitFile {
    pub path: String,
    pub status: String,
    pub staged: bool,
    #[ts(type = "number")]
    pub additions: usize,
    #[ts(type = "number")]
    pub deletions: usize,
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export, export_to = "../../src/types/")]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    pub branch: Option<String>,
    #[ts(type = "number")]
    pub ahead: usize,
    #[ts(type = "number")]
    pub behind: usize,
    pub files: Vec<GitFile>,
    pub is_repo: bool,
}
