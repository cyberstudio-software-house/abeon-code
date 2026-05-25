use std::collections::HashMap;
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
}

impl AppState {
    pub fn new(db: DbPool) -> Self {
        Self {
            db,
            session_watchers: SessionWatchers::new(),
            pty: PtyManager::new(),
            shell_env: Mutex::new(None),
        }
    }
}
