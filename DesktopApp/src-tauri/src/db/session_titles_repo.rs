use r2d2::PooledConnection;
use r2d2_sqlite::SqliteConnectionManager;
use std::collections::HashMap;

type Conn = PooledConnection<SqliteConnectionManager>;

pub fn get(conn: &Conn, project_id: i64, session_id: &str) -> Option<String> {
    conn.query_row(
        "SELECT title FROM session_titles WHERE project_id = ?1 AND session_id = ?2",
        rusqlite::params![project_id, session_id],
        |r| r.get(0),
    ).ok()
}

pub fn get_all(conn: &Conn, project_id: i64) -> HashMap<String, String> {
    let mut stmt = conn.prepare(
        "SELECT session_id, title FROM session_titles WHERE project_id = ?1"
    ).unwrap();
    let rows = stmt.query_map(rusqlite::params![project_id], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
    }).unwrap();
    rows.filter_map(|r| r.ok()).collect()
}

pub fn set(conn: &Conn, project_id: i64, session_id: &str, title: &str) {
    conn.execute(
        "INSERT INTO session_titles (project_id, session_id, title) VALUES (?1, ?2, ?3)
         ON CONFLICT(project_id, session_id) DO UPDATE SET title = excluded.title",
        rusqlite::params![project_id, session_id, title],
    ).ok();
}
