use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use parking_lot::Mutex;
use crate::db::DbPool;
use crate::sessions::watcher::SessionWatchers;
use crate::pty::PtyManager;

pub struct AppState {
    pub db: DbPool,
    pub session_watchers: Arc<SessionWatchers>,
    pub pty: Arc<PtyManager>,
    pub shell_env: Mutex<Option<HashMap<String, String>>>,
    pub clipboard_images: Mutex<HashMap<String, Vec<PathBuf>>>,
}

impl AppState {
    pub fn new(db: DbPool) -> Self {
        Self {
            db,
            session_watchers: SessionWatchers::new(),
            pty: PtyManager::new(),
            shell_env: Mutex::new(None),
            clipboard_images: Mutex::new(HashMap::new()),
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
}
