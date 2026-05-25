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
pub struct GitRepo {
    pub label: String,
    pub branch: Option<String>,
    #[ts(type = "number")]
    pub ahead: usize,
    #[ts(type = "number")]
    pub behind: usize,
    pub files: Vec<GitFile>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export, export_to = "../../src/types/")]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    pub repos: Vec<GitRepo>,
    pub is_repo: bool,
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export, export_to = "../../src/types/")]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum DiffResult {
    Text { hunks: Vec<DiffHunk> },
    Binary,
    TooLarge {
        #[ts(type = "number")]
        size: usize,
    },
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export, export_to = "../../src/types/")]
#[serde(rename_all = "camelCase")]
pub struct DiffHunk {
    pub header: String,
    #[ts(type = "number")]
    pub old_start: usize,
    #[ts(type = "number")]
    pub new_start: usize,
    pub lines: Vec<DiffLine>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export, export_to = "../../src/types/")]
#[serde(rename_all = "camelCase")]
pub struct DiffLine {
    pub kind: String,
    #[ts(type = "number | null")]
    pub old_lineno: Option<usize>,
    #[ts(type = "number | null")]
    pub new_lineno: Option<usize>,
    pub content: String,
}
