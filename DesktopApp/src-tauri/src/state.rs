use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use parking_lot::Mutex;
use crate::db::DbPool;
use crate::sessions::watcher::SessionWatchers;
use crate::pty::PtyManager;
use crate::remote::registry::SessionPtyRegistry;
use crate::error::{AppError, AppResult};

#[derive(Default)]
pub struct OpenCodeStartRegistry {
    pending: Mutex<HashMap<i64, OpenCodeStart>>,
}

struct OpenCodeStart {
    token: String,
    pty_id: Option<String>,
}

impl OpenCodeStartRegistry {
    pub fn claim(&self, project_id: i64) -> AppResult<String> {
        let mut pending = self.pending.lock();
        if pending.contains_key(&project_id) {
            return Err(AppError::Other(
                "Poczekaj na powiązanie uruchamianej sesji OpenCode".into(),
            ));
        }
        let token = uuid::Uuid::new_v4().to_string();
        pending.insert(project_id, OpenCodeStart { token: token.clone(), pty_id: None });
        Ok(token)
    }

    pub fn bind(&self, project_id: i64, token: &str, pty_id: &str) {
        if let Some(start) = self.pending.lock().get_mut(&project_id) {
            if start.token == token {
                start.pty_id = Some(pty_id.to_string());
            }
        }
    }

    pub fn release(&self, project_id: i64, token: &str) {
        let mut pending = self.pending.lock();
        if pending.get(&project_id).map(|start| start.token.as_str()) == Some(token) {
            pending.remove(&project_id);
        }
    }

    pub fn release_after(
        self: Arc<Self>,
        project_id: i64,
        token: String,
        delay: std::time::Duration,
    ) {
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(delay).await;
            self.release(project_id, &token);
        });
    }

    pub fn resolve_pty(&self, pty_id: &str) {
        self.pending
            .lock()
            .retain(|_, start| start.pty_id.as_deref() != Some(pty_id));
    }
}

pub struct AppState {
    pub db: DbPool,
    pub session_watchers: Arc<SessionWatchers>,
    pub pty: Arc<PtyManager>,
    pub session_pty: Arc<SessionPtyRegistry>,
    pub opencode_starts: Arc<OpenCodeStartRegistry>,
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
            opencode_starts: Arc::new(OpenCodeStartRegistry::default()),
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

    #[test]
    fn opencode_start_tokens_do_not_release_a_newer_claim() {
        let registry = OpenCodeStartRegistry::default();
        let first = registry.claim(1).unwrap();
        assert!(registry.claim(1).is_err());
        registry.bind(1, &first, "pty-first");
        registry.resolve_pty("pty-first");

        let second = registry.claim(1).unwrap();
        registry.release(1, &first);
        assert!(registry.claim(1).is_err());
        registry.release(1, &second);
        assert!(registry.claim(1).is_ok());
    }

    #[tokio::test]
    async fn opencode_start_release_waits_for_discovery_grace_period() {
        let registry = Arc::new(OpenCodeStartRegistry::default());
        let token = registry.claim(1).unwrap();
        registry
            .clone()
            .release_after(1, token, std::time::Duration::from_millis(20));

        assert!(registry.claim(1).is_err());
        tokio::time::sleep(std::time::Duration::from_millis(30)).await;
        assert!(registry.claim(1).is_ok());
    }
}
