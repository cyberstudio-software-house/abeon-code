use serde::Serialize;
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export, export_to = "../../src/types/")]
#[serde(rename_all = "camelCase")]
pub struct ShellInfo {
    pub name: String,
    pub path: String,
}
