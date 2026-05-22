use std::sync::Arc;
use crate::db::DbPool;
use crate::sessions::watcher::SessionWatchers;

pub struct AppState {
    pub db: DbPool,
    pub session_watchers: Arc<SessionWatchers>,
}

impl AppState {
    pub fn new(db: DbPool) -> Self {
        Self { db, session_watchers: SessionWatchers::new() }
    }
}
