use rusqlite::{params, Connection};
use crate::domain::Project;
use crate::error::AppResult;

fn row_to_project(row: &rusqlite::Row) -> rusqlite::Result<Project> {
    Ok(Project {
        id: row.get(0)?,
        name: row.get(1)?,
        path: row.get(2)?,
        claude_dir: row.get(3)?,
        color: row.get(4)?,
        sort_order: row.get(5)?,
        created_at: row.get(6)?,
    })
}

pub fn list(conn: &Connection) -> AppResult<Vec<Project>> {
    let mut s = conn.prepare(
        "SELECT id,name,path,claude_dir,color,sort_order,created_at
         FROM projects ORDER BY sort_order ASC, created_at ASC",
    )?;
    let rows = s.query_map([], row_to_project)?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

pub fn insert(
    conn: &Connection,
    name: &str,
    path: &str,
    claude_dir: &str,
    color: Option<&str>,
) -> AppResult<Project> {
    let created_at = chrono::Utc::now().timestamp_millis();
    let sort_order: i64 = conn.query_row(
        "SELECT COALESCE(MAX(sort_order)+1, 0) FROM projects", [], |r| r.get(0),
    )?;
    conn.execute(
        "INSERT INTO projects(name,path,claude_dir,color,sort_order,created_at)
         VALUES(?,?,?,?,?,?)",
        params![name, path, claude_dir, color, sort_order, created_at],
    )?;
    let id = conn.last_insert_rowid();
    Ok(Project {
        id, name: name.to_string(), path: path.to_string(),
        claude_dir: claude_dir.to_string(), color: color.map(|s| s.to_string()),
        sort_order, created_at,
    })
}

pub fn update(
    conn: &Connection, id: i64, name: Option<&str>, color: Option<&str>,
) -> AppResult<Project> {
    if let Some(n) = name {
        conn.execute("UPDATE projects SET name=? WHERE id=?", params![n, id])?;
    }
    if let Some(c) = color {
        if c.is_empty() {
            conn.execute("UPDATE projects SET color=NULL WHERE id=?", params![id])?;
        } else {
            conn.execute("UPDATE projects SET color=? WHERE id=?", params![c, id])?;
        }
    }
    get(conn, id)
}

pub fn get(conn: &Connection, id: i64) -> AppResult<Project> {
    Ok(conn.query_row(
        "SELECT id,name,path,claude_dir,color,sort_order,created_at FROM projects WHERE id=?",
        params![id], row_to_project,
    )?)
}

pub fn get_by_path(conn: &Connection, path: &str) -> AppResult<Option<Project>> {
    let mut s = conn.prepare(
        "SELECT id,name,path,claude_dir,color,sort_order,created_at FROM projects WHERE path=?",
    )?;
    let mut rows = s.query(params![path])?;
    match rows.next()? {
        Some(row) => Ok(Some(row_to_project(row)?)),
        None => Ok(None),
    }
}

pub fn delete(conn: &Connection, id: i64) -> AppResult<()> {
    conn.execute("DELETE FROM projects WHERE id=?", params![id])?;
    Ok(())
}

pub fn reorder(conn: &Connection, ids: &[i64]) -> AppResult<()> {
    let tx = conn.unchecked_transaction()?;
    for (i, id) in ids.iter().enumerate() {
        tx.execute("UPDATE projects SET sort_order=? WHERE id=?", params![i as i64, id])?;
    }
    tx.commit()?;
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
    fn insert_list_roundtrip() {
        let p = pool();
        let c = p.get().unwrap();
        let proj = insert(&c, "Demo", "/x/y", "-x-y", None).unwrap();
        assert_eq!(proj.name, "Demo");
        let all = list(&c).unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].path, "/x/y");
    }

    #[test]
    fn unique_path() {
        let p = pool();
        let c = p.get().unwrap();
        insert(&c, "A", "/x", "-x", None).unwrap();
        let err = insert(&c, "B", "/x", "-x", None);
        assert!(err.is_err());
    }

    #[test]
    fn reorder_works() {
        let p = pool();
        let c = p.get().unwrap();
        let a = insert(&c, "A", "/a", "-a", None).unwrap();
        let b = insert(&c, "B", "/b", "-b", None).unwrap();
        reorder(&c, &[b.id, a.id]).unwrap();
        let all = list(&c).unwrap();
        assert_eq!(all[0].id, b.id);
        assert_eq!(all[1].id, a.id);
    }

    #[test]
    fn get_by_path_finds_and_misses() {
        let p = pool();
        let c = p.get().unwrap();
        insert(&c, "Demo", "/x/y", "-x-y", None).unwrap();
        let found = get_by_path(&c, "/x/y").unwrap();
        assert!(found.is_some());
        assert_eq!(found.unwrap().name, "Demo");
        assert!(get_by_path(&c, "/nope").unwrap().is_none());
    }

    #[test]
    fn update_sets_and_clears_color() {
        let p = pool();
        let c = p.get().unwrap();
        let proj = insert(&c, "Demo", "/x/y", "-x-y", Some("#b78640")).unwrap();
        let recolored = update(&c, proj.id, None, Some("#4a7dc2")).unwrap();
        assert_eq!(recolored.color.as_deref(), Some("#4a7dc2"));
        let cleared = update(&c, proj.id, None, Some("")).unwrap();
        assert_eq!(cleared.color, None);
        let untouched = update(&c, proj.id, Some("Renamed"), None).unwrap();
        assert_eq!(untouched.name, "Renamed");
        assert_eq!(untouched.color, None);
    }
}
