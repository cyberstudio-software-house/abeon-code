use serde::Serialize;
use ts_rs::TS;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[ts(export, export_to = "../../src/types/")]
#[serde(rename_all = "camelCase")]
pub enum FileEntryKind {
    Dir,
    File,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[ts(export, export_to = "../../src/types/")]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub kind: FileEntryKind,
    pub ignored: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[ts(export, export_to = "../../src/types/")]
#[serde(rename_all = "camelCase")]
pub struct FileSearchResponse {
    pub results: Vec<String>,
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[ts(export, export_to = "../../src/types/")]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum FileContent {
    Text {
        content: String,
        version: String,
        #[ts(type = "number")]
        size: u64,
    },
    Image {
        data_url: String,
        version: String,
        #[ts(type = "number")]
        size: u64,
    },
    Binary {
        #[ts(type = "number")]
        size: u64,
    },
    TooLarge {
        #[ts(type = "number")]
        size: u64,
    },
}
