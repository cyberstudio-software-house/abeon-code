use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// A Claude model alias discovered by `detect_claude_options`. `source` is "binary"
/// (scanned from the CLI binary) or "session" (seen in session JSONL fallback).
/// `latest` marks the newest version within its family.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/types/")]
#[serde(rename_all = "camelCase")]
pub struct DetectedModel {
    pub model_id: String,
    pub family: String,
    pub source: String,
    pub latest: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/types/")]
#[serde(rename_all = "camelCase")]
pub struct ClaudeOptions {
    pub models: Vec<DetectedModel>,
    pub effort_levels: Vec<String>,
}
