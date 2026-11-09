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
pub mod notes_repo;
pub mod supervisor_decisions_repo;

const MIGRATION_001: &str = include_str!("migrations/001_initial.sql");
const MIGRATION_002: &str = include_str!("migrations/002_session_titles.sql");
const MIGRATION_003: &str = include_str!("migrations/003_action_pre_command.sql");
const MIGRATION_004: &str = include_str!("migrations/004_clickup.sql");
const MIGRATION_005: &str = include_str!("migrations/005_notes.sql");
const MIGRATION_006: &str = include_str!("migrations/006_supervisor.sql");
const MIGRATION_007: &str = include_str!("migrations/007_notes_untitled.sql");

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
    let mut conn = pool.get()?;
    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    tx.execute_batch(MIGRATION_001)?;
    let v: i64 = tx.query_row(
        "SELECT COALESCE(MAX(version),0) FROM schema_version", [], |r| r.get(0)
    ).unwrap_or(0);
    if v < 2 { tx.execute_batch(MIGRATION_002)?; }
    if v < 3 { tx.execute_batch(MIGRATION_003)?; }
    if v < 4 { tx.execute_batch(MIGRATION_004)?; }
    if v < 5 { tx.execute_batch(MIGRATION_005)?; }
    if v < 6 { tx.execute_batch(MIGRATION_006)?; }
    if v < 7 { tx.execute_batch(MIGRATION_007)?; }
    tx.commit()?;
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
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN ('projects','actions','settings','notes')",
            [],
            |r| r.get(0),
        ).unwrap();
        assert_eq!(count, 4);
    }

    #[test]
    fn migration_creates_notes_scope_and_order_index() {
        let file = NamedTempFile::new().unwrap();
        let pool = init_pool(&file.path().to_path_buf()).unwrap();
        let conn = pool.get().unwrap();
        let table: String = conn.query_row(
            "SELECT tbl_name FROM sqlite_master WHERE type='index' AND name='idx_notes_project_updated'",
            [],
            |row| row.get(0),
        ).unwrap();
        assert_eq!(table, "notes");
        let mut statement = conn.prepare(
            "SELECT name, desc FROM pragma_index_xinfo('idx_notes_project_updated') WHERE key=1 ORDER BY seqno",
        ).unwrap();
        let columns = statement.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, bool>(1)?))
        }).unwrap().collect::<rusqlite::Result<Vec<_>>>().unwrap();
        assert_eq!(columns, vec![
            ("project_id".to_string(), false),
            ("updated_at".to_string(), true),
            ("id".to_string(), true),
        ]);
    }

    #[test]
    fn upgrades_existing_v4_database_and_preserves_data_on_reopening() {
        let file = NamedTempFile::new().unwrap();
        let path = file.path().to_path_buf();
        {
            let conn = rusqlite::Connection::open(&path).unwrap();
            for migration in [MIGRATION_001, MIGRATION_002, MIGRATION_003, MIGRATION_004] {
                conn.execute_batch(migration).unwrap();
            }
            conn.execute_batch(
                "INSERT INTO projects(id,name,path,claude_dir,created_at) VALUES(7,'Existing','/existing','-existing',123);
                 INSERT INTO actions(project_id,label,command,pre_command) VALUES(7,'Build','npm run build','nvm use 20');
                 INSERT INTO settings(key,value) VALUES('theme','dark');",
            ).unwrap();
            let version: i64 = conn.query_row("SELECT MAX(version) FROM schema_version", [], |row| row.get(0)).unwrap();
            assert_eq!(version, 4);
            let count: i64 = conn.query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE name IN ('notes','idx_notes_project_updated')",
                [], |row| row.get(0),
            ).unwrap();
            assert_eq!(count, 0);
        }

        let note_id = {
            let pool = init_pool(&path).unwrap();
            let conn = pool.get().unwrap();
            let version: i64 = conn.query_row("SELECT MAX(version) FROM schema_version", [], |row| row.get(0)).unwrap();
            assert_eq!(version, 7);
            let project = projects_repo::get(&conn, 7).unwrap();
            assert_eq!(project.name, "Existing");
            assert_eq!(project.path, "/existing");
            assert_eq!(project.created_at, 123);
            let action: (String, String) = conn.query_row(
                "SELECT command,pre_command FROM actions WHERE project_id=7", [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            ).unwrap();
            assert_eq!(action, ("npm run build".to_string(), "nvm use 20".to_string()));
            let theme: String = conn.query_row("SELECT value FROM settings WHERE key='theme'", [], |row| row.get(0)).unwrap();
            assert_eq!(theme, "dark");
            let index_count: i64 = conn.query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='idx_notes_project_updated' AND tbl_name='notes'",
                [], |row| row.get(0),
            ).unwrap();
            assert_eq!(index_count, 1);
            notes_repo::create(&conn, Some(7), "Content").unwrap().id
        };

        let pool = init_pool(&path).unwrap();
        let conn = pool.get().unwrap();
        let note = notes_repo::get(&conn, note_id).unwrap();
        assert_eq!(note.project_id, Some(7));
        assert_eq!(note.content, "Content");
        assert_eq!(notes_repo::list(&conn, Some(7)).unwrap().len(), 1);
    }

    fn seed_database(path: &PathBuf, migrations: &[&str]) -> rusqlite::Connection {
        let conn = rusqlite::Connection::open(path).unwrap();
        for migration in migrations {
            conn.execute_batch(migration).unwrap();
        }
        conn
    }

    #[test]
    fn migration_007_folds_titles_into_content_and_keeps_order() {
        let file = NamedTempFile::new().unwrap();
        let path = file.path().to_path_buf();
        {
            let conn = seed_database(&path, &[
                MIGRATION_001, MIGRATION_002, MIGRATION_003,
                MIGRATION_004, MIGRATION_005, MIGRATION_006,
            ]);
            conn.execute_batch(
                "INSERT INTO notes(id,project_id,title,content,created_at,updated_at) VALUES(1,NULL,'Plan','Treść',1,5);
                 INSERT INTO notes(id,project_id,title,content,created_at,updated_at) VALUES(2,NULL,'Tylko tytuł','',2,6);
                 INSERT INTO notes(id,project_id,title,content,created_at,updated_at) VALUES(3,NULL,'   ','Bez tytułu',3,7);",
            ).unwrap();
        }

        let pool = init_pool(&path).unwrap();
        let conn = pool.get().unwrap();
        let version: i64 = conn.query_row("SELECT MAX(version) FROM schema_version", [], |row| row.get(0)).unwrap();
        assert_eq!(version, 7);
        let content_of = |id: i64| -> String {
            conn.query_row("SELECT content FROM notes WHERE id=?", [id], |row| row.get(0)).unwrap()
        };
        assert_eq!(content_of(1), "Plan\nTreść");
        assert_eq!(content_of(2), "Tylko tytuł");
        assert_eq!(content_of(3), "Bez tytułu");
        let non_empty_titles: i64 = conn.query_row(
            "SELECT COUNT(*) FROM notes WHERE title<>''", [], |row| row.get(0),
        ).unwrap();
        assert_eq!(non_empty_titles, 0);
        let mut statement = conn.prepare("SELECT updated_at FROM notes ORDER BY id").unwrap();
        let updated = statement.query_map([], |row| row.get::<_, i64>(0)).unwrap()
            .collect::<rusqlite::Result<Vec<_>>>().unwrap();
        assert_eq!(updated, vec![5, 6, 7]);
    }

    #[test]
    fn concurrent_first_open_of_an_old_database_succeeds_everywhere() {
        let file = NamedTempFile::new().unwrap();
        let path = file.path().to_path_buf();
        {
            let conn = seed_database(&path, &[MIGRATION_001, MIGRATION_002, MIGRATION_003, MIGRATION_004]);
            conn.execute_batch(
                "INSERT INTO projects(id,name,path,claude_dir,created_at) VALUES(7,'Existing','/existing','-existing',123);",
            ).unwrap();
        }

        let handles = (0..4).map(|_| {
            let path = path.clone();
            std::thread::spawn(move || init_pool(&path).map(|_| ()))
        }).collect::<Vec<_>>();
        let results = handles.into_iter().map(|handle| handle.join().unwrap()).collect::<Vec<_>>();
        assert!(results.iter().all(Result::is_ok), "{results:?}");

        let conn = rusqlite::Connection::open(&path).unwrap();
        let version: i64 = conn.query_row("SELECT MAX(version) FROM schema_version", [], |row| row.get(0)).unwrap();
        assert_eq!(version, 7);
    }
}
