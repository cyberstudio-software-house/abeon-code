use rusqlite::{params, Connection};
use crate::domain::Action;
use crate::error::AppResult;

fn row(r: &rusqlite::Row) -> rusqlite::Result<Action> {
    Ok(Action {
        id: r.get(0)?,
        project_id: r.get(1)?,
        label: r.get(2)?,
        command: r.get(3)?,
        working_dir: r.get(4)?,
        source: r.get(5)?,
        sort_order: r.get(6)?,
    })
}

pub fn list(conn: &Connection, project_id: i64) -> AppResult<Vec<Action>> {
    let mut s = conn.prepare(
        "SELECT id,project_id,label,command,working_dir,source,sort_order
         FROM actions WHERE project_id=? ORDER BY sort_order ASC, id ASC",
    )?;
    let rows = s.query_map(params![project_id], row)?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

pub fn get(conn: &Connection, id: i64) -> AppResult<Action> {
    Ok(conn.query_row(
        "SELECT id,project_id,label,command,working_dir,source,sort_order FROM actions WHERE id=?",
        params![id], row,
    )?)
}

pub fn insert(
    conn: &Connection,
    project_id: i64, label: &str, command: &str,
    working_dir: Option<&str>, source: Option<&str>,
) -> AppResult<Action> {
    let sort_order: i64 = conn.query_row(
        "SELECT COALESCE(MAX(sort_order)+1, 0) FROM actions WHERE project_id=?",
        params![project_id], |r| r.get(0),
    )?;
    conn.execute(
        "INSERT INTO actions(project_id,label,command,working_dir,source,sort_order)
         VALUES(?,?,?,?,?,?)",
        params![project_id, label, command, working_dir, source, sort_order],
    )?;
    let id = conn.last_insert_rowid();
    get(conn, id)
}

pub fn update(
    conn: &Connection, id: i64,
    label: Option<&str>, command: Option<&str>, working_dir: Option<&str>,
) -> AppResult<Action> {
    if let Some(l) = label {
        conn.execute("UPDATE actions SET label=? WHERE id=?", params![l, id])?;
    }
    if let Some(c) = command {
        conn.execute("UPDATE actions SET command=? WHERE id=?", params![c, id])?;
    }
    if let Some(w) = working_dir {
        conn.execute("UPDATE actions SET working_dir=? WHERE id=?", params![w, id])?;
    }
    get(conn, id)
}

pub fn delete(conn: &Connection, id: i64) -> AppResult<()> {
    conn.execute("DELETE FROM actions WHERE id=?", params![id])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{init_pool, projects_repo};
    use tempfile::NamedTempFile;

    #[test]
    fn crud_actions() {
        let f = NamedTempFile::new().unwrap();
        let pool = init_pool(&f.path().to_path_buf()).unwrap();
        let c = pool.get().unwrap();
        let p = projects_repo::insert(&c, "X", "/x", "-x", None).unwrap();
        let a = insert(&c, p.id, "dev", "npm run dev", None, Some("npm")).unwrap();
        assert_eq!(a.label, "dev");
        assert_eq!(list(&c, p.id).unwrap().len(), 1);
        update(&c, a.id, Some("dev2"), None, None).unwrap();
        assert_eq!(get(&c, a.id).unwrap().label, "dev2");
        delete(&c, a.id).unwrap();
        assert_eq!(list(&c, p.id).unwrap().len(), 0);
    }
}
