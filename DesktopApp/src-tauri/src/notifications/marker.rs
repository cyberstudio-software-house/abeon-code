use std::path::{Path, PathBuf};
use std::sync::Arc;
use parking_lot::Mutex;
use notify::{RecommendedWatcher, RecursiveMode, Watcher as _, Event, EventKind};
use tauri::AppHandle;
use serde_json::Value;
use crate::notifications::{AttentionEvent, emit_attention};

pub type MarkerFilter = Arc<dyn Fn(&str, Option<&Path>) -> bool + Send + Sync>;

struct ParsedMarker {
    event: AttentionEvent,
    cwd: Option<PathBuf>,
}

/// Extract an AttentionEvent from raw Claude hook JSON. Returns None when the
/// payload has no usable `session_id`.
fn parse_marker(raw: &str) -> Option<ParsedMarker> {
    let v: Value = serde_json::from_str(raw).ok()?;
    let session_id = v.get("session_id").and_then(|s| s.as_str())?.to_string();
    if session_id.is_empty() {
        return None;
    }
    let message = v.get("message").and_then(|m| m.as_str()).map(String::from);
    let cwd = v
        .get("cwd")
        .and_then(|c| c.as_str())
        .filter(|c| !c.is_empty())
        .map(PathBuf::from);
    Some(ParsedMarker {
        event: AttentionEvent { session_id, reason: "hook".to_string(), message },
        cwd,
    })
}

fn accept_marker(raw: &str, suppress: Option<&MarkerFilter>) -> Option<AttentionEvent> {
    let marker = parse_marker(raw)?;
    let suppressed = suppress
        .is_some_and(|suppress| suppress(&marker.event.session_id, marker.cwd.as_deref()));
    (!suppressed).then_some(marker.event)
}

pub struct AttentionWatcher {
    dir: PathBuf,
    watcher: Mutex<Option<RecommendedWatcher>>,
    suppress: Option<MarkerFilter>,
}

impl AttentionWatcher {
    pub fn new(dir: PathBuf, suppress: Option<MarkerFilter>) -> Arc<Self> {
        Arc::new(Self { dir, watcher: Mutex::new(None), suppress })
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// Start watching the marker directory. Creates it if missing.
    pub fn start(self: &Arc<Self>, app: AppHandle) {
        if let Err(e) = std::fs::create_dir_all(&self.dir) {
            eprintln!("attention watcher: failed to create marker dir {:?}: {e}", self.dir);
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
        // `cat >` fires Create (empty) before Modify (content); don't consume the
        // empty file or the content arriving next would be lost.
        if raw.trim().is_empty() {
            return;
        }
        let _ = std::fs::remove_file(path);
        if let Some(event) = accept_marker(&raw, self.suppress.as_ref()) {
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
        let ev = parse_marker(raw).unwrap().event;
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

    #[test]
    fn suppressed_markers_emit_nothing() {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let recorded = seen.clone();
        let suppress: MarkerFilter = Arc::new(move |session_id: &str, cwd: Option<&Path>| {
            recorded
                .lock()
                .push((session_id.to_string(), cwd.map(Path::to_path_buf)));
            session_id == "supervisor" || cwd == Some(Path::new("/data/supervisor"))
        });
        let idle = |session_id: &str, cwd: &str| {
            format!(r#"{{"session_id":"{session_id}","cwd":"{cwd}","message":"Claude is waiting for your input"}}"#)
        };
        assert!(accept_marker(&idle("supervisor", "/elsewhere"), Some(&suppress)).is_none());
        assert!(accept_marker(&idle("cleared", "/data/supervisor"), Some(&suppress)).is_none());
        let kept = accept_marker(&idle("worker", "/home/u/app"), Some(&suppress)).unwrap();
        assert_eq!(kept.session_id, "worker");
        assert_eq!(
            seen.lock().last().cloned(),
            Some(("worker".to_string(), Some(PathBuf::from("/home/u/app"))))
        );
        let without_cwd = accept_marker(r#"{"session_id":"worker"}"#, Some(&suppress)).unwrap();
        assert_eq!(without_cwd.session_id, "worker");
        assert_eq!(seen.lock().last().cloned(), Some(("worker".to_string(), None)));
        assert!(accept_marker(&idle("supervisor", "/x"), None).is_some());
    }
}
