use rusqlite::{params, Connection};
use crate::domain::clickup::ClickUpLink;
use crate::error::AppResult;

fn row(r: &rusqlite::Row) -> rusqlite::Result<ClickUpLink> {
    Ok(ClickUpLink {
        project_id: r.get(0)?,
        task_id: r.get(1)?,
        custom_id: r.get(2)?,
        name: r.get(3)?,
        status: r.get(4)?,
        url: r.get(5)?,
        linked_at: r.get(6)?,
    })
}

pub fn list(conn: &Connection, project_id: i64) -> AppResult<Vec<ClickUpLink>> {
    let mut s = conn.prepare(
        "SELECT project_id,task_id,custom_id,name,status,url,linked_at
         FROM clickup_links WHERE project_id=? ORDER BY linked_at DESC",
    )?;
    let rows = s.query_map(params![project_id], row)?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

pub fn get(conn: &Connection, project_id: i64, task_id: &str) -> AppResult<Option<ClickUpLink>> {
    let mut s = conn.prepare(
        "SELECT project_id,task_id,custom_id,name,status,url,linked_at
         FROM clickup_links WHERE project_id=? AND task_id=?",
    )?;
    let mut rows = s.query(params![project_id, task_id])?;
    match rows.next()? {
        Some(r) => Ok(Some(row(r)?)),
        None => Ok(None),
    }
}

pub fn upsert(conn: &Connection, l: &ClickUpLink) -> AppResult<()> {
    conn.execute(
        "INSERT INTO clickup_links(project_id,task_id,custom_id,name,status,url,linked_at)
         VALUES(?,?,?,?,?,?,?)
         ON CONFLICT(project_id,task_id) DO UPDATE SET
           custom_id=excluded.custom_id, name=excluded.name,
           status=excluded.status, url=excluded.url",
        params![l.project_id, l.task_id, l.custom_id, l.name, l.status, l.url, l.linked_at],
    )?;
    Ok(())
}

pub fn delete(conn: &Connection, project_id: i64, task_id: &str) -> AppResult<()> {
    conn.execute(
        "DELETE FROM clickup_links WHERE project_id=? AND task_id=?",
        params![project_id, task_id],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{init_pool, projects_repo};
    use crate::domain::clickup::ClickUpLink;
    use tempfile::NamedTempFile;

    fn link(project_id: i64, task_id: &str, name: &str) -> ClickUpLink {
        ClickUpLink {
            project_id,
            task_id: task_id.into(),
            custom_id: Some("CU-1".into()),
            name: name.into(),
            status: Some("open".into()),
            url: "https://app.clickup.com/t/abc".into(),
            linked_at: 1_700_000_000_000,
        }
    }

    #[test]
    fn links_crud() {
        let f = NamedTempFile::new().unwrap();
        let pool = init_pool(&f.path().to_path_buf()).unwrap();
        let c = pool.get().unwrap();
        let p = projects_repo::insert(&c, "X", "/x", "-x", None).unwrap();

        assert_eq!(list(&c, p.id).unwrap().len(), 0);
        upsert(&c, &link(p.id, "abc", "Task A")).unwrap();
        upsert(&c, &link(p.id, "abc", "Task A renamed")).unwrap();
        assert_eq!(list(&c, p.id).unwrap().len(), 1);
        assert_eq!(get(&c, p.id, "abc").unwrap().unwrap().name, "Task A renamed");

        delete(&c, p.id, "abc").unwrap();
        assert_eq!(list(&c, p.id).unwrap().len(), 0);
    }
}
