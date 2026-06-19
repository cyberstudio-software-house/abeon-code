use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use parking_lot::Mutex;
use crate::db::DbPool;
use crate::sessions::watcher::SessionWatchers;
use crate::pty::PtyManager;
use crate::remote::registry::SessionPtyRegistry;

pub struct AppState {
    pub db: DbPool,
    pub session_watchers: Arc<SessionWatchers>,
    pub pty: Arc<PtyManager>,
    pub session_pty: Arc<SessionPtyRegistry>,
    pub shell_env: Mutex<Option<HashMap<String, String>>>,
    pub clipboard_images: Mutex<HashMap<String, Vec<PathBuf>>>,
    /// Cached project usage keyed by project_id: (max session-file mtime seen, summary).
    pub project_usage_cache: Mutex<HashMap<i64, (i64, crate::domain::UsageSummary)>>,
    /// Cached result of `detect_models`; populated on first call, bypassed by `force`.
    pub detected_models: Mutex<Option<Vec<crate::domain::DetectedModel>>>,
    pub pending_open_paths: Mutex<Vec<String>>,
    pub cli_frontend_ready: Mutex<bool>,
}

impl AppState {
    pub fn new(db: DbPool) -> Self {
        Self {
            db,
            session_watchers: SessionWatchers::new(),
            pty: PtyManager::new(),
            session_pty: Arc::new(SessionPtyRegistry::new()),
            shell_env: Mutex::new(None),
            clipboard_images: Mutex::new(HashMap::new()),
            project_usage_cache: Mutex::new(HashMap::new()),
            detected_models: Mutex::new(None),
            pending_open_paths: Mutex::new(Vec::new()),
            cli_frontend_ready: Mutex::new(false),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_state() -> AppState {
        let path = PathBuf::from(":memory:");
        let pool = crate::db::init_pool(&path).expect("in-memory db");
        AppState::new(pool)
    }

    #[test]
    fn clipboard_images_insert_and_remove() {
        let state = test_state();
        let pty_id = "test-pty-1".to_string();
        let path = PathBuf::from("/tmp/test.png");

        {
            let mut map = state.clipboard_images.lock();
            map.entry(pty_id.clone()).or_default().push(path.clone());
        }

        {
            let map = state.clipboard_images.lock();
            let paths = map.get(&pty_id).unwrap();
            assert_eq!(paths.len(), 1);
            assert_eq!(paths[0], path);
        }

        {
            let mut map = state.clipboard_images.lock();
            let removed = map.remove(&pty_id);
            assert!(removed.is_some());
            assert!(map.get(&pty_id).is_none());
        }
    }

    #[test]
    fn session_pty_registry_is_present_and_usable() {
        let state = test_state();
        state.session_pty.bind("sess-1", "pty-a");
        assert_eq!(state.session_pty.pty_for("sess-1"), Some("pty-a".to_string()));
    }
}
