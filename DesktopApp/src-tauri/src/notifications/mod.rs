pub mod marker;
pub mod hook_installer;
pub mod desktop;

use serde::Serialize;
use tauri::{AppHandle, Emitter};

/// Global event name listened to once by the frontend (AppShell).
pub const ATTENTION_EVENT: &str = "session-attention";

/// Emitted when the user activates a desktop notification; payload is the session id.
pub const ACTIVATE_EVENT: &str = "notification-activate";

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

pub fn emit_activate(app: &AppHandle, session_id: String) {
    let _ = app.emit(ACTIVATE_EVENT, session_id);
}
