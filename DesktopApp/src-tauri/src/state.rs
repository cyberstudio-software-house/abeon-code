use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use parking_lot::Mutex;
use crate::db::DbPool;
use crate::sessions::watcher::SessionWatchers;
use crate::pty::PtyManager;
use crate::remote::registry::SessionPtyRegistry;
use crate::error::AppResult;

#[derive(Default)]
pub struct OpenCodeStartRegistry {
    state: Mutex<OpenCodeStartState>,
}

struct OpenCodeStart {
    project_id: i64,
    pty_id: Option<String>,
    started_at: i64,
    sequence: u64,
}

#[derive(Default)]
struct OpenCodeStartState {
    pending: HashMap<String, OpenCodeStart>,
    resolved_sessions: HashMap<(i64, String), String>,
    next_sequence: u64,
}

impl OpenCodeStartRegistry {
    pub fn claim(&self, project_id: i64) -> AppResult<String> {
        self.claim_at(project_id, current_time_millis())
    }

    fn claim_at(&self, project_id: i64, started_at: i64) -> AppResult<String> {
        let mut state = self.state.lock();
        let token = uuid::Uuid::new_v4().to_string();
        let sequence = state.next_sequence;
        state.next_sequence = state.next_sequence.saturating_add(1);
        state.pending.insert(
            token.clone(),
            OpenCodeStart { project_id, pty_id: None, started_at, sequence },
        );
        Ok(token)
    }

    pub fn bind(&self, project_id: i64, token: &str, pty_id: &str) {
        if let Some(start) = self.state.lock().pending.get_mut(token) {
            if start.project_id == project_id {
                start.pty_id = Some(pty_id.to_string());
            }
        }
    }

    pub fn release(&self, project_id: i64, token: &str) {
        let mut state = self.state.lock();
        if state.pending.get(token).map(|start| start.project_id) == Some(project_id) {
            state.pending.remove(token);
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

    pub fn resolve_session(
        &self,
        project_id: i64,
        session_id: &str,
        created_at: i64,
        eligible_pty_ids: &[String],
    ) -> Option<String> {
        let mut state = self.state.lock();
        let session_key = (project_id, session_id.to_string());
        if let Some(pty_id) = state.resolved_sessions.get(&session_key) {
            return eligible_pty_ids
                .contains(pty_id)
                .then(|| pty_id.clone());
        }
        let (token, pty_id) = state.pending.iter()
            .filter(|(_, start)| {
                start.project_id == project_id
                    && start.pty_id.is_some()
                    && created_at >= start.started_at
            })
            .min_by_key(|(_, start)| (created_at.abs_diff(start.started_at), start.sequence))
            .map(|(token, start)| (token.clone(), start.pty_id.clone().unwrap()))?;
        state.pending.remove(&token)?;
        state.resolved_sessions.insert(session_key, pty_id.clone());
        eligible_pty_ids.contains(&pty_id).then_some(pty_id)
    }
}

fn current_time_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
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
    fn opencode_start_tokens_are_independent_within_a_project() {
        let registry = OpenCodeStartRegistry::default();
        let first = registry.claim_at(1, 100).unwrap();
        let second = registry.claim_at(1, 200).unwrap();
        registry.bind(1, &first, "pty-first");
        registry.bind(1, &second, "pty-second");

        assert_eq!(
            registry.resolve_session(1, "ses-second", 210, &["pty-second".to_string()]),
            Some("pty-second".to_string()),
        );
        assert_eq!(
            registry.resolve_session(1, "ses-second", 210, &["pty-second".to_string()]),
            Some("pty-second".to_string()),
        );
        assert_eq!(
            registry.resolve_session(1, "ses-first", 300, &["pty-first".to_string()]),
            Some("pty-first".to_string()),
        );
    }

    #[test]
    fn opencode_start_is_reserved_for_its_owner_window() {
        let registry = OpenCodeStartRegistry::default();
        let first = registry.claim_at(1, 100).unwrap();
        let second = registry.claim_at(1, 200).unwrap();
        registry.bind(1, &first, "pty-first");
        registry.bind(1, &second, "pty-second");

        assert_eq!(
            registry.resolve_session(1, "ses-second", 210, &["pty-first".to_string()]),
            None,
        );
        assert_eq!(
            registry.resolve_session(1, "ses-second", 210, &["pty-second".to_string()]),
            Some("pty-second".to_string()),
        );
        assert_eq!(
            registry.resolve_session(1, "ses-first", 220, &["pty-first".to_string()]),
            Some("pty-first".to_string()),
        );
    }

    #[test]
    fn opencode_start_does_not_match_a_session_created_before_it() {
        let registry = OpenCodeStartRegistry::default();
        let token = registry.claim_at(1, 100).unwrap();
        registry.bind(1, &token, "pty-current");

        assert_eq!(
            registry.resolve_session(1, "ses-old", 99, &["pty-current".to_string()]),
            None,
        );
        assert_eq!(
            registry.resolve_session(1, "ses-current", 110, &["pty-current".to_string()]),
            Some("pty-current".to_string()),
        );
    }

    #[test]
    fn opencode_starts_with_equal_timestamps_resolve_in_claim_order() {
        let registry = OpenCodeStartRegistry::default();
        let first = registry.claim_at(1, 100).unwrap();
        let second = registry.claim_at(1, 100).unwrap();
        registry.bind(1, &first, "pty-first");
        registry.bind(1, &second, "pty-second");

        assert_eq!(
            registry.resolve_session(
                1,
                "ses-first",
                110,
                &["pty-first".to_string(), "pty-second".to_string()],
            ),
            Some("pty-first".to_string()),
        );
        assert_eq!(
            registry.resolve_session(
                1,
                "ses-second",
                120,
                &["pty-first".to_string(), "pty-second".to_string()],
            ),
            Some("pty-second".to_string()),
        );
    }

    #[tokio::test]
    async fn expired_opencode_start_cannot_be_resolved() {
        let registry = Arc::new(OpenCodeStartRegistry::default());
        let token = registry.claim(1).unwrap();
        registry.bind(1, &token, "pty-expired");
        registry
            .clone()
            .release_after(1, token, std::time::Duration::from_millis(20));

        tokio::time::sleep(std::time::Duration::from_millis(30)).await;
        assert_eq!(
            registry.resolve_session(1, "ses-expired", i64::MAX, &["pty-expired".to_string()]),
            None,
        );
    }
}
