use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// A model alias discovered by `detect_models`, not necessarily in the static
/// `BUILTIN_MODELS` list. `source` is "binary" (scanned from the CLI binary) or
/// "session" (seen in session JSONL fallback).
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/types/")]
#[serde(rename_all = "camelCase")]
pub struct DetectedModel {
    pub model_id: String,
    pub family: String,
    pub source: String,
}
