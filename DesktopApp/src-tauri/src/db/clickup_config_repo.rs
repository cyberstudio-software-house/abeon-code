use rusqlite::{params, Connection};
use crate::domain::clickup::ClickUpProjectConfig;
use crate::error::AppResult;

pub fn get(conn: &Connection, project_id: i64) -> AppResult<Option<ClickUpProjectConfig>> {
    let mut stmt = conn.prepare(
        "SELECT project_id, workspace_id, space_id, list_id
         FROM clickup_project_config WHERE project_id = ?",
    )?;
    let mut rows = stmt.query(params![project_id])?;
    match rows.next()? {
        Some(r) => Ok(Some(ClickUpProjectConfig {
            project_id: r.get(0)?,
            workspace_id: r.get(1)?,
            space_id: r.get(2)?,
            list_id: r.get(3)?,
        })),
        None => Ok(None),
    }
}

pub fn set(
    conn: &Connection,
    project_id: i64,
    workspace_id: &str,
    space_id: Option<&str>,
    list_id: Option<&str>,
) -> AppResult<()> {
    conn.execute(
        "INSERT INTO clickup_project_config(project_id, workspace_id, space_id, list_id)
         VALUES(?,?,?,?)
         ON CONFLICT(project_id) DO UPDATE SET
           workspace_id = excluded.workspace_id,
           space_id     = excluded.space_id,
           list_id      = excluded.list_id",
        params![project_id, workspace_id, space_id, list_id],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{init_pool, projects_repo};
    use tempfile::NamedTempFile;

    #[test]
    fn config_upsert_round_trip() {
        let f = NamedTempFile::new().unwrap();
        let pool = init_pool(&f.path().to_path_buf()).unwrap();
        let c = pool.get().unwrap();
        let p = projects_repo::insert(&c, "X", "/x", "-x", None).unwrap();

        assert!(get(&c, p.id).unwrap().is_none());

        set(&c, p.id, "ws1", Some("sp1"), None).unwrap();
        let cfg = get(&c, p.id).unwrap().unwrap();
        assert_eq!(cfg.workspace_id, "ws1");
        assert_eq!(cfg.space_id.as_deref(), Some("sp1"));
        assert_eq!(cfg.list_id, None);

        set(&c, p.id, "ws1", Some("sp1"), Some("li9")).unwrap();
        assert_eq!(get(&c, p.id).unwrap().unwrap().list_id.as_deref(), Some("li9"));
    }
}
