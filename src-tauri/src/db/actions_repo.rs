use rusqlite::Connection;
use crate::domain::Action;
use crate::error::{AppError, AppResult};

pub fn get(_conn: &Connection, _id: i64) -> AppResult<Action> {
    Err(AppError::NotFound("actions_repo not implemented yet (Phase 6)".into()))
}
