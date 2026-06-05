pub mod marker;
pub mod hook_installer;

use serde::Serialize;
use tauri::{AppHandle, Emitter};

/// Global event name listened to once by the frontend (AppShell).
pub const ATTENTION_EVENT: &str = "session-attention";

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AttentionEvent {
    pub session_id: String,
    /// "hook" (Claude Notification hook) or "heuristic" (JSONL activity).
    pub reason: String,
    pub message: Option<String>,
}

pub fn emit_attention(app: &AppHandle, event: AttentionEvent) {
    let _ = app.emit(ATTENTION_EVENT, event);
}
