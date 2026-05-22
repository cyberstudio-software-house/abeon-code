use std::sync::Arc;
use crate::db::DbPool;
use crate::sessions::watcher::SessionWatchers;
use crate::pty::PtyManager;

pub struct AppState {
    pub db: DbPool,
    pub session_watchers: Arc<SessionWatchers>,
    pub pty: Arc<PtyManager>,
}

impl AppState {
    pub fn new(db: DbPool) -> Self {
        Self {
            db,
            session_watchers: SessionWatchers::new(),
            pty: PtyManager::new(),
        }
    }
}
