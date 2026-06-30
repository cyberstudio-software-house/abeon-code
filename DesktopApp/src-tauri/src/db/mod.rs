use std::path::PathBuf;
use r2d2::Pool;
use r2d2_sqlite::SqliteConnectionManager;
use crate::error::{AppError, AppResult};

pub type DbPool = Pool<SqliteConnectionManager>;

pub mod projects_repo;
pub mod actions_repo;
pub mod session_titles_repo;
pub mod settings_repo;
pub mod clickup_config_repo;
pub mod clickup_links_repo;

const MIGRATION_001: &str = include_str!("migrations/001_initial.sql");
const MIGRATION_002: &str = include_str!("migrations/002_session_titles.sql");
const MIGRATION_003: &str = include_str!("migrations/003_action_pre_command.sql");
const MIGRATION_004: &str = include_str!("migrations/004_clickup.sql");

pub fn db_path() -> AppResult<PathBuf> {
    let mut dir = dirs::config_dir().ok_or_else(|| AppError::Other("no config dir".into()))?;
    dir.push("AbeonCode");
    std::fs::create_dir_all(&dir)?;
    dir.push("abeoncode.db");
    Ok(dir)
}

pub fn init_pool(path: &PathBuf) -> AppResult<DbPool> {
    let manager = SqliteConnectionManager::file(path).with_init(|c| {
        c.execute_batch("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;")
    });
    let pool = Pool::builder().max_size(8).build(manager)?;
    run_migrations(&pool)?;
    Ok(pool)
}

fn run_migrations(pool: &DbPool) -> AppResult<()> {
    let conn = pool.get()?;
    conn.execute_batch(MIGRATION_001)?;
    let v: i64 = conn.query_row(
        "SELECT COALESCE(MAX(version),0) FROM schema_version", [], |r| r.get(0)
    ).unwrap_or(0);
    if v < 2 { conn.execute_batch(MIGRATION_002)?; }
    if v < 3 { conn.execute_batch(MIGRATION_003)?; }
    if v < 4 { conn.execute_batch(MIGRATION_004)?; }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::NamedTempFile;

    #[test]
    fn migration_creates_tables() {
        let f = NamedTempFile::new().unwrap();
        let pool = init_pool(&f.path().to_path_buf()).unwrap();
        let conn = pool.get().unwrap();
        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN ('projects','actions','settings')",
            [],
            |r| r.get(0),
        ).unwrap();
        assert_eq!(count, 3);
    }
}
