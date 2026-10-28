use crate::domain::DecisionEntry;
use crate::error::AppResult;
use rusqlite::{params, Connection};

pub struct NewDecision {
    pub created_at: i64,
    pub session_id: Option<String>,
    pub kind: &'static str,
    pub question: String,
    pub decision: String,
    pub rationale: String,
}

pub fn insert(conn: &Connection, entry: &NewDecision) -> AppResult<i64> {
    conn.execute(
        "INSERT INTO supervisor_decisions(created_at,session_id,kind,question,decision,rationale)
         VALUES(?,?,?,?,?,?)",
        params![
            entry.created_at,
            entry.session_id,
            entry.kind,
            entry.question,
            entry.decision,
            entry.rationale
        ],
    )?;
    Ok(conn.last_insert_rowid())
}

pub fn list(conn: &Connection, limit: u32) -> AppResult<Vec<DecisionEntry>> {
    let mut statement = conn.prepare(
        "SELECT id,created_at,session_id,kind,question,decision,rationale
         FROM supervisor_decisions ORDER BY created_at DESC, id DESC LIMIT ?",
    )?;
    let rows = statement.query_map(params![limit], |row| {
        Ok(DecisionEntry {
            id: row.get(0)?,
            created_at: row.get(1)?,
            session_id: row.get(2)?,
            kind: row.get(3)?,
            question: row.get(4)?,
            decision: row.get(5)?,
            rationale: row.get(6)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

pub fn prune_older_than(conn: &Connection, cutoff_ms: i64) -> AppResult<usize> {
    Ok(conn.execute(
        "DELETE FROM supervisor_decisions WHERE created_at < ?",
        params![cutoff_ms],
    )?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_pool;
    use tempfile::NamedTempFile;

    fn pool() -> crate::db::DbPool {
        let file = NamedTempFile::new().unwrap();
        let path = file.path().to_path_buf();
        std::mem::forget(file);
        init_pool(&path).unwrap()
    }

    fn entry(created_at: i64, question: &str) -> NewDecision {
        NewDecision {
            created_at,
            session_id: Some("session-1".to_string()),
            kind: "answered",
            question: question.to_string(),
            decision: "yes".to_string(),
            rationale: "because".to_string(),
        }
    }

    #[test]
    fn insert_list_prune() {
        let pool = pool();
        let conn = pool.get().unwrap();
        let day = 24 * 60 * 60 * 1000;
        let now = 100 * day;
        insert(&conn, &entry(now - 31 * day, "old")).unwrap();
        insert(&conn, &entry(now - 1000, "middle")).unwrap();
        insert(&conn, &entry(now, "newest")).unwrap();

        let removed = prune_older_than(&conn, now - 30 * day).unwrap();
        assert_eq!(removed, 1);

        let entries = list(&conn, 10).unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].question, "newest");
        assert_eq!(entries[1].question, "middle");
        assert_eq!(entries[0].kind, "answered");
        assert_eq!(entries[0].session_id.as_deref(), Some("session-1"));
    }

    #[test]
    fn list_respects_limit() {
        let pool = pool();
        let conn = pool.get().unwrap();
        for index in 0..5 {
            insert(&conn, &entry(index, "q")).unwrap();
        }
        assert_eq!(list(&conn, 3).unwrap().len(), 3);
    }
}
