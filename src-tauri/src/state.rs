use parking_lot::RwLock;
use std::sync::Arc;
use crate::db::DbPool;

pub struct AppState {
    pub db: DbPool,
    pub watchers: Arc<RwLock<Vec<()>>>,
}

impl AppState {
    pub fn new(db: DbPool) -> Self {
        Self { db, watchers: Arc::new(RwLock::new(Vec::new())) }
    }
}
