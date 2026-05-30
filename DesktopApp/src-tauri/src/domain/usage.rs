use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Token counts (dimension 1). Cache write collapses 5m+1h for display.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/types/")]
#[serde(rename_all = "camelCase")]
pub struct TokenTotals {
    #[ts(type = "number")]
    pub input: u64,
    #[ts(type = "number")]
    pub output: u64,
    #[ts(type = "number")]
    pub cache_write: u64,
    #[ts(type = "number")]
    pub cache_read: u64,
}

/// Per-model breakdown (models carry different prices).
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/types/")]
#[serde(rename_all = "camelCase")]
pub struct ModelUsage {
    pub model: String,
    pub tokens: TokenTotals,
    pub cost_usd: f64,
}

/// Aggregate usage for a session or a whole project (dimension 1 + 2).
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/types/")]
#[serde(rename_all = "camelCase")]
pub struct UsageSummary {
    pub tokens: TokenTotals,
    pub cost_usd: f64,
    pub by_model: Vec<ModelUsage>,
    pub unknown_models: Vec<String>,
}
