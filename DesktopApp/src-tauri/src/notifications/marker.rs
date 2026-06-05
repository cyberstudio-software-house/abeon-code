use std::path::{Path, PathBuf};
use std::sync::Arc;
use parking_lot::Mutex;
use notify::{RecommendedWatcher, RecursiveMode, Watcher as _, Event, EventKind};
use tauri::AppHandle;
use serde_json::Value;
use crate::notifications::{AttentionEvent, emit_attention};

/// Extract an AttentionEvent from raw Claude hook JSON. Returns None when the
/// payload has no usable `session_id`.
fn parse_marker(raw: &str) -> Option<AttentionEvent> {
    let v: Value = serde_json::from_str(raw).ok()?;
    let session_id = v.get("session_id").and_then(|s| s.as_str())?.to_string();
    if session_id.is_empty() {
        return None;
    }
    let message = v.get("message").and_then(|m| m.as_str()).map(String::from);
    Some(AttentionEvent { session_id, reason: "hook".to_string(), message })
}

pub struct AttentionWatcher {
    dir: PathBuf,
    watcher: Mutex<Option<RecommendedWatcher>>,
}

impl AttentionWatcher {
    pub fn new(dir: PathBuf) -> Arc<Self> {
        Arc::new(Self { dir, watcher: Mutex::new(None) })
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// Start watching the marker directory. Creates it if missing.
    pub fn start(self: &Arc<Self>, app: AppHandle) {
        if std::fs::create_dir_all(&self.dir).is_err() {
            return;
        }
        let mut guard = self.watcher.lock();
        if guard.is_some() {
            return;
        }
        let self_clone = self.clone();
        let app_clone = app.clone();
        let watcher = notify::recommended_watcher(move |res: notify::Result<Event>| {
            if let Ok(ev) = res {
                if matches!(ev.kind, EventKind::Create(_) | EventKind::Modify(_)) {
                    for p in ev.paths {
                        self_clone.handle_marker(&app_clone, &p);
                    }
                }
            }
        });
        if let Ok(mut w) = watcher {
            if w.watch(&self.dir, RecursiveMode::NonRecursive).is_ok() {
                *guard = Some(w);
            }
        }
    }

    fn handle_marker(&self, app: &AppHandle, path: &Path) {
        if path.extension().map(|e| e != "json").unwrap_or(true) {
            return;
        }
        let raw = match std::fs::read_to_string(path) {
            Ok(s) => s,
            Err(_) => return,
        };
        let _ = std::fs::remove_file(path);
        if let Some(event) = parse_marker(&raw) {
            emit_attention(app, event);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_session_id_and_message() {
        let raw = r#"{"session_id":"abc-123","transcript_path":"/x.jsonl","message":"Claude needs your permission"}"#;
        let ev = parse_marker(raw).unwrap();
        assert_eq!(ev.session_id, "abc-123");
        assert_eq!(ev.reason, "hook");
        assert_eq!(ev.message.as_deref(), Some("Claude needs your permission"));
    }

    #[test]
    fn missing_session_id_returns_none() {
        let raw = r#"{"transcript_path":"/x.jsonl"}"#;
        assert!(parse_marker(raw).is_none());
    }

    #[test]
    fn empty_session_id_returns_none() {
        let raw = r#"{"session_id":""}"#;
        assert!(parse_marker(raw).is_none());
    }

    #[test]
    fn invalid_json_returns_none() {
        assert!(parse_marker("not json").is_none());
    }
}
