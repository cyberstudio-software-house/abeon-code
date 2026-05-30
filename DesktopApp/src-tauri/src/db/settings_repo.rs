use rusqlite::{params, Connection};
use std::collections::HashMap;
use crate::error::AppResult;

pub fn get(conn: &Connection, key: &str) -> AppResult<Option<String>> {
    let mut stmt = conn.prepare("SELECT value FROM settings WHERE key = ?")?;
    let mut rows = stmt.query(params![key])?;
    match rows.next()? {
        Some(row) => Ok(Some(row.get(0)?)),
        None => Ok(None),
    }
}

pub fn get_all(conn: &Connection) -> AppResult<HashMap<String, String>> {
    let mut stmt = conn.prepare("SELECT key, value FROM settings")?;
    let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
    let mut map = HashMap::new();
    for row in rows {
        let (k, v) = row?;
        map.insert(k, v);
    }
    Ok(map)
}

pub fn set(conn: &Connection, key: &str, value: &str) -> AppResult<()> {
    conn.execute(
        "INSERT INTO settings(key, value) VALUES(?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

pub fn delete(conn: &Connection, key: &str) -> AppResult<()> {
    conn.execute("DELETE FROM settings WHERE key = ?", params![key])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_pool;
    use tempfile::NamedTempFile;

    fn pool() -> crate::db::DbPool {
        let f = NamedTempFile::new().unwrap();
        let path = f.path().to_path_buf();
        std::mem::forget(f);
        init_pool(&path).unwrap()
    }

    #[test]
    fn set_get_roundtrip() {
        let p = pool();
        let c = p.get().unwrap();
        set(&c, "theme", "dark").unwrap();
        assert_eq!(get(&c, "theme").unwrap(), Some("dark".to_string()));
    }

    #[test]
    fn set_overwrites() {
        let p = pool();
        let c = p.get().unwrap();
        set(&c, "theme", "dark").unwrap();
        set(&c, "theme", "light").unwrap();
        assert_eq!(get(&c, "theme").unwrap(), Some("light".to_string()));
    }

    #[test]
    fn get_missing_returns_none() {
        let p = pool();
        let c = p.get().unwrap();
        assert_eq!(get(&c, "nonexistent").unwrap(), None);
    }

    #[test]
    fn get_all_returns_all_rows() {
        let p = pool();
        let c = p.get().unwrap();
        set(&c, "theme", "dark").unwrap();
        set(&c, "leftWidth", "260").unwrap();
        set(&c, "migrated_v2", "1").unwrap();
        let all = get_all(&c).unwrap();
        assert_eq!(all.len(), 3);
        assert_eq!(all.get("theme"), Some(&"dark".to_string()));
        assert_eq!(all.get("leftWidth"), Some(&"260".to_string()));
        assert_eq!(all.get("migrated_v2"), Some(&"1".to_string()));
    }

    #[test]
    fn delete_removes_row() {
        let p = pool();
        let c = p.get().unwrap();
        set(&c, "theme", "dark").unwrap();
        delete(&c, "theme").unwrap();
        assert_eq!(get(&c, "theme").unwrap(), None);
    }

    #[test]
    fn delete_missing_is_noop() {
        let p = pool();
        let c = p.get().unwrap();
        delete(&c, "nonexistent").unwrap();
    }
}
